import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyEdits } from '../../../services/help-video-edits.js'

// #1532 cancel + #1561 hardware fallback, through the real renderer.

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}
const col = (k: string) => k.replace(/^\w+\./, '')
const time = (v: unknown) => new Date(v as string).getTime()
function compare(a: unknown, op: string, b: unknown): boolean {
  if (a == null) return false
  const x = time(a)
  const y = time(b)
  if (op === '<') return x < y
  if (op === '>') return x > y
  if (op === '>=') return x >= y
  return x === y
}
function builder(name: string) {
  const table = name.split(' as ')[0]
  const conds: Array<(r: Row) => boolean> = []
  const rows = () => {
    tables[table] ??= []
    return tables[table]
  }
  const sel = () => rows().filter((r) => conds.every((c) => c(r)))
  const b: Record<string, unknown> = {
    where(c: Row | string, op?: string, v?: unknown) {
      if (typeof c === 'string') {
        if (v === undefined) conds.push((r) => String(r[col(c)]) === String(op))
        else conds.push((r) => compare(r[col(c)], String(op), v))
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

const ff = {
  calls: [] as string[][],
  failCodec: null as string | null,
  during: null as null | (() => Promise<void>)
}
vi.mock('../../../services/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/ffmpeg.js')>()),
  hasFfmpeg: async () => true,
  probeVideo: async () => ({ duration_ms: 1000, width: 640, height: 360, has_audio: true }),
  runFfmpeg: async (args: string[], _p: unknown, signal?: AbortSignal) => {
    ff.calls.push(args)
    const hook = ff.during
    ff.during = null
    await hook?.()
    if (signal?.aborted) throw new Error('aborted')
    const codec = args.includes('-c:v') ? args[args.indexOf('-c:v') + 1] : null
    if (codec && codec === ff.failCodec) throw new Error(`${codec}: encoder failed`)
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
const runs = { completed: [] as string[], failed: 0 }
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: async () => ({
    id: 41,
    progress() {},
    complete: async (o: string) => {
      runs.completed.push(o)
    },
    fail: async () => {
      runs.failed++
    }
  })
}))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
const work = mkdtempSync(join(tmpdir(), 'nvr-render-cancel-'))
vi.mock('../../../services/help-video-uploads.js', () => ({
  videoWorkDir: () => work,
  discardFile: async () => true
}))
const settings = { hardware: 'off' as 'off' | 'auto' }
vi.mock('../../../services/help-video-settings.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/help-video-settings.js')>()
  return {
    ...real,
    renderEncoderSettings: async () => ({ ...real.ENCODER_DEFAULTS, hardware: settings.hardware })
  }
})
vi.mock('../../../services/help-video-encoder.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/help-video-encoder.js')>()
  return {
    ...real,
    // This host "has" VideoToolbox whenever the settings allow hardware.
    planVideoEncode: async (
      s: { hardware: string },
      size: { width: number; height: number },
      ms: number
    ) =>
      s.hardware === 'auto'
        ? real.hardwarePlan('videotoolbox', s as never, size)
        : real.softwarePlan(s as never, size, ms)
  }
})

const r = await import('../../../services/help-video-render.js')

function version(id: string, extra: Row = {}): Row {
  return {
    id,
    video_id: 'vid',
    version: 1,
    edits: JSON.stringify(emptyEdits(1000)),
    edits_hash: `hash-${id}`,
    source_file: `src-${id}`,
    source_duration_ms: 1000,
    render_status: 'queued',
    render_started_at: null,
    created_at: new Date(Date.now() - 3_600_000),
    created_by: 'user',
    ...extra
  }
}
const versions = () => {
  tables.nivaro_help_video_versions ??= []
  return tables.nivaro_help_video_versions
}
const row = (id: string) => versions().find((v) => v.id === id) as Row
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
  ff.calls = []
  ff.failCodec = null
  ff.during = null
  runs.completed = []
  runs.failed = 0
  settings.hardware = 'off'
  process.env.CRON_TICKS = 'off'
})
afterEach(async () => {
  await settle()
  delete process.env.CRON_TICKS
})

