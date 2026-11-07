/**
 * What a requirements-dialog pick changes BESIDES the field it asked for
 * (army5 b09 HIGH): picking a line's Category runs the server's
 * cross-record defaults, and those overwrote the line's Price ($2 → $1, line
 * $14 → $7) with nothing on screen. The dialog rehearses each row's write
 * (PATCH ?dry_run=1) and names every value the row ALREADY HAD that the write
 * would replace, before anything is saved. A value filled into an empty field
 * is the derivation working as designed and is not asked about.
 */
export interface RehearsalReport {
  ok?: boolean
  changes?: Array<{ field: string; from: unknown; to: unknown }>
}

export interface SideEffectChange {
  field: string
  from: unknown
  to: unknown
}

const blank = (v: unknown) => v === null || v === undefined || v === ''

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (blank(a) && blank(b)) return true
  if (blank(a) || blank(b)) return false
  if (typeof a !== 'object' && typeof b !== 'object') {
    const na = Number(a)
    const nb = Number(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb
    return String(a) === String(b)
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Bookkeeping columns every write stamps (army6 M2): a Category pick asked to
 * confirm "Changed: 2026-11-06T16:02:14.065Z → …". The server's own stamp is
 * never a value the person chose, so it is never asked about.
 */
export const AUDIT_FIELDS: ReadonlySet<string> = new Set([
  'changed',
  'created',
  'modified',
  'date_created',
  'date_updated',
  'date_modified',
  'created_at',
  'updated_at',
  'modified_at',
  'user_created',
  'user_updated',
  'created_by',
  'updated_by',
  'modified_by'
])

/** The rehearsal's changes to fields the dialog did not send, over a value
 *  the row already held. `known` (when given) limits them to fields the
 *  dialog shows — a column it has no meta for means nothing to the person. */
export function overwrittenBySideEffect(
  report: RehearsalReport | null | undefined,
  sent: Record<string, unknown>,
  known?: (field: string) => boolean
): SideEffectChange[] {
  if (!report || report.ok === false || !Array.isArray(report.changes)) return []
  const out: SideEffectChange[] = []
  for (const c of report.changes) {
    if (!c || typeof c.field !== 'string') continue
    if (c.field in sent || c.field.startsWith('_')) continue
    if (AUDIT_FIELDS.has(c.field.toLowerCase())) continue
    if (known && !known(c.field)) continue
    if (blank(c.from) || same(c.from, c.to)) continue
    out.push({ field: c.field, from: c.from, to: c.to })
  }
  return out
}

/** "Keep current values": the row's write also carries the values it already
 *  had, which the server's cross-record defaults never overwrite (a target the
 *  caller sent is left alone). A write-computed column the server drops or
 *  re-derives from its kept inputs. */
export function keepValuesPatch(changes: SideEffectChange[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const c of changes) out[c.field] = c.from
  return out
}

/** At most this many row writes (or rehearsals) in flight from one dialog
 *  (REVIEW-R5 M5): each is a full update in its own transaction holding row
 *  locks, and a Submit with 40–80 lines sent them all at once. */
export const ROW_WRITE_CONCURRENCY = 5

/** Run `tasks` with at most `limit` in flight; results in task order. A task
 *  that throws rejects the whole run, like Promise.all — callers catch inside
 *  each task. */
export async function runPooled<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit = ROW_WRITE_CONCURRENCY
): Promise<T[]> {
  const out = new Array<T>(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      out[i] = await tasks[i]()
    }
  }
  const n = Math.max(1, Math.min(limit, tasks.length))
  await Promise.all(Array.from({ length: n }, worker))
  return out
}
