import { EditsError, hashEdits, normalizeEdits, type VideoEdits } from './help-video-edits.js'
import { type MusicOrigin, normalizeOrigin } from './help-video-openverse.js'

// The manifest of a help-video package (moving videos between instances) and
// its validation. Pure: no database, no files — the package service feeds it
// the parsed JSON and the archive's entry list. Everything in a package is
// untrusted: ids must be exact uuids, entry names must be the writer's own
// `f<n>` names, sizes must match the archive, text is capped and edits are
// normalized by THIS instance's rules (their hash recomputed, never taken).

export const PACKAGE_TYPE = 'nivaro-help-video-package'
export const PACKAGE_VERSION = 1
export const MAX_PACKAGE_VIDEOS = 50
export const MANIFEST_ENTRY = 'manifest.json'
export const MANIFEST_MAX_BYTES = 16 * 1024 * 1024

export type FileRole = 'source' | 'rendered' | 'captions' | 'poster' | 'music'
export const FILE_ROLES: readonly FileRole[] = ['source', 'rendered', 'captions', 'poster', 'music']

const GB = 1024 * 1024 * 1024
export const ROLE_RULES: Record<FileRole, { mimes: string[]; max: number }> = {
  source: { mimes: ['video/webm', 'video/mp4'], max: Math.round(1.2 * GB) },
  rendered: { mimes: ['video/mp4'], max: 2 * GB },
  captions: { mimes: ['text/vtt'], max: 5 * 1024 * 1024 },
  poster: { mimes: ['image/jpeg', 'image/png'], max: 10 * 1024 * 1024 },
  /** An author's background music (#1547), already converted to AAC. */
  music: { mimes: ['audio/mp4'], max: 40 * 1024 * 1024 }
}
const MAX_SOURCE_MS = 31 * 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENTRY_RE = /^f[1-9][0-9]{0,3}$/
const KEY_RE = /^[A-Za-z0-9_.:-]{1,100}$/
const SHA_RE = /^[0-9a-f]{64}$/

export interface ManifestFile {
  entry: string
  mime: string
  size: number
  sha256: string
}
export interface PackageContext {
  kind: 'collection' | 'page'
  key: string
  state_key: string | null
}
export interface PackagePage {
  key: string
  label: string
  app: string | null
}
export interface Manifest {
  type: typeof PACKAGE_TYPE
  version: number
  exported_at: string
  source: { instance: string; url: string | null }
  pages: PackagePage[]
  videos: Array<{
    id: string
    title: string
    description: string | null
    category: string | null
    allow_downloads: boolean
    contexts: PackageContext[]
    version: {
      number: number
      edits: unknown
      edits_hash: string
      rendered_hash: string | null
      source_duration_ms: number | null
      width: number | null
      height: number | null
      clicks: unknown
      levels: unknown
      note: string | null
      files: Partial<Record<FileRole, ManifestFile>>
      /** Where uploaded music came from (an Openverse import), when known. */
      music_origin?: unknown
    }
  }>
}

/** One video of a package after validation. */
export interface PackageVideo {
  id: string
  title: string
  description: string | null
  category: string | null
  allow_downloads: boolean
  contexts: PackageContext[]
  number: number
  edits: VideoEdits
  edits_hash: string
  /** The render in the package is current for these edits on this instance. */
  render_reusable: boolean
  source_duration_ms: number
  width: number | null
  height: number | null
  clicks: Array<{ t_ms: number; x: number; y: number }> | null
  levels: number[] | null
  note: string | null
  files: Partial<Record<FileRole, ManifestFile>>
  music_origin: MusicOrigin | null
}

export interface CheckedManifest {
  source: { instance: string; url: string | null }
  exported_at: string | null
  pages: PackagePage[]
  videos: PackageVideo[]
  /** Videos the package names but this instance refuses, with why. */
  rejected: Array<{ id: string; title: string; reasons: string[] }>
}

export class PackageError extends Error {
  statusCode = 422
  code = 'HELP_VIDEO_PACKAGE_INVALID'
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\0/g, '').slice(0, max) : ''
const optStr = (v: unknown, max: number): string | null => {
  const s = str(v, max).trim()
  return s ? s : null
}
const int = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}

