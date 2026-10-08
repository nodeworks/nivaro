import { mkdirSync, mkdtempSync, utimesSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyEdits } from '../../../services/help-video-edits.js'

type Row = Record<string, unknown>
type Op = { op: string; table?: string; patch?: Row; ids?: string[] }
const tables: Record<string, Row[]> = {}
const ops: Op[] = []

const col = (k: string) => k.replace(/^\w+\./, '')
const time = (v: unknown) => new Date(v as string).getTime()
function compare(a: unknown, op: string, b: unknown): boolean {
  if (a == null) return false
  const x = time(a)
  const y = time(b)
  if (op === '<') return x < y
  if (op === '>') return x > y
  if (op === '<=') return x <= y
  if (op === '>=') return x >= y
  return x === y
}
function builder(name: string) {
  const table = name.split(' as ')[0]
  const conds: Array<(r: Row) => boolean> = []
  let order: [string, string] | null = null
  const rows = () => {
    tables[table] ??= []
    return tables[table]
  }
  const sel = () => {
    const out = rows().filter((r) => conds.every((c) => c(r)))
    if (order) {
      const [k, dir] = order
      out.sort(
        (a, b) =>
          (time(a[k]) - time(b[k]) || Number(a[k]) - Number(b[k])) * (dir === 'desc' ? -1 : 1)
      )
    }
    return out
  }
  const b: Record<string, unknown> = {
    where(c: Row | string, op?: string, v?: unknown) {
      if (typeof c === 'string') conds.push((r) => compare(r[col(c)], String(op), v))
      else
        for (const [k, v2] of Object.entries(c))
          conds.push((r) => String(r[col(k)]).toLowerCase() === String(v2).toLowerCase())
      return b
    },
    whereNotNull(k: string) {
      conds.push((r) => r[col(k)] != null)
      return b
    },
    whereRaw: () => b,
    join: () => b,
    orderBy(k: string, dir = 'asc') {
      order = [col(k), dir]
      return b
    },
    // Reads hand back copies, as a real driver does.
    first: async () => {
      const hit = sel()[0]
      return hit ? { ...hit } : undefined
    },
    select: async () => sel().map((x) => ({ ...x })),
    update: async (patch: Row) => {
      const hit = sel()
      for (const r of hit) Object.assign(r, patch)
      ops.push({ op: 'update', table, patch, ids: hit.map((r) => String(r.id)) })
      return hit.length
    }
  }
  return b
}
vi.mock('../../../db/index.js', () => ({ db: (name: string) => builder(name) }))

const ff = { has: true, probed: 0, during: null as null | (() => void) }
vi.mock('../../../services/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/ffmpeg.js')>()),
  hasFfmpeg: async () => ff.has,
  probeVideo: async () => {
    ff.probed++
    return { duration_ms: 1000, width: 640, height: 360, has_audio: false }
  },
  runFfmpeg: async (args: string[]) => {
    const hook = ff.during
    ff.during = null
    hook?.()
    await writeFile(args[args.length - 1], 'x')
  }
}))
const files = { source: { filename_disk: 'k', type: 'video/webm' } as Row, n: 0 }
vi.mock('../../../services/files.js', () => ({
  getFile: async () => files.source,
  uploadFileFromPath: async () => ({ id: `new-${++files.n}` }),
  deleteFile: async (id: string) => {
    ops.push({ op: 'deleteFile', ids: [id] })
  }
}))
vi.mock('../../../services/stored-object-stream.js', () => ({
  openStoredObject: async () => ({ stream: Readable.from([Buffer.from('source bytes')]) })
}))
vi.mock('../../../services/help-video-annotations.js', () => ({
  rasterizeAnnotations: async () => []
}))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: async () => ({
    id: 7,
    progress() {},
    complete: async () => {},
    fail: async () => {}
  })
}))
const app = { current: null as unknown }
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => app.current }))
const work = mkdtempSync(join(tmpdir(), 'nvr-render-'))
vi.mock('../../../services/help-video-uploads.js', () => ({ videoWorkDir: () => work }))

const r = await import('../../../services/help-video-render.js')

