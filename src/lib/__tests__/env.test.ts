import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

async function freshEnv() {
  const mod = await import(`../env?t=${Date.now()}-${Math.random()}`)
  return mod as typeof import('../env')
}

const ORIGINAL_ENV = { ...process.env }

// Next's types mark NODE_ENV readonly; tests legitimately vary it.
function setNodeEnv(value: string) {
  Object.assign(process.env, { NODE_ENV: value })
}

const FULL_PROD_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@h:6543/db',
  DIRECT_URL: 'postgresql://u:p@h:5432/db',
  NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  ENCRYPTION_KEY: 'k',
  ANTHROPIC_API_KEY: 'sk-ant-x',
  REDIS_URL: 'redis://localhost:6379',
  FILE_SCAN_URL: 'https://scanner.example.test/scan',
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

test('production with everything set: does not throw', async () => {
  Object.assign(process.env, FULL_PROD_ENV)
  const { assertServerEnv } = await freshEnv()
  assert.doesNotThrow(() => assertServerEnv())
})

test('production with missing vars: throws listing every missing name', async () => {
  Object.assign(process.env, FULL_PROD_ENV)
  delete process.env.DATABASE_URL
  delete process.env.ENCRYPTION_KEY
  const { assertServerEnv } = await freshEnv()
  assert.throws(
    () => assertServerEnv(),
    (error: Error) =>
      error.message.includes('DATABASE_URL') && error.message.includes('ENCRYPTION_KEY'),
  )
})

test('production with only QWEN_API_KEY as model key: passes', async () => {
  Object.assign(process.env, FULL_PROD_ENV)
  delete process.env.ANTHROPIC_API_KEY
  process.env.QWEN_API_KEY = 'sk-qwen-x'
  const { assertServerEnv } = await freshEnv()
  assert.doesNotThrow(() => assertServerEnv())
})

test('production with no model key: throws mentioning both options', async () => {
  Object.assign(process.env, FULL_PROD_ENV)
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.QWEN_API_KEY
  const { assertServerEnv } = await freshEnv()
  assert.throws(
    () => assertServerEnv(),
    (error: Error) =>
      error.message.includes('ANTHROPIC_API_KEY') && error.message.includes('QWEN_API_KEY'),
  )
})

test('development with nothing set: does not throw (dev ergonomics)', async () => {
  setNodeEnv('development')
  for (const key of Object.keys(FULL_PROD_ENV)) {
    if (key !== 'NODE_ENV') delete process.env[key]
  }
  const { assertServerEnv } = await freshEnv()
  assert.doesNotThrow(() => assertServerEnv())
})
