import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import {
  bustHelpVideoSettings,
  HELP_VIDEO_SETTINGS_COLUMN,
  HelpVideoSettingsError,
  loadHelpVideoSettings,
  parseStoredSettings
} from './help-video-settings.js'
import { getApp } from './io-holder.js'

// Storage housekeeping (#1531): what help videos take up, per video and
// version, and a retention rule that removes superseded versions' files.
//
// The rule lives in help_video_settings.retention_days (migration 410's JSON
// column; null = keep everything). A nightly sweep (server.ts,
// help-video-storage-sweep) and "Run now" (POST /help-videos/storage/sweep)
// remove the source, render, captions and poster of every version that
//   - is neither the published version nor the current draft,
//   - still has its files,
//   - has no render queued or running,
//   - is older than retention_days, and
//   - does not share its recording with a version that stays (opening the
//     editor or restoring copies the published version's source_file id, so a
//     draft or restore made from the published cut names the same file).
// The version row stays with its file columns NULL and files_removed_at set
// (migration 415): the Versions tab says "files removed by retention", restore
// answers 409 HELP_VIDEO_VERSION_FILES_REMOVED, and a package export refuses a
// video whose published version lost its files (it cannot by these rules).
// GET /help-videos/storage/plan lists what the next sweep would remove and why
// before anything runs; every removed file is an activity row, the way
// purgeVideo logs, plus one summary row per sweep.

export const RETENTION_KEY = 'retention_days'
export const RETENTION_MIN_DAYS = 1
export const RETENTION_MAX_DAYS = 3650

export type StorageRole = 'source' | 'rendered' | 'captions' | 'poster'
export const STORAGE_ROLES: readonly StorageRole[] = ['source', 'rendered', 'captions', 'poster']
const ROLE_COLUMN: Record<StorageRole, string> = {
  source: 'source_file',
  rendered: 'rendered_file',
  captions: 'captions_file',
  poster: 'poster_file'
}

export interface StorageFile {
  role: StorageRole
  id: string
  /** Null when the files row is missing (the bytes are already gone). */
  bytes: number | null
}
export interface StorageVersion {
  id: string
  version: number
  created_at: string
  is_published: boolean
  is_draft: boolean
  render_status: string
  files_removed_at: string | null
  files: StorageFile[]
  bytes: number
}
export interface StorageVideo {
  id: string
  title: string
  status: string
  /** The poster the library shows (the video row's own). */
  poster: StorageFile | null
  versions: StorageVersion[]
  bytes: number
  by_role: Record<StorageRole, number>
}
export interface StorageTotals {
  bytes: number
  files: number
  videos: number
  versions: number
  by_role: Record<StorageRole, number>
}
export interface StorageReport {
  migrated: boolean
  retention_days: number | null
  limits: { retention_min_days: number; retention_max_days: number }
  videos: StorageVideo[]
  totals: StorageTotals
}

export interface Removal {
  video_id: string
  title: string
  version_id: string
  version: number
  age_days: number
  files: StorageFile[]
  bytes: number
  why: string
}
export interface Kept {
  video_id: string
  version_id: string
  version: number
  why: string
}
export interface SweepPlan {
  retention_days: number | null
  removals: Removal[]
  kept: Kept[]
  bytes: number
  files: number
}

type Raw = Record<string, unknown>
const low = (v: unknown) => String(v ?? '').toLowerCase()
const up = (v: unknown) => String(v ?? '').toUpperCase()
const emptyRoles = (): Record<StorageRole, number> => ({
  source: 0,
  rendered: 0,
  captions: 0,
  poster: 0
})

/** "12.3 MB" for activity rows and job outcomes. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'unknown size'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

// ── the retention setting ──────────────────────────────────────────────────

/** The stored rule, or null (keep everything) for nothing or anything bad. */
export function storedRetentionDays(stored: Raw): number | null {
  const v = stored[RETENTION_KEY]
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= RETENTION_MIN_DAYS && n <= RETENTION_MAX_DAYS ? n : null
}

/** A PATCH's value checked strictly: null = keep everything. */
export function validateRetentionDays(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null
  const n = Number(input)
  if (!Number.isInteger(n) || n < RETENTION_MIN_DAYS || n > RETENTION_MAX_DAYS) {
    throw new HelpVideoSettingsError(
      `retention_days must be a whole number from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS}, or null to keep everything`
    )
  }
  return n
}

