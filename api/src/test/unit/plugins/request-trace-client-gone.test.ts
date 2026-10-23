// api/src/test/unit/plugins/request-trace-client-gone.test.ts
// Staging demo 2026-10-23: signed-out POST /api/presence/ping requests read "stuck in auth" on
// the Traffic Map in-flight list for 6+ minutes with 0 queries. The route is public (it never
// authenticates); the entries were leaks. A client that leaves AFTER its whole body arrived gets
// neither onRequestAbort (the request was complete) nor onResponse (the response never
// finishes), so inflightEnd never ran and the entry aged for an hour.
import net from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => {
  const db = Object.assign(() => ({}), { raw: async () => [] })
  return { db, _staticDb: {}, _backgroundDb: null, dbRead: {} }
})

import { requestTracePlugin } from '../../../plugins/request-trace.js'
import { inflightAuth, listInflight, resetInflight } from '../../../services/traffic-inflight.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let current: FastifyInstance | null = null

async function app(handlerMs: number) {
  const a = Fastify()
  await a.register(requestTracePlugin)
  a.post('/api/presence/ping', async (_req, reply) => {
    await sleep(handlerMs)
    return reply.code(204).send()
  })
  a.post('/api/signed', { preHandler: async (req) => inflightAuth(req, true) }, async () => {
    await sleep(handlerMs)
    return { ok: true }
  })
  await a.listen({ port: 0, host: '127.0.0.1' })
  current = a
  return (a.server.address() as net.AddressInfo).port
}

/** Sends a complete POST, then drops the connection after `leaveMs` without reading a reply. */
function postAndLeave(port: number, path: string, leaveMs: number): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ sessionId: 'abc', pageUrl: 'https://x/' })
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(
        `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`
      )
      setTimeout(() => {
        s.destroy()
        // Let the server see the close.
        setTimeout(resolve, 30)
      }, leaveMs)
    })
    s.on('error', () => {})
  })
}

afterEach(async () => {
  await current?.close()
  current = null
  resetInflight()
})

describe('in-flight entries when the client leaves', () => {
  it('ends the entry once the handler replies to a client that already left', async () => {
    const port = await app(200)
    await postAndLeave(port, '/api/presence/ping', 50)
    // The handler is still running: the request is really in flight, and marked gone.
    const during = listInflight().rows
    expect(during).toHaveLength(1)
    expect(during[0]).toMatchObject({ route: '/api/presence/ping', client_gone: true })
    await sleep(300)
    expect(listInflight().total).toBe(0)
  })

  it('a public route never reads as "auth" (it never authenticates)', async () => {
    const port = await app(200)
    await postAndLeave(port, '/api/presence/ping', 50)
    expect(listInflight().rows[0].phase).toBe('handler')
    await sleep(300)
  })

  it('reads "auth" only while authenticate runs', async () => {
    const port = await app(200)
    await postAndLeave(port, '/api/signed', 50)
    expect(listInflight().rows[0].phase).toBe('auth')
    await sleep(300)
    expect(listInflight().total).toBe(0)
  })

  it('still ends a normal request at its response', async () => {
    const port = await app(0)
    const res = await fetch(`http://127.0.0.1:${port}/api/presence/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(res.status).toBe(204)
    await sleep(20)
    expect(listInflight().total).toBe(0)
  })
})
