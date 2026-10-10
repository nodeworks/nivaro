import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1560: the background job that builds a finalized upload's sprite sheet and
// peaks, over a fake ffmpeg (sprite: copies its input; peaks: writes a known
// PCM signal) and a tiny stand-in for knex.

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {
  nivaro_help_video_uploads: [],
  nivaro_help_video_versions: []
}
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()
function builder(table: string) {
  const data = tables[table]
  const tests: Array<(r: Row) => boolean> = []
  const sel = () => data.filter((r) => tests.every((t) => t(r)))
  const b: Record<string, unknown> = {
    where(c: Row) {
      for (const [k, v] of Object.entries(c)) tests.push((r) => same(r[k], v))
      return b
    },
    whereIn(k: string, vals: unknown[]) {
      tests.push((r) => vals.some((v) => same(v, r[k])))
      return b
    },
    whereNull(k: string) {
      tests.push((r) => r[k] == null)
      return b
    },
    update: async (patch: Row) => {
      if (st.dbFail) throw new Error('db down')
      const hit = sel()
      for (const r of hit) Object.assign(r, patch)
      return hit.length
    }
  }
  return b
}
vi.mock('../../../db/index.js', () => ({ db: (t: string) => builder(t) }))
const st = vi.hoisted(() => ({
  migrated: true,
  ffmpeg: true,
  dbFail: false,
  spriteFail: false,
  ran: [] as string[][],
  uploaded: [] as string[],
  discarded: [] as string[]
}))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => st.migrated }))
vi.mock('../../../services/ffmpeg.js', () => ({
  hasFfmpeg: async () => st.ffmpeg,
  lockedInputArgs: (mime: string) => ['-f', mime],
  runFfmpeg: async (args: string[]) => {
    st.ran.push(args)
    const out = args[args.length - 1]
    if (out.endsWith('.jpg')) {
      if (st.spriteFail) throw new Error('tile failed')
      writeFileSync(out, readFileSync(args[args.indexOf('-i') + 1]))
    } else {
      // 4000 Hz mono s16le: 0.3 s of silence, 0.1 s at half scale, 0.1 s at full.
      const pcm = Buffer.alloc(4000 * 2 * 0.5)
      for (let i = 1200; i < 1600; i++) pcm.writeInt16LE(16384, i * 2)
      for (let i = 1600; i < 2000; i++) pcm.writeInt16LE(32767, i * 2)
      writeFileSync(out, pcm)
    }
  }
}))
vi.mock('../../../services/files.js', () => ({
  getFile: async (id: string) => (id === 'gone' ? undefined : { id, filename_disk: `${id}.webm` }),
  uploadFileFromPath: async (_u: unknown, _p: string, name: string) => {
    st.uploaded.push(name)
    return { id: 'SPRITE-FILE' }
  }
}))
vi.mock('../../../services/stored-object-stream.js', () => ({
  openStoredObject: async () => ({ stream: Readable.from([Buffer.from('webm-bytes')]) })
}))
vi.mock('../../../services/help-video-uploads.js', () => ({
  withConversionSlot: async (_w: unknown, work: () => Promise<unknown>) => work(),
  videoWorkDir: () => work,
  discardFile: async (_u: unknown, id: string) => {
    st.discarded.push(id)
    return true
  }
}))

const work = mkdtempSync(join(tmpdir(), 'nvr-extras-'))
const { buildMediaExtras } = await import('../../../services/help-video-extras.js')

const UPLOAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const user = { id: 'U1' } as never
const input = {
  uploadId: UPLOAD,
  fileId: 'REC',
  mime: 'video/webm',
  durationMs: 12_500,
  width: 1920,
  height: 1080,
  hasAudio: true
}

beforeEach(() => {
  tables.nivaro_help_video_uploads.length = 0
  tables.nivaro_help_video_versions.length = 0
  tables.nivaro_help_video_uploads.push({ id: UPLOAD, file_id: 'REC', status: 'finalized' })
  st.migrated = true
  st.ffmpeg = true
  st.dbFail = false
  st.spriteFail = false
  st.ran = []
  st.uploaded = []
  st.discarded = []
})

describe('buildMediaExtras', () => {
  it('stores the sheet and the peaks on the upload row and on versions made from it', async () => {
    tables.nivaro_help_video_versions.push(
      { id: 'V1', source_file: 'REC', sprite_file: null, peaks: null },
      { id: 'V2', source_file: 'OTHER', sprite_file: null, peaks: null }
    )
    const out = await buildMediaExtras(user, input)
    expect(out?.sprite).toMatchObject({
      file_id: 'sprite-file',
      tile_w: 160,
      tile_h: 90,
      cols: 10,
      count: 13
    })
    expect(out?.peaks).toEqual([0, 0, 0, 0.5, 1])
    expect(st.uploaded).toEqual([`sprite-${UPLOAD}.jpg`])
    const row = tables.nivaro_help_video_uploads[0]
    expect(row.sprite_file).toBe('SPRITE-FILE')
    expect(JSON.parse(String(row.sprite))).toMatchObject({ interval_ms: 1000 })
    expect(JSON.parse(String(row.peaks))).toEqual([0, 0, 0, 0.5, 1])
    expect(tables.nivaro_help_video_versions[0].sprite_file).toBe('SPRITE-FILE')
    expect(tables.nivaro_help_video_versions[1].sprite_file).toBeNull()
    // The scratch directory (`<upload id>-<8 hex>`, never the bare id) is gone.
    const scratch = st.ran[0][st.ran[0].indexOf('-i') + 1]
    expect(scratch).toMatch(
      new RegExp(`^${join(work, 'extras', UPLOAD)}-[0-9a-f]{8}/source\\.webm$`)
    )
    expect(existsSync(join(work, 'extras', UPLOAD))).toBe(false)
    expect(readdirSync(join(work, 'extras'))).toEqual([])
  })
  it('keeps the peaks when the sheet fails, and skips the sheet for a huge frame', async () => {
    st.spriteFail = true
    const out = await buildMediaExtras(user, input)
    expect(out?.sprite).toBeNull()
    expect(out?.peaks).toHaveLength(5)
    expect(st.uploaded).toEqual([])
    st.spriteFail = false
    st.ran = []
    await buildMediaExtras(user, { ...input, width: 7680, height: 4320 })
    expect(st.ran).toHaveLength(1) // peaks only
    expect(st.ran[0]).toContain('pcm_s16le')
  })
  it('does nothing before the migration, without ffmpeg, or when the file is gone', async () => {
    st.migrated = false
    expect(await buildMediaExtras(user, input)).toBeNull()
    st.migrated = true
    st.ffmpeg = false
    expect(await buildMediaExtras(user, input)).toBeNull()
    st.ffmpeg = true
    expect(await buildMediaExtras(user, { ...input, fileId: 'gone' })).toBeNull()
    expect(st.ran).toHaveLength(0)
  })
  it('drops the sheet again when the recording was discarded meanwhile, or the write fails', async () => {
    tables.nivaro_help_video_uploads[0].status = 'abandoned'
    expect(await buildMediaExtras(user, input)).toBeNull()
    expect(st.discarded).toEqual(['SPRITE-FILE'])
    tables.nivaro_help_video_uploads[0].status = 'finalized'
    st.discarded = []
    st.dbFail = true
    await expect(buildMediaExtras(user, input)).rejects.toThrow('db down')
    expect(st.discarded).toEqual(['SPRITE-FILE'])
  })
})
