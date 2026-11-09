import type { FastifyInstance, FastifyRequest } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { fileRecordRefs } from './file-access.js'
import { fileAttributions } from './file-attribution.js'
import { compileAccessGates, visibleIds } from './record-access.js'
import { tenantScopedRoom } from './tenant-rooms.js'
import { normalizeApp } from './traffic-client-facts.js'

/**
 * File download log (#3234) and report (#3235).
 *
 * Every download or open of a stored file through GET /api/files/:id writes
 * one activity row per record the file belongs to (`action: 'file-download'`),
 * so it shows on the record's history and the person's activity and is kept
 * like the rest of the log. A file used on no record gets one row on
 * nivaro_files. Not logged: thumbnails (/transform), files a page embeds
 * (Sec-Fetch-Dest image/style/script/font…), the follow-up range requests of
 * a streamed video, and the same person + file again within a minute.
 *
 * The row's comment is JSON — {file, name, app, kind} — parsed back by the
 * report and the per-record counts. No table of its own:
 * nothing to migrate or promote.
 */

export const FILE_DOWNLOAD_ACTION = 'file-download'
const REPEAT_WINDOW_S = 60
const MAX_RECORDS_PER_FILE = 5

/** Fetch destinations of a resource a page embeds rather than a person opening it. */
const EMBEDDED_DESTS = new Set([
  'image',
  'style',
  'script',
  'font',
  'track',
  'manifest',
  'worker',
  'sharedworker',
  'serviceworker',
  'audioworklet',
  'paintworklet',
  'xslt'
])

function header(req: Pick<FastifyRequest, 'headers'>, name: string): string {
  const v = req.headers[name]
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
}

/** 'download' (asked to save), 'open' (opened in the browser) or null (not a person's download). */
export function downloadKind(
  req: Pick<FastifyRequest, 'headers' | 'query'>
): 'download' | 'open' | null {
  const range = /^bytes=(\d+)-/i.exec(header(req, 'range'))
  // A streamed video asks for the rest of the file in pieces; only the first counts.
  if (range && Number(range[1]) > 0) return null
  const q = (req.query ?? {}) as { download?: string }
  if (q.download === '1' || q.download === 'true') return 'download'
  const dest = header(req, 'sec-fetch-dest').toLowerCase()
  if (dest && EMBEDDED_DESTS.has(dest)) return null
  return 'open'
}

/** Which app the download came from: x-nivaro-app, else the page that linked it ('admin', another
 *  front end's host, or 'direct' for a link with no referring page). */
export function downloadApp(
  req: Pick<FastifyRequest, 'headers'>,
  adminOrigin?: string | null
): string {
  const named = normalizeApp(header(req, 'x-nivaro-app'))
  if (named) return named
  const ref = header(req, 'referer')
  if (!ref) return 'direct'
  let origin: string
  try {
    origin = new URL(ref).origin
  } catch {
    return 'direct'
  }
  const admin = adminOrigin === undefined ? adminBaseUrl() : adminOrigin
  try {
    if (admin && new URL(admin).origin === origin) return 'admin'
  } catch {
    /* a malformed admin URL just means no match */
  }
  // Another front end (a headless app on its own host): name it by its host.
  try {
    return new URL(origin).host.toLowerCase().slice(0, 60) || 'direct'
  } catch {
    return 'direct'
  }
}

export interface DownloadComment {
  file: string
  name: string | null
  app: string
  kind: 'download' | 'open'
}

/** The stored comment, or null when the row is not a download row. */
export function parseDownloadComment(raw: unknown): DownloadComment | null {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null
  try {
    const v = JSON.parse(raw) as Partial<DownloadComment>
    if (!v || typeof v.file !== 'string') return null
    return {
      file: v.file,
      name: typeof v.name === 'string' ? v.name : null,
      app: typeof v.app === 'string' ? v.app : 'direct',
      kind: v.kind === 'open' ? 'open' : 'download'
    }
  } catch {
    return null
  }
}

