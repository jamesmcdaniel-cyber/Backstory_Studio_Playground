/**
 * The HTTP step's two file paths, end to end through the executor:
 *
 * - UPLOAD: a form-data field bound to a file that can no longer be read must
 *   FAIL the step. The hand-rolled multipart loop this replaced skipped the
 *   part instead — posting the request without its attachment and reporting
 *   success.
 * - DOWNLOAD: fetching a file whose text cannot be extracted (a corrupt or
 *   password-protected DOCX) still succeeds — the bytes were stored correctly,
 *   which is the step's job. Knowledge ingestion, whose whole product IS the
 *   text, still rejects the same file loudly.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { enterTestTenant } from '@/lib/server/__tests__/test-tenant'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let runFlowExecution: any
  let saveStoredFile: any
  let readStoredFile: any
  let ingestKnowledgeFile: any
  let setSsrfResolver: any
  let encryptSecret: any
  let clearPins: any
  const ids: Record<string, string> = {}
  const realFetch = globalThis.fetch

  const position = { x: 0, y: 0 }
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  // A file that claims to be a DOCX and starts like a ZIP, but whose archive is
  // truncated garbage — exactly what a corrupt or password-protected upload
  // looks like to the reader.
  const brokenDocx = Buffer.concat([Buffer.from('PK'), Buffer.from('not a real archive at all')])

  const uploadGraph = (body: unknown) => ({
    nodes: [
      { id: 'trigger', type: 'trigger', position, data: { trigger: { type: 'manual' } } },
      {
        id: 'upload',
        type: 'http',
        position,
        data: {
          method: 'POST',
          url: 'https://files.example.com/upload',
          bodyMode: 'form-data',
          body: JSON.stringify(body),
          credentialId: ids.credential,
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'upload' }],
  })
  const downloadGraph = () => ({
    nodes: [
      { id: 'trigger', type: 'trigger', position, data: { trigger: { type: 'manual' } } },
      {
        id: 'get',
        type: 'http',
        position,
        data: { method: 'GET', url: 'https://files.example.com/report.docx', responseType: 'file', credentialId: ids.credential },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'get' }],
  })

  const stepRow = async (runId: string, nodeId: string) =>
    prisma.flowRunStep.findFirst({ where: { flowRunId: runId, nodeId }, orderBy: { order: 'desc' } })

  const makeFlow = async (graph: unknown, name: string) => {
    const flow = await prisma.flow.create({
      data: { name, organizationId: ids.org, status: 'ACTIVE', graph, publishedGraph: graph },
    })
    return flow.id
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('../execute-flow'))
    ;({ saveStoredFile, readStoredFile } = await import('@/lib/files/storage'))
    ;({ ingestKnowledgeFile } = await import('@/lib/knowledge/ingest'))
    ;({ encryptSecret } = await import('@/lib/crypto/secrets'))
    const ssrf = await import('@/lib/net/ssrf')
    setSsrfResolver = ssrf.__setSsrfResolver
    clearPins = ssrf.clearPins
    // Hosts resolve from a table rather than real DNS: the file host is public,
    // the metadata host is link-local (what a redirect attack aims at). Nothing
    // is dialled — fetch is stubbed.
    setSsrfResolver(async (host: string) => [
      { address: host === 'metadata.example.com' ? '169.254.169.254' : '93.184.216.34', family: 4 as const },
    ])
    const org = await prisma.organization.create({ data: { name: 'FileSteps', slug: `file-steps-${Date.now()}` } })
    ids.org = org.id
    // Operate as this tenant for the rest of the file, exactly as the flow
    // engine and the API wrapper do in production. Parent-scoped rows
    // (flow_run_steps) are tenanted through their run, so under RLS a read
    // with no tenant matches nothing and returns [] without an error.
    enterTestTenant(org.id)
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
    // Every HTTP step must authenticate (validation refuses zero-auth requests),
    // so the steps under test carry a plain header credential.
    const credential = await prisma.httpCredential.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        name: 'files.example.com key',
        authType: 'header',
        allowedHost: 'files.example.com',
        secretConfig: encryptSecret(JSON.stringify({ name: 'x-api-key', value: 'k' })),
      },
    })
    ids.credential = credential.id
  })

  after(async () => {
    globalThis.fetch = realFetch
    setSsrfResolver(null)
    clearPins()
    await prisma.flowRunStep.deleteMany({ where: { run: { organizationId: ids.org } } })
    await prisma.flowRun.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.knowledgeChunk.deleteMany({ where: { organizationId: ids.org } })
    await prisma.knowledgeDocument.deleteMany({ where: { organizationId: ids.org } })
    await prisma.storedFile.deleteMany({ where: { organizationId: ids.org } })
    await prisma.httpCredential.deleteMany({ where: { organizationId: ids.org } })
    await prisma.user.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('an unreadable referenced file fails the step instead of posting without the attachment', async () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const flowId = await makeFlow(
      uploadGraph({
        title: 'Q3',
        document: { fileId: 'file_that_is_gone', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 4, url: '/api/files/file_that_is_gone' },
      }),
      'upload-missing-file',
    )
    const result = await runFlowExecution({ flowId, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(result.status, 'failed')
    const step = await stepRow(result.flowRunId, 'upload')
    assert.equal(step.status, 'failed')
    assert.match(step.error, /invoice\.pdf/)
    assert.match(step.error, /no longer available/)
    // The whole point: nothing was sent. A partial upload reported as success
    // is worse than a failed step.
    assert.equal(requests, 0)
  })

  test('a readable referenced file is sent as a real binary part', async () => {
    const saved = await saveStoredFile({
      organizationId: ids.org,
      userId: ids.user,
      filename: 'rows.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('id,name\n1,ada'),
    })
    let sentBody = ''
    let sentContentType = ''
    globalThis.fetch = (async (_url: string, init: any) => {
      const echo = new Response(init.body)
      sentContentType = echo.headers.get('content-type') ?? ''
      sentBody = await echo.text()
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const flowId = await makeFlow(
      uploadGraph({
        title: 'Q3',
        document: { fileId: saved.id, filename: 'rows.csv', mimeType: 'text/csv', size: saved.size, url: `/api/files/${saved.id}` },
      }),
      'upload-real-file',
    )
    const result = await runFlowExecution({ flowId, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(result.status, 'succeeded')
    assert.match(sentContentType, /^multipart\/form-data; boundary=/)
    assert.match(sentBody, /name="document"; filename="rows\.csv"/i)
    assert.match(sentBody, /id,name/)
    assert.match(sentBody, /name="title"/)
  })

  test('downloading a file whose text cannot be extracted still stores it and succeeds', async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(brokenDocx), {
        status: 200,
        headers: { 'content-type': DOCX_MIME, 'content-disposition': 'attachment; filename="broken.docx"' },
      })) as unknown as typeof fetch
    const flowId = await makeFlow(downloadGraph(), 'download-broken-docx')
    const result = await runFlowExecution({ flowId, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(result.status, 'succeeded')
    const step = await stepRow(result.flowRunId, 'get')
    assert.equal(step.status, 'succeeded')
    const output = step.output as { fileId: string; filename: string; content?: string }
    assert.equal(output.filename, 'broken.docx')
    // Extraction failed, so there is no text — but the FILE is stored intact.
    assert.equal(output.content ?? '', '')
    const stored = await readStoredFile(output.fileId, ids.org)
    assert.ok(stored)
    assert.deepEqual(Buffer.from(stored.buffer), brokenDocx)
  })

  test('knowledge ingestion of the same file still rejects loudly', async () => {
    await assert.rejects(
      () =>
        ingestKnowledgeFile({
          organizationId: ids.org,
          agentId: null,
          userId: ids.user,
          filename: 'broken.docx',
          mimeType: DOCX_MIME,
          buffer: brokenDocx,
        }),
      (error: any) => /docx|document|read/i.test(error.message),
    )
    assert.equal(await prisma.knowledgeDocument.count({ where: { organizationId: ids.org } }), 0)
  })

  test('a step whose target redirects to a private address fails instead of following the hop', async () => {
    const dialled: string[] = []
    globalThis.fetch = (async (url: string) => {
      dialled.push(String(url))
      return new Response('', { status: 302, headers: { location: 'https://metadata.example.com/latest/meta-data/' } })
    }) as unknown as typeof fetch
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', position, data: { trigger: { type: 'manual' } } },
        {
          id: 'call',
          type: 'http',
          position,
          data: { method: 'GET', url: 'https://files.example.com/go', followRedirects: true, credentialId: ids.credential },
        },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'call' }],
    }
    const flowId = await makeFlow(graph, 'redirect-to-metadata')
    const result = await runFlowExecution({ flowId, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(result.status, 'failed')
    const step = await stepRow(result.flowRunId, 'call')
    // The step refuses the hop rather than following it. (The message is the
    // guard's "redirects are not allowed" rather than "private address" because
    // the interpreter does not currently forward the node's followRedirects
    // setting to the adapter — see the redirect-chain tests in
    // http-redirect-ssrf.test.ts for the per-hop validation itself.)
    assert.match(step.error, /not allowed|private or reserved address/)
    // Only the first (public) hop was ever requested — the link-local address
    // in the Location header is never dialled.
    assert.deepEqual(dialled, ['https://files.example.com/go'])
  })
}
