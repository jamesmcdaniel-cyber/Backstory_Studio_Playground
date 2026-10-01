import { createClient } from '@supabase/supabase-js'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { assertNotExecutable, directUploadNeedsWholeFile, FileRejectedError, scanFileBuffer, verifyFileMime } from '@/lib/files/security'

/**
 * Original-file storage for uploads (run-form file inputs and future step
 * outputs). Bytes go to Supabase Storage when the service-role key is
 * configured (prod); otherwise they live inline on the row (`backend: 'db'`)
 * — which is also what local dev and CI exercise. Reads dispatch on the
 * row's recorded backend, so environments can migrate without data moves.
 */

export const STORED_FILE_MAX_BYTES = 10_000_000
/** Tabular files (datasets) are stored whole and computed over in the sandbox,
 *  never read into a prompt, so they get their own ceiling. A 24-month
 *  activity extract for a 2,000-rep org is ~25 MB; this leaves headroom. */
export const DATASET_MAX_BYTES = 200_000_000
export const DEFAULT_ORG_FILE_STORAGE_MAX_BYTES = 500_000_000
const BUCKET = 'stored-files'
// How much of a directly-uploaded file the server reads back to verify its
// type. Magic bytes live in the first few hundred bytes; text detection uses 8K.
const VERIFY_HEAD_BYTES = 16_384

export function isDatasetFilename(filename: string): boolean {
  return /\.(csv|tsv)$/i.test(filename)
}

/** The per-file ceiling that applies to this filename. */
export function maxBytesForFile(filename: string): number {
  return isDatasetFilename(filename) ? DATASET_MAX_BYTES : STORED_FILE_MAX_BYTES
}

export class DirectUploadUnavailableError extends Error {}

function safeFilename(filename: string): string {
  return filename.replace(/[\r\n]/g, ' ').slice(0, 200) || 'file'
}

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

// The bucket is created on first use rather than assumed: a project that has
// never stored a file has no bucket, and "Bucket not found" is a poor way for
// an upload to learn that. Checked once per process.
let bucketReady: Promise<void> | null = null
function ensureBucket(supabase: NonNullable<ReturnType<typeof supabaseAdmin>>): Promise<void> {
  bucketReady ??= (async () => {
    const existing = await supabase.storage.getBucket(BUCKET)
    if (!existing.error && existing.data) return
    // No per-bucket size limit: it may not exceed the project's own cap (50 MB
    // on the free plan), and a limit above it makes creation fail outright.
    // The project cap applies either way; our ceilings are enforced in code.
    const created = await supabase.storage.createBucket(BUCKET, { public: false })
    // A concurrent creator winning the race is fine; anything else is not.
    if (created.error && !/already exists|duplicate/i.test(created.error.message)) {
      bucketReady = null
      throw new Error(`Could not prepare file storage: ${created.error.message}`)
    }
  })()
  return bucketReady
}

