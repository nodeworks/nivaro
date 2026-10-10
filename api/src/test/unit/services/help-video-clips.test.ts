import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1562: making, listing and deleting clips, over a tiny table-aware stand-in
// for knex and a fake ffmpeg that copies its input to its output.

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {
  nivaro_help_video_clips: [],
  nivaro_help_video_versions: []
}
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()
const bare = (k: string) => k.replace(/^.*\./, '')
function builder(table: string) {
  if (!tables[table]) tables[table] = []
  const data = tables[table]
  const tests: Array<(r: Row) => boolean> = []
  const sel = () => data.filter((r) => tests.every((t) => t(r)))
  const b: Record<string, unknown> = {
    where(c: Row | string, op?: unknown, v?: unknown) {
      if (typeof c === 'string') {
        const k = bare(c)
        if (v === undefined) tests.push((r) => same(r[k], op))
        else tests.push((r) => new Date(r[k] as string).getTime() < (v as Date).getTime())
      } else for (const [k, val] of Object.entries(c)) tests.push((r) => same(r[bare(k)], val))
      return b
    },
    whereNot(c: Row) {
      for (const [k, val] of Object.entries(c)) tests.push((r) => !same(r[bare(k)], val))
      return b
    },
    whereIn(k: string, vals: unknown[]) {
      tests.push((r) => vals.some((v) => same(v, r[bare(k)])))
      return b
    },
    whereNull(k: string) {
      tests.push((r) => r[bare(k)] == null)
      return b
    },
    orderBy: () => b,
    limit: () => b,
    select: async () => sel().map((r) => ({ ...r })),
    count: () => ({ first: async () => ({ n: sel().length }) }),
    first: async () => (sel()[0] ? { ...sel()[0] } : undefined),
    update: async (patch: Row) => {
      const hit = sel()
      for (const r of hit) Object.assign(r, patch)
      return hit.length
    },
    insert: async (r: Row) => {
      data.push({ ...r })
    },
    delete: async () => {
      const hit = sel()
      for (const r of hit) data.splice(data.indexOf(r), 1)
      return hit.length
    },
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(sel().map((r) => ({ ...r }))).then(res, rej)
  }
  return b
}
vi.mock('../../../db/index.js', () => ({ db: (t: string) => builder(t) }))
const st = vi.hoisted(() => ({
  migrated: true,
  ffmpeg: true,
  ran: [] as string[][],
  graphs: [] as string[],
  uploads: 0
}))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => st.migrated }))
vi.mock('../../../services/ffmpeg.js', () => ({
  hasFfmpeg: async () => st.ffmpeg,
  lockedInputArgs: (mime: string) =>
    mime === 'video/mp4' || mime === 'video/webm' ? ['-f', mime] : ['-protocol_whitelist', 'file'],
  probeVideo: async () => ({ duration_ms: 60_000, width: 1920, height: 1080, has_audio: true }),
  runFfmpeg: async (args: string[], onProgress?: (ms: number) => void) => {
    st.ran.push(args)
    if (files.failWith) throw Object.assign(new Error(files.failWith), { stderr: files.failWith })
    // The graph comes by file, written before ffmpeg is started.
    if (args.includes('-filter_complex')) throw new Error('the graph was passed as an argument')
    st.graphs.push(readFileSync(args[args.indexOf('-filter_complex_script') + 1], 'utf8'))
    onProgress?.(1500)
    writeFileSync(args[args.length - 1], readFileSync(args[args.indexOf('-i') + 1]))
  }
}))
const files = vi.hoisted(() => ({ discarded: [] as string[], failWith: null as string | null }))
vi.mock('../../../services/files.js', () => ({
  getFile: async (id: string) =>
    id === 'missing' ? undefined : { id, filename_disk: `${id}.bin`, type: 'video/webm' },
  uploadFileFromPath: async () => ({ id: `clip-file-${++st.uploads}` })
}))
vi.mock('../../../services/help-video-uploads.js', () => ({
  discardFile: async (_u: unknown, id: string) => {
    files.discarded.push(id)
    return true
  },
  videoWorkDir: () => work
}))
vi.mock('../../../services/stored-object-stream.js', () => ({
  openStoredObject: async () => ({ stream: Readable.from([Buffer.from('video-bytes')]) })
}))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
const runs = vi.hoisted(() => ({ outcomes: [] as string[], failures: 0, failed: [] as string[] }))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: async () => ({
    id: 1,
    progress: () => {},
    complete: async (o: string) => {
      runs.outcomes.push(o)
    },
    fail: async (err: unknown) => {
      runs.failures++
      runs.failed.push(err instanceof Error ? err.message : String(err))
    }
  })
}))

