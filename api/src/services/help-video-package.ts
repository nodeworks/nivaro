import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { hasFfmpeg, probeVideo } from './ffmpeg.js'
import { getFile, uploadFileFromPath } from './files.js'
import { downloadsAllowed, withDownloads } from './help-video-download.js'
import { editedDuration } from './help-video-edits.js'
import {
  type CheckedManifest,
  checkManifest,
  contextSig,
  FILE_ROLES,
  type FileRole,
  MANIFEST_ENTRY,
  MANIFEST_MAX_BYTES,
  type Manifest,
  type ManifestFile,
  matchContexts,
  type PackageContext,
  PackageError,
  type PackagePage,
  type PackageVideo
} from './help-video-package-manifest.js'
import { queueRender } from './help-video-render.js'
import {
  listTar,
  readTarEntry,
  TAR_END,
  type TarEntry,
  tarEntryStream,
  tarHeader,
  tarPadding
} from './help-video-tar.js'
import { discardFile, looksLikeVideo, videoWorkDir } from './help-video-uploads.js'
import { instanceKey } from './instance-key.js'
import { openStoredObject } from './stored-object-stream.js'

// Moving help videos between instances (record and polish on staging, then
// bring them to production). Admin only on both ends. The runtime tables stay
// out of promote-config on purpose; this is an explicit export and import:
//
//   export  → a tar: one entry per file (`f1`, `f2`, …) and `manifest.json`
//             (written last, so every size and sha256 in it is known).
//   import  → the package arrives in 8 MB parts (no request-size limit to
//             meet), is checked, previewed, then applied. Ids are kept, so a
//             later package for the same video adds a new version to it.
//
// Roles do not travel (their ids differ between instances): a created video
// arrives published but only authors can watch it, with no required viewing.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION_TTL_MS = 24 * 3_600_000
const MAX_PART_BYTES = 8 * 1024 * 1024
export const EXPORT_TICKET_PREFIX = 'hv:pkg:'
export const EXPORT_TICKET_TTL_S = 600

function fail(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}
const low = (v: unknown) => String(v ?? '').toLowerCase()
const up = (v: unknown) => String(v ?? '').toUpperCase()

/** Largest package accepted (HELP_VIDEO_PACKAGE_MAX_MB, default 4 GB). */
export function maxPackageBytes(): number {
  const mb = Number(process.env.HELP_VIDEO_PACKAGE_MAX_MB)
  return Math.round((Number.isFinite(mb) && mb > 0 ? mb : 4096) * 1024 * 1024)
}

// ── Export ─────────────────────────────────────────────────────────────────

/** Normalizes the ids an admin picked: exact uuids, de-duplicated, ≤ 50. */
export function exportIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const ids = [...new Set(list.map((v) => low(v).trim()).filter((v) => UUID_RE.test(v)))]
  if (!ids.length) throw fail(400, 'HELP_VIDEO_PACKAGE_EMPTY', 'Pick at least one video')
  if (ids.length > 50) throw fail(400, 'HELP_VIDEO_PACKAGE_TOO_MANY', 'At most 50 videos at once')
  return ids
}

interface ExportFile {
  entry: string
  role: FileRole
  key: string
  mime: string
}

/** Checks the picked videos can be exported (each has a published version
 *  whose original recording is stored) and returns them in order. */
export async function exportableVideos(ids: string[]) {
  const videos = (await db('nivaro_help_videos').whereIn('id', ids)) as Array<
    Record<string, unknown>
  >
  const byId = new Map(videos.map((v) => [low(v.id), v]))
  const problems: string[] = []
  for (const id of ids) {
    const v = byId.get(id)
    if (!v) problems.push(`${id}: not found`)
    else if (!v.published_version_id) problems.push(`${String(v.title) || id}: never published`)
  }
  if (problems.length) {
    throw Object.assign(
      fail(
        422,
        'HELP_VIDEO_PACKAGE_NOT_EXPORTABLE',
        `These can't be exported: ${problems.join('; ')}`
      ),
      { problems }
    )
  }
  return ids.map((id) => byId.get(id) as Record<string, unknown>)
}

