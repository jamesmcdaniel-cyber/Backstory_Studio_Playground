/**
 * Server-sent events for interactive AI routes. A route that can stream
 * returns `eventStream(...)` when the client asked for `text/event-stream`;
 * everything that can fail before the model call (validation, rate limits,
 * budget) still throws ApiError first and answers as ordinary JSON.
 *
 * Events: `delta` {text} as the answer forms, then exactly one of `done`
 * {…the same payload the JSON route returns} or `error` {error, code}.
 *
 * The body runs inside the handler's async context (the stream's start
 * callback is invoked synchronously), so the ambient tenant stays set for
 * every database call the stream makes.
 */

import { ApiError } from '@/lib/server/api-handler'

export function wantsEventStream(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/event-stream')
}

export type StreamSend = {
  delta: (text: string) => void
}

export function eventStream(run: (send: StreamSend) => Promise<unknown>): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      const send: StreamSend = { delta: (text) => { if (text) write('delta', { text }) } }
      void run(send)
        .then((payload) => write('done', payload))
        .catch((error: unknown) => {
          const message = error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong.'
          const code = error instanceof ApiError ? error.code : 'STREAM_FAILED'
          write('error', { success: false, error: message, code })
        })
        .finally(() => controller.close())
    },
  })
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Vercel/NGINX must not buffer the stream into one late chunk.
      'x-accel-buffering': 'no',
    },
  })
}