export async function saveStoredFile(params: {
  organizationId: string
  userId?: string | null
  filename: string
  mimeType: string
  buffer: Buffer
  /** Content the platform produced itself (a computed result) or an operator
   *  loaded from a CLI after inspecting it. Skips the malware scanner, which
   *  exists for what browsers send us; every upload route leaves this unset. */
  trusted?: boolean
}): Promise<{ id: string; filename: string; mimeType: string; size: number }> {
  const ceiling = maxBytesForFile(params.filename)
  if (params.buffer.length > ceiling) {
    throw new FileRejectedError(`Files can be at most ${Math.round(ceiling / 1_000_000)} MB.`)
  }
  const filename = safeFilename(params.filename)
  const mimeType = verifyFileMime(params.buffer, params.mimeType, filename)
  if (!params.trusted) await scanFileBuffer(params.buffer, filename)
  const quota = Math.max(STORED_FILE_MAX_BYTES, Number(process.env.ORG_FILE_STORAGE_MAX_BYTES) || DEFAULT_ORG_FILE_STORAGE_MAX_BYTES)
  const reserveAndCreate = async (backend: 'supabase' | 'db') => tenantTransaction(params.organizationId, async (tx) => {
    const reserved = await tx.organization.updateMany({
      where: { id: params.organizationId, storageBytes: { lte: BigInt(quota - params.buffer.length) } },
      data: { storageBytes: { increment: BigInt(params.buffer.length) } },
    })
    if (reserved.count !== 1) {
      throw new FileRejectedError(`Workspace file storage limit reached (${Math.round(quota / 1_000_000)} MB). Delete old files and try again.`)
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
    await ensureBucket(supabase)
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
  const row = await prisma.storedFile.findFirst({ where: { id, organizationId, status: 'ready' } })
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


/**
 * Direct-to-storage upload, step 1: reserve quota and a row, hand the browser
 * a signed URL it PUTs the bytes to. Nothing passes through the app server —
 * which is the whole point: a 30 MB extract is well past what a serverless
 * request body may carry. Only available where Supabase Storage is configured;
 * callers fall back to the multipart route otherwise.
 */
export async function createPendingUpload(params: {
  organizationId: string
  userId?: string | null
  filename: string
  mimeType: string
  size: number
}): Promise<{ id: string; uploadUrl: string; token: string; storagePath: string; bucket: string }> {
  const supabase = supabaseAdmin()
  if (!supabase) throw new DirectUploadUnavailableError('Direct uploads need object storage, which this deployment does not have configured.')
  await ensureBucket(supabase)
  const ceiling = maxBytesForFile(params.filename)
  if (!Number.isFinite(params.size) || params.size <= 0) throw new FileRejectedError('The file is empty.')
  if (params.size > ceiling) throw new FileRejectedError(`Files can be at most ${Math.round(ceiling / 1_000_000)} MB.`)
  const filename = safeFilename(params.filename)
  const quota = Math.max(STORED_FILE_MAX_BYTES, Number(process.env.ORG_FILE_STORAGE_MAX_BYTES) || DEFAULT_ORG_FILE_STORAGE_MAX_BYTES)
  const row = await tenantTransaction(params.organizationId, async (tx) => {
    const reserved = await tx.organization.updateMany({
      where: { id: params.organizationId, storageBytes: { lte: BigInt(quota - params.size) } },
      data: { storageBytes: { increment: BigInt(params.size) } },
    })
    if (reserved.count !== 1) {
      throw new FileRejectedError(`Workspace file storage limit reached (${Math.round(quota / 1_000_000)} MB). Delete old files and try again.`)
    }
    return tx.storedFile.create({
      data: {
        organizationId: params.organizationId,
        userId: params.userId ?? null,
        filename,
        mimeType: params.mimeType || 'application/octet-stream',
        size: params.size,
        backend: 'supabase',
        storagePath: '',
        status: 'pending',
      },
    })
  })
  const storagePath = `${params.organizationId}/${row.id}`
  const signed = await supabase.storage.from(BUCKET).createSignedUploadUrl(storagePath)
  if (signed.error || !signed.data) {
    await deletePending(row.id, params.organizationId, row.size)
    throw new Error(`Could not start the upload: ${signed.error?.message ?? 'no signed URL'}`)
  }
  await prisma.storedFile.update({ where: { id: row.id, organizationId: params.organizationId }, data: { storagePath } })
  return { id: row.id, uploadUrl: signed.data.signedUrl, token: signed.data.token, storagePath, bucket: BUCKET }
}

async function deletePending(id: string, organizationId: string, size: number): Promise<void> {
  await tenantTransaction(organizationId, async (tx) => {
    const removed = await tx.storedFile.deleteMany({ where: { id, organizationId, status: 'pending' } })
    if (removed.count) await tx.organization.update({ where: { id: organizationId }, data: { storageBytes: { decrement: BigInt(size) } } })
  }).catch(() => {})
}

/**
 * Direct-to-storage upload, step 2: the browser says the PUT finished. Verify
 * what actually landed (it may be nothing, or something else entirely): the
 * object must exist, be within the ceiling, and its head must match the type
 * the filename claims. The malware hook, when configured, sees the whole
 * file. Only then does the row become readable.
 */
export async function finalizeUpload(params: {
  id: string
  organizationId: string
}): Promise<{ id: string; filename: string; mimeType: string; size: number }> {
  const supabase = supabaseAdmin()
  if (!supabase) throw new DirectUploadUnavailableError('Direct uploads need object storage.')
  const row = await prisma.storedFile.findFirst({ where: { id: params.id, organizationId: params.organizationId } })
  if (!row) throw new Error('Upload not found.')
  if (row.status === 'ready') return { id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size }
  const storagePath = row.storagePath || `${params.organizationId}/${row.id}`
  const bucket = supabase.storage.from(BUCKET)
  const reject = async (message: string): Promise<never> => {
    await bucket.remove([storagePath]).catch(() => undefined)
    await deletePending(row.id, params.organizationId, row.size)
    throw new FileRejectedError(message)
  }
  const info = await bucket.info(storagePath).catch(() => null)
  const actualSize = Number(info?.data?.size ?? NaN)
  if (info?.error || !Number.isFinite(actualSize)) return reject('The upload did not complete. Try again.')
  const ceiling = maxBytesForFile(row.filename)
  if (actualSize > ceiling) return reject(`Files can be at most ${Math.round(ceiling / 1_000_000)} MB.`)
  if (actualSize <= 0) return reject('The uploaded file is empty.')

  const needsWholeFile = directUploadNeedsWholeFile()
  let head: Buffer
  let whole: Buffer | null = null
  // A required scanner must fail closed. Downloading the complete object here
  // deliberately hands the decision to scanFileBuffer(), whose missing-URL
  // branch rejects when FILE_SCAN_REQUIRED=true. The old range-read branch
  // skipped scanFileBuffer entirely and could mark an unscanned object ready.
  if (needsWholeFile) {
    const downloaded = await bucket.download(storagePath)
    if (downloaded.error || !downloaded.data) return reject('The upload could not be read back.')
    whole = Buffer.from(await downloaded.data.arrayBuffer())
    head = whole.subarray(0, VERIFY_HEAD_BYTES)
  } else {
    const signed = await bucket.createSignedUrl(storagePath, 60)
    if (signed.error || !signed.data) return reject('The upload could not be read back.')
    const response = await fetch(signed.data.signedUrl, { headers: { Range: `bytes=0-${VERIFY_HEAD_BYTES - 1}` } })
    if (!response.ok) return reject('The upload could not be read back.')
    head = Buffer.from(await response.arrayBuffer())
  }
  let mimeType: string
  try {
    mimeType = verifyFileMime(head, row.mimeType, row.filename)
    assertNotExecutable(head)
    if (isDatasetFilename(row.filename) && !/^text\//.test(mimeType) && mimeType !== 'application/json') {
      throw new Error('That file is named like a dataset but does not contain text.')
    }
    if (whole) await scanFileBuffer(whole, row.filename)
  } catch (error) {
    return reject(error instanceof Error ? error.message : 'The file was rejected.')
  }

  await tenantTransaction(params.organizationId, async (tx) => {
    await tx.storedFile.update({
      where: { id: row.id, organizationId: params.organizationId },
      data: { status: 'ready', size: actualSize, mimeType, storagePath },
    })
    const delta = BigInt(actualSize - row.size)
    if (delta !== BigInt(0)) {
      await tx.organization.update({ where: { id: params.organizationId }, data: { storageBytes: { increment: delta } } })
    }
  })
  return { id: row.id, filename: row.filename, mimeType, size: actualSize }
}