/** The package as a stream: files first (each hashed on the way out), then
 *  the manifest, then the end-of-archive blocks. */
export async function exportPackageStream(
  ids: string[],
  user: User
): Promise<{ stream: Readable; filename: string; count: number }> {
  const videos = await exportableVideos(ids)
  const files: ExportFile[] = []
  const manifest: Manifest = {
    type: 'nivaro-help-video-package',
    version: 1,
    exported_at: new Date().toISOString(),
    source: { instance: instanceKey(), url: process.env.PUBLIC_URL || null },
    pages: [],
    videos: []
  }
  const pageKeys = new Set<string>()
  const pendingFiles: Array<{ video: number; role: FileRole; f: ExportFile }> = []
  for (const v of videos) {
    const ver = (await db('nivaro_help_video_versions')
      .where({ id: v.published_version_id })
      .first()) as Record<string, unknown>
    const contexts = (await db('nivaro_help_video_contexts')
      .where({ video_id: v.id })
      .select('kind', 'key', 'state_key')) as PackageContext[]
    for (const c of contexts) if (c.kind === 'page') pageKeys.add(c.key)
    const renderCurrent = !!ver.rendered_file && ver.rendered_hash === ver.edits_hash
    const roleFile: Partial<Record<FileRole, unknown>> = {
      source: ver.source_file,
      rendered: renderCurrent ? ver.rendered_file : null,
      captions: renderCurrent ? ver.captions_file : null,
      poster: ver.poster_file ?? v.poster_file
    }
    const index = manifest.videos.length
    manifest.videos.push({
      id: low(v.id),
      title: String(v.title ?? ''),
      description: (v.description as string | null) ?? null,
      category: (v.category as string | null) ?? null,
      allow_downloads: downloadsAllowed(v.visibility),
      contexts: contexts.map((c) => ({ kind: c.kind, key: c.key, state_key: c.state_key ?? null })),
      version: {
        number: Number(ver.version),
        edits: JSON.parse(String(ver.edits)),
        edits_hash: String(ver.edits_hash),
        rendered_hash: renderCurrent ? String(ver.rendered_hash) : null,
        source_duration_ms: ver.source_duration_ms == null ? null : Number(ver.source_duration_ms),
        width: ver.width == null ? null : Number(ver.width),
        height: ver.height == null ? null : Number(ver.height),
        clicks: parse(ver.clicks),
        levels: parse(ver.levels),
        note: (ver.note as string | null) ?? null,
        files: {}
      }
    })
    for (const role of FILE_ROLES) {
      const fileId = roleFile[role]
      if (!fileId) continue
      const row = await getFile(String(fileId))
      if (!row?.filename_disk) {
        if (role === 'source') {
          throw fail(
            422,
            'HELP_VIDEO_PACKAGE_NOT_EXPORTABLE',
            `${String(v.title) || v.id}: the original recording is missing from storage`
          )
        }
        continue
      }
      const f: ExportFile = {
        entry: `f${files.length + 1}`,
        role,
        key: String(row.filename_disk),
        mime: String(row.type ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase()
      }
      files.push(f)
      pendingFiles.push({ video: index, role, f })
    }
  }
  if (pageKeys.size) {
    const pages = (await db('nivaro_help_video_pages')
      .whereIn('key', [...pageKeys])
      .select('key', 'label', 'app')) as PackagePage[]
    manifest.pages = pages.map((p) => ({ key: p.key, label: p.label, app: p.app ?? null }))
  }

  const mtime = Date.now() / 1000
  async function* body(): AsyncGenerator<Buffer> {
    for (const { video, role, f } of pendingFiles) {
      const o = await openStoredObject(f.key)
      const hash = createHash('sha256')
      yield tarHeader(f.entry, o.size, mtime)
      let sent = 0
      for await (const chunk of o.stream) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        hash.update(b)
        sent += b.length
        yield b
      }
      if (sent !== o.size) throw new Error(`${f.entry}: stored object changed while exporting`)
      yield tarPadding(o.size)
      const entry: ManifestFile = {
        entry: f.entry,
        mime: f.mime,
        size: o.size,
        sha256: hash.digest('hex')
      }
      manifest.videos[video].version.files[role] = entry
    }
    const m = Buffer.from(JSON.stringify(manifest), 'utf8')
    yield tarHeader(MANIFEST_ENTRY, m.length, mtime)
    yield m
    yield tarPadding(m.length)
    yield TAR_END
  }
  for (const v of videos) {
    await logActivity({
      action: 'help-video-export',
      user: user.id,
      collection: 'nivaro_help_videos',
      item: low(v.id),
      comment: `package of ${videos.length}`
    })
  }
  const stamp = new Date().toISOString().slice(0, 10)
  return {
    stream: Readable.from(body()),
    filename: `help-videos-${stamp}-${videos.length}.tar`,
    count: videos.length
  }
}

