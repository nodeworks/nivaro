import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
// A tiny table-aware stand-in for the knex calls the uploads service makes.
const tables: Record<string, Row[]> = {
  nivaro_help_video_uploads: [],
  nivaro_help_video_versions: [],
  nivaro_help_videos: []
}
const rows = tables.nivaro_help_video_uploads

const bare = (k: string) => k.replace(/^.*\./, '')
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()
function builder(table: string) {
  if (!tables[table]) tables[table] = []
  const data = tables[table]
  const tests: Array<(r: Row) => boolean> = []
  const b: Record<string, unknown> = {
    where(c: Row | string, op?: unknown, v?: unknown) {
      if (typeof c === 'string') {
        const k = bare(c)
        if (v === undefined) tests.push((r) => same(r[k], op))
        else tests.push((r) => new Date(r[k] as string).getTime() < (v as Date).getTime())
      } else {
        for (const [k, val] of Object.entries(c)) tests.push((r) => same(r[bare(k)], val))
      }
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
    whereNotNull(k: string) {
      tests.push((r) => r[bare(k)] != null)
      return b
    },
    // fn builds `select 1 from <t> whereRaw('<t>.<col> = <outer>.<col>')`
    whereNotExists(fn: (this: Row) => void) {
      const sub: { t?: string; inner?: string; outer?: string } = {}
      const rec: Record<string, unknown> = {
        select: () => rec,
        from: (t: string) => {
          sub.t = t
          return rec
        },
        whereRaw: (sql: string) => {
          const [l, r] = sql.split('=').map((x) => bare(x.trim()))
          sub.inner = l
          sub.outer = r
          return rec
        }
      }
      fn.call(rec)
      tests.push(
        (r) =>
          !(tables[sub.t as string] ?? []).some(
            (o) =>
              o[sub.inner as string] != null && same(o[sub.inner as string], r[sub.outer as string])
          )
      )
      return b
    },
    orderBy: () => b,
    select: async () => sel(),
    first: async () => sel()[0],
    update: async (patch: Row) => {
      const hit = sel()
      for (const r of hit) Object.assign(r, patch)
      return hit.length
    },
    insert: async (r: Row) => {
      data.push({ ...r })
    },
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(sel()).then(res, rej)
  }
  const sel = () => data.filter((r) => tests.every((t) => t(r)))
  return b
}
vi.mock('../../../db/index.js', () => ({
  db: Object.assign((t: string) => builder(t), { raw: (x: string) => x })
}))

const ff = {
  has: true,
  probe: { duration_ms: 5000 as number | null, width: 1, height: 1, has_audio: true }
}
vi.mock('../../../services/ffmpeg.js', () => ({
  hasFfmpeg: async () => ff.has,
  probeVideo: async () => ff.probe,
  remuxToFile: async (i: string, o: string) => writeFileSync(o, readFileSync(i))
}))
const files = vi.hoisted(() => ({
  fail: false,
  deleteFail: false,
  deleted: [] as string[],
  objects: [] as string[]
}))
vi.mock('../../../services/files.js', () => ({
  uploadFileFromPath: async () => {
    if (files.fail) throw new Error('storage down')
    return { id: 'file-1' }
  },
  getFile: async (id: string) => ({ id, filename_disk: `${id}.webm` }),
  deleteFile: async (id: string) => {
    if (files.deleteFail) throw new Error('FK in the way')
    files.deleted.push(id)
  }
}))
vi.mock('../../../services/storage-drivers.js', () => ({
  deleteStoredObject: async (key: string) => {
    files.objects.push(key)
  }
}))

const work = mkdtempSync(join(tmpdir(), 'nvr-up-'))
process.env.VIDEO_WORK_DIR = work
const up = await import('../../../services/help-video-uploads.js')
const user = { id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' } as never
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])
const partFile = (id: string) => join(work, 'uploads', `${id}.part`)

beforeEach(() => {
  for (const t of Object.values(tables)) t.length = 0
  ff.has = true
  ff.probe = { duration_ms: 5000, width: 1, height: 1, has_audio: true }
  files.fail = false
  files.deleteFail = false
  files.deleted = []
  files.objects = []
})

describe('upload ids', () => {
  it('rejects ids that are not exactly a uuid (SQL Server truncating compare)', async () => {
    const s = await up.openUpload(user, 'video/webm')
    for (const bad of [`${s.id}/../../x`, `{${s.id}}`, `${s.id}zzz`, '../x']) {
      await expect(up.appendPart(user, bad, 0, webm)).rejects.toMatchObject({ statusCode: 404 })
      await expect(up.finalizeUpload(user, bad, {})).rejects.toMatchObject({ statusCode: 404 })
      await expect(up.abandonUpload(user, bad)).rejects.toMatchObject({ statusCode: 404 })
      await expect(up.takeFinalizedUpload(user, bad)).rejects.toMatchObject({ statusCode: 404 })
    }
  })
  it('builds the temp path from the row id, not the caller string', async () => {
    const s = await up.openUpload(user, 'video/webm')
    await up.appendPart(user, s.id.toUpperCase(), 0, webm)
    expect(existsSync(partFile(s.id))).toBe(true)
  })
})

