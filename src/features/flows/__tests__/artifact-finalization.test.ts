import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('artifact validation precedes the atomic terminal transaction and errors are not swallowed', () => {
  const source = readFileSync('src/features/flows/finalize-flow-run.ts', 'utf8')
  assert.ok(source.indexOf('await prepareFlowArtifactVersion(') < source.indexOf('tenantTransaction(job.organizationId'))
  assert.match(source, /await publish\(tx\)/)
  assert.match(source, /publicationFailed\(publicationError\)/)
  assert.doesNotMatch(source, /registerVersionFromFlowRun|catch\(\(\) => null\)/)
})

test('prepared flow publications use the caller transaction and validate before it', () => {
  const source = readFileSync('src/lib/artifacts/service.ts', 'utf8').split('export async function prepareFlowArtifactVersion')[1].split('/** The first HTML')[0]
  assert.ok(source.indexOf('await validateArtifactRuntime(html)') < source.indexOf('return async tx'))
  assert.match(source, /insertValidatedVersion\(tx,/)
  assert.match(source, /if \(existing\) return existing.id/)
  assert.match(source, /if \(!html\) throw new Error/)
})