function parse(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ── Import sessions ──────────────────────────────────────────────────────────

interface ImportSession {
  id: string
  user: string
  dir: string
  next_part: number
  last_part_bytes: number | null
  bytes: number
  created: number
  busy: boolean
  checked: CheckedManifest | null
  /** entry name → path of the extracted, verified file */
  extracted: Map<string, string>
  probes: Map<string, { duration_ms: number | null; width: number | null; height: number | null }>
}
const sessions = new Map<string, ImportSession>()

function sessionDir(id: string): string {
  return join(videoWorkDir(), 'packages', id)
}

function own(user: User, id: string): ImportSession {
  const s = UUID_RE.test(String(id)) ? sessions.get(low(id)) : undefined
  if (!s || s.user !== up(user.id)) {
    throw fail(
      404,
      'HELP_VIDEO_IMPORT_NOT_FOUND',
      'That upload is not here any more — start the import again'
    )
  }
  return s
}

/** Drops sessions (and their folders) older than a day, and any folder no
 *  session in this process knows about. */
export async function purgeStaleImports(now = Date.now()): Promise<number> {
  let removed = 0
  for (const [id, s] of sessions) {
    if (now - s.created > SESSION_TTL_MS && !s.busy) {
      sessions.delete(id)
      await rm(s.dir, { recursive: true, force: true })
      removed++
    }
  }
  const root = join(videoWorkDir(), 'packages')
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (sessions.has(name)) continue
    const path = join(root, name)
    const st = await stat(path).catch(() => null)
    if (st && now - st.mtimeMs > SESSION_TTL_MS) {
      await rm(path, { recursive: true, force: true })
      removed++
    }
  }
  return removed
}

export async function openImport(
  user: User
): Promise<{ id: string; next_part: number; max_bytes: number }> {
  await purgeStaleImports().catch(() => 0)
  const id = randomUUID()
  const dir = sessionDir(id)
  await mkdir(dir, { recursive: true })
  sessions.set(id, {
    id,
    user: up(user.id),
    dir,
    next_part: 0,
    last_part_bytes: null,
    bytes: 0,
    created: Date.now(),
    busy: false,
    checked: null,
    extracted: new Map(),
    probes: new Map()
  })
  return { id, next_part: 0, max_bytes: maxPackageBytes() }
}

/** Same part rule as recording uploads: n must be the next part; resending
 *  the last part with the same size is accepted and ignored. */