/** The records a file belongs to: foreign keys first, then the places that hold ids without one. */
async function recordsOfFile(file: {
  id: unknown
  uploaded_on?: unknown
}): Promise<Array<{ collection: string; id: string }>> {
  const id = String(file.id)
  const out: Array<{ collection: string; id: string }> = []
  const add = (collection: string, item: string) => {
    if (out.length >= MAX_RECORDS_PER_FILE) return
    if (!out.some((r) => r.collection === collection && r.id === item))
      out.push({ collection, id: item })
  }
  try {
    for (const r of (await fileRecordRefs([id])).get(id.toLowerCase()) ?? [])
      add(r.collection, r.id)
  } catch {
    /* fall through to the attributions */
  }
  if (out.length === 0) {
    try {
      const attr = (await fileAttributions([file])).get(id.toUpperCase()) ?? []
      for (const a of attr) if (a.kind === 'record') add(a.collection, a.id)
    } catch {
      /* logged on the file itself below */
    }
  }
  return out
}

/**
 * Logs one download (fire-and-forget from the file route). Never throws and
 * never delays the bytes: the caller does not await it.
 */
export async function logFileDownload(
  app: FastifyInstance,
  req: FastifyRequest,
  file: { id: unknown; filename_download?: string | null; uploaded_on?: unknown }
): Promise<void> {
  try {
    const user = req.user?.id
    if (!user || req.method !== 'GET') return
    const kind = downloadKind(req)
    if (!kind) return
    const fileId = String(file.id)
    const redis = (app as { redis?: { set: (...a: unknown[]) => Promise<unknown> } }).redis
    if (redis) {
      try {
        const key = `filedl:${tenantScopedRoom(`${String(user).toLowerCase()}:${fileId.toLowerCase()}`)}`
        if ((await redis.set(key, '1', 'EX', REPEAT_WINDOW_S, 'NX')) === null) return
      } catch {
        /* no Redis = log every hit rather than lose the record */
      }
    }
    const comment: DownloadComment = {
      file: fileId,
      name: file.filename_download ?? null,
      app: downloadApp(req),
      kind
    }
    const text = JSON.stringify(comment)
    const records = await recordsOfFile(file)
    const targets = records.length > 0 ? records : [{ collection: 'nivaro_files', id: fileId }]
    for (const t of targets) {
      await logActivity({
        action: FILE_DOWNLOAD_ACTION,
        user,
        collection: t.collection,
        item: t.id,
        comment: text,
        req
      })
    }
  } catch {
    /* the download itself already succeeded */
  }
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface DownloadRow {
  activity_id: number
  user: string | null
  at: string
  collection: string | null
  item: string | null
  file: string
  name: string | null
  app: string
  kind: 'download' | 'open'
}

const MAX_REPORT_ROWS = 20_000

/** Download rows matching the filters (newest first), as raw stored rows. */
async function readRows(filters: {
  from?: Date | null
  to?: Date | null
  collection?: string | null
  item?: string | null
  user?: string | null
  fileIds?: string[]
}): Promise<DownloadRow[]> {
  const q = db('nivaro_activity')
    .where('action', FILE_DOWNLOAD_ACTION)
    .orderBy('timestamp', 'desc')
    .limit(MAX_REPORT_ROWS)
    .select('id', 'user', 'timestamp', 'collection', 'item', 'comment')
  if (filters.from) void q.where('timestamp', '>=', filters.from)
  if (filters.to) void q.where('timestamp', '<', filters.to)
  if (filters.collection) void q.where('collection', filters.collection)
  if (filters.item) void q.where('item', filters.item)
  if (filters.user) void q.where('user', filters.user)
  const rows = (await q) as Array<{
    id: number
    user: string | null
    timestamp: Date | string
    collection: string | null
    item: string | null
    comment: string | null
  }>
  // File ids are matched here, not with JSON_VALUE in SQL: the server may
  // evaluate it on rows of other actions whose comment is not JSON.
  const wanted = filters.fileIds ? new Set(filters.fileIds.map((i) => i.toLowerCase())) : null
  const out: DownloadRow[] = []
  for (const r of rows) {
    const c = parseDownloadComment(r.comment)
    if (!c) continue
    if (wanted && !wanted.has(c.file.toLowerCase())) continue
    out.push({
      activity_id: Number(r.id),
      user: r.user ? String(r.user) : null,
      at: new Date(r.timestamp).toISOString(),
      collection: r.collection,
      item: r.item != null ? String(r.item) : null,
      file: c.file,
      name: c.name,
      app: c.app,
      kind: c.kind
    })
  }
  return out
}

/** Keeps only the rows whose record (or, for a file on no record, the file) the viewer can read. */
async function visibleRows(
  rows: DownloadRow[],
  viewer: { user: User; isAdmin: boolean; req: FastifyRequest }
): Promise<DownloadRow[]> {
  const byCollection = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.collection || r.item == null) continue
    const set = byCollection.get(r.collection) ?? new Set<string>()
    set.add(r.item)
    byCollection.set(r.collection, set)
  }
  const allowed = new Map<string, Set<string>>()
  for (const [collection, ids] of byCollection) {
    if (collection === 'nivaro_files') {
      const { readableFileIdList } = await import('./file-access.js')
      const ok = await readableFileIdList([...ids], viewer.req)
      allowed.set(collection, new Set([...ids].filter((i) => ok.has(i.toLowerCase()) || ok.has(i))))
      continue
    }
    try {
      const gates = await compileAccessGates(viewer.user, collection, {
        actingAdmin: viewer.isAdmin
      })
      allowed.set(collection, await visibleIds(gates, [...ids]))
    } catch {
      allowed.set(collection, new Set())
    }
  }
  return rows.filter(
    (r) => r.collection && r.item != null && allowed.get(r.collection)?.has(r.item)
  )
}

