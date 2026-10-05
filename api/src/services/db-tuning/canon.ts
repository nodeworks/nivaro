/**
 * Row canonicalisation for the twin proof: the same result set must read the same
 * whatever the column order, numeric type or time of day. Elapsed-time style columns
 * are excluded because several report procedures emit them and they can never agree
 * across two runs seconds apart.
 */
// Known cost: a genuine data column such as `age_group` is excluded too.
export const EXCLUDED_COLUMN_PATTERNS: RegExp[] = [
  /elapsed/i,
  /_ms$/i,
  /^duration/i,
  /^age_/i,
  /_age$/i,
  /^run_at$/i,
  /^generated_at$/i
]

function norm(v: unknown): unknown {
  if (v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : String(v)
  // No leading zeros: varchar codes like "007" must stay distinct from "7".
  if (typeof v === 'string' && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(v.trim())) {
    const n = Number(v)
    if (Number.isFinite(n) && Math.abs(n) < 1e15) return Math.round(n * 10000) / 10000
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  if (Buffer.isBuffer(v)) return v.toString('base64')
  return v
}

export function canonRow(
  row: Record<string, unknown>,
  exclude: RegExp[] = EXCLUDED_COLUMN_PATTERNS
): string {
  const keys = Object.keys(row)
    .filter((k) => !exclude.some((re) => re.test(k)))
    .sort()
  return JSON.stringify(keys.map((k) => [k, norm(row[k])]))
}

export function canonRows(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((r) => canonRow(r)).sort()
}

export function multisetDiff(a: string[], b: string[]): { added: string[]; removed: string[] } {
  const count = new Map<string, number>()
  for (const s of a) count.set(s, (count.get(s) ?? 0) + 1)
  const added: string[] = []
  for (const s of b) {
    const n = count.get(s) ?? 0
    if (n > 0) count.set(s, n - 1)
    else added.push(s)
  }
  const removed: string[] = []
  for (const [s, n] of count) for (let i = 0; i < n; i++) removed.push(s)
  return { added, removed }
}