export function decideImportPart(
  s: { next_part: number; last_part_bytes: number | null; bytes: number },
  n: number,
  size: number,
  max = maxPackageBytes()
): 'append' | 'duplicate' | { status: number; error: string } {
  if (!Number.isInteger(n) || n < 0) return { status: 400, error: 'Bad part number' }
  if (size <= 0) return { status: 400, error: 'The part is empty' }
  if (size > MAX_PART_BYTES) return { status: 413, error: 'A part may be at most 8 MB' }
  if (n === s.next_part - 1) {
    return size === s.last_part_bytes
      ? 'duplicate'
      : { status: 409, error: `Part ${n} was already received with another size` }
  }
  if (n !== s.next_part) return { status: 409, error: `Expected part ${s.next_part}, got ${n}` }
  if (s.bytes + size > max) {
    return { status: 413, error: `Packages may be at most ${Math.round(max / 1024 / 1024)} MB` }
  }
  return 'append'
}

export async function appendImportPart(
  user: User,
  id: string,
  n: number,
  body: Buffer
): Promise<{ next_part: number; bytes: number }> {
  const s = own(user, id)
  if (s.busy || s.checked) throw fail(409, 'HELP_VIDEO_IMPORT_CLOSED', 'This upload is finished')
  const d = decideImportPart(s, n, body.length)
  if (typeof d === 'object') throw fail(d.status, 'HELP_VIDEO_IMPORT_PART', d.error)
  if (d === 'append') {
    s.busy = true
    try {
      await appendFile(join(s.dir, 'package.tar'), body)
      s.bytes += body.length
      s.last_part_bytes = body.length
      s.next_part += 1
    } finally {
      s.busy = false
    }
  }
  return { next_part: s.next_part, bytes: s.bytes }
}

export async function discardImport(user: User, id: string): Promise<void> {
  const s = own(user, id)
  if (s.busy) throw fail(409, 'HELP_VIDEO_IMPORT_BUSY', 'This import is still working')
  sessions.delete(s.id)
  await rm(s.dir, { recursive: true, force: true })
}

const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b.length > 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
}

async function head(path: string, n = 64): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const b = Buffer.alloc(n)
    const { bytesRead } = await fh.read(b, 0, n, 0)
    return b.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Copies one entry out of the archive into the session folder, hashing it on
 *  the way, and refuses it when the checksum differs. The path is built from
 *  the writer's own entry name (`f<n>`, checked), never anything else. */
async function extractEntry(s: ImportSession, e: TarEntry, f: ManifestFile): Promise<string> {
  const done = s.extracted.get(f.entry)
  if (done) return done
  const dest = join(s.dir, 'x', f.entry)
  await mkdir(join(s.dir, 'x'), { recursive: true })
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk as Buffer)
      cb(null, chunk)
    }
  })
  await pipeline(tarEntryStream(join(s.dir, 'package.tar'), e), tap, createWriteStream(dest))
  if (hash.digest('hex') !== f.sha256) {
    await rm(dest, { force: true })
    throw new PackageError(`${f.entry} is damaged (checksum mismatch)`)
  }
  s.extracted.set(f.entry, dest)
  return dest
}

/** Is this extracted file what the manifest says it is? Video files are
 *  probed with ffprobe when it is installed; captions must be WebVTT and
 *  posters JPEG or PNG. */
async function checkMedia(
  s: ImportSession,
  role: FileRole,
  f: ManifestFile,
  path: string
): Promise<string | null> {
  const h = await head(path)
  if (role === 'source' || role === 'rendered') {
    if (!looksLikeVideo(f.mime, h)) return `The ${role} file is not a ${f.mime} video`
    if (await hasFfmpeg()) {
      try {
        const p = await probeVideo(path, f.mime)
        if (!p.duration_ms || p.duration_ms <= 0) return `The ${role} file has no length`
        if (p.duration_ms > 31 * 60_000) return `The ${role} file is over 30 minutes`
        s.probes.set(f.entry, p)
      } catch {
        return `The ${role} file could not be read`
      }
    }
    return null
  }
  if (role === 'captions')
    return h.toString('utf8').startsWith('WEBVTT') ? null : 'The captions are not WebVTT'
  return IMAGE_MAGIC[f.mime]?.(h) ? null : `The poster is not a ${f.mime} image`
}