describe('part 0 magic bytes', () => {
  it('refuses a non-video first part', async () => {
    const s = await up.openUpload(user, 'video/webm')
    await expect(
      up.appendPart(user, s.id, 0, Buffer.from('#EXTM3U\n/etc/hosts'))
    ).rejects.toMatchObject({ statusCode: 422, code: 'UPLOAD_NOT_VIDEO' })
    expect(existsSync(partFile(s.id))).toBe(false)
  })
  it('recognises EBML and ftyp', () => {
    expect(up.looksLikeVideo('video/webm', webm)).toBe(true)
    expect(up.looksLikeVideo('video/mp4', Buffer.from('\0\0\0\x18ftypmp42'))).toBe(true)
    expect(up.looksLikeVideo('video/mp4', webm)).toBe(false)
  })
})

describe('concurrent parts', () => {
  it('a same-size simultaneous resend is a duplicate: bytes are written once', async () => {
    const s = await up.openUpload(user, 'video/webm')
    await up.appendPart(user, s.id, 0, webm)
    const part = Buffer.from('abcdefgh')
    const r = await Promise.allSettled([
      up.appendPart(user, s.id, 1, part),
      up.appendPart(user, s.id, 1, part)
    ])
    expect(r.every((x) => x.status === 'fulfilled')).toBe(true)
    expect(readFileSync(partFile(s.id)).length).toBe(webm.length + part.length)
  })
  it('refuses the loser with 409 when sizes differ and writes only the winner', async () => {
    const s = await up.openUpload(user, 'video/webm')
    await up.appendPart(user, s.id, 0, webm)
    const r = await Promise.allSettled([
      up.appendPart(user, s.id, 1, Buffer.from('aaaa')),
      up.appendPart(user, s.id, 1, Buffer.from('bbbbbb'))
    ])
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const bad = r.find((x) => x.status === 'rejected') as PromiseRejectedResult
    expect(bad.reason).toMatchObject({ statusCode: 409 })
    expect(readFileSync(partFile(s.id)).length).toBe(webm.length + 4)
  })
})

describe('finalize', () => {
  async function ready() {
    const s = await up.openUpload(user, 'video/webm')
    await up.appendPart(user, s.id, 0, webm)
    return s
  }
  it('a second concurrent finalize gets 409 and only one wins', async () => {
    const s = await ready()
    const r = await Promise.allSettled([
      up.finalizeUpload(user, s.id, {}),
      up.finalizeUpload(user, s.id, {})
    ])
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409
    })
  })
  it('keeps the recording when storage fails, and a retry succeeds', async () => {
    const s = await ready()
    files.fail = true
    await expect(up.finalizeUpload(user, s.id, {})).rejects.toThrow('storage down')
    expect(existsSync(partFile(s.id))).toBe(true)
    expect(existsSync(join(work, 'uploads', `${s.id}.fixed.webm`))).toBe(false)
    expect(rows[0].status).toBe('open')
    files.fail = false
    await expect(up.finalizeUpload(user, s.id, {})).resolves.toMatchObject({ file_id: 'file-1' })
    expect(existsSync(partFile(s.id))).toBe(false)
  })
  it('refuses a probed duration over 31 minutes and keeps the upload open', async () => {
    const s = await ready()
    ff.probe = { ...ff.probe, duration_ms: 31 * 60_000 + 1 }
    await expect(up.finalizeUpload(user, s.id, { duration_ms: 1000 })).rejects.toMatchObject({
      statusCode: 422,
      code: 'UPLOAD_TOO_LONG'
    })
    expect(rows[0].status).toBe('open')
    expect(existsSync(partFile(s.id))).toBe(true)
  })
})

describe('stale finalizing rows', () => {
  async function stuck(ageMs: number) {
    const s = await up.openUpload(user, 'video/webm')
    await up.appendPart(user, s.id, 0, webm)
    rows[0].status = 'finalizing'
    rows[0].updated_at = new Date(Date.now() - ageMs)
    return s
  }
  it('a fresh finalizing row still answers 409', async () => {
    const s = await stuck(60_000)
    await expect(up.finalizeUpload(user, s.id, {})).rejects.toMatchObject({ statusCode: 409 })
    expect(rows[0].status).toBe('finalizing')
  })
  it('a finalizing row older than an hour can be finalized again', async () => {
    const s = await stuck(2 * 3_600_000)
    await expect(up.finalizeUpload(user, s.id, {})).resolves.toMatchObject({ file_id: 'file-1' })
    expect(rows[0].status).toBe('finalized')
  })
  it('purge abandons a stale finalizing row and removes its part', async () => {
    const s = await stuck(25 * 3_600_000)
    expect(await up.purgeStaleUploads()).toBe(1)
    expect(rows[0].status).toBe('abandoned')
    expect(existsSync(partFile(s.id))).toBe(false)
  })
})

