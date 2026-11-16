import { useEffect, useSyncExternalStore } from 'react'
import { startFileUpload, type UploadConfig, viewAsFetchActive } from './upload-file'

/**
 * "Beth is uploading quote.pdf (60%)" (realtime #282, round 9 item 9).
 *
 * Outbound: a file field uploads through `trackedUpload`, which reports start, progress (a few
 * times a second at most), finish and cancel as the window event `nvr:upload-state`. The record
 * page's socket (RecordLiveSync, or admin's presence socket) carries it into the record room.
 * The server sends the file name only to viewers who may read that field (everyone else reads
 * "a file") and ends an upload whose tab leaves.
 *
 * Inbound: `applyRemoteUpload` keeps the co-viewers' uploads in one small store per page.
 * A file field shows the uploads going into it (`useRemoteUploads(c, id, field)`) and claims
 * its field (`useClaimUploadField`); the record's chip row shows only those no mounted field
 * claimed. An upload not heard from for `STALE_MS` drops on its own.
 */

export type UploadPhase = 'start' | 'progress' | 'done' | 'cancel'

export interface UploadStateDetail {
  upload: string
  name: string
  phase: UploadPhase
  /** Older listeners read only this: 'start' while running, 'done' when it ended. */
  state: 'start' | 'done'
  pct: number | null
  field?: string
  collection?: string
  item?: string
}

export const UPLOAD_STATE_EVENT = 'nvr:upload-state'
/** A progress report leaves at most this often (the server keeps its own gap too). */
export const PROGRESS_REPORT_MS = 500
/** A remote upload with no news for this long is dropped (the uploader's tab went away). */
export const STALE_MS = 30_000

