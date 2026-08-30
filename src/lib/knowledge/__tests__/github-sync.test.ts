import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeGitHubBlob,
  GITHUB_SYNC_MAX_FILE_BYTES,
  GitHubSyncInputError,
  normalizeGitHubPathPrefix,
  normalizeGitHubRef,
  planGitHubTree,
} from '../github-sync'

const blob = (path: string, size: number) => ({ path, size, type: 'blob' as const, sha: path.padEnd(40, 'a').slice(0, 40) })

test('GitHub sync planning retains readable source files while bounding and classifying skips', () => {
  const plan = planGitHubTree([
    blob('README.md', 100),
    blob('src/index.ts', 200),
    blob('.env', 20),
    blob('node_modules/pkg/index.js', 30),
    blob('diagram.png', 40),
    blob('docs/huge.md', GITHUB_SYNC_MAX_FILE_BYTES + 1),
    blob('empty.txt', 0),
  ], 1)

  assert.deepEqual(plan.selected.map((entry) => entry.path), ['README.md'])
  assert.deepEqual([...plan.retainedPaths], ['README.md', 'src/index.ts'])
  assert.equal(plan.skipped.sensitive_path, 1)
  assert.equal(plan.skipped.generated_or_dependency_path, 1)
  assert.equal(plan.skipped.unsupported_type, 1)
  assert.equal(plan.skipped.file_too_large, 1)
  assert.equal(plan.skipped.empty_or_unknown_size, 1)
  assert.equal(plan.skipped.file_limit, 1)
})

test('GitHub path prefixes are repository-relative and reject traversal', () => {
  assert.equal(normalizeGitHubPathPrefix('/docs/reference/'), 'docs/reference')
  assert.throws(() => normalizeGitHubPathPrefix('../private'), GitHubSyncInputError)
  assert.throws(() => normalizeGitHubPathPrefix('docs\\private'), GitHubSyncInputError)
  assert.equal(normalizeGitHubRef('feature/repository-sync'), 'feature/repository-sync')
  assert.throws(() => normalizeGitHubRef('../private'), GitHubSyncInputError)
})

test('GitHub blob decoding accepts UTF-8 and blocks binary or credential-bearing content', () => {
  const payload = (content: string | Buffer) => ({
    encoding: 'base64',
    content: Buffer.from(content).toString('base64'),
  })
  assert.equal(decodeGitHubBlob(payload('# Project\nReadable reference.')), '# Project\nReadable reference.')
  assert.throws(() => decodeGitHubBlob(payload(Buffer.from([1, 0, 2]))), GitHubSyncInputError)
  assert.throws(
    () => decodeGitHubBlob(payload(`token = ghp_${'A'.repeat(30)}`)),
    GitHubSyncInputError,
  )
})
