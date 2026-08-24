/**
 * The load test that actually decides whether 1,000 concurrent users work.
 *
 * The other two scripts in this directory drive the PUBLIC API with a bearer
 * key. That is not the load that breaks first. At 1,000 concurrent sessions the
 * dominant traffic is the app shell polling `/api/snapshot` every 8 seconds —
 * one authenticated request per user per cycle, each paying a full auth
 * resolution plus eight parallel queries. ~125 req/s of it, from people who are
 * doing nothing but having the tab open.
 *
 * So this script drives SESSION traffic, not API-key traffic, and it drives it
 * through the same door a browser would: a real Supabase session cookie.
 *
 * ── Why multiple accounts are mandatory, not a nicety ──────────────────────
 * `/api/snapshot` is cached per (organization, user). Pointing 1,000 VUs at one
 * account would return a ~100% cache hit rate and report a latency profile that
 * no real deployment will ever see — the test would "pass" by measuring Redis
 * instead of Postgres. LOAD_TEST_ACCOUNTS therefore takes a LIST, and the run
 * refuses to start if the list is too thin to be honest about it (see below).
 *
 * ── What it measures ──────────────────────────────────────────────────────
 *   snapshot_304          share of polls answered from ETag revalidation. This
 *                         is the headline number: every 304 is a poll that cost
 *                         no serialization and no payload.
 *   snapshot_bytes        response size. The pre-diet shell returned up to 300
 *                         FULL agent rows per poll; the trend shows the diet.
 *   server_errors         5xx rate. Thresholds fail the run, they don't warn.
 *   throttled             429s. NOT an error — under backpressure a 429 with
 *                         Retry-After is the CORRECT answer and the run should
 *                         still pass. Counted separately so the difference
 *                         between "shed load deliberately" and "fell over" is
 *                         visible rather than averaged away.
 *
 * ── Running it ────────────────────────────────────────────────────────────
 *   BASE_URL=https://staging.example.com \
 *   SUPABASE_URL=https://ref.supabase.co SUPABASE_ANON_KEY=... \
 *   LOAD_TEST_ACCOUNTS='[{"email":"a@x.com","password":"..."}, ...]' \
 *   k6 run scripts/load/shell-poll.js
 *
 * Stage it: LOAD_STAGE=100, then 400, then 1000. Do not jump straight to 1000 —
 * the point is to find WHERE the knee is, and a single run at the target tells
 * you only that it broke, not when.
 *
 * Never point this at production.
 */
