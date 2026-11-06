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

/** The rehearsal's changes to fields the dialog did not send, over a value
 *  the row already held. */
export function overwrittenBySideEffect(
  report: RehearsalReport | null | undefined,
  sent: Record<string, unknown>
): SideEffectChange[] {
  if (!report || report.ok === false || !Array.isArray(report.changes)) return []
  const out: SideEffectChange[] = []
  for (const c of report.changes) {
    if (!c || typeof c.field !== 'string') continue
    if (c.field in sent || c.field.startsWith('_')) continue
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
