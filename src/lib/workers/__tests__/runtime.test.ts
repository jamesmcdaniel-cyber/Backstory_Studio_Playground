import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { QUEUE_NAMES, workerConfig } from '@/lib/queue/config'
import { WorkerRuntime, buildWorkerSpecs, type WorkerHandle, type WorkerRuntimeDeps, type WorkerSpec } from '../runtime'

/**
 * The worker entrypoint had zero tests, which meant the topology it registers —
 * the thing an outage actually turns on — was only ever verified by deploying
 * it. These tests assert the wiring decisions with the Redis and process edges
 * stubbed: no worker is booted, no connection is opened, nothing is enqueued.
 */

interface StubWorker extends WorkerHandle {
  queue: string
  options: Record<string, unknown>
  failedListeners: ((job: any, error: Error) => void)[]
  closed: boolean
  running: boolean
}

function harness(overrides: Partial<WorkerRuntimeDeps> = {}) {
  const workers: StubWorker[] = []
  const signals: string[] = []
  const exits: number[] = []
  const routes: string[] = []
  let serverClosed = false
  let pingResult: Promise<string> = Promise.resolve('PONG')
  let healthHandler: ((request: unknown, reply: { code: (n: number) => void }) => Promise<unknown>) | undefined

  const deps: Partial<WorkerRuntimeDeps> = {
    createServer: () =>
      ({
        get: (path: string, handler: never) => {
          routes.push(path)
          healthHandler = handler
        },
        close: async () => { serverClosed = true },
        log: { warn() {}, error() {}, info() {} },
      }) as never,
    createWorker: (queue, _handler, options) => {
      const worker: StubWorker = {
        queue,
        options: options as unknown as Record<string, unknown>,
        failedListeners: [],
        closed: false,
        running: true,
        isRunning: () => worker.running,
        on: (_event, listener) => worker.failedListeners.push(listener),
        close: async () => { worker.closed = true },
      }
      workers.push(worker)
      return worker
    },
    connection: () => ({ ping: () => pingResult }),
    onSignal: (signal) => { signals.push(signal) },
    exit: (code) => { exits.push(code) },
    ...overrides,
  }

  const runtime = new WorkerRuntime(deps)
  return {
    runtime,
    workers,
    signals,
    exits,
    routes,
    get serverClosed() { return serverClosed },
    setPing: (value: Promise<string>) => { pingResult = value },
    health: async () => {
      let status = 0
      const body = await healthHandler!({}, { code: (n: number) => { status = n } })
      return { status, body: body as Record<string, unknown> }
    },
  }
}

afterEach(() => { delete process.env.APP_EDITION })

describe('consumer topology', () => {
  test('the internal edition consumes every queue', () => {
    const specs = buildWorkerSpecs(false)

    assert.deepEqual(specs.map((spec) => spec.queue), [
      QUEUE_NAMES.AGENT_EXECUTION,
      QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION,
      QUEUE_NAMES.FLOW_EXECUTION,
      QUEUE_NAMES.TEMPLATE_GENERATION,
      QUEUE_NAMES.MODEL_BENCH,
    ])
  })

  test('the customer edition registers neither internal-only queue', () => {
    // The edition gate lives in the topology, not just in the enqueue path: a
    // customer deploy that consumed these queues would be a surface leak of the
    // kind customer-edition.md exists to prevent. Model bench is internal for
    // the same reason as the console that triggers it.
    const specs = buildWorkerSpecs(true)

    assert.equal(specs.some((spec) => spec.queue === QUEUE_NAMES.TEMPLATE_GENERATION), false)
    assert.equal(specs.some((spec) => spec.queue === QUEUE_NAMES.MODEL_BENCH), false)
    assert.equal(specs.length, 3)
  })

  test('the edition is read at build time, not hardcoded', () => {
    process.env.APP_EDITION = 'customer'
    assert.equal(buildWorkerSpecs().length, 3)
    process.env.APP_EDITION = 'internal'
    assert.equal(buildWorkerSpecs().length, 5)
  })

  test('every spec carries a distinct queue and its own failure handler', () => {
    const specs = buildWorkerSpecs(false)

    assert.equal(new Set(specs.map((spec) => spec.queue)).size, specs.length)
    for (const spec of specs) {
      assert.equal(typeof spec.handler, 'function', `${spec.queue} has no handler`)
      assert.equal(typeof spec.onFailed, 'function', `${spec.queue} has no dead-letter handler`)
    }
    // A shared onFailed closure would dead-letter under the wrong queue name.
    assert.equal(new Set(specs.map((spec) => spec.onFailed)).size, specs.length)
  })
})