import http from 'k6/http'
import encoding from 'k6/encoding'
import { check, sleep, fail } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/$/, '')
const SUPABASE_URL = (__ENV.SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_ANON_KEY = __ENV.SUPABASE_ANON_KEY || ''
const TARGET_VUS = Number(__ENV.LOAD_STAGE || 100)
/** Matches SNAPSHOT_POLL_MS in src/lib/client/snapshot.ts. */
const POLL_SECONDS = Number(__ENV.POLL_SECONDS || 8)

if (!BASE_URL || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('BASE_URL, SUPABASE_URL and SUPABASE_ANON_KEY are required')
}
if (/(^|\.)prod|www\./i.test(BASE_URL) && __ENV.I_MEAN_IT !== 'yes') {
  throw new Error(`${BASE_URL} looks like production. Set I_MEAN_IT=yes only if it genuinely is not.`)
}

const snapshot304 = new Rate('snapshot_304')
const snapshotBytes = new Trend('snapshot_bytes')
const serverErrors = new Rate('server_errors')
const throttled = new Counter('throttled')

export const options = {
  scenarios: {
    // The shell poll: every user, all the time. This is the load under test.
    shell: {
      executor: 'ramping-vus',
      exec: 'shellPoll',
      startVUs: 0,
      stages: [
        { duration: '2m', target: TARGET_VUS },  // ramp — a cliff here is a cold-start problem, not a capacity one
        { duration: '5m', target: TARGET_VUS },  // hold — the only segment whose numbers mean anything
        { duration: '1m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
    // A burst of executions ON TOP of the steady poll load. Run capacity and
    // read capacity contend for the same connection pool, so testing either
    // alone measures a machine that does not exist.
    burst: {
      executor: 'constant-arrival-rate',
      exec: 'startRun',
      rate: Number(__ENV.RUNS_PER_SECOND || Math.max(1, Math.round(TARGET_VUS / 50))),
      timeUnit: '1s',
      duration: '5m',
      startTime: '2m',
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
  },
  thresholds: {
    server_errors: ['rate<0.01'],
    'http_req_duration{endpoint:snapshot}': ['p(95)<400', 'p(99)<1000'],
    'http_req_failed{endpoint:snapshot}': ['rate<0.02'],
  },
  // Percentiles, not just averages: an average hides the exact tail that a
  // pooled-connection ceiling produces.
  summaryTrendStats: ['avg', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
}

/** Mirrors MAX_CHUNK_SIZE / BASE64_PREFIX in @supabase/ssr. See e2e/support/session.ts. */
const MAX_CHUNK_SIZE = 3180
const BASE64_PREFIX = 'base64-'

function cookieName() {
  // `sb-<project-ref>-auth-token` — the ref is the first hostname label.
  const host = SUPABASE_URL.replace(/^https?:\/\//, '').split('/')[0]
  return `sb-${host.split('.')[0]}-auth-token`
}

/** Serialize a session into the exact cookie header @supabase/ssr would write. */
function cookieHeader(session) {
  const name = cookieName()
  const value = BASE64_PREFIX + encoding.b64encode(JSON.stringify(session), 'rawurl')
  if (value.length <= MAX_CHUNK_SIZE) return `${name}=${value}`
  const parts = []
  for (let i = 0; i * MAX_CHUNK_SIZE < value.length; i += 1) {
    parts.push(`${name}.${i}=${value.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE)}`)
  }
  return parts.join('; ')
}

function parseAccounts() {
  const raw = (__ENV.LOAD_TEST_ACCOUNTS || '').trim()
  if (!raw) fail('LOAD_TEST_ACCOUNTS is required: a JSON array of {email, password}.')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    fail(`LOAD_TEST_ACCOUNTS is not valid JSON: ${error.message}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) fail('LOAD_TEST_ACCOUNTS must be a non-empty JSON array.')
  return parsed
}

export function setup() {
  const accounts = parseAccounts()
  // Refuse a dishonest run rather than produce a flattering number. One account
  // per 50 VUs keeps per-(org,user) cache hits near what a real population
  // produces; below that the snapshot cache answers nearly everything and the
  // database is never actually asked the question this test exists to ask.
  const minimum = Math.max(1, Math.ceil(TARGET_VUS / 50))
  if (accounts.length < minimum && __ENV.ALLOW_THIN_ACCOUNT_POOL !== 'yes') {
    fail(
      `${accounts.length} account(s) for ${TARGET_VUS} VUs will measure the snapshot cache, not the database. ` +
        `Supply at least ${minimum}, or set ALLOW_THIN_ACCOUNT_POOL=yes to accept a cache-warm run deliberately.`,
    )
  }

  const sessions = []
  for (const account of accounts) {
    const response = http.post(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      JSON.stringify({ email: account.email, password: account.password }),
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'content-type': 'application/json' } },
    )
    if (response.status !== 200) {
      // Named, because "sign-in failed" across 20 accounts is unactionable.
      fail(`Password grant failed for ${account.email} (${response.status}): ${response.body}`)
    }
    const session = response.json()
    sessions.push({ cookie: cookieHeader(session), flowId: account.flowId || null })
  }
  return { sessions }
}

/** ETag per VU, so a VU revalidates its OWN last response the way a browser does. */
let etag = null

export function shellPoll(data) {
  const session = data.sessions[(__VU - 1) % data.sessions.length]
  const headers = { Cookie: session.cookie }
  if (etag) headers['If-None-Match'] = etag

  const response = http.get(`${BASE_URL}/api/snapshot`, { headers, tags: { endpoint: 'snapshot' } })

  if (response.status === 429) throttled.add(1)
  serverErrors.add(response.status >= 500)
  snapshot304.add(response.status === 304)
  snapshotBytes.add(response.body ? response.body.length : 0)
  if (response.headers.Etag) etag = response.headers.Etag

  check(response, {
    'snapshot served or revalidated': (r) => r.status === 200 || r.status === 304 || r.status === 429,
  })
  sleep(POLL_SECONDS)
}

export function startRun(data) {
  const session = data.sessions[Math.floor(Math.random() * data.sessions.length)]
  if (!session.flowId) return
  const response = http.post(
    `${BASE_URL}/api/flows/${session.flowId}/execute`,
    JSON.stringify({ input: { loadTest: true } }),
    { headers: { Cookie: session.cookie, 'content-type': 'application/json' }, tags: { endpoint: 'execute' }, timeout: '60s' },
  )
  if (response.status === 429) throttled.add(1)
  serverErrors.add(response.status >= 500)
  check(response, { 'run accepted or throttled': (r) => [200, 202, 429].includes(r.status) })
}
