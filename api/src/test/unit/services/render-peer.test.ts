import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

import { internalRenderRoutes } from '../../../routes/internal-render.js'
import {
  bearerMatches,
  decodeMeta,
  encodeMeta,
  peerFileOp,
  peerHtmlToPdf,
  probeRenderPeer,
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
      margin: '14mm'
    })
    expect(pdf.toString()).toBe('%PDF-1.7 12')
    expect(local.pdfCalls[0].opts).toEqual({ format: 'Letter', landscape: true, margin: '14mm' })
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
})