const work = mkdtempSync(join(tmpdir(), 'nvr-clips-'))
const clips = await import('../../../services/help-video-clips.js')
const { emptyEdits, hashEdits } = await import('../../../services/help-video-edits.js')

const VIDEO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const VERSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const user = { id: 'U1' } as never
const edits = {
  ...emptyEdits(60_000),
  segments: [{ start_ms: 0, end_ms: 60_000, speed: 1 as const }]
}
const video = { id: VIDEO, published_version_id: VERSION, draft_version_id: null }

beforeEach(() => {
  for (const t of Object.values(tables)) t.length = 0
  tables.nivaro_help_video_versions.push({
    id: VERSION,
    video_id: VIDEO,
    source_file: 'src-file',
    rendered_file: null,
    rendered_hash: null,
    edits: JSON.stringify(edits),
    edits_hash: hashEdits(edits),
    source_duration_ms: 60_000,
    width: 1920,
    height: 1080
  })
  st.migrated = true
  st.ffmpeg = true
  st.ran = []
  st.graphs = []
  st.uploads = 0
  files.discarded = []
  files.failWith = null
  runs.outcomes = []
  runs.failures = 0
  runs.failed = []
})

describe('checkClipRange / cleanClipLabel', () => {
  it('accepts a window inside the video of half a second to 30 s', () => {
    expect(clips.checkClipRange(1000, 4000, 60_000)).toEqual({ start_ms: 1000, end_ms: 4000 })
    expect(clips.checkClipRange('1000.4', 31_000, 60_000)).toEqual({
      start_ms: 1000,
      end_ms: 31_000
    })
  })
  it('refuses a backwards, over-long, too-short or out-of-video window with 422', () => {
    for (const [a, b] of [
      [5000, 1000],
      ['x', 1000],
      [0, 30_001],
      [0, 400],
      [59_000, 60_001]
    ]) {
      expect(() => clips.checkClipRange(a, b, 60_000)).toThrow(
        expect.objectContaining({ statusCode: 422, code: 'HELP_VIDEO_CLIP_RANGE' })
      )
    }
  })
  it('trims and bounds the label', () => {
    expect(clips.cleanClipLabel('  Approve   the PO \n')).toBe('Approve the PO')
    expect(clips.cleanClipLabel('')).toBeNull()
    expect(clips.cleanClipLabel(42)).toBeNull()
    expect(clips.cleanClipLabel('x'.repeat(200))).toHaveLength(120)
  })
})

describe('serializeClip', () => {
  const row = {
    id: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
    video_id: VIDEO.toUpperCase(),
    version_id: VERSION,
    kind: 'gif',
    status: 'ready',
    progress: 100,
    error: null,
    start_ms: 1000,
    end_ms: 4000,
    label: 'Approve',
    bytes: 12_345,
    width: 640,
    height: 360,
    file_id: 'F',
    created_by: 'U1',
    created_at: new Date('2026-10-10T00:00:00Z')
  }
  it('links a ready clip through the ticketed route, lower-casing ids', () => {
    const dto = clips.serializeClip(row, 'TICKET')
    expect(dto.url).toBe(
      `/api/help-videos/${VIDEO}/clips/cccccccc-cccc-4ccc-8ccc-cccccccccccc?st=TICKET`
    )
    expect(dto).toMatchObject({ kind: 'gif', status: 'ready', bytes: 12_345, label: 'Approve' })
  })
  it('has no link while the clip is being made, or without a ticket', () => {
    expect(clips.serializeClip({ ...row, status: 'queued', file_id: null }, 'T').url).toBeNull()
    expect(clips.serializeClip(row, null).url).toBeNull()
  })
  it('tells authors why a clip failed, viewers only that it did', () => {
    const failed = { ...row, status: 'failed', error: 'The clip could not be made', file_id: null }
    expect(clips.serializeClip(failed, 'T', { author: true })).toMatchObject({
      status: 'failed',
      error: 'The clip could not be made'
    })
    expect(clips.serializeClip(failed, 'T', { author: false }).error).toBeNull()
    expect(clips.serializeClip(failed, 'T').error).toBeNull()
  })
})