describe('cancelRender', () => {
  it('takes a queued version off the queue for good', async () => {
    versions().push(version('a'))
    const res = await r.cancelRender('a', 'Robert Lee')
    expect(res).toEqual({ cancelled: true, was: 'queued' })
    expect(row('a')).toMatchObject({ render_status: 'failed', render_progress: null })
    expect(String(row('a').render_error)).toMatch(/^Cancelled by Robert Lee\./)
    process.env.CRON_TICKS = 'on' // an owner drains the queue: nothing to take
    r.kickRenderer()
    await settle()
    expect(ff.calls).toEqual([])
    expect(row('a').render_status).toBe('failed')
  })

  it('says so when the version is not queued or rendering', async () => {
    versions().push(version('a', { render_status: 'ready' }))
    expect(await r.cancelRender('a', null)).toEqual({ cancelled: false, was: 'ready' })
    expect(row('a').render_status).toBe('ready')
  })

  it('stops a running render: ffmpeg aborted, row failed, run marked cancelled', async () => {
    versions().push(version('a'))
    let seenActive: string[] = []
    ff.during = async () => {
      seenActive = r.activeRenderKeys()
      await r.cancelRender('a', 'Robert Lee')
    }
    await r.queueRender('a')
    await settle()
    expect(seenActive).toEqual(['a'])
    expect(row('a').render_status).toBe('failed')
    expect(String(row('a').render_error)).toMatch(/^Cancelled by Robert Lee\./)
    expect(row('a').rendered_file ?? null).toBeNull()
    expect(runs.completed[0]).toMatch(/^cancelled/)
    expect(runs.failed).toBe(0)
    expect(r.activeRenderKeys()).toEqual([])
    // Only the one (aborted) encode ran: no poster, no retry.
    expect(ff.calls).toHaveLength(1)
  })

  it('stops a render whose claim another process took away', async () => {
    versions().push(version('a'))
    ff.during = async () => {
      // Another process cancelled it: the row is failed, the claim is gone.
      Object.assign(row('a'), { render_status: 'failed', render_error: 'Cancelled elsewhere' })
      await new Promise((res) => setTimeout(res, 5_200))
    }
    await r.queueRender('a')
    await settle()
    expect(row('a')).toMatchObject({ render_status: 'failed', render_error: 'Cancelled elsewhere' })
    expect(runs.completed[0]).toMatch(/^cancelled/)
  }, 10_000)
})

describe('hardware fallback', () => {
  it('renders with VideoToolbox when allowed and it works', async () => {
    settings.hardware = 'auto'
    versions().push(version('a'))
    await r.queueRender('a')
    await settle()
    expect(row('a').render_status).toBe('ready')
    expect(ff.calls[0]).toContain('h264_videotoolbox')
    expect(runs.completed[0]).toMatch(/h264_videotoolbox/)
  })

  it('retries once in software when the hardware encode fails', async () => {
    settings.hardware = 'auto'
    ff.failCodec = 'h264_videotoolbox'
    versions().push(version('a'))
    await r.queueRender('a')
    await settle()
    expect(row('a').render_status).toBe('ready')
    const encodes = ff.calls.filter((c) => c.includes('-filter_complex'))
    expect(encodes.map((c) => c[c.indexOf('-c:v') + 1])).toEqual(['h264_videotoolbox', 'libx264'])
    expect(runs.completed[0]).toMatch(
      /libx264 veryfast crf 23 \(videotoolbox failed; encoded in software\)/
    )
  })

  it('fails (no second retry) when software fails too', async () => {
    ff.failCodec = 'libx264'
    versions().push(version('a'))
    await r.queueRender('a')
    await settle()
    expect(row('a').render_status).toBe('failed')
    expect(ff.calls.filter((c) => c.includes('-filter_complex'))).toHaveLength(1)
    expect(runs.failed).toBe(1)
  })
})
