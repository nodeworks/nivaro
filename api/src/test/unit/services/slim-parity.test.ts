import { createServer, type Server } from 'node:http'
import Fastify from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeHandoffRedis } from '../../fixtures/fake-handoff-redis.js'
import { memoryKnex } from '../../fixtures/memory-knex.js'

// Slim parity, feature by feature: a process of the slim image (no ffmpeg,
// no Chromium) runs each media feature's real entry point and nothing fails.
// Async artefacts land on the media worker's lists (media-handoff.test.ts
// drains them); what a request waits on comes from a fake render peer. With
// neither, the readiness checks FAIL instead of people meeting 503s.

const st = vi.hoisted(() => ({
  app: null as null | { redis: unknown; log: unknown },
  ffmpegRuns: 0,
  checks: new Map<string, { run: () => Promise<{ status: string; detail?: string }> }>(),
  db: null as unknown as ReturnType<typeof import('../../fixtures/memory-knex.js').memoryKnex>
}))

vi.mock('../../../services/ffmpeg.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/ffmpeg.js')>()),
  hasFfmpeg: async () => false,
  runFfmpeg: async () => {
    st.ffmpegRuns++
    throw new Error('ffmpeg ran on the slim image')
  }
}))
vi.mock('../../../services/pdf-layout.js', () => ({
  hasLocalChromium: async () => false,
  htmlToPdfLocal: async () => {
    throw new Error('Chromium ran on the slim image')
  },
  getBrowser: async () => {
    throw new Error('Chromium ran on the slim image')
  }
}))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => st.app }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../../../services/readiness.js', () => ({
  registerReadinessCheck: (c: { id: string; run: () => Promise<{ status: string }> }) =>
    st.checks.set(c.id, c)
}))
vi.mock('../../../db/index.js', () => ({
  db: new Proxy(() => {}, {
    apply: (_t, _this, args: [string]) => st.db(args[0]),
    get: (_t, k) => (st.db as unknown as Record<string | symbol, unknown>)[k]
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: async () => 1 }))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { id: ADMIN }
  }
}))

const handoff = await import('../../../services/media-handoff.js')
const { startCaptionJob, defaultDeps } = await import('../../../services/help-video-captions.js')
const { startMediaExtras } = await import('../../../services/help-video-extras.js')
const { sessionReplayExportRoutes } = await import('../../../routes/session-replay-export.js')
const { renderHostEncoders } = await import('../../../services/help-video-encoder.js')
const { registerRenderPeerReadiness } = await import('../../../routes/internal-render.js')

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FILE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ADMIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TOKEN = 'slim-parity-render-token-0123456789'
const saved = { ...process.env }
let redis: ReturnType<typeof fakeHandoffRedis>

/** A render peer: health and the encoder report, behind the bearer. */
let peer: Server
let peerUrl = ''
beforeAll(async () => {
  peer = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end('{"code":"RENDER_TOKEN"}')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.startsWith('/api/internal/render/health'))
      return res.end(JSON.stringify({ ok: true, chromium: true, ffmpeg: true, version: '9.9.9' }))
    if (req.url?.startsWith('/api/internal/render/encoders'))
      return res.end(
        JSON.stringify({
          hardware: { available: ['vaapi'], failed: [], checked_at: '2026-10-22T00:00:00Z' }
        })
      )
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r))
  const a = peer.address()
  peerUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  registerRenderPeerReadiness()
})
afterAll(() => new Promise<void>((r) => peer.close(() => r())))

beforeEach(() => {
  redis = fakeHandoffRedis()
  st.app = { redis, log: { warn: () => {} } }
  st.ffmpegRuns = 0
  st.db = memoryKnex({
    nivaro_session_recordings: [{ id: ID, user: ADMIN, started_at: new Date() }],
    nivaro_users: [{ id: ADMIN, first_name: 'Ada', last_name: 'Admin', email: 'a@x.test' }]
  })
  process.env.NIVARO_IMAGE_VARIANT = 'slim'
  process.env.RENDER_URL = peerUrl
  process.env.RENDER_TOKEN = TOKEN
  delete process.env.CLOUD_META_DB_URL
})
afterEach(() => {
  process.env = { ...saved }
})

