import { emitToUser } from './live-progress.js'

/**
 * Save progress for big saves (realtime round 7, item 8).
 *
 * A record saved with many child rows in ONE write (a new request with 500 lines, an
 * integration posting a nested set) used to sit on a spinner until the last row was in. The
 * tab that saves now names its save (`?save_progress=<id>`, an id it made up) and the server
 * tells that person's own sockets how far it got:
 *
 *   save:progress { save, done, total, phase: 'lines' | 'totals', finished? }
 *
 * Counts only — never a value, never a row id — to the `user:<id>` room, which only the
 * saver's own sockets can join. Emits are throttled (the first, then at most one per
 * SAVE_PROGRESS_EMIT_MS, then the last), so 500 rows are a handful of small events. Nothing
 * about the write changes: no id (or a malformed one), too few rows, or no socket and the
 * write runs exactly as before; the client falls back to its spinner.
 *
 * Nested writes nest (a line with its own sub-rows): the first set opened for a request owns
 * the progress, inner sets report nothing of their own.
 */

/** Fewer rows than this save fast enough that a count would only flicker. */
export const SAVE_PROGRESS_MIN_ROWS = 20
export const SAVE_PROGRESS_EMIT_MS = 200

const SAVE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

export type SavePhase = 'lines' | 'totals'

export interface SaveProgressEvent {
  save: string
  done: number
  total: number
  phase: SavePhase
  finished?: true
}

export interface SaveProgress {
  /** Rows the save will write on top of what it was opened with (a set's removals, found late). */
  grow(n: number): void
  /** One (or n) rows written. */
  step(n?: number): void
  /** The rows are in; the totals they feed are being recalculated. */
  phase(p: SavePhase): void
  /** The write finished (or failed): one closing event. */
  end(): void
}

const NOOP: SaveProgress = { grow() {}, step() {}, phase() {}, end() {} }

/** The save id a request carries, or null (validated: letters, digits, `_`, `-`, 8–64). */
export function saveIdOf(req: { query?: unknown } | null | undefined): string | null {
  const raw = (req?.query as Record<string, unknown> | undefined)?.save_progress
  return typeof raw === 'string' && SAVE_ID_RE.test(raw) ? raw : null
}

// One progress per request: an inner nested write (a line's own sub-rows) never opens a second.
const open = new WeakMap<object, SaveProgress>()

/**
 * Progress for one save. `emit` is injectable for tests; `now` too.
 * Returns a no-op unless the request names a save, a person, and at least SAVE_PROGRESS_MIN_ROWS.
 */
export function openSaveProgress(
  req: { query?: unknown; user?: { id?: string | null } | null } | null | undefined,
  total: number,
  opts: {
    emit?: (userId: string, ev: SaveProgressEvent) => void
    now?: () => number
    minRows?: number
  } = {}
): SaveProgress & { owner: boolean } {
  if (!req || typeof req !== 'object') return { ...NOOP, owner: false }
  const existing = open.get(req)
  if (existing) return { ...NOOP, owner: false }
  const save = saveIdOf(req)
  const userId = req.user?.id ?? null
  if (!save || !userId || total < (opts.minRows ?? SAVE_PROGRESS_MIN_ROWS))
    return { ...NOOP, owner: false }
  const emit = opts.emit ?? ((uid, ev) => emitToUser(uid, 'save:progress', ev))
  const now = opts.now ?? Date.now
  let done = 0
  let size = total
  let phase: SavePhase = 'lines'
  let last = 0
  let ended = false
  const send = (force: boolean, finished = false) => {
    const t = now()
    if (!force && t - last < SAVE_PROGRESS_EMIT_MS) return
    last = t
    const ev: SaveProgressEvent = { save, done: Math.min(done, size), total: size, phase }
    if (finished) ev.finished = true
    emit(userId, ev)
  }
  const progress: SaveProgress = {
    grow(n) {
      if (n > 0) size += n
    },
    step(n = 1) {
      if (ended) return
      done += n
      send(false)
    },
    phase(p) {
      if (ended || p === phase) return
      phase = p
      send(true)
    },
    end() {
      if (ended) return
      ended = true
      open.delete(req)
      send(true, true)
    }
  }
  open.set(req, progress)
  // The first event says how many rows there are before the first one lands.
  send(true)
  return { ...progress, owner: true }
}
