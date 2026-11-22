import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyEdits } from '../../../services/help-video-edits.js'

// Ruling P5-15: on a Hub shared deployment (one process, many apps) a publish renders its own
// version in its own app's context, and the render-queue state is per app. Before, the one
// process-wide pump kept the context of the first app that started it: app B's publish during
// app A's render only set `again`, A's loop read A's database, and B's version stayed queued
// (no sweep runs on shared). Each app's database is its own table set here.

type Row = Record<string, unknown>
const dbs: Record<string, Record<string, Row[]>> = {}
const col = (k: string) => k.replace(/^\w+\./, '')
const { getTenantId, runWithTenantDb } = await import('../../../db/tenant-context.js')

function builder(name: string) {
  const app = getTenantId() ?? ''
  const table = name.split(' as ')[0]
  dbs[app] ??= {}
  const conds: Array<(r: Row) => boolean> = []
  const rows = () => {
    dbs[app][table] ??= []
    return dbs[app][table]
  }
  const sel = () => rows().filter((r) => conds.every((c) => c(r)))
  const b: Record<string, unknown> = {
    where(c: Row | string, op?: string, v?: unknown) {
      if (typeof c === 'string') {
        if (v === undefined) conds.push((r) => String(r[col(c)]) === String(op))
        else conds.push(() => true) // time windows: not what this test is about
      } else
        for (const [k, v2] of Object.entries(c))
          conds.push((r) => String(r[col(k)]).toLowerCase() === String(v2).toLowerCase())
      return b
    },
    whereIn(k: string, vs: unknown[]) {
      conds.push((r) => vs.map(String).includes(String(r[col(k)])))
      return b
    },
    whereNotNull: () => b,
    whereRaw: () => b,
    orderBy: () => b,
    first: async () => {
      const hit = sel()[0]
      return hit ? { ...hit } : undefined
    },
    select: async () => sel().map((x) => ({ ...x })),
    update: async (patch: Row) => {
      const hit = sel()
      for (const r of hit) Object.assign(r, patch)
      return hit.length
    }
  }
  return b
}
vi.mock('../../../db/index.js', () => ({ db: (name: string) => builder(name) }))

// A render blocks in ffmpeg while its app has a gate set.
const gates: Record<string, Promise<void> | undefined> = {}
const rendered: string[] = []
vi.mock('../../../services/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/ffmpeg.js')>()),
  hasFfmpeg: async () => true,
  probeVideo: async () => ({ duration_ms: 1000, width: 640, height: 360, has_audio: false }),
  runFfmpeg: async (args: string[], _p: unknown, signal?: AbortSignal) => {
    const app = getTenantId() ?? ''
    await gates[app]
    if (signal?.aborted) throw new Error('aborted')
    rendered.push(app)
    await writeFile(args[args.length - 1], 'x')
  }
}))
vi.mock('../../../services/files.js', () => ({
  getFile: async () => ({ filename_disk: 'k', type: 'video/webm' }),
  uploadFileFromPath: async () => ({ id: `new-${Math.random()}` }),
  deleteFile: async () => {}
}))
vi.mock('../../../services/stored-object-stream.js', () => ({
  openStoredObject: async () => ({ stream: Readable.from([Buffer.from('source bytes')]) })
}))
vi.mock('../../../services/help-video-annotations.js', () => ({
  rasterizeAnnotations: async () => []
}))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: async () => ({
    id: null,
    progress() {},
    complete: async () => {},
    fail: async () => {}
  })
}))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
const work = mkdtempSync(join(tmpdir(), 'nvr-render-shared-'))
vi.mock('../../../services/help-video-uploads.js', () => ({
  videoWorkDir: () => work,
  discardFile: async () => true
}))

const r = await import('../../../services/help-video-render.js')

function version(id: string): Row {
  return {
    id,
    video_id: 'vid',
    edits: JSON.stringify(emptyEdits(1000)),
    edits_hash: `hash-${id}`,
    source_file: `src-${id}`,
    source_duration_ms: 1000,
    render_status: 'queued',
    render_started_at: null,
    created_at: new Date(Date.now() - 3_600_000),
    created_by: 'user',
    rendered_file: null,
    captions_file: null,
    poster_file: null
  }
}
const versions = (app: string) => {
  dbs[app] ??= {}
  dbs[app].nivaro_help_video_versions ??= []
  return dbs[app].nivaro_help_video_versions
}
const status = (app: string, id: string) =>
  versions(app).find((v) => v.id === id)?.render_status as string | undefined

