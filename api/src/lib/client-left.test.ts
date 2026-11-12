import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerCompression } from '../plugins/compression.js'
import { clientLeft, isEarlyCloseError } from './client-left.js'

/**
 * The real path, not a mock of it: a POST whose whole body arrived, a client that hangs up
 * while the handler is still working, and an answer big enough to go through the compression
 * stream. Fastify then hands the error handler ERR_STREAM_PREMATURE_CLOSE (its own
 * `request.raw.aborted` test is false once the body was read), which is what filled the issue
 * log in the first week live.
 */
interface Seen {
  err: Error & { code?: string }
  left: boolean
  destroyed: boolean
}

let app: FastifyInstance | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

async function boot(handler: (release: Promise<void>) => Promise<unknown>) {
  let release!: () => void
  const released = new Promise<void>((r) => {
    release = r
  })
  let arrived!: () => void
  const handlerStarted = new Promise<void>((r) => {
    arrived = r
  })
  let done!: (s: Seen) => void
  const seen = new Promise<Seen>((r) => {
    done = r
  })
  app = Fastify()
  await registerCompression(app)
  app.setErrorHandler((err: Error & { code?: string }, _req, reply) => {
    done({ err, left: clientLeft(err, reply.raw), destroyed: reply.raw.destroyed })
    if (!reply.raw.destroyed) return reply.code(500).send({ error: 'failed' })
  })
  app.post('/big', async () => {
    arrived()
    return handler(released)
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as AddressInfo).port
  return { port, release, handlerStarted, seen }
}

function post(port: number) {
  const req = httpRequest({
    host: '127.0.0.1',
    port,
    path: '/big',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' }
  })
  req.on('error', () => {})
  req.end(JSON.stringify({ reads: [{ key: 'a', path: '/x' }] }))
  return req
}

describe('clientLeft', () => {
  it('is true when the browser hangs up before a compressed answer is written', async () => {
    // Random text: past the size the compression plugin answers inline, so it streams.
    const big = JSON.stringify({
      data: Array.from({ length: 60_000 }, () => Math.random().toString(36))
    })
    const { port, release, handlerStarted, seen } = await boot(async (released) => {
      await released
      return big
    })
    const req = post(port)
    await handlerStarted
    const closed = new Promise<void>((r) => req.on('close', () => r()))
    req.destroy()
    await closed
    // Give the server a turn to see the socket close before the handler answers.
    await new Promise((r) => setTimeout(r, 50))
    release()
    const s = await seen
    expect(s.err.code).toBe('ERR_STREAM_PREMATURE_CLOSE')
    expect(s.destroyed).toBe(true)
    expect(s.left).toBe(true)
  })

  it('is false when the source of the answer breaks and the client is still there', async () => {
    const { port, release, seen } = await boot(async () => {
      // A storage read that closes early: the same error code, but nobody hung up.
      const source = new Readable({ read() {} })
      setTimeout(() => source.destroy(), 10)
      return source
    })
    release()
    const req = post(port)
    const s = await seen
    expect(isEarlyCloseError(s.err)).toBe(true)
    expect(s.destroyed).toBe(false)
    expect(s.left).toBe(false)
    req.destroy()
  })

  it('never calls another kind of failure a client leaving, even on a closed connection', () => {
    const gone = { destroyed: true, writableFinished: false }
    expect(clientLeft(new Error('Invalid object name'), gone)).toBe(false)
    expect(
      clientLeft(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), gone)
    ).toBe(false)
  })

  it('is false once the answer finished: a close after that is the normal end', () => {
    const err = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })
    expect(clientLeft(err, { destroyed: true, writableFinished: true })).toBe(false)
    expect(clientLeft(err, { destroyed: false, writableFinished: false })).toBe(false)
    expect(clientLeft(err, { destroyed: true, writableFinished: false })).toBe(true)
  })

  it('reads the older end-of-stream wording too', () => {
    expect(isEarlyCloseError(new Error('premature close'))).toBe(true)
    expect(isEarlyCloseError(new Error('Premature close'))).toBe(false)
    expect(isEarlyCloseError(null)).toBe(false)
  })
})
