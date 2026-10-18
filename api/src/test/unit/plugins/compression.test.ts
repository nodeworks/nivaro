import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerCompression, shouldSkipCompression } from '../../../plugins/compression.js'

const big = { data: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `row number ${i}` })) }

async function build() {
  const app = Fastify()
  // A payload-reading hook registered BEFORE compression, as api-logger /
  // idempotency are: it must see the plain JSON string.
  const seen: { len: number; plain: boolean }[] = []
  app.addHook('onSend', async (_req, _reply, payload) => {
    if (typeof payload === 'string') {
      let plain = true
      try {
        JSON.parse(payload)
      } catch {
        plain = false
      }
      seen.push({ len: Buffer.byteLength(payload), plain })
    }
    return payload
  })
  await registerCompression(app)
  app.get('/big', async () => big)
  app.get('/small', async () => ({ ok: true }))
  app.get('/ranged', async (_req, reply) => {
    return reply
      .code(206)
      .header('Content-Range', 'bytes 0-2999/9000')
      .header('Content-Type', 'text/plain')
      .send('x'.repeat(3000))
  })
  app.get('/accept-ranges', async (_req, reply) => {
    return reply
      .header('Accept-Ranges', 'bytes')
      .header('Content-Type', 'text/plain')
      .send('x'.repeat(3000))
  })
  app.get('/sse-ish', async (_req, reply) => {
    return reply.header('Content-Type', 'text/event-stream').send('data: x\n\n'.repeat(500))
  })
  app.get('/opt-out', { compress: false }, async () => big)
  app.get('/png', async (_req, reply) => {
    return reply.header('Content-Type', 'image/png').send(Buffer.alloc(5000, 1))
  })
  await app.ready()
  return { app, seen }
}

describe('response compression (#2437)', () => {
  it('brotli-encodes JSON over 1 KB and round-trips', async () => {
    const { app } = await build()
    const res = await app.inject({ url: '/big', headers: { 'accept-encoding': 'br, gzip' } })
    expect(res.headers['content-encoding']).toBe('br')
    expect(String(res.headers.vary)).toMatch(/accept-encoding/i)
    expect(JSON.parse(brotliDecompressSync(res.rawPayload).toString())).toEqual(big)
    expect(res.rawPayload.length).toBeLessThan(JSON.stringify(big).length / 3)
  })

  it('falls back to gzip', async () => {
    const { app } = await build()
    const res = await app.inject({ url: '/big', headers: { 'accept-encoding': 'gzip' } })
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(JSON.parse(gunzipSync(res.rawPayload).toString())).toEqual(big)
  })

  it('leaves a response with no Accept-Encoding alone', async () => {
    const { app } = await build()
    const res = await app.inject({ url: '/big' })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.json()).toEqual(big)
  })

  it('does not compress under 1 KB', async () => {
    const { app } = await build()
    const res = await app.inject({ url: '/small', headers: { 'accept-encoding': 'br' } })
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.json()).toEqual({ ok: true })
  })

  it('does not compress 206 / Content-Range / Accept-Ranges / event-stream replies', async () => {
    const { app } = await build()
    for (const url of ['/ranged', '/accept-ranges', '/sse-ish']) {
      const res = await app.inject({ url, headers: { 'accept-encoding': 'br, gzip' } })
      expect(res.headers['content-encoding'], url).toBeUndefined()
    }
    const r = await app.inject({ url: '/ranged', headers: { 'accept-encoding': 'br' } })
    expect(r.statusCode).toBe(206)
    expect(r.payload).toHaveLength(3000)
  })

  it('does not compress binary types or routes that opt out', async () => {
    const { app } = await build()
    for (const url of ['/png', '/opt-out']) {
      const res = await app.inject({ url, headers: { 'accept-encoding': 'br' } })
      expect(res.headers['content-encoding'], url).toBeUndefined()
    }
  })

  it('payload-reading onSend hooks registered earlier see the plain JSON body', async () => {
    const { app, seen } = await build()
    await app.inject({ url: '/big', headers: { 'accept-encoding': 'br' } })
    expect(seen).toHaveLength(1)
    expect(seen[0].plain).toBe(true)
    expect(seen[0].len).toBe(Buffer.byteLength(JSON.stringify(big)))
  })

  it('guard predicate', () => {
    expect(shouldSkipCompression({ acceptRanges: 'bytes' })).toBe(true)
    expect(shouldSkipCompression({ acceptRanges: 'none' })).toBe(false)
    expect(shouldSkipCompression({ contentRange: 'bytes 0-1/2' })).toBe(true)
    expect(shouldSkipCompression({ contentType: 'text/event-stream; charset=utf-8' })).toBe(true)
    expect(shouldSkipCompression({ contentType: 'application/json' })).toBe(false)
  })
})