/** Run `fn` as app `id`; the result is boxed so a returned promise is not awaited here. */
const inApp = <T>(id: string, fn: () => T) =>
  new Promise<{ v: T }>((resolve) =>
    runWithTenantDb({} as never, id, () => resolve({ v: fn() }), id)
  )

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function idle(app: string) {
  for (let i = 0; i < 100; i++) {
    const { v: p } = await inApp(app, () => r.whenRendererIdle())
    await p
    await new Promise((res) => setTimeout(res, 0))
    const { v: q } = await inApp(app, () => r.whenRendererIdle())
    if (p === q) return
  }
}

beforeEach(() => {
  for (const k of Object.keys(dbs)) delete dbs[k]
  for (const k of Object.keys(gates)) delete gates[k]
  rendered.length = 0
  process.env.HUB_SHARED_DEPLOYMENT = 'demo'
  process.env.CRON_TICKS = 'on' // a ticking shared process: was a queue "owner"
})
afterEach(async () => {
  for (const k of Object.keys(gates)) delete gates[k]
  await idle('A')
  await idle('B')
  delete process.env.HUB_SHARED_DEPLOYMENT
  delete process.env.CRON_TICKS
})

describe('help-video renders on a shared deployment', () => {
  it("app B's publish during app A's render is rendered in B's database", async () => {
    versions('A').push(version('a'))
    versions('B').push(version('b'))
    const gateA = deferred()
    gates.A = gateA.promise
    await inApp('A', () => r.queueRender('a')).then((x) => x.v)
    await vi.waitFor(() => expect(status('A', 'a')).toBe('rendering'))
    await inApp('B', () => r.queueRender('b')).then((x) => x.v)
    // B renders while A is still blocked
    await vi.waitFor(() => expect(status('B', 'b')).toBe('ready'))
    expect(status('A', 'a')).toBe('rendering')
    gateA.resolve()
    await idle('A')
    expect(status('A', 'a')).toBe('ready')
    expect(new Set(rendered)).toEqual(new Set(['A', 'B']))
  })

  it("a publish renders only its own version, not the app's whole queue", async () => {
    versions('A').push(version('old'), version('new'))
    await inApp('A', () => r.queueRender('new')).then((x) => x.v)
    await idle('A')
    expect(status('A', 'new')).toBe('ready')
    expect(status('A', 'old')).toBe('queued')
  })

  it('kickRenderer drains nothing (no queue owner on a shared deployment)', async () => {
    versions('A').push(version('a'))
    await inApp('A', () => r.kickRenderer())
    await idle('A')
    expect(status('A', 'a')).toBe('queued')
  })

  it('Cancel in one app never aborts the same version rendering in another app', async () => {
    // Apps copied from one another (dev / staging / production) share version ids.
    versions('A').push(version('same'))
    versions('B').push(version('same'))
    const gateA = deferred()
    const gateB = deferred()
    gates.A = gateA.promise
    gates.B = gateB.promise
    await inApp('A', () => r.queueRender('same')).then((x) => x.v)
    await inApp('B', () => r.queueRender('same')).then((x) => x.v)
    await vi.waitFor(async () => {
      expect((await inApp('A', () => r.activeRenderKeys())).v).toEqual(['same'])
      expect((await inApp('B', () => r.activeRenderKeys())).v).toEqual(['same'])
    })
    await inApp('A', () => r.cancelRender('same', null)).then((x) => x.v)
    gateA.resolve()
    gateB.resolve()
    await idle('A')
    await idle('B')
    expect(status('A', 'same')).toBe('failed')
    expect(status('B', 'same')).toBe('ready')
  })
})

describe('off a shared deployment nothing changes', () => {
  it('a ticking self-hosted process still drains the whole queue on a publish', async () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    versions('').push(version('old'), version('new'))
    await r.queueRender('new')
    for (let i = 0; i < 100; i++) {
      const p = r.whenRendererIdle()
      await p
      await new Promise((res) => setTimeout(res, 0))
      if (p === r.whenRendererIdle()) break
    }
    expect(status('', 'new')).toBe('ready')
    expect(status('', 'old')).toBe('ready')
  })
})
