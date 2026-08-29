import { NextResponse } from 'next/server'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { readStoredFile } from '@/lib/files/storage'
import { findVisibleRepositoryAsset, RepositoryAssetNotFoundError } from '@/lib/knowledge/repository'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2) || ''
  let asset
  try {
    asset = await findVisibleRepositoryAsset({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      id,
      includeContent: true,
    })
  } catch (error) {
    if (error instanceof RepositoryAssetNotFoundError) throw new ApiError(error.message, 404, 'REPOSITORY_ASSET_NOT_FOUND')
    throw error
  }
  const row = await prisma.knowledgeDocument.findFirst({
    where: { id: asset.id, organizationId: auth.organizationId },
    select: { storedFileId: true },
  })
  const original = row?.storedFileId ? await readStoredFile(row.storedFileId, auth.organizationId) : null
  if (row?.storedFileId && !original) {
    throw new ApiError('The retained original is temporarily unavailable. Try again shortly.', 503, 'ORIGINAL_UNAVAILABLE')
  }
  const buffer = original?.buffer ?? Buffer.from(asset.content ?? '', 'utf8')
  const filename = (original?.filename ?? asset.filename).replace(/["\r\n]/g, '')
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': original?.mimeType ?? asset.mimeType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}, { permission: 'flow.read' })
