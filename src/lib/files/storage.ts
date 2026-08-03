import { createClient } from '@supabase/supabase-js'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { scanFileBuffer, verifyFileMime } from '@/lib/files/security'

/**
 * Original-file storage for uploads (run-form file inputs and future step
 * outputs). Bytes go to Supabase Storage when the service-role key is
 * configured (prod); otherwise they live inline on the row (`backend: 'db'`)
 * — which is also what local dev and CI exercise. Reads dispatch on the
 * row's recorded backend, so environments can migrate without data moves.
 */

export const STORED_FILE_MAX_BYTES = 10_000_000
export const DEFAULT_ORG_FILE_STORAGE_MAX_BYTES = 500_000_000
const BUCKET = 'stored-files'

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function saveStoredFile(params: {
  organizationId: string
  userId?: string | null
  filename: string
  mimeType: string
  buffer: Buffer
}): Promise<{ id: string; filename: string; mimeType: string; size: number }> {
  if (params.buffer.length > STORED_FILE_MAX_BYTES) {
    throw new Error(`Files can be at most ${Math.round(STORED_FILE_MAX_BYTES / 1_000_000)} MB.`)
  }
  const filename = params.filename.replace(/[\r\n]/g, ' ').slice(0, 200) || 'file'
  const mimeType = verifyFileMime(params.buffer, params.mimeType, filename)
  await scanFileBuffer(params.buffer, filename)
  const quota = Math.max(STORED_FILE_MAX_BYTES, Number(process.env.ORG_FILE_STORAGE_MAX_BYTES) || DEFAULT_ORG_FILE_STORAGE_MAX_BYTES)
  const reserveAndCreate = async (backend: 'supabase' | 'db') => tenantTransaction(params.organizationId, async (tx) => {
    const reserved = await tx.organization.updateMany({
      where: { id: params.organizationId, storageBytes: { lte: BigInt(quota - params.buffer.length) } },
      data: { storageBytes: { increment: BigInt(params.buffer.length) } },
    })
    if (reserved.count !== 1) {
      throw new Error(`Workspace file storage limit reached (${Math.round(quota / 1_000_000)} MB). Delete old files and try again.`)
    }
    return tx.storedFile.create({
      data: {
        organizationId: params.organizationId,
        userId: params.userId ?? null,
        filename,
        mimeType,
        size: params.buffer.length,
        backend,
        ...(backend === 'supabase' ? { storagePath: '' } : { data: params.buffer }),
      },
    })
  })
  const supabase = supabaseAdmin()
  if (supabase) {
    const row = await reserveAndCreate('supabase')
    const storagePath = `${params.organizationId}/${row.id}`
    const uploaded = await supabase.storage.from(BUCKET).upload(storagePath, params.buffer, {
      contentType: mimeType,
      upsert: true,
    })
    if (uploaded.error) {
      // The row without bytes is useless — remove it so the caller's error
      // isn't followed by a phantom file in listings.
      await tenantTransaction(params.organizationId, async (tx) => {
        const removed = await tx.storedFile.deleteMany({ where: { id: row.id, organizationId: params.organizationId } })
        if (removed.count) await tx.organization.update({ where: { id: params.organizationId }, data: { storageBytes: { decrement: BigInt(row.size) } } })
      }).catch(() => {})
      throw new Error(`Could not store the file: ${uploaded.error.message}`)
    }
    await prisma.storedFile.update({ where: { id: row.id, organizationId: params.organizationId }, data: { storagePath } })
    return { id: row.id, filename, mimeType, size: params.buffer.length }
  }
  const row = await reserveAndCreate('db')
  return { id: row.id, filename, mimeType, size: params.buffer.length }
}

export async function deleteStoredFile(id: string, organizationId: string): Promise<boolean> {
  const row = await prisma.storedFile.findFirst({ where: { id, organizationId } })
  if (!row) return false
  if (row.backend === 'supabase' && row.storagePath) {
    const supabase = supabaseAdmin()
    if (supabase) {
      const removed = await supabase.storage.from(BUCKET).remove([row.storagePath])
      if (removed.error) throw new Error(`Could not delete stored file: ${removed.error.message}`)
    }
  }
  await tenantTransaction(organizationId, async (tx) => {
    const removed = await tx.storedFile.deleteMany({ where: { id, organizationId } })
    if (removed.count) {
      await tx.organization.update({ where: { id: organizationId }, data: { storageBytes: { decrement: BigInt(row.size) } } })
    }
  })
  return true
}

export async function readStoredFile(
  id: string,
  organizationId: string,
): Promise<{ filename: string; mimeType: string; buffer: Buffer } | null> {
  const row = await prisma.storedFile.findFirst({ where: { id, organizationId } })
  if (!row) return null
  if (row.backend === 'supabase' && row.storagePath) {
    const supabase = supabaseAdmin()
    if (!supabase) return null
    const downloaded = await supabase.storage.from(BUCKET).download(row.storagePath)
    if (downloaded.error || !downloaded.data) return null
    return { filename: row.filename, mimeType: row.mimeType, buffer: Buffer.from(await downloaded.data.arrayBuffer()) }
  }
  if (!row.data) return null
  return { filename: row.filename, mimeType: row.mimeType, buffer: Buffer.from(row.data) }
}
