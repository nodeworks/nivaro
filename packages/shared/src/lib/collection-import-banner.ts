/**
 * #1826 — what the "import running" banner says for a collection's PROCEDURE-mode staged
 * imports (GET /staged-imports/collection-runs). A procedure has no row-level progress, so a
 * running run shows indeterminate progress and the time since it started; an ended one shows
 * its outcome and, when it completed, the rows the run reported. Pure — the component renders.
 */

export interface CollectionImportRun {
  run_id: string
  label: string
  status: 'running' | 'completed' | 'error'
  started_at: string | null
  finished_at: string | null
  rows: number | null
}

export type ImportBannerState =
  | { kind: 'running'; runs: CollectionImportRun[]; elapsedSeconds: number | null }
  | { kind: 'completed' | 'error'; run: CollectionImportRun }
  | null

/** "45 s", "3 min 05 s", "1 h 12 min". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

/**
 * Which banner to show: every running run (elapsed = the longest-running one), else the newest
 * ended run the viewer has not dismissed. Ended runs are the server's to age out.
 */
export function importBannerState(
  runs: CollectionImportRun[] | null | undefined,
  now: number,
  dismissed: ReadonlySet<string> = new Set()
): ImportBannerState {
  const list = runs ?? []
  const running = list.filter((r) => r.status === 'running')
  if (running.length > 0) {
    const starts = running
      .map((r) => (r.started_at ? new Date(r.started_at).getTime() : Number.NaN))
      .filter((t) => Number.isFinite(t))
    const elapsedSeconds = starts.length ? Math.max(0, (now - Math.min(...starts)) / 1000) : null
    return { kind: 'running', runs: running, elapsedSeconds }
  }
  const ended = list
    .filter((r) => (r.status === 'completed' || r.status === 'error') && !dismissed.has(r.run_id))
    .sort((a, b) => new Date(b.finished_at ?? 0).getTime() - new Date(a.finished_at ?? 0).getTime())
  const run = ended[0]
  return run ? { kind: run.status as 'completed' | 'error', run } : null
}

/** "PO lines import" / "2 imports". */
export function runningTitle(runs: CollectionImportRun[]): string {
  if (runs.length === 1) return `${runs[0].label} import is running`
  return `${runs.length} imports are running`
}

/** "1,200 rows reported by the run" — or nothing when the run reported none. */
export function rowsText(rows: number | null): string | null {
  if (rows == null) return null
  return `${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'} reported by the run`
}
