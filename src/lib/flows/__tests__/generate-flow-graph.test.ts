import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGeneratedGraphReply } from '@/lib/flows/generate-flow-graph'
import { normalizeGeneratedFlowGraphInput } from '@/lib/flows/copilot'
import { flowGraphSchema } from '@/lib/flows/graph'

/**
 * The LLM → graph seam. The model is asked for the whole graph as a JSON STRING
 * inside a wrapper object, which means every real-world model quirk — fences,
 * a graph returned unwrapped, a truncated reply — lands here first.
 *
 * The whole pipeline the generator runs is
 *   flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(parseGeneratedGraphReply(raw)))
 * so these assert on that composition, not on the unwrapping alone.
 */

const GRAPH = {
  nodes: [{ id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { kind: 'manual' } }],
  edges: [],
}

const pipeline = (raw: string) => flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(parseGeneratedGraphReply(raw)))

test('the wrapped graph string is unwrapped', () => {
  assert.deepEqual(parseGeneratedGraphReply(JSON.stringify({ graphJson: JSON.stringify(GRAPH) })), GRAPH)
})

test('a fenced graph string is unwrapped', () => {
  for (const fence of ['```json\n', '```JSON\n', '```\n']) {
    const raw = JSON.stringify({ graphJson: `${fence}${JSON.stringify(GRAPH)}\n\`\`\`` })
    assert.deepEqual(parseGeneratedGraphReply(raw), GRAPH, fence)
  }
})

test('leading and trailing whitespace around the wrapped string is tolerated', () => {
  const raw = JSON.stringify({ graphJson: `\n\n  ${JSON.stringify(GRAPH)}  \n` })
  assert.deepEqual(parseGeneratedGraphReply(raw), GRAPH)
})

test('a model that returns the graph unwrapped is still accepted', () => {
  // No graphJson key: the outer object IS the graph.
  assert.deepEqual(parseGeneratedGraphReply(JSON.stringify(GRAPH)), GRAPH)
})

test('a graph nested as an object rather than a string falls back to the outer reply', () => {
  const raw = JSON.stringify({ graphJson: GRAPH })
  assert.deepEqual(parseGeneratedGraphReply(raw), { graphJson: GRAPH })
})

// ── malformed replies ─────────────────────────────────────────────────────────

test('a truncated reply is rejected, not half-applied', () => {
  const truncated = JSON.stringify({ graphJson: JSON.stringify(GRAPH) }).slice(0, 60)
  assert.throws(() => parseGeneratedGraphReply(truncated), SyntaxError)
})

test('a truncated INNER graph string is rejected', () => {
  const raw = JSON.stringify({ graphJson: '{"nodes":[{"id":"n1","type":"trig' })
  assert.throws(() => parseGeneratedGraphReply(raw), SyntaxError)
})

test('prose instead of JSON is rejected', () => {
  for (const raw of ['', 'I could not build that flow.', 'null-ish', '<html>error</html>']) {
    assert.throws(() => parseGeneratedGraphReply(raw), SyntaxError, JSON.stringify(raw))
  }
})

test('a fenced reply whose fence contains prose is rejected rather than silently emptied', () => {
  const raw = JSON.stringify({ graphJson: '```json\nsorry, no graph\n```' })
  assert.throws(() => parseGeneratedGraphReply(raw), SyntaxError)
})

test('a JSON reply that is not a graph fails the schema rather than shipping an empty flow', () => {
  for (const payload of ['null', '"a string"', '42', '[]', '{}', '{"graphJson":"{}"}', '{"graphJson":"[]"}']) {
    assert.throws(() => pipeline(payload), `${payload} should not produce a graph`)
  }
})

test('a graph with nodes but no edges array fails the schema', () => {
  const raw = JSON.stringify({ graphJson: JSON.stringify({ nodes: GRAPH.nodes }) })
  assert.throws(() => pipeline(raw))
})

test('a graph whose node has an unknown type fails the schema', () => {
  const raw = JSON.stringify({
    graphJson: JSON.stringify({
      nodes: [{ id: 'n1', type: 'teleport', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    }),
  })
  assert.throws(() => pipeline(raw))
})

test('a well-formed reply survives the whole unwrap → normalize → parse pipeline', () => {
  const graph = pipeline(JSON.stringify({ graphJson: JSON.stringify(GRAPH) }))
  assert.deepEqual(graph.nodes.map((node) => node.id), ['n1'])
  assert.deepEqual(graph.edges, [])
})

test('a numeric branch label on an edge is coerced before the schema sees it', () => {
  const raw = JSON.stringify({
    graphJson: JSON.stringify({
      nodes: [
        { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { kind: 'manual' } },
        { id: 'n2', type: 'agent', position: { x: 0, y: 100 }, data: { agentId: '', prompt: 'go' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', branch: 1 }],
    }),
  })
  const graph = pipeline(raw)
  assert.equal(graph.edges[0].branch, '1')
})

test.skip('generateFlowGraph end-to-end (grounding + up to 2 repair rounds) — needs a database for the org roster and a model runner seam', () => {})
