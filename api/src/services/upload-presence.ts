/**
 * "Beth is uploading quote.pdf (60%)" (realtime round 9, item 9) — the per-socket bookkeeping
 * behind the record-room `record:uploading` relay (plugins/socketio.ts). Pure: no I/O.
 *
 *  - `accept` cleans a client's report and says whether to relay it: progress is passed on at
 *    most every `PROGRESS_GAP_MS` per upload (a 40 MB file reports hundreds of times), start,
 *    finish and cancel always are.
 *  - `drop(room)` / `dropAll()` end what this socket still had in flight when it leaves the
 *    record or disconnects, so a closed tab never leaves a chip spinning on someone else's screen.
 *
 * The wire shape stays readable by older clients, which only know `state: 'start' | 'done'`:
 * progress rides `state: 'start'` + `phase: 'progress'`, a cancel rides `state: 'done'` +
 * `phase: 'cancel'`.
 */

export const PROGRESS_GAP_MS = 700
export const MAX_IN_FLIGHT = 10

export type UploadPhase = 'start' | 'progress' | 'done' | 'cancel'

export interface UploadReport {
  room: string
  upload: string
  field: string | null
  name: string
  phase: UploadPhase
  /** 0–100, whole numbers; null before the browser knows the size. */
  pct: number | null
}

interface InFlight {
  room: string
  field: string | null
  name: string
  lastSent: number
}

const UPLOAD_ID = /^[A-Za-z0-9_-]{1,40}$/
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** A client payload → a clean report, or null when it is not one. */
export function parseUploadReport(
  room: string,
  payload: unknown,
  fallbackId: string
): UploadReport | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const phase: UploadPhase =
    p.phase === 'progress' || p.phase === 'cancel' || p.phase === 'done' || p.phase === 'start'
      ? (p.phase as UploadPhase)
      : p.state === 'done'
        ? 'done'
        : 'start'
  const upload = typeof p.upload === 'string' && UPLOAD_ID.test(p.upload) ? p.upload : fallbackId
  const field = typeof p.field === 'string' && FIELD.test(p.field) ? p.field : null
  const raw = Number(p.pct)
  const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null
  const name =
    String(p.name ?? '')
      .trim()
      .slice(0, 200) || 'a file'
  return { room, upload, field, name, phase, pct }
}

export interface UploadTracker {
  /** Should this report be relayed now? Updates the in-flight list. */
  accept(r: UploadReport, now?: number): boolean
  /** Uploads still in flight in `room` (ended — the caller announces their cancel). */
  drop(room: string): UploadReport[]
  dropAll(): UploadReport[]
  size(): number
}

export function uploadTracker(): UploadTracker {
  const live = new Map<string, InFlight>()
  const end = (keep: (f: InFlight) => boolean): UploadReport[] => {
    const out: UploadReport[] = []
    for (const [id, f] of live) {
      if (!keep(f)) continue
      live.delete(id)
      out.push({
        room: f.room,
        upload: id,
        field: f.field,
        name: f.name,
        phase: 'cancel',
        pct: null
      })
    }
    return out
  }
  return {
    accept(r, now = Date.now()) {
      const cur = live.get(r.upload)
      if (r.phase === 'done' || r.phase === 'cancel') {
        live.delete(r.upload)
        return true
      }
      if (r.phase === 'start' || !cur) {
        if (!cur && live.size >= MAX_IN_FLIGHT) return false
        live.set(r.upload, { room: r.room, field: r.field, name: r.name, lastSent: now })
        return true
      }
      // progress: never faster than the gap, except the last step.
      if (cur.room !== r.room) return false
      if (r.pct !== 100 && now - cur.lastSent < PROGRESS_GAP_MS) return false
      cur.lastSent = now
      return true
    },
    drop: (room) => end((f) => f.room === room),
    dropAll: () => end(() => true),
    size: () => live.size
  }
}

/** The event a viewer gets. `name` only when they may read the field (else a neutral word). */
export function uploadEvent(
  r: UploadReport,
  record: { collection: string | null; item: string | null },
  user: { id: string; name: string },
  withName: boolean
): Record<string, unknown> {
  return {
    collection: record.collection,
    item: record.item,
    user: user.id,
    user_name: user.name,
    upload: r.upload,
    field: r.field,
    name: withName ? r.name : 'a file',
    name_hidden: !withName,
    // Older clients read only `state`: progress keeps the chip ('start'), cancel removes it.
    state: r.phase === 'done' || r.phase === 'cancel' ? 'done' : 'start',
    phase: r.phase,
    pct: r.pct
  }
}
