import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const folderName = z
  .string()
  .trim()
  .min(1, 'Folder name is required.')
  .max(60, 'Folder name must be 60 characters or fewer.')
  .transform((name) => name.replace(/\s+/g, ' '))
  .refine((name) => name.toLocaleLowerCase() !== 'general', 'General is the built-in workspace folder.')

const createSchema = z.object({ name: folderName })
const updateSchema = z.object({ id: z.string().min(1), name: folderName })
const deleteSchema = z.object({ id: z.string().min(1) })

async function assertNameAvailable(organizationId: string, name: string, exceptId?: string) {
  const duplicate = await prisma.workspaceFolder.findFirst({
    where: {
      organizationId,
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  })
  if (duplicate) throw new ApiError('A public folder with that name already exists.', 409, 'FOLDER_EXISTS')
}

function duplicateFolderError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ApiError('A public folder with that name already exists.', 409, 'FOLDER_EXISTS')
  }
  throw error
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const folders = await prisma.workspaceFolder.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
  return { success: true, folders }
}, { permission: 'agent.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { name } = createSchema.parse(await request.json())
  await assertNameAvailable(auth.organizationId, name)
  try {
    const folder = await prisma.workspaceFolder.create({
      data: { organizationId: auth.organizationId, name },
      select: { id: true, name: true },
    })
    return { success: true, folder }
  } catch (error) {
    duplicateFolderError(error)
  }
}, { permission: 'agent.write' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const { id, name } = updateSchema.parse(await request.json())
  const current = await prisma.workspaceFolder.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, name: true },
  })
  if (!current) throw new ApiError('Public folder not found.', 404, 'FOLDER_NOT_FOUND')
  if (current.name === name) return { success: true, folder: current }
  await assertNameAvailable(auth.organizationId, name, id)

  try {
    const folder = await tenantTransaction(auth.organizationId, async (tx) => {
      // AgentTask.folder is the compatible assignment column used by exports,
      // search, and older clients. Rename those assignments atomically with
      // the catalogue row so no agent briefly falls out of its folder.
      await tx.agentTask.updateMany({
        where: {
          organizationId: auth.organizationId,
          visibility: { not: 'private' },
          folder: { equals: current.name, mode: 'insensitive' },
        },
        data: { folder: name },
      })
      return tx.workspaceFolder.update({
        where: { id, organizationId: auth.organizationId },
        data: { name },
        select: { id: true, name: true },
      })
    })
    return { success: true, folder }
  } catch (error) {
    duplicateFolderError(error)
  }
}, { permission: 'agent.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = deleteSchema.parse(await request.json())
  const current = await prisma.workspaceFolder.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, name: true },
  })
  if (!current) throw new ApiError('Public folder not found.', 404, 'FOLDER_NOT_FOUND')

  const moved = await tenantTransaction(auth.organizationId, async (tx) => {
    const result = await tx.agentTask.updateMany({
      where: {
        organizationId: auth.organizationId,
        visibility: { not: 'private' },
        folder: { equals: current.name, mode: 'insensitive' },
      },
      data: { folder: null },
    })
    await tx.workspaceFolder.delete({ where: { id, organizationId: auth.organizationId } })
    return result.count
  })

  return { success: true, moved }
}, { permission: 'agent.write' })