/** The stored JSON with retention_days set (or removed when null); every
 *  other key stays as it was. */
export function serializeRetention(stored: Raw, days: number | null): string | null {
  const next = { ...stored }
  if (days === null) delete next[RETENTION_KEY]
  else next[RETENTION_KEY] = days
  return Object.keys(next).length ? JSON.stringify(next) : null
}

export async function currentRetentionDays(): Promise<{
  migrated: boolean
  retention_days: number | null
}> {
  const { migrated, stored } = await loadHelpVideoSettings()
  return { migrated, retention_days: storedRetentionDays(stored) }
}

export async function saveRetentionDays(input: unknown): Promise<number | null> {
  const days = validateRetentionDays(input)
  let colOk = false
  try {
    colOk = await hasColumn('nivaro_settings', HELP_VIDEO_SETTINGS_COLUMN)
  } catch {
    colOk = false
  }
  if (!colOk) {
    throw new HelpVideoSettingsError(
      'The retention setting needs migration 410, which this database has not run yet.',
      409,
      'HELP_VIDEO_SETTINGS_MIGRATION_PENDING'
    )
  }
  const row = (await db('nivaro_settings').where({ id: 1 }).first(HELP_VIDEO_SETTINGS_COLUMN)) as
    | Raw
    | undefined
  if (!row) throw new HelpVideoSettingsError('The settings row is missing', 500, 'SETTINGS_MISSING')
  const next = serializeRetention(parseStoredSettings(row[HELP_VIDEO_SETTINGS_COLUMN]), days)
  await db('nivaro_settings')
    .where({ id: 1 })
    .update({ [HELP_VIDEO_SETTINGS_COLUMN]: next })
  bustHelpVideoSettings()
  return days
}

// ── the report ─────────────────────────────────────────────────────────────

const CHUNK = 400

async function fileSizes(ids: Iterable<string>): Promise<Map<string, number | null>> {
  const list = [...new Set([...ids].map(up))]
  const out = new Map<string, number | null>()
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK)
    const rows = (await db('nivaro_files').whereIn('id', chunk).select('id', 'filesize')) as Array<{
      id: unknown
      filesize: unknown
    }>
    for (const r of rows) {
      const n = r.filesize == null ? null : Number(r.filesize)
      out.set(up(r.id), n != null && Number.isFinite(n) ? n : null)
    }
  }
  return out
}

/** Sizes from rows the caller loaded (pure, for tests and the sweep). */
export function buildStorageReport(
  videos: Array<Raw>,
  versions: Array<Raw>,
  sizes: Map<string, number | null>,
  setting: { migrated: boolean; retention_days: number | null }
): StorageReport {
  const byVideo = new Map<string, Raw[]>()
  for (const v of versions) {
    const id = low(v.video_id)
    const list = byVideo.get(id) ?? []
    list.push(v)
    byVideo.set(id, list)
  }
  const file = (role: StorageRole, id: unknown): StorageFile | null =>
    id ? { role, id: low(id), bytes: sizes.get(up(id)) ?? null } : null
  const totals: StorageTotals = {
    bytes: 0,
    files: 0,
    videos: 0,
    versions: 0,
    by_role: emptyRoles()
  }
  const out: StorageVideo[] = []
  for (const v of videos) {
    const id = low(v.id)
    const rows = (byVideo.get(id) ?? []).sort((a, b) => Number(b.version) - Number(a.version))
    const by_role = emptyRoles()
    const poster = file('poster', v.poster_file)
    const seen = new Set<string>()
    const add = (f: StorageFile | null) => {
      if (!f || seen.has(f.id)) return 0
      seen.add(f.id)
      by_role[f.role] += f.bytes ?? 0
      totals.files++
      return f.bytes ?? 0
    }
    let bytes = add(poster)
    const vers: StorageVersion[] = rows.map((r) => {
      const files = STORAGE_ROLES.map((role) => file(role, r[ROLE_COLUMN[role]])).filter(
        (f): f is StorageFile => !!f
      )
      let vb = 0
      for (const f of files) vb += add(f)
      bytes += vb
      return {
        id: low(r.id),
        version: Number(r.version),
        created_at: new Date(r.created_at as string).toISOString(),
        is_published: low(r.id) === low(v.published_version_id),
        is_draft: low(r.id) === low(v.draft_version_id),
        render_status: String(r.render_status ?? 'none'),
        files_removed_at: r.files_removed_at
          ? new Date(r.files_removed_at as string).toISOString()
          : null,
        files,
        bytes: files.reduce((n, f) => n + (f.bytes ?? 0), 0)
      }
    })
    totals.videos++
    totals.versions += vers.length
    totals.bytes += bytes
    for (const role of STORAGE_ROLES) totals.by_role[role] += by_role[role]
    out.push({
      id,
      title: String(v.title ?? ''),
      status: String(v.status ?? ''),
      poster,
      versions: vers,
      bytes,
      by_role
    })
  }
  out.sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title))
  return {
    migrated: setting.migrated,
    retention_days: setting.retention_days,
    limits: { retention_min_days: RETENTION_MIN_DAYS, retention_max_days: RETENTION_MAX_DAYS },
    videos: out,
    totals
  }
}