async function peopleNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const list = [...new Set(ids.filter(Boolean))]
  for (let i = 0; i < list.length; i += 1000) {
    const rows = (await db('nivaro_users')
      .whereIn('id', list.slice(i, i + 1000))
      .select('id', 'first_name', 'last_name', 'email')) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    for (const u of rows) {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
      out.set(String(u.id).toUpperCase(), name || u.email || 'Unknown person')
    }
  }
  return out
}

const nameOf = (names: Map<string, string>, id: string | null) =>
  id ? (names.get(id.toUpperCase()) ?? 'Unknown person') : 'Unknown person'

export interface PersonCount {
  user: string
  name: string
  count: number
  last: string
}

export interface FileDownloadStat {
  count: number
  people: PersonCount[]
}

/** Folds rows into per-person counts, most recent first. */
export function peopleOf(rows: DownloadRow[], names: Map<string, string>): PersonCount[] {
  const m = new Map<string, PersonCount>()
  for (const r of rows) {
    const key = (r.user ?? '').toUpperCase()
    const p = m.get(key) ?? {
      user: r.user ?? '',
      name: nameOf(names, r.user),
      count: 0,
      last: r.at
    }
    p.count += 1
    if (r.at > p.last) p.last = r.at
    m.set(key, p)
  }
  return [...m.values()].sort((a, b) => (a.last < b.last ? 1 : -1))
}

/**
 * Download counts for the files on one record (the Files field chip). The
 * caller must be able to read the record; only downloads logged on THIS record
 * count.
 */
export async function recordDownloadStats(
  req: FastifyRequest,
  collection: string,
  item: string,
  fileIds: string[]
): Promise<Record<string, FileDownloadStat>> {
  const { recordVisibleTo } = await import('./revision-access.js')
  if (!(await recordVisibleTo(req, collection, item))) return {}
  const ids = [...new Set(fileIds.filter((i) => /^[0-9a-f-]{36}$/i.test(i)))].slice(0, 200)
  if (ids.length === 0) return {}
  const rows = await readRows({ collection, item, fileIds: ids })
  const names = await peopleNames(rows.map((r) => r.user ?? ''))
  const byFile = new Map<string, DownloadRow[]>()
  for (const r of rows) {
    const k = r.file.toLowerCase()
    byFile.set(k, [...(byFile.get(k) ?? []), r])
  }
  const out: Record<string, FileDownloadStat> = {}
  for (const id of ids) {
    const list = byFile.get(id.toLowerCase()) ?? []
    if (list.length > 0) out[id] = { count: list.length, people: peopleOf(list, names) }
  }
  return out
}

