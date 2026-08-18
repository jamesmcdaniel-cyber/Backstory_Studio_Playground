import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { interpretFlow, type RunActionFn } from '../interpret'
import { bindFormFiles, buildMultipartBody, bodyHasFileReference, type StoredFileBytes } from '@/lib/flows/file-ref'
import { prepareHttpRequest } from '../http'

const fileRef = (over: Partial<{ fileId: string; filename: string; mimeType: string; size: number; url: string }> = {}) => ({
  fileId: 'file_1',
  filename: 'invoice.pdf',
  mimeType: 'application/pdf',
  size: 4,
  url: '/api/files/file_1',
  ...over,
})

const bytes: Record<string, StoredFileBytes> = {
  file_1: { buffer: Buffer.from('%PDF'), filename: 'invoice.pdf', mimeType: 'application/pdf' },
  file_2: { buffer: Buffer.from('id,name\n1,a'), filename: 'rows.csv', mimeType: 'text/csv' },
}
const readFile = async (id: string) => bytes[id] ?? null

/** Read a FormData back off the wire, exactly as the server would receive it. */
async function wire(form: FormData): Promise<{ contentType: string; body: string }> {
  const response = new Response(form)
  return { contentType: response.headers.get('content-type') ?? '', body: await response.text() }
}

// ── The multipart body the executor sends ──────────────────────────────────

test('buildMultipartBody sends a binary part with its filename and content-type alongside text fields', async () => {
  const form = await buildMultipartBody({ title: 'Q3 invoice', retries: 2, document: fileRef() }, readFile)
  const { contentType, body } = await wire(form)

  const boundary = /boundary=(-{2,}[^\s;]+)/.exec(contentType)?.[1]
  assert.ok(boundary, `expected a multipart boundary, got ${contentType}`)
  assert.match(contentType, /^multipart\/form-data;/)
  // Every part is delimited by the boundary, and the body terminates with it.
  assert.equal(body.split(`--${boundary}`).length - 1, 4) // 3 parts + closing
  assert.ok(body.trimEnd().endsWith(`--${boundary}--`))

  assert.match(body, /content-disposition: form-data; name="title"/i)
  assert.match(body, /Q3 invoice/)
  assert.match(body, /content-disposition: form-data; name="retries"/i)
  assert.match(body, /content-disposition: form-data; name="document"; filename="invoice\.pdf"/i)
  assert.match(body, /content-type: application\/pdf/i)
  assert.match(body, /%PDF/)
})

test('buildMultipartBody sends every file of a multi-file field', async () => {
  const form = await buildMultipartBody(
    { attachments: [fileRef(), fileRef({ fileId: 'file_2', filename: 'rows.csv', mimeType: 'text/csv' })] },
    readFile,
  )
  const { body } = await wire(form)
  assert.match(body, /name="attachments"; filename="invoice\.pdf"/i)
  assert.match(body, /name="attachments"; filename="rows\.csv"/i)
  assert.match(body, /content-type: text\/csv/i)
})

test('buildMultipartBody keeps the existing text-only behavior intact', async () => {
  const form = await buildMultipartBody({ a: 'one', b: ['two', 'three'], skipped: null, nested: { x: 1 } }, readFile)
  const { body } = await wire(form)
  assert.match(body, /name="a"/)
  assert.equal(body.match(/name="b"/g)?.length, 2)
  assert.doesNotMatch(body, /name="skipped"/)
  assert.match(body, /\{"x":1\}/)
  assert.doesNotMatch(body, /filename=/)
})

test('buildMultipartBody fails loudly when a referenced file is gone', async () => {
  await assert.rejects(
    () => buildMultipartBody({ document: fileRef({ fileId: 'missing' }) }, readFile),
    /no longer available/,
  )
})

