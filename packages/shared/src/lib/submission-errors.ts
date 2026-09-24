/**
 * Which rows of a submitted line grid a FAILED partner submission was about,
 * and which reason belongs to which row — vendor-agnostic, so the catalog
 * picker (and anything else showing per-line feedback) needs no partner
 * names in it.
 *
 *  - The payload's line items are its first top-level array of objects
 *    (MDSi `products`, Fusion `orderDetails`, …); every primitive value of a
 *    line is a candidate identifier (cifaNumber, productNumber, sku…).
 *  - Identifiers compare with leading zeros stripped, so a partner's
 *    "000105608" still names our "105608".
 *  - The decoded error's " · "-joined segments that start "LineNumber N:" /
 *    "Line N:" name the Nth line of the payload (the order it was built in);
 *    only that row carries that reason. Segments naming no line apply to
 *    every submitted row. Without any line-specific segment, every row that
 *    was in the payload carries the whole error, as before.
 */

/** Digit-only values compare with leading zeros stripped, everything else verbatim. */
export function normalizeIdent(v: string | number): string {
  const s = String(v).trim()
  return /^\d+$/.test(s) ? String(Number.parseInt(s, 10)) : s
}

export interface SubmissionLineErrors {
  /** Every identifier the payload's lines carried (normalized). */
  idents: Set<string>
  /** The whole decoded error. */
  error: string
  /** The reason for a row given its candidate identifiers (normalized), or null. */
  reasonFor: (rowIdents: string[]) => string | null
}

const LINE_SEGMENT_RE = /^\s*Line(?:\s*Number)?\s*(\d+)\s*[:\-–]\s*(.*)$/i

export function submissionLineErrors(
  body: Record<string, unknown> | null | undefined,
  lastError: string | null | undefined
): SubmissionLineErrors | null {
  const lines = (Object.values(body ?? {}).find(
    (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object')
  ) ?? []) as Array<Record<string, unknown>>
  const identsOf = (line: Record<string, unknown>) => {
    const out = new Set<string>()
    for (const v of Object.values(line ?? {})) {
      if ((typeof v === 'string' || typeof v === 'number') && v !== '') out.add(normalizeIdent(v))
    }
    return out
  }
  const all = new Set<string>()
  for (const line of lines) for (const i of identsOf(line)) all.add(i)
  if (all.size === 0) return null
  const error = lastError ?? 'Submission failed'
  const perLine = new Map<number, string[]>()
  const general: string[] = []
  for (const seg of error.split(' · ')) {
    const m = LINE_SEGMENT_RE.exec(seg)
    if (m) {
      const n = Number(m[1])
      perLine.set(n, [...(perLine.get(n) ?? []), m[2].trim() || seg.trim()])
    } else if (seg.trim()) general.push(seg.trim())
  }
  const byIdent = new Map<string, string>()
  for (const [n, msgs] of perLine) {
    const line = lines[n - 1]
    if (!line) continue
    for (const i of identsOf(line)) byIdent.set(i, msgs.join(' · '))
  }
  return {
    idents: all,
    error,
    reasonFor: (rowIdents) => {
      const named = rowIdents.map((i) => byIdent.get(i)).find(Boolean) ?? null
      if (perLine.size > 0) return named ?? (general.length ? general.join(' · ') : null)
      return rowIdents.some((i) => all.has(i)) ? error : null
    }
  }
}
