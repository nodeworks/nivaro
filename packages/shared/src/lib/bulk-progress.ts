import { useSyncExternalStore } from 'react'
import { useLiveEvent } from './live'

/**
 * Bulk action progress on rows (#1827).
 *
 * A bulk run sends `?progress=<id>`; the server tells the caller's own sockets, row by row,
 * which row it is on and how each ended (`bulk:rows { progress, rows: [{id, status, reason?}],
 * running }`). The list shows a spinner on the running row, then a tick or the refusal reason
 * inline. State is module-level so the bar that starts a run and the rows that render it need no
 * shared parent; it clears itself a few seconds after the run ends.
 */

export type BulkRowState = {
  status: 'queued' | 'running' | 'done' | 'skipped' | 'failed'
  reason?: string
}

interface Run {
  id: string
  rows: Map<string, BulkRowState>
  finished: boolean
}

let run: Run | null = null
let version = 0
const listeners = new Set<() => void>()
let clearTimer: ReturnType<typeof setTimeout> | null = null

function emit() {
  version++
  for (const l of listeners) l()
}

/** A fresh id for one run — the bar passes it as `?progress=` and calls `startBulkProgress`. */
export function newBulkProgressId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  return `bp${rand}`.slice(0, 40)
}

/** Mark the selected rows as waiting; the server's events move them on. */
export function startBulkProgress(id: string, rowIds: Array<string | number>): void {
  if (clearTimer) clearTimeout(clearTimer)
  run = {
    id,
    rows: new Map(rowIds.map((r) => [String(r), { status: 'queued' } as BulkRowState])),
    finished: false
  }
  emit()
}

/** The run is over from this tab's point of view (response arrived): keep the marks briefly. */
export function endBulkProgress(id: string, keepMs = 6000): void {
  if (!run || run.id !== id) return
  run.finished = true
  // Anything the server never reported on has simply finished with the request.
  for (const [k, v] of run.rows)
    if (v.status === 'queued' || v.status === 'running') run.rows.set(k, { status: 'done' })
  emit()
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    if (run?.id === id) {
      run = null
      emit()
    }
  }, keepMs)
}

interface BulkRowsPayload {
  progress?: string
  rows?: Array<{ id: string; status: BulkRowState['status']; reason?: string }>
  running?: string | null
  finished?: boolean
}

function apply(p: BulkRowsPayload): void {
  if (!run || p?.progress !== run.id) return
  for (const r of p.rows ?? []) run.rows.set(String(r.id), { status: r.status, reason: r.reason })
  if (p.running != null) {
    const cur = run.rows.get(String(p.running))
    if (!cur || cur.status === 'queued') run.rows.set(String(p.running), { status: 'running' })
  }
  emit()
}

/** Mount once where a list renders: feeds the socket's `bulk:rows` events into the run. */
export function useBulkProgressFeed(): void {
  useLiveEvent('bulk:rows', apply, { includeOwn: true })
}

/** The state of one row in the current run, or null when it is not part of it. */
export function useBulkRowState(rowId: string | number): BulkRowState | null {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
    () => 0
  )
  return run?.rows.get(String(rowId)) ?? null
}

/** Test seam. */
export function __resetBulkProgress(): void {
  run = null
  version = 0
  if (clearTimer) clearTimeout(clearTimer)
}
export const __applyBulkRows = apply
