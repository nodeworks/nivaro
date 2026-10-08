import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const rows: Row[] = []

function matches(r: Row, cond: Row) {
  return Object.entries(cond).every(
    ([k, v]) => String(r[k]).toLowerCase() === String(v).toLowerCase()
  )
}
function builder() {
  let cond: Row = {}
  const lts: Array<[string, Date]> = []
  let ins: [string, unknown[]] | null = null
  const sel = () =>
    rows.filter(
      (r) =>
        matches(r, cond) &&
        lts.every(([k, v]) => new Date(r[k] as string).getTime() < v.getTime()) &&
        (!ins || ins[1].includes(r[ins[0]]))
    )
  const b: Record<string, unknown> = {
    where(c: Row | string, _op?: string, v?: Date) {
      if (typeof c === 'string') lts.push([c, v as Date])
      else cond = { ...cond, ...c }
      return b
    },
    whereIn(k: string, vals: unknown[]) {
      ins = [k, vals]
      return b
    },
    select: async () => sel(),
    first: async () => sel()[0],
    update: async (patch: Row) => {
      const hit = sel()
      for (const r of hit) Object.assign(r, patch)
      return hit.length
    },
    insert: async (r: Row) => {
      rows.push({ ...r })
    }
  }
  return b
}
vi.mock('../../../db/index.js', () => ({ db: () => builder() }))

const ff = {
  has: true,
  probe: { duration_ms: 5000 as number | null, width: 1, height: 1, has_audio: true }
}
vi.mock('../../../services/ffmpeg.js', () => ({
  hasFfmpeg: async () => ff.has,
  probeVideo: async () => ff.probe,
  remuxToFile: async (i: string, o: string) => writeFileSync(o, readFileSync(i))
}))
const files = { fail: false }
vi.mock('../../../services/files.js', () => ({
  uploadFileFromPath: async () => {
    if (files.fail) throw new Error('storage down')
    return { id: 'file-1' }
  }
}))

const work = mkdtempSync(join(tmpdir(), 'nvr-up-'))
process.env.VIDEO_WORK_DIR = work
const up = await import('../../../services/help-video-uploads.js')
const user = { id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' } as never
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])
const partFile = (id: string) => join(work, 'uploads', `${id}.part`)

beforeEach(() => {
  rows.length = 0
  ff.has = true
  ff.probe = { duration_ms: 5000, width: 1, height: 1, has_audio: true }
  files.fail = false
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