describe('finished recordings never saved as a video (I1)', () => {
  const DAY = 86_400_000
  async function finished(ageMs = 60_000) {
    const s = await up.openUpload(user, 'video/webm')
    await up.appendPart(user, s.id, 0, webm)
    await up.finalizeUpload(user, s.id, {})
    const row = rows.find((r) => same(r.id, s.id)) as Row
    row.updated_at = new Date(Date.now() - ageMs)
    return { id: s.id, row }
  }
  const useIt = (fileId: unknown) =>
    tables.nivaro_help_video_versions.push({ id: 'v1', source_file: fileId })

  it('/uploads/mine lists an unused finalized recording with its length, not a used one', async () => {
    const a = await finished()
    const listed = await up.listOpenUploads(user)
    expect(listed).toEqual([
      expect.objectContaining({ id: a.id, status: 'finalized', duration_ms: 5000 })
    ])
    useIt(a.row.file_id)
    expect(await up.listOpenUploads(user)).toEqual([])
  })

  it('still lists open uploads, newest first', async () => {
    const a = await finished()
    const b = await up.openUpload(user, 'video/webm')
    a.row.created_at = new Date(Date.now() - 60_000)
    const ids = (await up.listOpenUploads(user)).map((u) => u.id)
    expect(ids).toEqual([b.id, a.id])
  })

  it('discarding an unused recording deletes its bytes and file, then marks it abandoned', async () => {
    const { id, row } = await finished()
    await up.abandonUpload(user, id)
    expect(row.status).toBe('abandoned')
    expect(row.file_id).toBeNull()
    expect(files.objects).toEqual(['file-1.webm'])
    expect(files.deleted).toEqual(['file-1'])
  })

  it('refuses to discard a recording a video already uses, and keeps its file', async () => {
    const { id, row } = await finished()
    useIt(row.file_id)
    await expect(up.abandonUpload(user, id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'UPLOAD_CLOSED'
    })
    expect(row.status).toBe('finalized')
    expect(files.deleted).toEqual([])
  })

  it('refuses to discard a used, abandoned or finishing upload', async () => {
    for (const status of ['used', 'abandoned', 'finalizing']) {
      const { id, row } = await finished()
      row.status = status
      await expect(up.abandonUpload(user, id)).rejects.toMatchObject({ statusCode: 409 })
      expect(row.status).toBe(status)
    }
    expect(files.deleted).toEqual([])
  })

  it('a failed file delete gives the row its file id back for the purge to retry', async () => {
    const { id, row } = await finished()
    files.deleteFail = true
    await up.abandonUpload(user, id)
    expect(row.status).toBe('abandoned')
    expect(row.file_id).toBe('file-1')
    files.deleteFail = false
    await up.purgeStaleUploads()
    expect(row.file_id).toBeNull()
    expect(files.deleted).toEqual(['file-1'])
  })

  it('purge deletes unused recordings older than 7 days and keeps newer or used ones', async () => {
    const old = await finished(8 * DAY)
    const recent = await finished(6 * DAY)
    const oldUsed = await finished(8 * DAY)
    oldUsed.row.file_id = 'file-2'
    useIt('file-2')
    expect(await up.purgeStaleUploads()).toBe(1)
    expect(old.row).toMatchObject({ status: 'abandoned', file_id: null })
    expect(recent.row.status).toBe('finalized')
    expect(oldUsed.row.status).toBe('finalized')
    expect(files.deleted).toEqual(['file-1'])
  })

  it('purge removes leftover remux temp files older than an hour, nothing else', async () => {
    const dir = join(work, 'uploads')
    mkdirSync(dir, { recursive: true })
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const stale = join(dir, `${id}.fixed.webm`)
    const fresh = join(dir, `${id.replace(/c/g, 'd')}.fixed.mp4`)
    const other = join(dir, 'notes.fixed.webm')
    for (const f of [stale, fresh, other]) writeFileSync(f, 'x')
    const twoHoursAgo = (Date.now() - 2 * 3_600_000) / 1000
    utimesSync(stale, twoHoursAgo, twoHoursAgo)
    utimesSync(other, twoHoursAgo, twoHoursAgo)
    await up.purgeStaleUploads()
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
})