const queued = async (kind: (typeof handoff.HANDOFF_KINDS)[number]) =>
  (redis.lists.get(handoff.handoffKey(kind)) ?? []).map((raw) => JSON.parse(raw).payload)

describe('slim image: every media feature works', () => {
  it('captions: the job is queued and handed to the media worker', async () => {
    const job = await startCaptionJob(
      { id: ID },
      FILE,
      { id: ADMIN },
      {
        ...defaultDeps,
        provider: async () => ({ kind: 'gateway', model: 'whisper-1' })
      }
    )
    expect(job.status).toBe('queued')
    expect(await queued('captions')).toEqual([{ version_id: FILE }])
    expect(st.ffmpegRuns).toBe(0)
  })

  it('upload thumbnails and waveform: handed to the media worker', async () => {
    const input = {
      uploadId: ID,
      fileId: FILE,
      mime: 'video/webm',
      durationMs: 9000,
      width: 1280,
      height: 720,
      hasAudio: true
    }
    startMediaExtras({ id: ADMIN } as never, input)
    await vi.waitFor(async () =>
      expect(await queued('extras')).toEqual([{ user_id: ADMIN, input }])
    )
    expect(st.ffmpegRuns).toBe(0)
  })

  it('session-replay WebM: 202 through the real route, handed to the media worker', async () => {
    const app = Fastify()
    await app.register(sessionReplayExportRoutes, { prefix: '/api/session-recordings' })
    const res = await app.inject({
      method: 'POST',
      url: `/api/session-recordings/${ID}/export`,
      payload: { format: 'webm', from_ms: 0, to_ms: 5000 }
    })
    expect(res.statusCode).toBe(202)
    expect(await queued('replay-webm')).toEqual([
      { recordingId: ID, fromMs: 0, toMs: 5000, userId: ADMIN }
    ])
  })

  it('the encoder report comes from the render server', async () => {
    expect(await renderHostEncoders()).toMatchObject({
      available: ['vaapi'],
      source: 'render-server'
    })
  })

  it('readiness passes with a render server and a media worker', async () => {
    await redis.set(
      handoff.mediaWorkerKey(),
      JSON.stringify({
        instance: 'w1',
        name: 'worker',
        version: '9.9.9',
        ffmpeg: true,
        chromium: true,
        at: new Date().toISOString()
      })
    )
    expect(await st.checks.get('render-peer')!.run()).toMatchObject({ status: 'pass' })
    expect(await st.checks.get('media-worker')!.run()).toMatchObject({ status: 'pass' })
  })
})

describe('slim image misconfigured: the deploy gate fails, people never see it', () => {
  it('no RENDER_URL: render-peer FAILS (not warns)', async () => {
    delete process.env.RENDER_URL
    const r = await st.checks.get('render-peer')!.run()
    expect(r.status).toBe('fail')
    expect(r.detail).toMatch(/no RENDER_URL/)
  })

  it('a render server that does not answer, or refuses the token: FAILS', async () => {
    process.env.RENDER_URL = 'http://127.0.0.1:1'
    expect((await st.checks.get('render-peer')!.run()).status).toBe('fail')
    process.env.RENDER_URL = peerUrl
    process.env.RENDER_TOKEN = 'a-different-token-of-thirty-two-chars'
    expect((await st.checks.get('render-peer')!.run()).status).toBe('fail')
  })

  it('no media worker heartbeat: media-worker FAILS', async () => {
    const r = await st.checks.get('media-worker')!.run()
    expect(r.status).toBe('fail')
    expect(r.detail).toMatch(/No media worker has checked in/)
  })

  it('without Redis the features still answer readably (503), never crash', async () => {
    st.app = null
    await expect(
      startCaptionJob({ id: ID }, FILE, null, {
        ...defaultDeps,
        provider: async () => ({ kind: 'gateway', model: 'whisper-1' })
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'HELP_VIDEO_CAPTIONS_NO_FFMPEG' })
    const app = Fastify()
    await app.register(sessionReplayExportRoutes, { prefix: '/api/session-recordings' })
    const res = await app.inject({
      method: 'POST',
      url: `/api/session-recordings/${ID}/export`,
      payload: { format: 'webm' }
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'RENDER_UNAVAILABLE' })
  })
})
