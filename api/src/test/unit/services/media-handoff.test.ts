import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeHandoffRedis } from '../../fixtures/fake-handoff-redis.js'

// Slim parity: a process without ffmpeg/Chromium (the slim image) hands clips,
// captions, upload extras and replay videos to the media worker over Redis;
// the worker drains them one per kind through each feature's own runner.
// The runners are stubs here (each feature's test covers its runner).

const st = vi.hoisted(() => ({
  ffmpeg: false,
  chromium: false,
  app: null as null | { redis: unknown },
  ran: [] as Array<{ kind: string; arg: unknown }>,
  drops: [] as Array<{ user: string; recording: string | null; why: string }>,
  renderKicks: 0
}))

vi.mock('../../../services/ffmpeg.js', () => ({ hasFfmpeg: async () => st.ffmpeg }))
vi.mock('../../../services/pdf-layout.js', () => ({ hasLocalChromium: async () => st.chromium }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => st.app }))
vi.mock('../../../services/help-video-clips.js', () => ({
  runClipHere: async (id: string) => {
    st.ran.push({ kind: 'clip', arg: id })
  }
}))
vi.mock('../../../services/help-video-captions.js', () => ({
  runCaptionJobHere: async (id: string) => {
    st.ran.push({ kind: 'captions', arg: id })
  }
}))
vi.mock('../../../services/help-video-extras.js', () => ({
  runMediaExtrasHere: async (userId: string, input: unknown) => {
    st.ran.push({ kind: 'extras', arg: { userId, input } })
  }
}))
vi.mock('../../../services/session-replay-export.js', () => ({
  runWebmExportHere: async (job: unknown) => {
    st.ran.push({ kind: 'replay-webm', arg: job })
  },
  failQueuedWebmExport: async (user: string, recording: string | null, why: string) => {
    st.drops.push({ user, recording, why })
  }
}))
vi.mock('../../../services/help-video-render.js', () => ({
  kickRenderer: () => {
    st.renderKicks++
  }
}))

const m = await import('../../../services/media-handoff.js')
const { config } = await import('../../../config.js')
const { inBackgroundPool } = await import('../../../db/pool-context.js')

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const saved = { ...process.env }
let redis: ReturnType<typeof fakeHandoffRedis>

beforeEach(() => {
  redis = fakeHandoffRedis()
  st.app = { redis }
  st.ffmpeg = false
  st.chromium = false
  st.ran = []
  st.drops = []
  st.renderKicks = 0
  process.env.NIVARO_IMAGE_VARIANT = 'slim'
  delete process.env.MEDIA_WORKER
  delete process.env.CLOUD_META_DB_URL
  delete process.env.NIVARO_ROLE
})

afterEach(async () => {
  await m.stopMediaWorker()
  process.env = { ...saved }
})

/** A media worker's heartbeat, as a running worker writes it. */
const putBeat = (chromium = true) =>
  redis.set(
    m.mediaWorkerKey(),
    JSON.stringify({
      instance: 'w0',
      name: 'worker',
      version: '1',
      ffmpeg: true,
      chromium,
      at: new Date().toISOString()
    })
  )
const replayJob = { recordingId: ID, userId: USER, fromMs: null, toMs: 5000 }

/** Turn this process into the worker: full image, binaries, MEDIA_WORKER=on. */
async function becomeWorker(
  opts: { chromium?: boolean; run?: Parameters<typeof m.startMediaWorker>[0]['run'] } = {}
) {
  delete process.env.NIVARO_IMAGE_VARIANT
  process.env.MEDIA_WORKER = 'on'
  st.ffmpeg = true
  st.chromium = opts.chromium ?? true
  const started = await m.startMediaWorker({
    redis,
    instance: 'w1',
    name: 'efp-worker',
    version: '9.9.9',
    run: opts.run
  })
  expect(started).toBe(true)
}