export async function storageReport(): Promise<StorageReport> {
  const videos = (await db('nivaro_help_videos').select(
    'id',
    'title',
    'status',
    'poster_file',
    'published_version_id',
    'draft_version_id'
  )) as Raw[]
  const versions = (await db('nivaro_help_video_versions').select('*')) as Raw[]
  const ids: string[] = []
  for (const v of videos) if (v.poster_file) ids.push(String(v.poster_file))
  for (const r of versions)
    for (const role of STORAGE_ROLES)
      if (r[ROLE_COLUMN[role]]) ids.push(String(r[ROLE_COLUMN[role]]))
  const sizes = await fileSizes(ids)
  return buildStorageReport(videos, versions, sizes, await currentRetentionDays())
}

// ── the plan ───────────────────────────────────────────────────────────────

const PENDING = new Set(['queued', 'rendering'])

/** What a sweep would remove and why, and what stays and why. Pure. */
export function decideRemovals(
  videos: StorageVideo[],
  opts: { retention_days: number | null; now?: Date }
): SweepPlan {
  const plan: SweepPlan = {
    retention_days: opts.retention_days,
    removals: [],
    kept: [],
    bytes: 0,
    files: 0
  }
  const days = opts.retention_days
  if (days === null) return plan
  const now = (opts.now ?? new Date()).getTime()
  const cutoff = now - days * 86_400_000
  for (const v of videos) {
    const candidates = new Set<string>()
    const keep = (ver: StorageVersion, why: string) =>
      plan.kept.push({ video_id: v.id, version_id: ver.id, version: ver.version, why })
    for (const ver of v.versions) {
      if (ver.is_published) keep(ver, 'the published version')
      else if (ver.is_draft) keep(ver, 'the current draft')
      else if (ver.files_removed_at) keep(ver, 'files already removed')
      else if (PENDING.has(ver.render_status)) keep(ver, 'a render is queued or running')
      else if (new Date(ver.created_at).getTime() > cutoff) keep(ver, `newer than ${days} days`)
      else candidates.add(ver.id)
    }
    // Files a staying version (or the library poster) names are never removed.
    const referenced = new Set<string>()
    if (v.poster) referenced.add(v.poster.id)
    for (const ver of v.versions) {
      if (candidates.has(ver.id)) continue
      for (const f of ver.files) referenced.add(f.id)
    }
    // A version whose recording a staying version shares is left whole: its
    // own render goes with the 30-day render prune, the recording stays.
    for (const ver of v.versions) {
      if (!candidates.has(ver.id)) continue
      const source = ver.files.find((f) => f.role === 'source')
      if (source && referenced.has(source.id)) {
        candidates.delete(ver.id)
        keep(ver, 'its recording is still used by a version that stays')
      }
    }
    // Oldest first; a recording two removable versions share is listed (and
    // deleted) once, with the older one.
    const taken = new Set<string>()
    for (const ver of [...v.versions].sort((a, b) => a.version - b.version)) {
      if (!candidates.has(ver.id)) continue
      const files = ver.files.filter((f) => !referenced.has(f.id) && !taken.has(f.id))
      for (const f of files) taken.add(f.id)
      const bytes = files.reduce((n, f) => n + (f.bytes ?? 0), 0)
      const age = Math.floor((now - new Date(ver.created_at).getTime()) / 86_400_000)
      plan.removals.push({
        video_id: v.id,
        title: v.title,
        version_id: ver.id,
        version: ver.version,
        age_days: age,
        files,
        bytes,
        why: `superseded ${age} days ago (retention ${days} days)`
      })
      plan.bytes += bytes
      plan.files += files.length
    }
  }
  plan.removals.sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title))
  return plan
}

