import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// #2789 — the render peer: a slim process (no Chromium, no ffmpeg) hands PDFs
// and fixed ffmpeg jobs to a full one over /api/internal/render with a shared
// bearer. These run the real client (services/render-peer.ts) against the
// real routes (routes/internal-render.ts) on a loopback port, with the
// binaries themselves stubbed.

const TOKEN = 'render-secret-for-tests-0123456789'
const local = vi.hoisted(() => ({
  chromium: true,
  ffmpeg: true,
  pdfCalls: [] as Array<{ html: string; opts: unknown }>,
  probe: { duration_ms: 4200, width: 1280, height: 720, has_audio: true },
  convertFails: null as null | { statusCode: number; code: string; message: string }
}))

vi.mock('../../../services/pdf-layout.js', () => ({
  hasLocalChromium: async () => local.chromium,
  htmlToPdfLocal: async (html: string, opts: unknown) => {
    local.pdfCalls.push({ html, opts })
    return Buffer.from(`%PDF-1.7 ${html.length}`)
  }
}))
vi.mock('../../../services/ffmpeg.js', () => ({
  hasFfmpeg: async () => local.ffmpeg,
  isLockedMime: (m: string) => ['video/webm', 'video/mp4', 'audio/mp4'].includes(m),
  probeVideoLocal: async () => local.probe,
  probeStreamsLocal: async () => ({ duration_ms: 4200, streams: [] }),
  remuxToFileLocal: async (i: string, o: string) => writeFileSync(o, readFileSync(i))
}))
vi.mock('../../../services/help-video-uploads.js', () => ({
  convertUploadedFile: async (
    raw: string,
    _mime: string,
    opts: { outPath: (ext: string) => string }
  ) => {
    if (local.convertFails)
      throw Object.assign(new Error(local.convertFails.message), local.convertFails)
    writeFileSync(opts.outPath('.mp4'), Buffer.concat([readFileSync(raw), Buffer.from('+mp4')]))
    return { container: 'video/mp4', probe: local.probe }
  }
}))
vi.mock('../../../services/help-video-music.js', () => ({
  convertMusicFile: async (raw: string, _mime: string, out: string) => {
    writeFileSync(out, readFileSync(raw))
    return { ...local.probe, duration_ms: 60_000 }
  }
}))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/help-video-encoder.js', () => ({
  detectHardwareEncoders: async (fresh: boolean) => ({
    available: fresh ? ['vaapi'] : [],
    failed: [],
    checked_at: '2026-10-22T00:00:00Z'
  })
}))

import { failedAuthLimiter, internalRenderRoutes, slots } from '../../../routes/internal-render.js'
import {
  bearerMatches,
  decodeMeta,
  encodeMeta,
  maskUrl,
  peerEncoders,
  peerFileOp,
  peerHtmlToPdf,
  plainHttpAllowed,
  probeRenderPeer,
  renderPeerTarget,
  renderPeerToken,
  renderPeerUrl,
  renderUnavailable
} from '../../../services/render-peer.js'

let app: FastifyInstance
let base = ''
const dir = mkdtempSync(join(tmpdir(), 'render-peer-test-'))
const saved = { url: process.env.RENDER_URL, token: process.env.RENDER_TOKEN }