// ── Preview ────────────────────────────────────────────────────────────────

export interface ImportPreviewVideo {
  id: string
  title: string
  action: 'create' | 'update' | 'rejected'
  reasons: string[]
  target: { title: string; status: string; versions: number } | null
  version: { from_number: number; duration_ms: number; render: 'reuse' | 'queue' } | null
  files: Array<{ role: FileRole; size: number }>
  contexts: {
    added: PackageContext[]
    already: PackageContext[]
    skipped: Array<PackageContext & { reason: string }>
  }
  notes: string[]
}
export interface ImportPreview {
  id: string
  source: { instance: string; url: string | null }
  exported_at: string | null
  bytes: number
  videos: ImportPreviewVideo[]
}

async function whatIsHere(contexts: PackageContext[]) {
  const collections = [
    ...new Set(contexts.filter((c) => c.kind === 'collection').map((c) => c.key))
  ]
  const known = collections.length
    ? ((await db('nivaro_collections')
        .whereIn('collection', collections)
        .select('collection')) as Array<{
        collection: string
      }>)
    : []
  const states = new Map<string, Set<string>>()
  if (collections.length) {
    const rows = (await db('nivaro_workflow_bindings as b')
      .join('nivaro_workflow_states as s', 's.template', 'b.template')
      .whereIn('b.collection', collections)
      .select('b.collection', 's.key')) as Array<{ collection: string; key: string }>
    for (const r of rows) {
      if (!states.has(r.collection)) states.set(r.collection, new Set())
      states.get(r.collection)?.add(r.key)
    }
  }
  return { collections: new Set(known.map((k) => k.collection)), states }
}

async function plan(s: ImportSession): Promise<ImportPreviewVideo[]> {
  const checked = s.checked as CheckedManifest
  const all = checked.videos.flatMap((v) => v.contexts)
  const here = await whatIsHere(all)
  const ids = checked.videos.map((v) => v.id)
  const targets = ids.length
    ? ((await db('nivaro_help_videos').whereIn('id', ids)) as Array<Record<string, unknown>>)
    : []
  const byId = new Map(targets.map((t) => [low(t.id), t]))
  const counts = ids.length
    ? ((await db('nivaro_help_video_versions')
        .whereIn('video_id', ids)
        .groupBy('video_id')
        .select('video_id')
        .count('* as n')) as Array<{ video_id: string; n: number | string }>)
    : []
  const countBy = new Map(counts.map((c) => [low(c.video_id), Number(c.n)]))
  const existingCtx = ids.length
    ? ((await db('nivaro_help_video_contexts')
        .whereIn('video_id', ids)
        .select('video_id', 'kind', 'key', 'state_key')) as Array<
        PackageContext & { video_id: string }
      >)
    : []
  const out: ImportPreviewVideo[] = checked.rejected.map((r) => ({
    id: r.id,
    title: r.title,
    action: 'rejected',
    reasons: r.reasons,
    target: null,
    version: null,
    files: [],
    contexts: { added: [], already: [], skipped: [] },
    notes: []
  }))
  for (const v of checked.videos) {
    const t = byId.get(v.id)
    const { matched, skipped } = matchContexts(v.contexts, here)
    const have = new Set(
      existingCtx.filter((c) => low(c.video_id) === v.id).map((c) => contextSig(c))
    )
    const added = matched.filter((c) => !have.has(contextSig(c)))
    const already = matched.filter((c) => have.has(contextSig(c)))
    const notes: string[] = []
    if (!t) {
      notes.push(
        'Arrives published, but only video authors can watch it until you choose who can watch. Required viewing is off.'
      )
    } else if (t.status === 'archived') {
      notes.push('It is archived here: the new version is stored and the video stays archived.')
    } else if (!t.published_version_id) {
      notes.push(
        'It was never published here: it arrives published, but only video authors can watch it until you choose who can watch.'
      )
    } else {
      notes.push(
        'The new version becomes the published one. Who can watch, required viewing and the downloads switch stay as they are here.'
      )
    }
    if (t?.draft_version_id) notes.push('The draft being edited here is left alone.')
    if (!v.render_reusable) notes.push('The video will be rendered here after the import.')
    const unknownPages = v.contexts.filter(
      (c) => c.kind === 'page' && !checked.pages.some((p) => p.key === c.key)
    )
    if (unknownPages.length) {
      notes.push(
        `${unknownPages.length === 1 ? 'A page' : `${unknownPages.length} pages`} it shows on ${unknownPages.length === 1 ? 'has' : 'have'} not been opened on the instance it came from; it will show there once someone opens it.`
      )
    }
    out.push({
      id: v.id,
      title: v.title,
      action: t ? 'update' : 'create',
      reasons: [],
      target: t
        ? {
            title: String(t.title ?? ''),
            status: String(t.status),
            versions: countBy.get(v.id) ?? 0
          }
        : null,
      version: {
        from_number: v.number,
        duration_ms: editedDuration(v.edits),
        render: v.render_reusable ? 'reuse' : 'queue'
      },
      files: FILE_ROLES.flatMap((role) =>
        v.files[role] ? [{ role, size: (v.files[role] as ManifestFile).size }] : []
      ),
      contexts: { added, already, skipped },
      notes
    })
  }
  return out
}

