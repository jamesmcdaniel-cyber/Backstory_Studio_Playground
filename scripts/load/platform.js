import http from 'k6/http'
import { check, sleep } from 'k6'

const base = __ENV.BASE_URL
const key = __ENV.BACKSTORY_API_KEY
if (!base || !key) throw new Error('BASE_URL and BACKSTORY_API_KEY are required')

export const options = {
  scenarios: {
    api_reads: { executor: 'ramping-vus', exec: 'reads', stages: [{ duration: '1m', target: 25 }, { duration: '3m', target: 100 }, { duration: '1m', target: 0 }] },
    flow_runs: { executor: 'constant-arrival-rate', exec: 'runs', rate: Number(__ENV.RUNS_PER_SECOND || 2), timeUnit: '1s', duration: '5m', preAllocatedVUs: 10, maxVUs: 50 },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:api_reads}': ['p(95)<500', 'p(99)<1200'],
    'http_req_duration{scenario:flow_runs}': ['p(95)<1500'],
  },
}

const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
export function reads() {
  const response = http.get(`${base}/api/v1/flows`, { headers, tags: { operation: 'list-flows' } })
  check(response, { 'flow list 200': (r) => r.status === 200 })
  sleep(0.2)
}
export function runs() {
  if (!__ENV.FLOW_ID) return
  const response = http.post(`${base}/api/v1/flows/${__ENV.FLOW_ID}/run`, JSON.stringify({ input: { loadTest: true } }), { headers, tags: { operation: 'run-flow' } })
  check(response, { 'flow run accepted': (r) => r.status === 202 })
}