beforeAll(async () => {
  process.env.RENDER_TOKEN = TOKEN
  app = Fastify({ forceCloseConnections: true })
  await app.register(internalRenderRoutes, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  process.env.RENDER_URL = base
})

afterAll(async () => {
  await app.close()
  process.env.RENDER_URL = saved.url
  process.env.RENDER_TOKEN = saved.token
})

afterEach(() => {
  process.env.RENDER_URL = base
  process.env.RENDER_TOKEN = TOKEN
  local.chromium = true
  local.ffmpeg = true
  local.convertFails = null
  local.pdfCalls = []
})

describe('render peer configuration', () => {
  it('reads RENDER_URL as an origin and refuses non-http values', () => {
    expect(renderPeerUrl({ RENDER_URL: 'http://nivaro_worker:3055/' })).toBe(
      'http://nivaro_worker:3055'
    )
    expect(renderPeerUrl({ RENDER_URL: '  ' })).toBeNull()
    expect(renderPeerUrl({ RENDER_URL: 'file:///etc/passwd' })).toBeNull()
    expect(renderPeerUrl({ RENDER_URL: 'not a url' })).toBeNull()
    expect(renderPeerToken({ RENDER_TOKEN: ' t ' })).toBe('t')
    expect(renderPeerToken({})).toBeNull()
  })

  it('checks the bearer timing-safely, whatever the length', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(bearerMatches(`bearer   ${TOKEN}`, TOKEN)).toBe(true)
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false)
    expect(bearerMatches('Bearer ', TOKEN)).toBe(false)
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false)
    expect(bearerMatches(undefined, TOKEN)).toBe(false)
  })

  it('round-trips the meta header', () => {
    const meta = { container: 'video/mp4', probe: { duration_ms: 1, name: 'é ✓' } }
    expect(decodeMeta(encodeMeta(meta))).toEqual(meta)
    expect(decodeMeta('%%%')).toBeNull()
    expect(decodeMeta(null)).toBeNull()
  })

  it('says plainly what is missing when there is no peer', () => {
    const e = renderUnavailable('pdf')
    expect(e.statusCode).toBe(503)
    expect(e.code).toBe('RENDER_UNAVAILABLE')
    expect(e.message).toMatch(/cannot make PDFs/)
    expect(e.message).toMatch(/RENDER_URL/)
  })
})