export function sanitizeClicks(
  raw: unknown,
  sourceMs: number
): Array<{ t_ms: number; x: number; y: number }> | null {
  if (!Array.isArray(raw)) return null
  const out: Array<{ t_ms: number; x: number; y: number }> = []
  for (const c of raw.slice(0, 20_000)) {
    if (!c || typeof c !== 'object') continue
    const { t_ms, x, y } = c as Record<string, unknown>
    const t = Number(t_ms)
    const fx = Number(x)
    const fy = Number(y)
    if (![t, fx, fy].every(Number.isFinite)) continue
    if (t < 0 || t > sourceMs || fx < 0 || fx > 1 || fy < 0 || fy > 1) continue
    out.push({ t_ms: Math.round(t), x: fx, y: fy })
  }
  return out
}

export function sanitizeLevels(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null
  return raw.slice(0, 20_000).map((v) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(1, Math.max(0, Math.round(n * 1000) / 1000)) : 0
  })
}

function checkContexts(raw: unknown): { ok: PackageContext[]; bad: string[] } {
  const ok: PackageContext[] = []
  const bad: string[] = []
  const seen = new Set<string>()
  for (const c of Array.isArray(raw) ? raw.slice(0, 50) : []) {
    const r = (c ?? {}) as Record<string, unknown>
    const kind = r.kind
    const key = String(r.key ?? '')
    const state = kind === 'collection' && r.state_key ? String(r.state_key) : null
    if ((kind !== 'collection' && kind !== 'page') || !KEY_RE.test(key)) {
      bad.push(`An unreadable screen (${String(kind)} ${key.slice(0, 40)})`)
      continue
    }
    if (state !== null && !KEY_RE.test(state)) {
      bad.push(`An unreadable step on ${key}`)
      continue
    }
    const sig = `${kind}|${key}|${state ?? ''}`
    if (seen.has(sig)) continue
    seen.add(sig)
    ok.push({ kind, key, state_key: state })
  }
  return { ok, bad }
}