export async function sweepPlan(): Promise<SweepPlan & { migrated: boolean }> {
  const report = await storageReport()
  const ready = await hasColumn('nivaro_help_video_versions', 'files_removed_at').catch(() => false)
  return {
    ...decideRemovals(report.videos, { retention_days: report.retention_days }),
    migrated: report.migrated && ready
  }
}

// ── the sweep ──────────────────────────────────────────────────────────────

export interface SweepResult {
  retention_days: number | null
  versions: number
  files: number
  bytes: number
  failed: number
  summary: string
}

/** Removes what the plan says, through the same file path purgeVideo uses.
 *  `user` is the administrator who pressed Run now (null for the nightly run). */
export async function runStorageSweep(opts: { user?: User | null } = {}): Promise<SweepResult> {
  const none = (summary: string): SweepResult => ({
    retention_days: null,
    versions: 0,
    files: 0,
    bytes: 0,
    failed: 0,
    summary
  })
  if (!(await hasColumn('nivaro_help_video_versions', 'files_removed_at').catch(() => false))) {
    return none('skipped: migration 415 has not run')
  }
  const plan = await sweepPlan()
  if (plan.retention_days === null) return none('retention is off: everything kept')
  if (!plan.removals.length) {
    return {
      ...none(`nothing to remove (retention ${plan.retention_days} days)`),
      retention_days: plan.retention_days
    }
  }
  const { deleteFile } = await import('./files.js')
  const userId = opts.user?.id ?? null
  const origin = userId ? undefined : 'machine'
  let files = 0
  let bytes = 0
  let failed = 0
  let versions = 0
  const videos = new Set<string>()
  for (const r of plan.removals) {
    // Unlink first: the version's foreign keys would refuse the file deletes.
    const updated = await db('nivaro_help_video_versions')
      .where({ id: r.version_id })
      .whereNull('files_removed_at')
      .update({
        source_file: null,
        rendered_file: null,
        captions_file: null,
        poster_file: null,
        rendered_hash: null,
        render_status: 'none',
        render_progress: null,
        files_removed_at: new Date()
      })
    if (!Number(updated)) continue
    versions++
    videos.add(r.video_id)
    const ids = r.files.map((f) => f.id)
    if (ids.length) {
      // The upload rows that produced these recordings still name the files.
      await db('nivaro_help_video_uploads')
        .whereIn('file_id', ids)
        .delete()
        .catch(() => 0)
    }
    for (const f of r.files) {
      try {
        await deleteFile(f.id)
        files++
        bytes += f.bytes ?? 0
        await logActivity({
          action: 'help-video-retention',
          user: userId,
          collection: 'nivaro_help_videos',
          item: r.video_id,
          comment: `v${r.version} · ${f.role} (${formatBytes(f.bytes)}) removed by retention (${plan.retention_days} days)`,
          origin
        })
      } catch (err) {
        failed++
        getApp()?.log?.warn?.(
          { err, file: f.id, versionId: r.version_id },
          '[help-videos] retention could not delete a file'
        )
      }
    }
  }
  const summary = `removed ${files} files (${formatBytes(bytes)}) from ${versions} versions of ${videos.size} videos; retention ${plan.retention_days} days${failed ? `; ${failed} files could not be deleted` : ''}`
  await logActivity({
    action: 'help-video-retention-sweep',
    user: userId,
    collection: 'nivaro_help_videos',
    comment: summary.slice(0, 500),
    origin
  })
  return { retention_days: plan.retention_days, versions, files, bytes, failed, summary }
}
