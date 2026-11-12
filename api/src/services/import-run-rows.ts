/**
 * The parsed rows of a finished import run, kept in memory for its post-run flows.
 *
 * A post-run flow op (set a pipeline state for the records the file named, push the
 * purchase orders a run linked) needs the FILE's values, not just the record ids the run
 * changed. It used to read them back from the definition's shared staging table, which
 * meant every such import had to keep a copy there (`keep_staging`) and two runs of one
 * import could read each other's rows. The worker now hands each run's rows to this
 * store and the ops read them by run id (`ctx.importProcessors.runRows(runId)`).
 *
 * In memory on purpose: post-run flows run in the process that ran the import, right
 * after it. Rows are kept for RUN_ROWS_TTL_MS so a flow re-run from the flow log soon
 * after still finds them; older runs answer null and the op says so. At most
 * MAX_RUNS runs are held — the oldest goes first.
 */

export type ImportRunRow = Record<string, string>

const RUN_ROWS_TTL_MS = 30 * 60 * 1000
const MAX_RUNS = 20

const store = new Map<string, { rows: ImportRunRow[]; at: number }>()

function sweep(now: number): void {
  for (const [id, v] of store) if (now - v.at > RUN_ROWS_TTL_MS) store.delete(id)
  while (store.size > MAX_RUNS) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

/** Keep a run's parsed rows for its post-run flows. */
export function rememberRunRows(runId: string | number, rows: ImportRunRow[]): void {
  const now = Date.now()
  store.delete(String(runId))
  store.set(String(runId), { rows, at: now })
  sweep(now)
}

/** A run's parsed rows (header-mapped, the staging column names), or null when gone. */
export function runRows(runId: string | number | null | undefined): ImportRunRow[] | null {
  if (runId == null || runId === '') return null
  sweep(Date.now())
  return store.get(String(runId))?.rows ?? null
}

/** Tests only. */
export function _resetRunRows(): void {
  store.clear()
}
