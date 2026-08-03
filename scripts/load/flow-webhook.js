import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter, Rate } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'
const FLOW_ID = __ENV.FLOW_ID
const FLOW_TRIGGER_SECRET = __ENV.FLOW_TRIGGER_SECRET

if (!FLOW_ID || !FLOW_TRIGGER_SECRET) {
  throw new Error('FLOW_ID and FLOW_TRIGGER_SECRET are required')
}

const serverErrors = new Rate('server_errors')
const throttled = new Counter('throttled_requests')

export const options = {
  stages: [
    { duration: '30s', target: 25 },
    { duration: '60s', target: 100 },
    { duration: '60s', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<1500'],
    server_errors: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
}

export default function flowWebhookLoad() {
  const deliveryId = `k6-${__VU}-${__ITER}-${Date.now()}`
  const response = http.post(
    `${BASE_URL}/api/flows/${FLOW_ID}/trigger`,
    JSON.stringify({ loadTest: true, vu: __VU, iteration: __ITER }),
    {
      headers: {
        'content-type': 'application/json',
        'x-trigger-secret': FLOW_TRIGGER_SECRET,
        'x-trigger-delivery-id': deliveryId,
        'x-trigger-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      timeout: '30s',
    },
  )
  if (response.status === 429) throttled.add(1)
  serverErrors.add(response.status >= 500)
  check(response, {
    'accepted or deliberately throttled': (res) => [200, 202, 429].includes(res.status),
  })
  sleep(1)
}
