import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { flowGraphSchema } from '@/lib/flows/graph'
import { portableFlowGraph } from '@/lib/flows/native-package'
import { REDACTED } from '@/lib/logging/redact'

/**
 * The gap these guard was never "someone forgot to redact four fields". It was
 * that redaction was written as an allowlist — `http` nodes, `headers` only —
 * so every node type added afterwards started unprotected and stayed that way,
 * and nothing failed when it did.
 *
 * Enumerating today's twenty-two node types here would rebuild the same trap.
 * So these tests derive the node list FROM THE SCHEMA and assert the property
 * holds for each one. A twenty-third node type is covered on the day it is
 * added, or these fail.
 */

const SRC = path.join(process.cwd(), 'src')

/** Every `type: z.literal('x')` the graph schema accepts. */
function declaredNodeTypes(): string[] {
  const source = readFileSync(path.join(SRC, 'lib', 'flows', 'graph.ts'), 'utf8')
  const types = [...source.matchAll(/type:\s*z\.literal\('([a-zA-Z]+)'\)/g)].map((match) => match[1])
  return [...new Set(types)]
}

test('the schema still declares the node types this guard reads', () => {
  // If the schema is refactored so the regex finds nothing, every test below
  // would vacuously pass. Fail loudly instead.
  const types = declaredNodeTypes()
  assert.ok(types.length >= 15, `expected many node types, found ${types.length}`)
  assert.ok(types.includes('http') && types.includes('code'))
})

test('EVERY node type has its literal credentials stripped on export', () => {
  const secret = ['sk', 'ant', 'api03', 'Z'.repeat(24)].join('-')

  for (const type of declaredNodeTypes()) {
    // A node of this type carrying a secret in a plausibly-named free-text
    // field. The graph schema is strict per type, so the node is built loosely
    // and the redactor is exercised directly on the shape export uses.
    const graph = {
      nodes: [
        {
          id: 'n1',
          type,
          position: { x: 0, y: 0 },
          data: { label: 'step', apiKey: secret, note: `calls with ${secret}` },
        },
      ],
      edges: [],
    }

    const exported = portableFlowGraph(graph as unknown as Parameters<typeof portableFlowGraph>[0])
    const serialized = JSON.stringify(exported)

    assert.ok(
      !serialized.includes(secret),
      `node type "${type}" exports a literal credential — portableFlowGraph must cover every type, not an allowlist`,
    )
    assert.ok(serialized.includes(REDACTED), `node type "${type}" should mark what was removed`)
  }
})

test('export keeps template references for every node type', () => {
  // The other half of the property. A redactor that eats `{{credentials.x}}`
  // makes exports useless and pushes authors back to literals.
  for (const type of declaredNodeTypes()) {
    const graph = {
      nodes: [{ id: 'n1', type, position: { x: 0, y: 0 }, data: { apiKey: '{{credentials.token}}' } }],
      edges: [],
    }
    const serialized = JSON.stringify(portableFlowGraph(graph as unknown as Parameters<typeof portableFlowGraph>[0]))
    assert.ok(
      serialized.includes('{{credentials.token}}'),
      `node type "${type}" lost a template reference on export`,
    )
  }
})

test('the graph schema itself is what export redacts — no second node list exists', () => {
  // A separate hand-maintained list of "node types that need redacting" is the
  // exact shape of the original bug. Assert none was introduced.
  const source = readFileSync(path.join(SRC, 'lib', 'flows', 'native-package.ts'), 'utf8')
  assert.ok(
    !/node\.type\s*===\s*'/.test(source),
    'native-package.ts branches on a specific node type again — redaction must apply to every node',
  )
})

test('run-data redaction covers every persisted free-text column on the run models', () => {
  // Derived from the Prisma schema rather than restated: a new Json column on
  // FlowRunStep holding third-party data is exactly the thing that would be
  // added later and silently persist secrets.
  const schema = readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8')
  const guard = readFileSync(path.join(SRC, 'lib', 'flows', 'run-data-guard.ts'), 'utf8')

  const block = schema.slice(schema.indexOf('model FlowRunStep'))
  const body = block.slice(0, block.indexOf('\n}'))

  const jsonColumns = [...body.matchAll(/^\s{2}(\w+)\s+Json/gm)].map((match) => match[1])
  const uncovered = jsonColumns.filter((column) => !guard.includes(`'${column}'`))

  assert.deepEqual(
    uncovered,
    [],
    `FlowRunStep has Json column(s) not listed in REDACTED_WRITE_FIELDS: ${uncovered.join(', ')}. ` +
      'Add them, or document why their contents can never carry a credential.',
  )
})

test('the redaction guard is wired into the Prisma client, not merely exported', () => {
  // The module could be perfect and unreferenced. This is the one assertion
  // that proves run data actually passes through it.
  const prismaSource = readFileSync(path.join(SRC, 'lib', 'prisma.ts'), 'utf8')

  assert.ok(prismaSource.includes('applyRunDataRedaction('), 'run-data redaction is not applied in the Prisma extension')
  assert.ok(prismaSource.includes('applyFlowSecretScan('), 'flow secret scanning is not applied in the Prisma extension')
})