/** Reads and checks the uploaded package (once), extracts and verifies every
 *  file a video needs, and answers what applying it would do. Nothing is
 *  written to the database. */
export async function previewImport(user: User, id: string): Promise<ImportPreview> {
  const s = own(user, id)
  if (s.busy) throw fail(409, 'HELP_VIDEO_IMPORT_BUSY', 'This import is still working')
  s.busy = true
  try {
    if (!s.checked) {
      const tarPath = join(s.dir, 'package.tar')
      if (!s.bytes) throw new PackageError('Nothing was uploaded')
      let entries: TarEntry[]
      try {
        entries = await listTar(tarPath, 1000)
      } catch (err) {
        throw new PackageError((err as Error).message)
      }
      const manifestEntry = entries.find((e) => e.name === MANIFEST_ENTRY)
      if (!manifestEntry) throw new PackageError('The package has no manifest (is it complete?)')
      let raw: unknown
      try {
        raw = JSON.parse(
          (await readTarEntry(tarPath, manifestEntry, MANIFEST_MAX_BYTES)).toString('utf8')
        )
      } catch {
        throw new PackageError('The package manifest is not readable')
      }
      const sizes = new Map<string, number>()
      for (const e of entries) if (e.name !== MANIFEST_ENTRY) sizes.set(e.name, e.size)
      const checked = checkManifest(raw, sizes)
      const byName = new Map(entries.map((e) => [e.name, e]))
      const ok: PackageVideo[] = []
      for (const v of checked.videos) {
        const reasons: string[] = []
        for (const role of FILE_ROLES) {
          const f = v.files[role]
          if (!f) continue
          try {
            const path = await extractEntry(s, byName.get(f.entry) as TarEntry, f)
            const bad = await checkMedia(s, role, f, path)
            if (bad) reasons.push(bad)
          } catch (err) {
            reasons.push((err as Error).message)
          }
        }
        // The probed recording wins over what the package says about it.
        const probe = v.files.source ? s.probes.get(v.files.source.entry) : undefined
        if (probe) {
          v.width = probe.width ?? v.width
          v.height = probe.height ?? v.height
        }
        if (reasons.length) checked.rejected.push({ id: v.id, title: v.title, reasons })
        else ok.push(v)
      }
      checked.videos = ok
      s.checked = checked
      // The archive is no longer needed: every usable file is extracted.
      await rm(tarPath, { force: true })
    }
    return {
      id: s.id,
      source: s.checked.source,
      exported_at: s.checked.exported_at,
      bytes: s.bytes,
      videos: await plan(s)
    }
  } finally {
    s.busy = false
  }
}

