/**
 * Save progress for big saves (realtime round 7, item 8) — the client half.
 *
 * A save that carries many child rows in one write (a new record with its lines) names itself
 * with `?save_progress=<id>`; the server tells this person's own sockets how far it got
 * (`save:progress { save, done, total, phase, finished? }`, api services/save-progress.ts).
 * The save dialog shows "Saving 320/500 lines…". With no socket (or an older server) no event
 * arrives and the step keeps its spinner and "Saving 500 lines…" — the write is the same either
 * way. `save:progress` is the person's own work, so live updates Calm / Off never quiet it.
 */

/** From this many rows a save names itself (the server's SAVE_PROGRESS_MIN_ROWS). */
export const SAVE_PROGRESS_MIN_ROWS = 20

export interface SaveProgressEvent {
  save?: string
  done?: number
  total?: number
  phase?: 'lines' | 'totals'
  finished?: boolean
}

/** A fresh id for one save (letters and digits, 8–64 — what the server accepts). */
export function newSaveId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  return `sv${rand}`.slice(0, 40)
}

/** `/items/c` + the save id, keeping any query the path already has. */
export function withSaveId(path: string, saveId: string | null): string {
  if (!saveId) return path
  return `${path}${path.includes('?') ? '&' : '?'}save_progress=${encodeURIComponent(saveId)}`
}

/** Rows a create body carries in its nested sets (arrays under alias keys). */
export function nestedRowCount(body: Record<string, unknown>, aliasKeys: Iterable<string>): number {
  let n = 0
  for (const k of aliasKeys) {
    const v = body[k]
    if (Array.isArray(v)) n += v.length
  }
  return n
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/**
 * The step's line under "Create Request": what the save is doing now.
 *   before any event   "Saving 500 lines…"
 *   rows landing       "Saving 320 of 500 lines…"
 *   rows all in        "Updating totals…"
 */
export function saveProgressText(
  ev: SaveProgressEvent | null,
  fallbackTotal: number,
  noun: { one: string; many: string } = { one: 'line', many: 'lines' }
): string {
  const total = Math.max(0, Math.round(ev?.total ?? fallbackTotal))
  const word = plural(total, noun.one, noun.many)
  if (!ev || ev.done == null) return `Saving ${total.toLocaleString()} ${word}…`
  const done = Math.min(total, Math.max(0, Math.round(ev.done)))
  if (ev.phase === 'totals' || (done >= total && !ev.finished)) return 'Updating totals…'
  return `Saving ${done.toLocaleString()} of ${total.toLocaleString()} ${word}…`
}