function checkFile(
  role: FileRole,
  raw: unknown,
  entries: Map<string, number>
): { file?: ManifestFile; reason?: string } {
  if (raw == null) return {}
  const f = raw as Record<string, unknown>
  const entry = String(f.entry ?? '')
  const mime = String(f.mime ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  const size = Number(f.size)
  const sha = String(f.sha256 ?? '').toLowerCase()
  if (!ENTRY_RE.test(entry)) return { reason: `The ${role} file has an unexpected name` }
  if (!entries.has(entry)) return { reason: `The ${role} file is missing from the package` }
  if (!Number.isInteger(size) || size <= 0 || entries.get(entry) !== size) {
    return { reason: `The ${role} file's size does not match the package` }
  }
  if (!ROLE_RULES[role].mimes.includes(mime)) {
    return { reason: `The ${role} file is not an allowed type (${mime || 'none'})` }
  }
  if (size > ROLE_RULES[role].max) return { reason: `The ${role} file is too large` }
  if (!SHA_RE.test(sha)) return { reason: `The ${role} file has no checksum` }
  return { file: { entry, mime, size, sha256: sha } }
}

/**
 * Validates a parsed manifest against the archive's entries (name → size).
 * Throws PackageError when the package as a whole is unusable; a video that
 * is wrong on its own lands in `rejected` with plain reasons.
 */
export function checkManifest(raw: unknown, entries: Map<string, number>): CheckedManifest {
  const m = (raw ?? {}) as Record<string, unknown>
  if (m.type !== PACKAGE_TYPE) throw new PackageError('This is not a help-video package')
  if (Number(m.version) !== PACKAGE_VERSION) {
    throw new PackageError(`This package was made by a newer version (format ${String(m.version)})`)
  }
  if (!Array.isArray(m.videos) || m.videos.length === 0) {
    throw new PackageError('The package has no videos')
  }
  if (m.videos.length > MAX_PACKAGE_VIDEOS) {
    throw new PackageError(`A package holds at most ${MAX_PACKAGE_VIDEOS} videos`)
  }
  const src = (m.source ?? {}) as Record<string, unknown>
  const pages: PackagePage[] = []
  for (const p of Array.isArray(m.pages) ? m.pages.slice(0, 500) : []) {
    const r = (p ?? {}) as Record<string, unknown>
    const key = String(r.key ?? '')
    if (!KEY_RE.test(key)) continue
    pages.push({ key, label: str(r.label, 200) || key, app: optStr(r.app, 50) })
  }
  const out: CheckedManifest = {
    source: { instance: str(src.instance, 100) || 'unknown', url: optStr(src.url, 300) },
    exported_at: typeof m.exported_at === 'string' ? m.exported_at.slice(0, 40) : null,
    pages,
    videos: [],
    rejected: []
  }
  const usedEntries = new Set<string>()
  const ids = new Set<string>()
  for (const v of m.videos as unknown[]) {
    const r = (v ?? {}) as Record<string, unknown>
    const id = String(r.id ?? '').toLowerCase()
    const title = str(r.title, 200).trim()
    const reasons: string[] = []
    if (!UUID_RE.test(id)) {
      out.rejected.push({ id: id.slice(0, 40), title, reasons: ['Its id is not readable'] })
      continue
    }
    if (ids.has(id)) {
      out.rejected.push({ id, title, reasons: ['It appears twice in the package'] })
      continue
    }
    ids.add(id)
    if (!title) reasons.push('It has no title')
    const ver = (r.version ?? {}) as Record<string, unknown>
    const filesRaw = (ver.files ?? {}) as Record<string, unknown>
    const files: Partial<Record<FileRole, ManifestFile>> = {}
    for (const role of FILE_ROLES) {
      const { file, reason } = checkFile(role, filesRaw[role], entries)
      if (reason) reasons.push(reason)
      else if (file) {
        if (usedEntries.has(file.entry))
          reasons.push(`The ${role} file is shared with another video`)
        usedEntries.add(file.entry)
        files[role] = file
      }
    }
    if (!files.source) reasons.push('The original recording is missing')
    let sourceMs = int(ver.source_duration_ms) ?? 0
    if (sourceMs <= 0 || sourceMs > MAX_SOURCE_MS) {
      reasons.push('The recording length is missing or over 30 minutes')
      sourceMs = 0
    }
    let edits: VideoEdits | null = null
    if (sourceMs > 0) {
      try {
        edits = normalizeEdits(ver.edits, sourceMs)
      } catch (err) {
        if (!(err instanceof EditsError)) throw err
        reasons.push(`Its edits are not usable: ${err.message}`)
      }
    }
    // Uploaded music travels as its own file; music from the library does not.
    if (edits?.music?.source === 'upload') {
      if (!files.music) reasons.push('Its music file is missing from the package')
    } else if (files.music) {
      delete files.music
    }
    const ctx = checkContexts(r.contexts)
    if (reasons.length || !edits) {
      out.rejected.push({ id, title, reasons })
      continue
    }
    const hash = hashEdits(edits)
    // Reuse the package's render only when it was built for exactly these
    // edits as THIS instance normalizes them; otherwise render here.
    const reusable =
      !!files.rendered &&
      String(ver.rendered_hash ?? '') === String(ver.edits_hash ?? '') &&
      String(ver.edits_hash ?? '') === hash
    if (!reusable) {
      delete files.rendered
      delete files.captions
    }
    out.videos.push({
      id,
      title,
      description: optStr(r.description, 4000),
      category: optStr(r.category, 100),
      allow_downloads: r.allow_downloads !== false,
      contexts: ctx.ok,
      number: int(ver.number) ?? 0,
      edits,
      edits_hash: hash,
      render_reusable: reusable,
      source_duration_ms: sourceMs,
      width: int(ver.width),
      height: int(ver.height),
      clicks: sanitizeClicks(ver.clicks, sourceMs),
      levels: sanitizeLevels(ver.levels),
      note: optStr(ver.note, 300),
      files,
      music_origin: files.music ? normalizeOrigin(ver.music_origin) : null
    })
  }
  return out
}

/** How a package context lands here: kept, or skipped with the reason. */
export function matchContexts(
  contexts: PackageContext[],
  here: { collections: Set<string>; states: Map<string, Set<string>> }
): { matched: PackageContext[]; skipped: Array<PackageContext & { reason: string }> } {
  const matched: PackageContext[] = []
  const skipped: Array<PackageContext & { reason: string }> = []
  for (const c of contexts) {
    if (c.kind === 'page') {
      matched.push(c)
      continue
    }
    if (!here.collections.has(c.key)) {
      skipped.push({ ...c, reason: `There is no collection named ${c.key} here` })
      continue
    }
    if (c.state_key && !here.states.get(c.key)?.has(c.state_key)) {
      skipped.push({ ...c, reason: `${c.key} has no step called ${c.state_key} here` })
      continue
    }
    matched.push(c)
  }
  return { matched, skipped }
}

export function contextSig(c: PackageContext): string {
  return `${c.kind}|${c.key}|${c.state_key ?? ''}`
}