// ── Apply ──────────────────────────────────────────────────────────────────

export interface ImportResult {
  id: string
  title: string
  outcome: 'created' | 'updated' | 'failed' | 'skipped'
  version?: number
  render?: 'reused' | 'queued'
  contexts_added?: number
  contexts_skipped?: number
  error?: string
}

const EXT: Record<string, string> = {
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'text/vtt': 'vtt',
  'image/jpeg': 'jpg',
  'image/png': 'png'
}

async function applyOne(
  s: ImportSession,
  user: User,
  v: PackageVideo,
  pages: PackagePage[]
): Promise<ImportResult> {
  const created: string[] = []
  const ids: Partial<Record<FileRole, string>> = {}
  const short = v.id.slice(0, 8)
  try {
    for (const role of FILE_ROLES) {
      const f = v.files[role]
      if (!f) continue
      const path = s.extracted.get(f.entry)
      if (!path) throw new Error(`The ${role} file is no longer here`)
      const file = await uploadFileFromPath(
        user,
        path,
        `help-video-${short}-${role}.${EXT[f.mime] ?? 'bin'}`,
        f.mime
      )
      created.push(String(file.id))
      ids[role] = String(file.id)
    }
  } catch (err) {
    for (const f of created) await discardFile(user, f)
    throw err
  }
  const here = await whatIsHere(v.contexts)
  const { matched, skipped } = matchContexts(v.contexts, here)
  const versionId = randomUUID()
  const probe = v.files.source ? s.probes.get(v.files.source.entry) : undefined
  const sourceMs = probe?.duration_ms ?? v.source_duration_ms
  const now = new Date()
  let outcome: 'created' | 'updated' = 'created'
  let number = 1
  let added = 0
  try {
    await db.transaction(async (trx) => {
      const existing = (await trx('nivaro_help_videos').where({ id: v.id }).first()) as
        | Record<string, unknown>
        | undefined
      const max = await trx('nivaro_help_video_versions')
        .where({ video_id: v.id })
        .max('version as m')
        .first()
      number = Number(max?.m ?? 0) + 1
      const authorsOnly = withDownloads({ mode: 'roles', role_ids: [] }, v.allow_downloads)
      if (!existing) {
        await trx('nivaro_help_videos').insert({
          id: v.id,
          title: v.title,
          description: v.description,
          category: v.category,
          status: 'published',
          visibility: authorsOnly,
          created_by: user.id,
          updated_by: user.id,
          created_at: now,
          updated_at: now
        })
      } else {
        outcome = 'updated'
      }
      await trx('nivaro_help_video_versions').insert({
        id: versionId,
        video_id: v.id,
        version: number,
        source_file: ids.source,
        source_duration_ms: sourceMs,
        width: v.width,
        height: v.height,
        clicks: v.clicks == null ? null : JSON.stringify(v.clicks),
        levels: v.levels == null ? null : JSON.stringify(v.levels),
        edits: JSON.stringify(v.edits),
        edits_hash: v.edits_hash,
        render_status: v.render_reusable ? 'ready' : 'none',
        render_progress: v.render_reusable ? 100 : null,
        rendered_hash: v.render_reusable ? v.edits_hash : null,
        rendered_file: v.render_reusable ? (ids.rendered ?? null) : null,
        captions_file: v.render_reusable ? (ids.captions ?? null) : null,
        poster_file: ids.poster ?? null,
        note: `Imported from ${s.checked?.source.instance ?? 'another instance'} (v${v.number})`.slice(
          0,
          300
        ),
        created_by: user.id,
        created_at: now
      })
      const patch: Record<string, unknown> = {
        title: v.title,
        description: v.description,
        category: v.category,
        published_version_id: versionId,
        duration_ms: editedDuration(v.edits),
        updated_by: user.id,
        updated_at: now
      }
      if (ids.poster) patch.poster_file = ids.poster
      if (existing && existing.status !== 'archived') {
        if (!existing.published_version_id) {
          // Never published here: nobody chose who can watch a live video.
          patch.visibility = withDownloads(
            { mode: 'roles', role_ids: [] },
            downloadsAllowed(existing.visibility)
          )
        }
        patch.status = 'published'
      }
      await trx('nivaro_help_videos').where({ id: v.id }).update(patch)
      const have = new Set(
        (
          (await trx('nivaro_help_video_contexts')
            .where({ video_id: v.id })
            .select('kind', 'key', 'state_key')) as PackageContext[]
        ).map(contextSig)
      )
      const rows = matched
        .filter((c) => !have.has(contextSig(c)))
        .map((c) => ({ video_id: v.id, kind: c.kind, key: c.key, state_key: c.state_key }))
      if (rows.length) await trx('nivaro_help_video_contexts').insert(rows)
      added = rows.length
      const pageKeys = matched.filter((c) => c.kind === 'page').map((c) => c.key)
      if (pageKeys.length) {
        const known = new Set(
          (
            (await trx('nivaro_help_video_pages').whereIn('key', pageKeys).select('key')) as Array<{
              key: string
            }>
          ).map((p) => p.key)
        )
        const missing = pages.filter((p) => pageKeys.includes(p.key) && !known.has(p.key))
        if (missing.length) {
          await trx('nivaro_help_video_pages').insert(
            missing.map((p) => ({ key: p.key, label: p.label, app: p.app, last_seen: now }))
          )
        }
      }
    })
  } catch (err) {
    for (const f of created) await discardFile(user, f)
    throw err
  }
  if (!v.render_reusable) await queueRender(versionId)
  await logActivity({
    action: 'help-video-import',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: v.id,
    comment: `${outcome} v${number} from ${s.checked?.source.instance ?? 'a package'} · render ${v.render_reusable ? 'reused' : 'queued'}${skipped.length ? ` · ${skipped.length} screen(s) skipped` : ''}`
  })
  return {
    id: v.id,
    title: v.title,
    outcome,
    version: number,
    render: v.render_reusable ? 'reused' : 'queued',
    contexts_added: added,
    contexts_skipped: skipped.length
  }
}

