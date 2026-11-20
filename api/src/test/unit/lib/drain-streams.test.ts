import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  drainDeadlineMs,
  endEndlessStreams,
  endlessStreamCount,
  markEndlessStream
} from '../../../lib/drain-streams.js'

// A deploy's drain used to cut EVERY open connection 3 s in: a download, a partner push or a
// streamed answer still running was dropped. Now only endless subscriptions end at once.

describe('shutdown drain: endless streams end, real requests finish', () => {
  it('ends a marked SSE subscription and lets a slow request complete', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        markEndlessStream(res)
        res.write(': hi\n\n')
        return
      }
      setTimeout(() => res.end('done'), 300) // a request still in flight at shutdown
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    const get = (path: string) =>
      new Promise<{ body: string; ended: boolean }>((resolve, reject) => {
        const rq = request({ host: '127.0.0.1', port, path, agent: false }, (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => resolve({ body, ended: true }))
          res.on('error', reject)
        })
        rq.on('error', reject)
        rq.end()
      })
    const sse = get('/sse')
    await new Promise((r) => setTimeout(r, 50))
    const slow = get('/slow')
    await new Promise((r) => setTimeout(r, 50))
    expect(endlessStreamCount()).toBe(1)

    // The shutdown's order: end subscriptions, close idle, close the server.
    expect(endEndlessStreams()).toBe(1)
    server.closeIdleConnections()
    const closed = new Promise<void>((r) => server.close(() => r()))

    expect((await sse).ended).toBe(true)
    expect(await slow).toEqual({ body: 'done', ended: true })
    await closed
    expect(endlessStreamCount()).toBe(0)
  })

  it('deadline: explicit setting, else 12 s behind a drain delay, 8 s without, 3 s in dev', () => {
    expect(drainDeadlineMs({ SHUTDOWN_DRAIN_TIMEOUT_MS: '20000' } as never, 15_000)).toBe(20_000)
    expect(drainDeadlineMs({} as never, 15_000)).toBe(12_000)
    expect(drainDeadlineMs({} as never, 0)).toBe(8_000)
    expect(drainDeadlineMs({ NODE_ENV: 'development' } as never, 15_000)).toBe(3_000)
    expect(drainDeadlineMs({ SHUTDOWN_DRAIN_TIMEOUT_MS: 'x' } as never, 0)).toBe(8_000)
  })
})