test('prepareHttpRequest leaves content-type unset for form-data so the runtime sets the boundary', () => {
  const request = prepareHttpRequest({ method: 'POST', url: 'https://api.example.com/upload', bodyMode: 'form-data', body: { title: 'x' } })
  const headers = request.init.headers as Record<string, string>
  assert.ok(!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type'))
  assert.ok(request.init.body instanceof FormData)
})

// ── Binding an upstream file to a form field ───────────────────────────────

test('bindFormFiles merges a resolved file reference into the form-data body', () => {
  const result = bindFormFiles({ title: 'Q3' }, [{ field: 'document', source: 'step.download.output' }], () => fileRef())
  assert.ok('body' in result)
  assert.deepEqual(result.body, { title: 'Q3', document: fileRef() })
  assert.equal(bodyHasFileReference(result.body), true)
})

test('bindFormFiles accepts an empty body, a step envelope, and a list of files', () => {
  const wrapped = bindFormFiles(undefined, [{ field: 'f', source: 'step.a.output' }], () => ({ output: fileRef() }))
  assert.ok('body' in wrapped && 'f' in wrapped.body)

  const list = bindFormFiles({}, [{ field: 'f', source: 'step.a.output' }], () => [fileRef(), fileRef({ fileId: 'file_2' })])
  assert.ok('body' in list)
  assert.equal((list.body.f as unknown[]).length, 2)
})

test('bindFormFiles rejects a binding that resolves to no file', () => {
  const missing = bindFormFiles({}, [{ field: 'document', source: 'step.a.output' }], () => undefined)
  assert.ok('error' in missing && /not there/.test(missing.error))

  const notAFile = bindFormFiles({}, [{ field: 'document', source: 'step.a.output' }], () => 'just some text')
  assert.ok('error' in notAFile)
})

test('bindFormFiles rejects a body that is not a field object, and an unnamed field', () => {
  const raw = bindFormFiles('plain text body', [{ field: 'f', source: 'step.a.output' }], () => fileRef())
  assert.ok('error' in raw && /JSON object/.test(raw.error))

  const unnamed = bindFormFiles({}, [{ field: '  ', source: 'step.a.output' }], () => fileRef())
  assert.ok('error' in unnamed && /form field name/.test(unnamed.error))
})

// ── End to end through the interpreter ─────────────────────────────────────

function uploadGraph(formFiles: { field: string; source: string }[]): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'download', type: 'http', data: { method: 'GET', url: 'https://api.example.com/doc', responseType: 'file' } },
      {
        id: 'upload',
        type: 'http',
        data: {
          method: 'POST',
          url: 'https://api.example.com/upload',
          bodyMode: 'form-data',
          body: '{"title":"Q3 invoice"}',
          formFiles,
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'download' },
      { id: 'e2', source: 'download', target: 'upload' },
    ],
  }
}

test('the interpreter binds an upstream file into the form-data body it hands the adapter', async () => {
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    if (node.id === 'download') return { output: fileRef() }
    return { output: { ok: true } }
  }
  const result = await interpretFlow(uploadGraph([{ field: 'document', source: 'step.download.output' }]), {}, {
    runAgent: async () => ({ output: '' }),
    runAction,
  })
  assert.equal(result.status, 'succeeded')
  const uploadConfig = calls[1]
  assert.deepEqual(uploadConfig.body, { title: 'Q3 invoice', document: fileRef() })
  assert.equal(bodyHasFileReference(uploadConfig.body), true)

  // …and that body produces the real binary part downstream.
  const { body } = await wire(await buildMultipartBody(uploadConfig.body, readFile))
  assert.match(body, /name="document"; filename="invoice\.pdf"/i)
  assert.match(body, /name="title"/)
})

test('a file binding that resolves to nothing fails the step instead of posting without the file', async () => {
  const runAction: RunActionFn = async (node) => (node.id === 'download' ? { output: { note: 'no file here' } } : { output: { ok: true } })
  const result = await interpretFlow(uploadGraph([{ field: 'document', source: 'step.download.output' }]), {}, {
    runAgent: async () => ({ output: '' }),
    runAction,
  })
  assert.equal(result.status, 'failed')
  assert.match(String(result.error), /document/)
})

test('text-only form-data steps are untouched by the file path', async () => {
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: { ok: true } }
  }
  const graph = uploadGraph([])
  const result = await interpretFlow(graph, {}, { runAgent: async () => ({ output: '' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[1].body, { title: 'Q3 invoice' })
})