/** Applies a previewed package: each usable video (or only `onlyIds`) is
 *  created or gets a new published version. One video failing never stops
 *  the others. The session is closed afterwards. */
export async function applyImport(
  user: User,
  id: string,
  onlyIds?: unknown
): Promise<{ results: ImportResult[] }> {
  const s = own(user, id)
  if (!s.checked) throw fail(409, 'HELP_VIDEO_IMPORT_NOT_CHECKED', 'Preview the package first')
  if (s.busy) throw fail(409, 'HELP_VIDEO_IMPORT_BUSY', 'This import is still working')
  const pick = Array.isArray(onlyIds) ? new Set(onlyIds.map(low)) : null
  s.busy = true
  const results: ImportResult[] = []
  try {
    for (const v of s.checked.videos) {
      if (pick && !pick.has(v.id)) {
        results.push({ id: v.id, title: v.title, outcome: 'skipped' })
        continue
      }
      try {
        results.push(await applyOne(s, user, v, s.checked.pages))
      } catch (err) {
        results.push({
          id: v.id,
          title: v.title,
          outcome: 'failed',
          error: (err as Error).message.slice(0, 300)
        })
      }
    }
  } finally {
    s.busy = false
    sessions.delete(s.id)
    await rm(s.dir, { recursive: true, force: true })
  }
  await logActivity({
    action: 'help-video-package-import',
    user: user.id,
    collection: 'nivaro_help_videos',
    comment: results
      .map((r) => `${r.title || r.id}: ${r.outcome}`)
      .join('; ')
      .slice(0, 1000)
  })
  return { results }
}