const HOUR = 3_600_000
function version(id: string, extra: Row = {}): Row {
  return {
    id,
    video_id: 'vid',
    edits: JSON.stringify(emptyEdits(1000)),
    edits_hash: `hash-${id}`,
    source_file: `src-${id}`,
    source_duration_ms: 1000,
    render_status: 'queued',
    render_started_at: null,
    created_at: new Date(Date.now() - HOUR),
    created_by: 'user',
    rendered_file: null,
    captions_file: null,
    poster_file: null,
    ...extra
  }
}
const versions = () => {
  tables.nivaro_help_video_versions ??= []
  return tables.nivaro_help_video_versions
}
const row = (id: string) => versions().find((v) => v.id === id) as Row
const claims = () =>
  ops
    .filter((o) => o.op === 'update' && o.patch?.render_status === 'rendering')
    .flatMap((o) => o.ids)
const deleted = () => ops.filter((o) => o.op === 'deleteFile').flatMap((o) => o.ids)

async function settle() {
  for (let i = 0; i < 50; i++) {
    const p = r.whenRendererIdle()
    await p
    await new Promise((res) => setTimeout(res, 0))
    if (p === r.whenRendererIdle()) return
  }
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  ops.length = 0
  ff.has = true
  ff.probed = 0
  ff.during = null
  files.source = { filename_disk: 'k', type: 'video/webm' }
  files.n = 0
  app.current = null
})
afterEach(async () => {
  await settle()
  delete process.env.CRON_TICKS
  delete process.env.VIDEO_RENDER
})

describe('who renders', () => {
  it("a non-owner's boot kick claims nothing", async () => {
    process.env.CRON_TICKS = 'off'
    versions().push(version('a'))
    r.kickRenderer()
    await settle()
    expect(claims()).toEqual([])
    expect(row('a').render_status).toBe('queued')
  })

  it('VIDEO_RENDER=on makes a ticks-off process an owner', () => {
    process.env.CRON_TICKS = 'off'
    expect(r.ownsRenderQueue()).toBe(false)
    process.env.VIDEO_RENDER = 'on'
    expect(r.ownsRenderQueue()).toBe(true)
  })

  it("a non-owner's queueRender claims and renders only that id", async () => {
    process.env.CRON_TICKS = 'off'
    versions().push(version('a'), version('b'))
    await r.queueRender('b')
    await settle()
    expect(claims()).toEqual(['b'])
    expect(row('a').render_status).toBe('queued')
    expect(row('b')).toMatchObject({
      render_status: 'ready',
      rendered_hash: 'hash-b',
      rendered_file: 'new-1'
    })
  })

  it('an owner drains the whole queue', async () => {
    process.env.CRON_TICKS = 'on'
    versions().push(version('a'), version('b'))
    r.kickRenderer()
    await settle()
    expect(claims().sort()).toEqual(['a', 'b'])
    expect(versions().map((v) => v.render_status)).toEqual(['ready', 'ready'])
  })

  it('a process without ffmpeg never claims a row', async () => {
    ff.has = false
    process.env.CRON_TICKS = 'off'
    versions().push(version('a'))
    await r.queueRender('a')
    await settle()
    expect(row('a').render_status).toBe('queued') // left for a process that can render
    process.env.CRON_TICKS = 'on'
    r.kickRenderer()
    await settle()
    expect(claims()).toEqual([])
    expect(row('a').render_status).toBe('unavailable') // an owner says so on the row
  })

  it('claims inside the heavy slot', async () => {
    process.env.CRON_TICKS = 'on'
    app.current = {
      cron: {
        withHeavySlot: async (_label: string, w: () => Promise<void>) => {
          ops.push({ op: 'slot-enter' })
          await w()
          ops.push({ op: 'slot-exit' })
        }
      }
    }
    versions().push(version('a'))
    r.kickRenderer()
    await settle()
    const at = (pred: (o: Op) => boolean) => ops.findIndex(pred)
    const enter = at((o) => o.op === 'slot-enter')
    const claim = at((o) => o.patch?.render_status === 'rendering')
    const exit = at((o) => o.op === 'slot-exit')
    expect(enter).toBeGreaterThanOrEqual(0)
    expect(claim).toBeGreaterThan(enter)
    expect(exit).toBeGreaterThan(claim)
  })
})