describe('worker construction', () => {
  test('one worker per spec, each on its own queue', () => {
    const { workers } = harness()

    assert.deepEqual(workers.map((worker) => worker.queue), buildWorkerSpecs().map((spec) => spec.queue))
  })

  test('workers are built with the shared workerConfig', () => {
    // These four are the Upstash-command-burn settings that took the plane down
    // once already; a silent default would restore the old bill.
    const { workers } = harness()

    for (const worker of workers) {
      assert.equal(worker.options.concurrency, workerConfig.concurrency)
      assert.equal(worker.options.lockDuration, workerConfig.lockDuration)
      assert.equal(worker.options.drainDelay, workerConfig.drainDelay)
      assert.equal(worker.options.stalledInterval, workerConfig.stalledInterval)
      assert.ok(worker.options.connection, 'the worker must be given a connection')
    }
  })

  test("each worker's failed listener is its own spec's dead-letter handler", () => {
    const specs: WorkerSpec[] = buildWorkerSpecs(false)
    const { workers } = harness({ specs })

    assert.equal(workers.length, specs.length)
    workers.forEach((worker, index) => {
      assert.deepEqual(worker.failedListeners, [specs[index].onFailed])
    })
  })

  test('the health route is registered', () => {
    const { routes } = harness()
    assert.deepEqual(routes, ['/health'])
  })
})

describe('health check', () => {
  test('healthy when every worker runs and Redis answers PONG', async () => {
    const h = harness()

    const { status, body } = await h.health()

    assert.equal(status, 200)
    assert.equal(body.status, 'healthy')
    assert.equal(body.redis, true)
    assert.deepEqual(
      Object.keys(body.workers as Record<string, boolean>),
      h.workers.map((worker) => worker.queue),
    )
  })

  test('503 when a worker has stopped, even with Redis up', async () => {
    const h = harness()
    h.workers[0].running = false

    const { status, body } = await h.health()

    assert.equal(status, 503)
    assert.equal(body.status, 'unhealthy')
    assert.equal((body.workers as Record<string, boolean>)[h.workers[0].queue], false)
  })

  test('503 when the Redis ping rejects — reachable is not the same as consumed', async () => {
    const h = harness()
    h.setPing(Promise.reject(new Error('ECONNREFUSED')))

    const { status, body } = await h.health()

    assert.equal(status, 503)
    assert.equal(body.redis, false)
  })

  test('503 when Redis answers something other than PONG', async () => {
    const h = harness()
    h.setPing(Promise.resolve('LOADING'))

    assert.equal((await h.health()).status, 503)
  })
})

describe('shutdown', () => {
  test('both termination signals are registered', () => {
    assert.deepEqual(harness().signals, ['SIGINT', 'SIGTERM'])
  })

  test('shutdown closes the server and every worker, then exits 0', async () => {
    const h = harness()

    await h.runtime.shutdown()

    assert.equal(h.serverClosed, true)
    assert.deepEqual(h.workers.map((worker) => worker.closed), h.workers.map(() => true))
    assert.deepEqual(h.exits, [0])
  })

  test('shutdown is safe before start() ever set a timer', async () => {
    // Fly can SIGTERM a machine mid-boot; a shutdown that threw on undefined
    // timers would turn a graceful stop into a crash loop.
    const h = harness()
    await h.runtime.shutdown()
    assert.deepEqual(h.exits, [0])
  })
})

test('the runtime reports the queues it consumes', () => {
  const { runtime } = harness()
  assert.deepEqual(runtime.queues, buildWorkerSpecs().map((spec) => spec.queue))
})