describe('render peer routes', () => {
  it('refuses a missing or wrong token with 401', async () => {
    const none = await fetch(`${base}/api/internal/render/health`)
    expect(none.status).toBe(401)
    const wrong = await fetch(`${base}/api/internal/render/health`, {
      headers: { authorization: 'Bearer nope' }
    })
    expect(wrong.status).toBe(401)
    expect(((await wrong.json()) as { code: string }).code).toBe('RENDER_TOKEN')
  })

  it('answers health with what it can do', async () => {
    local.ffmpeg = false
    const h = await probeRenderPeer()
    expect(h).toMatchObject({ configured: true, ok: true, chromium: true, ffmpeg: false })
  })

  it('renders a PDF for the client, same bytes as locally', async () => {
    const pdf = await peerHtmlToPdf('<p>hello</p>', {
      format: 'Letter',
      landscape: true,
      margin: '14mm',
      allowOrigins: ['https://efp.example.com', 'not an origin', 'https://x.example.com/path']
    })
    expect(pdf.toString()).toBe('%PDF-1.7 12')
    // The caller's own origins ride along; anything that is not a bare origin is dropped.
    expect(local.pdfCalls[0].opts).toEqual({
      format: 'Letter',
      landscape: true,
      margin: '14mm',
      allowOrigins: ['https://efp.example.com']
    })
  })

  it('a wrong client token comes back as a readable 503', async () => {
    process.env.RENDER_TOKEN = 'wrong'
    await expect(peerHtmlToPdf('<p>x</p>')).rejects.toMatchObject({
      statusCode: 503,
      code: 'RENDER_PEER_AUTH'
    })
  })

  it('a peer without Chromium refuses the PDF with its reason', async () => {
    local.chromium = false
    await expect(peerHtmlToPdf('<p>x</p>')).rejects.toMatchObject({
      statusCode: 503,
      code: 'RENDER_UNAVAILABLE'
    })
  })

  it('an unreachable peer is a 503, not a crash', async () => {
    process.env.RENDER_URL = 'http://127.0.0.1:1'
    await expect(peerHtmlToPdf('<p>x</p>')).rejects.toMatchObject({
      statusCode: 503,
      code: 'RENDER_PEER_UNREACHABLE'
    })
    const h = await probeRenderPeer()
    expect(h.ok).toBe(false)
  })

  it('reports the encoders renders can use there (#1561, a slim settings page)', async () => {
    expect(await peerEncoders()).toMatchObject({ available: [] })
    expect(await peerEncoders(true)).toMatchObject({ available: ['vaapi'] })
    local.ffmpeg = false
    await expect(peerEncoders()).rejects.toMatchObject({
      statusCode: 503,
      code: 'RENDER_UNAVAILABLE'
    })
  })

  it('probes a streamed file and answers JSON', async () => {
    const f = join(dir, 'probe.webm')
    writeFileSync(f, Buffer.alloc(4096, 1))
    await expect(peerFileOp('probe-video', f, { mime: 'video/webm' })).resolves.toEqual(local.probe)
  })

  it('remuxes: the file comes back to disk with the probe in the header', async () => {
    const f = join(dir, 'rec.webm')
    const out = join(dir, 'rec.fixed.webm')
    writeFileSync(f, Buffer.from('webm-bytes'))
    const meta = await peerFileOp('remux', f, { mime: 'video/webm', output: out })
    expect(readFileSync(out).toString()).toBe('webm-bytes')
    expect(meta).toEqual(local.probe)
  })

  it('converts an upload and carries the container back', async () => {
    const f = join(dir, 'up.bin')
    const out = join(dir, 'up.out')
    writeFileSync(f, Buffer.from('mov'))
    const meta = await peerFileOp<{ container: string }>('convert-upload', f, {
      mime: 'video/mp4',
      output: out
    })
    expect(meta.container).toBe('video/mp4')
    expect(readFileSync(out).toString()).toBe('mov+mp4')
  })

  it("keeps the local code's refusal (status, code, message)", async () => {
    local.convertFails = {
      statusCode: 422,
      code: 'UPLOAD_TOO_LONG',
      message: 'Videos can be up to 30 minutes'
    }
    const f = join(dir, 'long.bin')
    writeFileSync(f, Buffer.from('x'))
    await expect(
      peerFileOp('convert-upload', f, { mime: 'video/mp4', output: join(dir, 'long.out') })
    ).rejects.toMatchObject({ statusCode: 422, code: 'UPLOAD_TOO_LONG' })
  })

  it('refuses an unknown operation and a bad mime', async () => {
    const res = await fetch(`${base}/api/internal/render/file/exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' },
      body: 'x'
    })
    expect(res.status).toBe(404)
    const f = join(dir, 'm.bin')
    writeFileSync(f, Buffer.from('x'))
    await expect(
      peerFileOp('convert-upload', f, { mime: 'text/html', output: join(dir, 'm.out') })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('is not mounted at all without RENDER_TOKEN', async () => {
    delete process.env.RENDER_TOKEN
    const bare = Fastify()
    await bare.register(internalRenderRoutes, { prefix: '/api' })
    const res = await bare.inject({ method: 'GET', url: '/api/internal/render/health' })
    expect(res.statusCode).toBe(404)
    await bare.close()
  })

  it('refuses to mount with a token under 32 characters', async () => {
    process.env.RENDER_TOKEN = 'short-token'
    const bare = Fastify()
    await bare.register(internalRenderRoutes, { prefix: '/api' })
    const res = await bare.inject({
      method: 'GET',
      url: '/api/internal/render/health',
      headers: { authorization: 'Bearer short-token' }
    })
    expect(res.statusCode).toBe(404)
    await bare.close()
  })

  it('refuses a file op whose mime does not pin a demuxer', async () => {
    const f = join(dir, 'concat.txt')
    writeFileSync(f, 'ffconcat version 1.0\nfile /etc/passwd\n')
    for (const mime of ['', 'text/plain', 'application/x-mpegurl']) {
      await expect(peerFileOp('probe-video', f, { mime })).rejects.toMatchObject({
        statusCode: 400,
        code: 'RENDER_BAD_REQUEST'
      })
    }
  })

  it('caps what the client accepts back from a peer', async () => {
    // A "peer" that claims a 200 MB PDF.
    const fake = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': String(200 * 1024 * 1024)
      })
      res.write(Buffer.alloc(1024))
      setTimeout(() => res.destroy(), 50)
    })
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
    const port = (fake.address() as { port: number }).port
    process.env.RENDER_URL = `http://127.0.0.1:${port}`
    await expect(peerHtmlToPdf('<p>x</p>')).rejects.toMatchObject({ code: 'RENDER_PEER_TOO_LARGE' })
    fake.closeAllConnections()
    await new Promise((r) => fake.close(r))
  })
})

describe('render peer hardening', () => {
  it('needs https: except on networks the token never leaves', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '::1',
      'nivaro_worker',
      'worker',
      'tasks.efp_worker',
      'tasks.worker',
      '10.0.3.4',
      '172.20.0.5',
      '192.168.1.9',
      'fd12::1'
    ])
      expect(plainHttpAllowed(h), h).toBe(true)
    for (const h of [
      'render.example.com',
      '8.8.8.8',
      '172.32.0.1',
      'tasks.a.b',
      '169.254.169.254x.com'
    ])
      expect(plainHttpAllowed(h), h).toBe(false)
    expect(renderPeerTarget({ RENDER_URL: 'http://render.example.com' })).toMatchObject({
      error: expect.stringMatching(/https/)
    })
    expect(renderPeerTarget({ RENDER_URL: 'https://render.example.com/' })).toEqual({
      url: 'https://render.example.com'
    })
    expect(renderPeerTarget({ RENDER_URL: 'http://u:p@nivaro_worker:3055' })).toMatchObject({
      error: expect.stringMatching(/credentials/)
    })
    expect(renderPeerUrl({ RENDER_URL: 'http://render.example.com' })).toBeNull()
  })

  it('a refused RENDER_URL says why instead of "not configured"', () => {
    process.env.RENDER_URL = 'http://render.example.com'
    expect(renderUnavailable('pdf').message).toMatch(/must use https/)
  })

  it('masks a password in the URL it reports', async () => {
    expect(maskUrl('http://user:secret@nivaro_worker:3055')).toBe(
      'http://user:••••••@nivaro_worker:3055'
    )
    process.env.RENDER_URL = 'http://user:secret@nivaro_worker:3055'
    const h = await probeRenderPeer()
    expect(h.url).toBe('http://user:••••••@nivaro_worker:3055')
    expect(JSON.stringify(h)).not.toContain('secret')
  })

  it('limits failed bearer checks per address', () => {
    const l = failedAuthLimiter(3, 60_000)
    expect(l.fail('1.2.3.4', 0)).toBe(true) // first in the window: logged
    expect(l.fail('1.2.3.4', 1)).toBe(false)
    expect(l.blocked('1.2.3.4', 2)).toBe(false)
    expect(l.fail('1.2.3.4', 3)).toBe(true) // hits the limit: logged again
    expect(l.blocked('1.2.3.4', 4)).toBe(true)
    expect(l.blocked('5.6.7.8', 4)).toBe(false)
    expect(l.blocked('1.2.3.4', 60_001)).toBe(false)
  })

  it('answers 429 after 20 wrong tokens from one address', async () => {
    let last = 0
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${base}/api/internal/render/health`, {
        headers: { authorization: `Bearer guess-${i}` }
      })
      last = res.status
    }
    expect(last).toBe(429)
  })

  it('runs work in a few slots and turns callers away past the queue', async () => {
    const s = slots(1, 1, 50)
    const a = await s.acquire()
    expect(a).toBeTypeOf('function')
    const waiting = s.acquire()
    expect(await s.acquire()).toBeNull() // queue full
    a?.()
    const b = await waiting
    expect(b).toBeTypeOf('function')
    expect(await s.acquire()).toBeNull() // waited 50 ms, nothing freed
    b?.()
    expect(s.busy).toBe(0)
  })
})