describe('createClip', () => {
  it('queues a clip of the published version and renders it to a stored file', async () => {
    const row = await clips.createClip(video, user, {
      kind: 'mp4',
      start_ms: 1000,
      end_ms: 4000,
      label: 'Approve'
    })
    expect(row.status).toBe('queued')
    await clips.whenClipsIdle()
    const done = tables.nivaro_help_video_clips[0]
    expect(done).toMatchObject({
      status: 'ready',
      progress: 100,
      file_id: 'clip-file-1',
      width: 1280,
      height: 720
    })
    expect(Number(done.bytes)).toBeGreaterThan(0)
    expect(st.ran).toHaveLength(1)
    expect(st.ran[0]).toContain('libx264')
    // The graph went by file in the clip's scratch directory, not in argv.
    expect(st.ran[0][st.ran[0].indexOf('-filter_complex_script') + 1]).toMatch(
      new RegExp(`^${join(work, 'clips')}/[0-9a-f-]{36}-[0-9a-f]{8}/filters\\.txt$`)
    )
    expect(st.graphs[0]).toContain('[vout]')
    expect(runs.outcomes[0]).toMatch(/^mp4 · 3 s/)
    expect(existsSync(join(work, 'clips'))).toBe(true)
  })
  it('makes a GIF in two ffmpeg runs', async () => {
    await clips.createClip(video, user, { kind: 'gif', start_ms: 0, end_ms: 2000 })
    await clips.whenClipsIdle()
    expect(st.ran).toHaveLength(2)
    expect(st.graphs[0]).toContain('palettegen')
    expect(st.graphs[1]).toContain('paletteuse')
    expect(tables.nivaro_help_video_clips[0]).toMatchObject({ status: 'ready', width: 640 })
  })
  it('cuts from the render when it is current', async () => {
    const v = tables.nivaro_help_video_versions[0]
    v.rendered_file = 'render-file'
    v.rendered_hash = v.edits_hash
    await clips.createClip(video, user, { kind: 'mp4', start_ms: 10_000, end_ms: 12_000 })
    await clips.whenClipsIdle()
    const args = st.ran[0]
    expect(args[args.indexOf('-ss') + 1]).toBe('10.000')
    expect(args[args.indexOf('-i') + 1]).toMatch(/input\.mp4$/)
  })
  it('refuses before the migration, without ffmpeg, with a bad kind or no version', async () => {
    st.migrated = false
    await expect(
      clips.createClip(video, user, { kind: 'mp4', start_ms: 0, end_ms: 1000 })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'HELP_VIDEO_CLIPS_MIGRATION_PENDING'
    })
    st.migrated = true
    st.ffmpeg = false
    await expect(
      clips.createClip(video, user, { kind: 'mp4', start_ms: 0, end_ms: 1000 })
    ).rejects.toMatchObject({
      statusCode: 503
    })
    st.ffmpeg = true
    await expect(
      clips.createClip(video, user, { kind: 'webm', start_ms: 0, end_ms: 1000 })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'HELP_VIDEO_CLIP_INVALID'
    })
    await expect(
      clips.createClip({ ...video, published_version_id: null }, user, {
        kind: 'mp4',
        start_ms: 0,
        end_ms: 1000
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'HELP_VIDEO_NO_VERSION' })
    expect(tables.nivaro_help_video_clips).toHaveLength(0)
  })
  it('stops at 20 clips per video, failed ones not counted', async () => {
    for (let i = 0; i < 20; i++) {
      tables.nivaro_help_video_clips.push({
        id: `c${i}`,
        video_id: VIDEO,
        status: i ? 'ready' : 'failed'
      })
    }
    await clips.createClip(video, user, { kind: 'mp4', start_ms: 0, end_ms: 1000 })
    tables.nivaro_help_video_clips.push({ id: 'c20', video_id: VIDEO, status: 'queued' })
    await expect(
      clips.createClip(video, user, { kind: 'mp4', start_ms: 0, end_ms: 1000 })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'HELP_VIDEO_CLIP_LIMIT'
    })
    await clips.whenClipsIdle()
  })
  it('stops at 50 clips queued or being made across the instance', async () => {
    for (let i = 0; i < 50; i++) {
      tables.nivaro_help_video_clips.push({
        id: `q${i}`,
        video_id: `other-video-${i}`,
        status: i % 2 ? 'queued' : 'rendering'
      })
    }
    await expect(
      clips.createClip(video, user, { kind: 'mp4', start_ms: 0, end_ms: 1000 })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'HELP_VIDEO_CLIP_LIMIT',
      message: expect.stringMatching(/Too many clips are being made/)
    })
    expect(tables.nivaro_help_video_clips).toHaveLength(50)
    // Finished ones do not count.
    tables.nivaro_help_video_clips[0].status = 'ready'
    await clips.createClip(video, user, { kind: 'mp4', start_ms: 0, end_ms: 1000 })
    await clips.whenClipsIdle()
    expect(tables.nivaro_help_video_clips).toHaveLength(51)
  })
  it('fails the row with a plain reason when the recording is missing', async () => {
    tables.nivaro_help_video_versions[0].source_file = 'missing'
    await clips.createClip(video, user, { kind: 'mp4', start_ms: 0, end_ms: 1000 })
    await clips.whenClipsIdle()
    expect(tables.nivaro_help_video_clips[0]).toMatchObject({ status: 'failed' })
    expect(String(tables.nivaro_help_video_clips[0].error)).toMatch(/could not be made|missing/)
    expect(runs.failures).toBe(1)
  })
  it('keeps ffmpeg detail (scratch paths) out of the row: job run and log only', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    tables.nivaro_help_video_versions[0].source_file = 'unreadable'
    files.failWith = `Error opening ${join(work, 'clips', 'x', 'input.webm')}: Invalid data`
    await clips.createClip(video, user, { kind: 'mp4', start_ms: 0, end_ms: 1000 })
    await clips.whenClipsIdle()
    const row = tables.nivaro_help_video_clips[0]
    expect(row).toMatchObject({ status: 'failed', error: 'The clip could not be made' })
    expect(String(row.error)).not.toContain(work)
    expect(runs.failures).toBe(1)
    expect(runs.failed[0]).toContain(work)
    expect(warned.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(work)
    warned.mockRestore()
  })
})