export interface DownloadReport {
  rows: Array<DownloadRow & { person: string }>
  by_file: Array<{
    file: string
    name: string | null
    count: number
    people: number
    last: string
    records: Array<{ collection: string; item: string }>
  }>
  by_person: Array<{ user: string; name: string; files: number; count: number; last: string }>
  by_record: Array<{ collection: string; item: string; files: number; count: number; last: string }>
  truncated: boolean
}

/** The admin report: every download the viewer may see, folded three ways. */
export async function downloadReport(
  req: FastifyRequest,
  filters: {
    from?: Date | null
    to?: Date | null
    collection?: string | null
    user?: string | null
  }
): Promise<DownloadReport> {
  const raw = await readRows(filters)
  const rows = await visibleRows(raw, { user: req.user as User, isAdmin: !!req.isAdmin, req })
  const names = await peopleNames(rows.map((r) => r.user ?? ''))

  const files = new Map<string, DownloadReport['by_file'][number] & { who: Set<string> }>()
  const people = new Map<string, DownloadReport['by_person'][number] & { fileSet: Set<string> }>()
  const records = new Map<string, DownloadReport['by_record'][number] & { fileSet: Set<string> }>()
  for (const r of rows) {
    const fk = r.file.toLowerCase()
    const f = files.get(fk) ?? {
      file: r.file,
      name: r.name,
      count: 0,
      people: 0,
      last: r.at,
      records: [],
      who: new Set<string>()
    }
    f.count += 1
    f.who.add((r.user ?? '').toUpperCase())
    if (r.at > f.last) f.last = r.at
    if (
      r.collection &&
      r.item != null &&
      r.collection !== 'nivaro_files' &&
      !f.records.some((x) => x.collection === r.collection && x.item === r.item)
    )
      f.records.push({ collection: r.collection, item: r.item })
    files.set(fk, f)

    const pk = (r.user ?? '').toUpperCase()
    const p = people.get(pk) ?? {
      user: r.user ?? '',
      name: nameOf(names, r.user),
      files: 0,
      count: 0,
      last: r.at,
      fileSet: new Set<string>()
    }
    p.count += 1
    p.fileSet.add(fk)
    if (r.at > p.last) p.last = r.at
    people.set(pk, p)

    if (r.collection && r.item != null && r.collection !== 'nivaro_files') {
      const rk = `${r.collection}\u0000${r.item}`
      const rec = records.get(rk) ?? {
        collection: r.collection,
        item: r.item,
        files: 0,
        count: 0,
        last: r.at,
        fileSet: new Set<string>()
      }
      rec.count += 1
      rec.fileSet.add(fk)
      if (r.at > rec.last) rec.last = r.at
      records.set(rk, rec)
    }
  }
  const byCount = <T extends { count: number; last: string }>(a: T, b: T) =>
    b.count - a.count || (a.last < b.last ? 1 : -1)
  return {
    rows: rows.map((r) => ({ ...r, person: nameOf(names, r.user) })),
    by_file: [...files.values()].map(({ who, ...f }) => ({ ...f, people: who.size })).sort(byCount),
    by_person: [...people.values()]
      .map(({ fileSet, ...p }) => ({ ...p, files: fileSet.size }))
      .sort(byCount),
    by_record: [...records.values()]
      .map(({ fileSet, ...r }) => ({ ...r, files: fileSet.size }))
      .sort(byCount),
    truncated: raw.length >= MAX_REPORT_ROWS
  }
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** One line per download: when, who, file, record, app, kind. */
export function downloadReportCsv(report: DownloadReport): string {
  const lines = [
    ['Downloaded at (UTC)', 'Person', 'File', 'File id', 'Collection', 'Record', 'App', 'Kind']
  ]
  for (const r of report.rows) {
    lines.push([
      r.at,
      r.person,
      r.name ?? '',
      r.file,
      r.collection === 'nivaro_files' ? '' : (r.collection ?? ''),
      r.collection === 'nivaro_files' ? '' : (r.item ?? ''),
      r.app,
      r.kind
    ])
  }
  return `${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`
}