let seq = 0
export function newUploadId(): string {
  seq = (seq + 1) % 1_000_000
  return `u${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function reportUploadState(d: Omit<UploadStateDetail, 'state'>): void {
  if (typeof window === 'undefined') return
  const detail: UploadStateDetail = {
    ...d,
    state: d.phase === 'done' || d.phase === 'cancel' ? 'done' : 'start'
  }
  window.dispatchEvent(new CustomEvent(UPLOAD_STATE_EVENT, { detail }))
}

/**
 * May this tab upload with progress (XMLHttpRequest) instead of the SDK client's fetch? Not in a
 * "View as" tab: its person rides a fetch wrapper (window flag `__nvrViewAsFetch`), which an XHR
 * would not carry — that tab keeps the client's upload, without a percentage.
 */
export function progressUploadAllowed(): boolean {
  if (typeof window === 'undefined' || typeof XMLHttpRequest === 'undefined') return false
  return !viewAsFetchActive()
}

/**
 * Upload one file and tell the record's co-viewers how it goes. `fallback` is the SDK client's
 * own upload, used when progress is not available. Resolves with the new file's id.
 */
export function trackedUpload(
  file: File,
  opts: {
    cfg: UploadConfig
    fallback: (file: File) => Promise<{ id: string }>
    field?: string
    collection?: string
    item?: string
    onProgress?: (pct: number) => void
  }
): Promise<{ id: string }> {
  const upload = newUploadId()
  const base = {
    upload,
    name: file.name,
    field: opts.field,
    collection: opts.collection,
    item: opts.item
  }
  reportUploadState({ ...base, phase: 'start', pct: 0 })
  let last = 0
  const finish = (phase: 'done' | 'cancel') => reportUploadState({ ...base, phase, pct: null })
  if (!progressUploadAllowed()) {
    return opts.fallback(file).then(
      (r) => {
        finish('done')
        return r
      },
      (err) => {
        finish('cancel')
        throw err
      }
    )
  }
  return new Promise((resolve, reject) => {
    startFileUpload(opts.cfg, file, {
      onProgress: (fraction) => {
        const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)))
        opts.onProgress?.(pct)
        const now = Date.now()
        if (now - last < PROGRESS_REPORT_MS && pct < 100) return
        last = now
        reportUploadState({ ...base, phase: 'progress', pct })
      },
      onDone: (id) => {
        finish('done')
        resolve({ id })
      },
      onError: (message) => {
        finish('cancel')
        reject(new Error(message))
      }
    })
  })
}

// ─── Other people's uploads on this page ────────────────────────────────────

export interface RemoteUpload {
  key: string
  collection: string
  item: string
  field: string | null
  user: string
  /** null when the server did not name the file to this viewer. */
  name: string | null
  pct: number | null
  seen: number
}

let uploads: RemoteUpload[] = []
const claimed = new Map<string, number>()
const listeners = new Set<() => void>()
let sweep: ReturnType<typeof setInterval> | null = null

/** What the hooks read: a new object on every change (uploads or field claims). */
let state: { uploads: RemoteUpload[] } = { uploads }
const emit = () => {
  state = { uploads }
  for (const l of listeners) l()
}

function ensureSweep() {
  if (sweep || typeof setInterval === 'undefined') return
  sweep = setInterval(() => {
    const cut = Date.now() - STALE_MS
    const kept = uploads.filter((u) => u.seen >= cut)
    if (kept.length !== uploads.length) {
      uploads = kept
      emit()
    }
    if (uploads.length === 0 && sweep) {
      clearInterval(sweep)
      sweep = null
    }
  }, 5_000)
}

/** One `record:uploading` payload from the server (pure on the store; ignores bad payloads). */
export function applyRemoteUpload(p: unknown, now = Date.now()): void {
  if (!p || typeof p !== 'object') return
  const r = p as Record<string, unknown>
  if (r.collection == null || r.item == null) return
  const user = String(r.user_name ?? r.user ?? 'Someone')
  const hidden = r.name_hidden === true
  const name = hidden ? null : String(r.name ?? '') || null
  // Older servers send no upload id: one entry per person + file name.
  const key = typeof r.upload === 'string' && r.upload ? r.upload : `${user}:${name ?? ''}`
  const phase = String(r.phase ?? (r.state === 'done' ? 'done' : 'start'))
  const rest = uploads.filter((u) => u.key !== key)
  if (phase === 'done' || phase === 'cancel') {
    if (rest.length !== uploads.length) {
      uploads = rest
      emit()
    }
    return
  }
  const pct = Number.isFinite(Number(r.pct)) && r.pct !== null ? Number(r.pct) : null
  uploads = [
    ...rest,
    {
      key,
      collection: String(r.collection),
      item: String(r.item),
      field: typeof r.field === 'string' && r.field ? r.field : null,
      user,
      name,
      pct,
      seen: now
    }
  ]
  ensureSweep()
  emit()
}

/** Tests only. */
export function __remoteUploads(): RemoteUpload[] {
  return uploads
}

/** Tests only. */
export function __resetRemoteUploads(): void {
  uploads = []
  claimed.clear()
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
const snapshot = () => state

const claimKey = (c: string, i: string, f: string) => `${c}\u0000${i}\u0000${f}`

/** The uploads going on in a record; `field` narrows to one field, `'unclaimed'` to the rest. */
export function remoteUploadsFor(
  list: readonly RemoteUpload[],
  collection: string,
  item: string,
  field?: string | 'unclaimed'
): RemoteUpload[] {
  return list.filter((u) => {
    if (u.collection !== collection || u.item !== String(item)) return false
    if (field === undefined) return true
    if (field === 'unclaimed')
      return !u.field || !claimed.has(claimKey(collection, String(item), u.field))
    return u.field === field
  })
}

export function useRemoteUploads(
  collection: string | null | undefined,
  item: string | null | undefined,
  field?: string | 'unclaimed'
): RemoteUpload[] {
  const { uploads: list } = useSyncExternalStore(subscribe, snapshot, snapshot)
  if (!collection || item == null) return []
  return remoteUploadsFor(list, collection, String(item), field)
}

/** A mounted file field shows its own uploads; the record's chip row leaves them out. */
export function useClaimUploadField(
  collection: string | null | undefined,
  item: string | null | undefined,
  field: string | null | undefined
): void {
  useEffect(() => {
    if (!collection || item == null || !field) return
    const k = claimKey(collection, String(item), field)
    claimed.set(k, (claimed.get(k) ?? 0) + 1)
    emit()
    return () => {
      const n = (claimed.get(k) ?? 1) - 1
      if (n <= 0) claimed.delete(k)
      else claimed.set(k, n)
      emit()
    }
  }, [collection, item, field])
}

/** "Beth is uploading quote.pdf (60%)" / "Beth is uploading a file". */
export function uploadSentence(u: Pick<RemoteUpload, 'user' | 'name' | 'pct'>): string {
  const name = u.name ? (u.name.length > 40 ? `${u.name.slice(0, 39)}…` : u.name) : null
  const what = name ? `“${name}”` : 'a file'
  const pct = u.pct != null && u.pct > 0 && u.pct < 100 ? ` (${u.pct}%)` : ''
  return `${u.user} is uploading ${what}${pct}`
}