describe('deleteClip / takeVideoClipFiles / failStaleClips', () => {
  it('deletes the row and the file, only for a clip of this video', async () => {
    await clips.createClip(video, user, { kind: 'mp4', start_ms: 0, end_ms: 1000 })
    await clips.whenClipsIdle()
    const id = String(tables.nivaro_help_video_clips[0].id)
    await expect(clips.deleteClip(user, 'other-video', id)).rejects.toMatchObject({
      statusCode: 404
    })
    await expect(clips.deleteClip(user, VIDEO, 'not-a-uuid')).rejects.toMatchObject({
      statusCode: 404
    })
    await clips.deleteClip(user, VIDEO, id)
    expect(tables.nivaro_help_video_clips).toHaveLength(0)
    expect(files.discarded).toEqual(['clip-file-1'])
  })
  it('hands the purge every clip file and drops the rows', async () => {
    tables.nivaro_help_video_clips.push(
      { id: 'c1', video_id: VIDEO, file_id: 'F1', status: 'ready' },
      { id: 'c2', video_id: VIDEO, file_id: null, status: 'failed' },
      { id: 'c3', video_id: 'other', file_id: 'F3', status: 'ready' }
    )
    expect(await clips.takeVideoClipFiles(VIDEO)).toEqual(['F1'])
    expect(tables.nivaro_help_video_clips.map((r) => r.id)).toEqual(['c3'])
  })
  it('fails clips a dead process left queued or rendering for an hour', async () => {
    const old = new Date(Date.now() - 2 * 3_600_000)
    tables.nivaro_help_video_clips.push(
      { id: 'c1', video_id: VIDEO, status: 'rendering', updated_at: old },
      { id: 'c2', video_id: VIDEO, status: 'queued', updated_at: new Date() },
      { id: 'c3', video_id: VIDEO, status: 'ready', updated_at: old }
    )
    expect(await clips.failStaleClips()).toBe(1)
    expect(tables.nivaro_help_video_clips.map((r) => r.status)).toEqual([
      'failed',
      'queued',
      'ready'
    ])
  })
})

describe('friendlyClipError', () => {
  it('names a missing recording or a cancel, and says nothing more of other failures', () => {
    expect(clips.friendlyClipError(new Error('Stored object not found'))).toBe(
      'The recording is missing from storage'
    )
    expect(clips.friendlyClipError(new Error('ffmpeg was cancelled'))).toBe(
      'The clip was cancelled'
    )
    expect(clips.friendlyClipError(new Error('ffmpeg exited with 1'))).toBe(
      'The clip could not be made'
    )
    expect(clips.friendlyClipError(new Error('/srv/work/clips/abc/input.webm: Invalid data'))).toBe(
      'The clip could not be made'
    )
  })
})