describe('placing media work on a slim process', () => {
  it('hands every kind to the media worker when the binaries are missing', async () => {
    await putBeat()
    for (const k of m.HANDOFF_KINDS) expect(await m.mediaPlacement(k)).toBe('worker')
  })

  it('refuses at once (503) when no media worker has checked in, never accepting dead work', async () => {
    await expect(m.mediaPlacement('clip')).rejects.toMatchObject({
      statusCode: 503,
      code: 'RENDER_UNAVAILABLE',
      message: expect.stringMatching(/no media worker has checked in/)
    })
    await putBeat(false) // a worker without Chromium: clips yes, replay videos no
    expect(await m.mediaPlacement('clip')).toBe('worker')
    await expect(m.mediaPlacement('replay-webm')).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringMatching(/no Chromium/)
    })
  })

  it("scopes every key to this instance's database", () => {
    const db = config.DB_DATABASE.toLowerCase().replace(/[^a-z0-9_.-]/g, '_')
    expect(m.handoffKey('clip')).toBe(`nvr:media-handoff:${db}:clip`)
    expect(m.handoffKickChannel()).toBe(`nvr:media-handoff:${db}:kick`)
    expect(m.mediaWorkerKey()).toBe(`nvr:media-worker:${db}`)
  })

  it('runs here when the binaries are here (Chromium only matters for replay videos)', async () => {
    await putBeat()
    st.ffmpeg = true
    expect(await m.mediaPlacement('clip')).toBe('here')
    expect(await m.mediaPlacement('replay-webm')).toBe('worker')
    st.chromium = true
    expect(await m.mediaPlacement('replay-webm')).toBe('here')
  })

  it('without Redis or in cloud mode it is the readable 503, never a crash', async () => {
    st.app = null
    await expect(m.mediaPlacement('clip')).rejects.toMatchObject({
      statusCode: 503,
      code: 'RENDER_UNAVAILABLE'
    })
    st.app = { redis }
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    await expect(m.handOff('clip', { id: ID })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('queues the job on its list and kicks the worker', async () => {
    await m.handOff('clip', { id: ID })
    expect(redis.lists.get(m.handoffKey('clip'))).toHaveLength(1)
    expect(JSON.parse(redis.lists.get(m.handoffKey('clip'))![0])).toMatchObject({
      kind: 'clip',
      payload: { id: ID }
    })
    expect(redis.published).toEqual([{ channel: m.handoffKickChannel(), message: 'clip' }])
  })

  it('caps queued replay videos per person (429), atomically, and keeps a record of each', async () => {
    for (let i = 0; i < 5; i++) await m.handOff('replay-webm', { ...replayJob }, { user: USER })
    await expect(m.handOff('replay-webm', { ...replayJob }, { user: USER })).rejects.toMatchObject({
      statusCode: 429,
      code: 'MEDIA_HANDOFF_USER_LIMIT'
    })
    await m.handOff('replay-webm', { ...replayJob, userId: ID }, { user: ID }) // someone else
    expect(redis.hashes.get(m.handoffRecordsKey('replay-webm'))?.size).toBe(6)
    expect(await redis.llen(m.handoffKey('replay-webm'))).toBe(6)
    await expect(m.handOff('replay-webm', { ...replayJob })).rejects.toThrow(/requester/)
  })

  it('turns a new job away past the backlog cap', async () => {
    for (let i = 0; i < 500; i++) await redis.rpush(m.handoffKey('extras'), '{}')
    await expect(m.handOff('extras', { user_id: USER })).rejects.toMatchObject({
      statusCode: 503,
      code: 'RENDER_BUSY'
    })
  })
})

describe('the media worker', () => {
  it('is never the slim image, web, cloud or a dev box; on a ticking full process', () => {
    expect(m.mediaWorkerEnabled({ MEDIA_WORKER: 'on' })).toBe(false) // slim, set in beforeEach
    delete process.env.NIVARO_IMAGE_VARIANT
    expect(m.mediaWorkerEnabled({ MEDIA_WORKER: 'on' })).toBe(true)
    expect(m.mediaWorkerEnabled({ MEDIA_WORKER: 'off', CRON_TICKS: 'on' })).toBe(false)
    process.env.CRON_TICKS = 'on'
    expect(m.mediaWorkerEnabled({ NIVARO_ROLE: 'worker' })).toBe(true)
    expect(m.mediaWorkerEnabled({ NIVARO_ROLE: 'web' })).toBe(false)
    process.env.CRON_TICKS = 'off'
    expect(m.mediaWorkerEnabled({})).toBe(false)
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect(m.mediaWorkerEnabled({ MEDIA_WORKER: 'on' })).toBe(false)
  })

  it('does not start without ffmpeg', async () => {
    delete process.env.NIVARO_IMAGE_VARIANT
    process.env.MEDIA_WORKER = 'on'
    expect(await m.startMediaWorker({ redis, instance: 'w1', name: null, version: '1' })).toBe(
      false
    )
  })

  it('drains what slim processes handed off, through each runner, and checks in', async () => {
    await m.handOff('clip', { id: ID })
    await m.handOff('captions', { version_id: ID })
    const input = {
      uploadId: ID,
      fileId: USER,
      mime: 'video/webm',
      durationMs: 4000,
      width: 1280,
      height: 720,
      hasAudio: true
    }
    await m.handOff('extras', { user_id: USER, input })
    const job = replayJob
    await m.handOff('replay-webm', job, { user: USER })
    await becomeWorker()
    for (const k of m.HANDOFF_KINDS) await m.drainForTests(k)
    // One queue per kind, drained side by side.
    expect(st.ran).toHaveLength(4)
    expect(st.ran).toEqual(
      expect.arrayContaining([
        { kind: 'clip', arg: ID },
        { kind: 'captions', arg: ID },
        { kind: 'extras', arg: { userId: USER, input } },
        { kind: 'replay-webm', arg: job }
      ])
    )
    for (const k of m.HANDOFF_KINDS) expect(await redis.llen(m.handoffKey(k))).toBe(0)
    // A job that ran leaves no record behind.
    expect(redis.hashes.get(m.handoffRecordsKey('replay-webm'))?.size).toBe(0)
    expect(await m.readMediaWorker(redis)).toMatchObject({
      instance: 'w1',
      name: 'efp-worker',
      version: '9.9.9',
      chromium: true
    })
  })

  it('a kick drains at once; a render kick wakes the render queue owner', async () => {
    await becomeWorker()
    process.env.NIVARO_IMAGE_VARIANT = 'slim' // the sender's side; the worker is running
    await m.handOff('clip', { id: ID })
    await vi.waitFor(() => expect(st.ran).toEqual([{ kind: 'clip', arg: ID }]))
    m.kickMediaWorker('render')
    await vi.waitFor(() => expect(st.renderKicks).toBe(1))
  })

  it('drops a job whose payload is not what its kind sends, and a stale one', async () => {
    await redis.rpush(
      m.handoffKey('clip'),
      JSON.stringify({ kind: 'clip', payload: { id: "1'; DROP" }, at: Date.now() })
    )
    await redis.rpush(
      m.handoffKey('clip'),
      JSON.stringify({ kind: 'clip', payload: { id: ID }, at: Date.now() - 25 * 3_600_000 })
    )
    await redis.rpush(m.handoffKey('clip'), 'not json')
    await becomeWorker()
    await m.drainForTests('clip')
    expect(st.ran).toEqual([])
    expect(await redis.llen(m.handoffKey('clip'))).toBe(0)
  })

  it('a worker without Chromium leaves replay videos for one that has it', async () => {
    await m.handOff('replay-webm', { ...replayJob }, { user: USER })
    await becomeWorker({ chromium: false })
    await m.drainForTests('replay-webm')
    expect(st.ran).toEqual([])
    expect(await redis.llen(m.handoffKey('replay-webm'))).toBe(1)
  })
})

describe('judging the media worker (readiness + preflight)', () => {
  const beat = {
    instance: 'w1',
    name: 'efp-worker',
    version: '1.0.0',
    ffmpeg: true,
    chromium: true,
    at: new Date().toISOString(),
    age_ms: 4000
  }
  const none = { ffmpeg: false, chromium: false }

  it('passes with the binaries here, whatever else', () => {
    expect(
      m.judgeMediaWorker(
        { ffmpeg: true, chromium: true },
        { variant: 'slim', cloud: false, redis: false, worker: null }
      ).status
    ).toBe('ok')
  })

  it('FAILS on the slim image without a worker heartbeat, warns elsewhere', () => {
    const ctx = { cloud: false, redis: true, worker: null }
    expect(m.judgeMediaWorker(none, { ...ctx, variant: 'slim' }).status).toBe('fail')
    expect(m.judgeMediaWorker(none, { ...ctx, variant: null }).status).toBe('warn')
    expect(m.judgeMediaWorker(none, { ...ctx, redis: false, variant: 'slim' }).status).toBe('fail')
    expect(m.judgeMediaWorker(none, { ...ctx, cloud: true, variant: 'slim' }).status).toBe('fail')
    // A deploy canary runs on its own Redis without the worker: warn only.
    expect(m.judgeMediaWorker(none, { ...ctx, variant: 'slim', role: 'canary' }).status).toBe(
      'warn'
    )
  })

  it('fails when nobody can make replay videos; passes with a full worker', () => {
    const ctx = { variant: 'slim' as const, cloud: false, redis: true }
    expect(m.judgeMediaWorker(none, { ...ctx, worker: { ...beat, chromium: false } }).status).toBe(
      'fail'
    )
    const ok = m.judgeMediaWorker(none, {
      ...ctx,
      worker: beat,
      backlog: { clip: 2, captions: 0, extras: 0, 'replay-webm': 0 }
    })
    expect(ok.status).toBe('ok')
    expect(ok.summary).toMatch(/efp-worker .*waiting: 2 clip/)
  })
})

describe('a queued replay export never vanishes', () => {
  it('a stale job: the requester hears it failed, the record is gone', async () => {
    await m.handOff('replay-webm', { ...replayJob }, { user: USER })
    const list = redis.lists.get(m.handoffKey('replay-webm'))!
    const item = JSON.parse(list[0])
    item.at = Date.now() - 25 * 3_600_000
    list[0] = JSON.stringify(item)
    await becomeWorker()
    await m.drainForTests('replay-webm')
    expect(st.ran).toEqual([])
    expect(st.drops).toEqual([
      { user: USER, recording: ID, why: 'it waited too long for the media worker' }
    ])
    expect(redis.hashes.get(m.handoffRecordsKey('replay-webm'))?.size).toBe(0)
  })

  it('a job the worker could not start: failed + notified', async () => {
    await m.handOff('replay-webm', { ...replayJob }, { user: USER })
    await becomeWorker({
      run: {
        'replay-webm': async () => {
          throw new Error('boom')
        }
      }
    })
    await m.drainForTests('replay-webm')
    expect(st.drops).toEqual([
      { user: USER, recording: ID, why: 'the media worker could not start it' }
    ])
  })

  it('a record whose job was lost (crash, unreadable item) is swept as failed', async () => {
    await m.handOff('replay-webm', { ...replayJob }, { user: USER })
    redis.lists.set(m.handoffKey('replay-webm'), ['not json'])
    const recs = redis.hashes.get(m.handoffRecordsKey('replay-webm'))!
    const [id, raw] = [...recs.entries()][0]
    recs.set(id, JSON.stringify({ ...JSON.parse(raw), at: Date.now() - 26 * 3_600_000 }))
    await becomeWorker()
    await m.drainForTests('replay-webm')
    expect(st.drops).toEqual([]) // the unreadable item names no record...
    await m.sweepForTests()
    expect(st.drops).toEqual([
      { user: USER, recording: ID, why: 'it was lost on the way to the media worker' }
    ])
    expect(recs.size).toBe(0)
  })

  it('a young record is left alone by the sweep', async () => {
    await m.handOff('replay-webm', { ...replayJob }, { user: USER })
    redis.lists.set(m.handoffKey('replay-webm'), [])
    await becomeWorker()
    await m.sweepForTests()
    expect(st.drops).toEqual([])
  })
})

describe('the worker runs on the background pool', () => {
  it('runners execute inside runInBackgroundPool (never the request pool)', async () => {
    await m.handOff('clip', { id: ID })
    const seen: boolean[] = []
    await becomeWorker({
      run: {
        clip: async () => {
          seen.push(inBackgroundPool())
        }
      }
    })
    await m.drainForTests('clip')
    expect(seen).toEqual([true])
  })
})
