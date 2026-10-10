import type { StorageRole, StorageVideo } from './api'

// Pure helpers for the Storage view (#1531): sizes as people read them, and
// the sortable table rows (one per version, with the video's own poster
// folded into its published version's row).

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
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

export interface StorageRow {
  video_id: string
  title: string
  status: string
  version_id: string
  version: number
  created_at: string
  /** 'published' | 'draft' | 'earlier' | 'removed' */
  state: 'published' | 'draft' | 'earlier' | 'removed'
  source: number
  rendered: number
  captions: number
  poster: number
  bytes: number
}

export type StorageSortKey = 'title' | 'version' | 'created_at' | 'state' | StorageRole | 'bytes'
export interface StorageSort {
  key: StorageSortKey
  dir: 'asc' | 'desc'
}

const STATE_ORDER = { published: 0, draft: 1, earlier: 2, removed: 3 }

export function storageRows(videos: StorageVideo[]): StorageRow[] {
  const rows: StorageRow[] = []
  for (const v of videos) {
    for (const ver of v.versions) {
      const sum = (role: StorageRole) =>
        ver.files.filter((f) => f.role === role).reduce((n, f) => n + (f.bytes ?? 0), 0)
      const poster = sum('poster') + (ver.is_published && v.poster ? (v.poster.bytes ?? 0) : 0)
      const source = sum('source')
      const rendered = sum('rendered')
      const captions = sum('captions')
      rows.push({
        video_id: v.id,
        title: v.title || 'Untitled video',
        status: v.status,
        version_id: ver.id,
        version: ver.version,
        created_at: ver.created_at,
        state: ver.files_removed_at
          ? 'removed'
          : ver.is_published
            ? 'published'
            : ver.is_draft
              ? 'draft'
              : 'earlier',
        source,
        rendered,
        captions,
        poster,
        bytes: source + rendered + captions + poster
      })
    }
  }
  return rows
}

export function sortStorageRows(rows: StorageRow[], sort: StorageSort): StorageRow[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  const cmp = (a: StorageRow, b: StorageRow): number => {
    switch (sort.key) {
      case 'title':
        return a.title.localeCompare(b.title) || a.version - b.version
      case 'version':
        return a.version - b.version
      case 'created_at':
        return a.created_at.localeCompare(b.created_at)
      case 'state':
        return STATE_ORDER[a.state] - STATE_ORDER[b.state]
      default:
        return a[sort.key] - b[sort.key]
    }
  }
  return [...rows].sort((a, b) => dir * cmp(a, b) || a.title.localeCompare(b.title))
}

/** The next direction when a header is pressed: sizes start large-first. */
export function nextStorageSort(current: StorageSort, key: StorageSortKey): StorageSort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  const sizes: StorageSortKey[] = ['source', 'rendered', 'captions', 'poster', 'bytes']
  return { key, dir: sizes.includes(key) || key === 'created_at' ? 'desc' : 'asc' }
}

/** The retention field as typed → the value to save, or an error line. */
export function parseRetentionInput(
  raw: string,
  limits: { retention_min_days: number; retention_max_days: number }
): { ok: true; days: number | null } | { ok: false; error: string } {
  const t = raw.trim()
  if (!t) return { ok: true, days: null }
  const n = Number(t)
  if (!Number.isInteger(n) || n < limits.retention_min_days || n > limits.retention_max_days) {
    return {
      ok: false,
      error: `Enter a whole number of days from ${limits.retention_min_days} to ${limits.retention_max_days}, or leave it blank to keep everything.`
    }
  }
  return { ok: true, days: n }
}