describe('claim token', () => {
  it('a final update with a stale claim discards the new files', async () => {
    process.env.CRON_TICKS = 'off'
    versions().push(version('a'))
    // Another process re-claims the row while this one renders.
    ff.during = () => {
      row('a').render_started_at = new Date(Date.now() + 60_000)
    }
    await r.queueRender('a')
    await settle()
    expect(row('a')).toMatchObject({ render_status: 'rendering', rendered_file: null })
    expect(deleted().sort()).toEqual(['new-1', 'new-2', 'new-3'])
  })

  it('a version purged mid-render leaves no files behind', async () => {
    process.env.CRON_TICKS = 'off'
    versions().push(version('a'))
    ff.during = () => {
      versions().length = 0
    }
    await r.queueRender('a')
    await settle()
    expect(deleted().sort()).toEqual(['new-1', 'new-2', 'new-3'])
  })

  it('refuses an unsupported recording format before probing it', async () => {
    process.env.CRON_TICKS = 'off'
    files.source = { filename_disk: 'k', type: 'video/quicktime' }
    versions().push(version('a'))
    await r.queueRender('a')
    await settle()
    expect(ff.probed).toBe(0)
    expect(row('a')).toMatchObject({
      render_status: 'failed',
      render_error: "This recording's format can't be processed. Try recording it again."
    })
  })
})

describe('sweepRenders', () => {
  const started = (msAgo: number) => new Date(Date.now() - msAgo)
  const run = (id: string, status: string, at: Date) => ({
    id: tables.nivaro_job_runs?.length ?? 0,
    kind: 'render',
    job_id: `help-video:${id}`,
    status,
    started_at: new Date(at.getTime() + 10)
  })

  it('leaves a live render alone and re-queues a dead or 6-hour-old one', async () => {
    process.env.CRON_TICKS = 'off' // the sweep's kick must not render here
    const live = started(HOUR)
    const dead = started(HOUR)
    const ancient = started(7 * HOUR)
    versions().push(
      version('live', { render_status: 'rendering', render_started_at: live }),
      version('dead', { render_status: 'rendering', render_started_at: dead }),
      version('ancient', { render_status: 'rendering', render_started_at: ancient })
    )
    tables.nivaro_job_runs = []
    tables.nivaro_job_runs.push(run('live', 'running', live))
    tables.nivaro_job_runs.push(run('dead', 'interrupted', dead))
    tables.nivaro_job_runs.push(run('ancient', 'running', ancient))
    expect(await r.sweepRenders()).toBe(2)
    expect(row('live').render_status).toBe('rendering')
    expect(row('dead').render_status).toBe('queued')
    expect(row('ancient').render_status).toBe('queued')
  })

  it('ignores an older run of the same version', async () => {
    process.env.CRON_TICKS = 'off'
    const now = started(HOUR)
    versions().push(version('a', { render_status: 'rendering', render_started_at: now }))
    tables.nivaro_job_runs = [run('a', 'completed', started(5 * HOUR))]
    // No run since this claim and still inside the grace period: alive.
    versions()[0].render_started_at = started(60_000)
    expect(await r.sweepRenders()).toBe(0)
    // Past the grace period with still no run: the claimer died.
    versions()[0].render_started_at = started(HOUR)
    expect(await r.sweepRenders()).toBe(1)
  })
})

describe('pruneOldRenders', () => {
  it("unlinks the version's files before deleting them", async () => {
    versions().push(
      version('old', {
        render_status: 'ready',
        rendered_file: 'r1',
        captions_file: 'c1',
        poster_file: 'p1',
        created_at: new Date(Date.now() - 40 * 86_400_000)
      })
    )
    expect(await r.pruneOldRenders()).toBe(1)
    const unlink = ops.findIndex((o) => o.op === 'update' && o.patch?.rendered_file === null)
    const firstDelete = ops.findIndex((o) => o.op === 'deleteFile')
    expect(unlink).toBeGreaterThanOrEqual(0)
    expect(firstDelete).toBeGreaterThan(unlink)
    expect(deleted()).toEqual(['r1', 'c1', 'p1'])
    expect(row('old')).toMatchObject({ render_status: 'none', rendered_hash: null })
  })
})

describe('cleanRenderScratch', () => {
  it('removes only scratch directories older than 24 hours', async () => {
    const base = join(work, 'render')
    mkdirSync(join(base, 'old-1'), { recursive: true })
    mkdirSync(join(base, 'young-1'), { recursive: true })
    const old = new Date(Date.now() - 25 * HOUR)
    utimesSync(join(base, 'old-1'), old, old)
    expect(await r.cleanRenderScratch()).toBe(1)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(base)).toContain('young-1')
    expect(readdirSync(base)).not.toContain('old-1')
  })
})
