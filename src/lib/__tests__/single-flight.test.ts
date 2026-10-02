import test from 'node:test'
import assert from 'node:assert/strict'
import { singleFlight } from '../single-flight'

test('concurrent reads share work; settled values and failures are not retained', async () => {
  const once = singleFlight<number>()
  let calls = 0
  let finish!: (n: number) => void
  const load = () => { calls++; return new Promise<number>(resolve => { finish = resolve }) }
  const a = once('org:a', load)
  const b = once('org:a', load)
  await Promise.resolve()
  assert.equal(calls, 1)
  finish(42)
  assert.deepEqual(await Promise.all([a, b]), [42, 42])
  assert.equal(await once('org:a', async () => 43), 43)
  await assert.rejects(once('org:a', async () => { throw Error('retry me') }), /retry me/)
  assert.equal(await once('org:a', async () => 44), 44)
})

test('different scope keys never share results', async () => {
  const once = singleFlight<number>()
  assert.deepEqual(await Promise.all([once('org:a', async () => 1), once('org:b', async () => 2)]), [1, 2])
})
