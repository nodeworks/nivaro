/**
 * Pure helpers for the request / trace / statement / compare / capture panels: waterfall layout,
 * durations, bodies, curl, query params, pending retry timing. No React, no fetches.
 */

export interface WaterfallSpan {
  seq: number
  phase: string
  ms: number
  at: number
  detail?: string
  queries?: number
  repeat?: { sql: string; n: number; ms: number }
  wide?: Array<{ table: string; n: number }>
}

export interface WaterfallRow extends WaterfallSpan {
  depth: number
  /** Bar start, percent of the request's total. */
  left: number
  /** Bar width, percent (at least 0.5 so a 0 ms phase still shows). */
  width: number
}

/** Below this much slack a span counts as inside the one before it. */
const SLACK = 0.5

/**
 * Spans indented by containment: a span inside the one before it (start ≥, end ≤) is a child;
 * one that only overlaps sits at the same depth. Bars are proportional to `total`.
 */
export function layoutWaterfall(spans: WaterfallSpan[], total: number): WaterfallRow[] {
  const sorted = [...spans].sort((a, b) => a.at - b.at || b.ms - a.ms)
  const t = Math.max(1, total, ...sorted.map((s) => s.at + s.ms))
  const stack: WaterfallSpan[] = []
  return sorted.map((s) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (s.at >= top.at - SLACK && s.at + s.ms <= top.at + top.ms + SLACK) break
      stack.pop()
    }
    const depth = stack.length
    stack.push(s)
    const left = Math.max(0, Math.min(100, (s.at / t) * 100))
    const width = Math.max(0.5, Math.min(100 - left, (s.ms / t) * 100))
    return { ...s, depth, left, width }
  })
}

/** "12 ms", "1.24 s", "—". */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (Math.abs(ms) >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)} s`
  return `${Math.round(ms * 10) / 10} ms`
}

/** "+1.2 s" / "−40 ms" for a signed delta. */
export function fmtDelta(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms === 0) return 'same'
  return `${ms > 0 ? '+' : '−'}${fmtMs(Math.abs(ms))}`
}

/** A JSON body pretty-printed (two spaces); anything else as it was. */
export function prettyBody(text: string | null | undefined): { text: string; json: boolean } {
  if (text == null) return { text: '', json: false }
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), json: true }
  } catch {
    return { text, json: false }
  }
}

/** The GraphQL request inside a body: its document, variables and operation name. */
export function graphqlParts(
  body: string | null | undefined
): { query: string | null; variables: string | null; operationName: string | null } | null {
  if (!body) return null
  try {
    const b = JSON.parse(body) as Record<string, unknown>
    if (!b || typeof b !== 'object' || Array.isArray(b)) return null
    if (typeof b.query !== 'string' && b.variables == null) return null
    return {
      query: typeof b.query === 'string' ? b.query : null,
      variables:
        b.variables != null && typeof b.variables === 'object'
          ? JSON.stringify(b.variables, null, 2)
          : null,
      operationName: typeof b.operationName === 'string' ? b.operationName : null
    }
  } catch {
    return null
  }
}

/** `a=1&b=x%20y` → decoded pairs in order. */
export function queryPairs(q: string | null | undefined): Array<[string, string]> {
  if (!q) return []
  const s = q.startsWith('?') ? q.slice(1) : q
  const dec = (v: string) => {
    try {
      return decodeURIComponent(v.replace(/\+/g, ' '))
    } catch {
      return v
    }
  }
  return s
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      return eq < 0 ? [dec(part), ''] : [dec(part.slice(0, eq)), dec(part.slice(eq + 1))]
    })
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The request as a curl command. The token is never the real one (`$NIVARO_TOKEN`); a body or
 * query that was masked or cut when stored is said so in a comment, since it will not replay
 * as it is.
 */
export function curlFor(input: {
  origin: string
  method: string
  path: string
  query?: string | null
  body?: string | null
}): string {
  const url = `${input.origin}${input.path}${input.query ? `?${input.query}` : ''}`
  const lines = [`curl -X ${input.method.toUpperCase()} ${shellQuote(url)}`]
  lines.push(`  -H "Authorization: Bearer $NIVARO_TOKEN"`)
  if (input.body) {
    lines.push(`  -H 'Content-Type: application/json'`)
    lines.push(`  --data ${shellQuote(input.body)}`)
  }
  const notes: string[] = []
  if ((input.query ?? '').includes('••••••') || (input.body ?? '').includes('••••••'))
    notes.push('# Values shown as •••••• were masked when stored — fill them in before running.')
  if ((input.query ?? '').endsWith('…') || (input.body ?? '').endsWith('…'))
    notes.push('# The stored query or body was cut short — complete it before running.')
  return [...notes, lines.join(' \\\n')].join('\n')
}

/** Keep polling a pending request? Every 2 s, for at most 20 s after the first answer. */
export const PENDING_RETRY_MS = 2000
export const PENDING_GIVE_UP_MS = 20_000
export function shouldRetryPending(firstAt: number, now: number): boolean {
  return now - firstAt < PENDING_GIVE_UP_MS
}

/** "+1.2 s" offset of a neighbour from the request it sits beside. */
export function offsetText(at: string | null, from: string | null): string {
  if (!at || !from) return ''
  const d = Date.parse(at) - Date.parse(from)
  if (!Number.isFinite(d)) return ''
  if (Math.abs(d) < 50) return 'same time'
  return `${d > 0 ? '+' : '−'}${fmtMs(Math.abs(d))}`
}

/** Seconds left until `expiresAt` as "4:05"; "expired" at 0. */
export function countdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000))
  if (s === 0) return 'expired'
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Does a statement read every column of a table that carries a long-text column (#483)? */
export function isWideStatement(sql: string, wide: Array<{ table: string }> | undefined): boolean {
  if (!wide || wide.length === 0) return false
  const m = /^\s*select\s+(?:top\s*\(?[@\w]+\)?\s+)?\*\s+from\s+\[?([A-Za-z0-9_]+)\]?/i.exec(sql)
  return !!m && wide.some((w) => w.table.toLowerCase() === m[1].toLowerCase())
}

/** The N+1 shape a statement is, from the spans that flagged a repeated statement. */
export function repeatOf(
  sql: string,
  spans: Array<{ repeat?: { sql: string; n: number } }>
): number | null {
  let best: number | null = null
  for (const s of spans)
    if (s.repeat && s.repeat.sql === sql) best = Math.max(best ?? 0, s.repeat.n)
  return best
}

/** Bars for one compared phase: widths as a percent of the larger of the pair across all phases. */
export function compareBars(
  phases: Array<{ a: number | null; b: number | null }>
): Array<{ a: number; b: number }> {
  const max = Math.max(1, ...phases.flatMap((p) => [p.a ?? 0, p.b ?? 0]))
  return phases.map((p) => ({
    a: p.a == null ? 0 : Math.max(0.5, (p.a / max) * 100),
    b: p.b == null ? 0 : Math.max(0.5, (p.b / max) * 100)
  }))
}

/** `rid1,rid2` → the pair, else null. */
export function comparePair(id: string): [string, string] | null {
  const parts = id.split(',')
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null
}

/** The caller key a request was made with, for "only this caller". */
export function callerKeyOf(row: { caller?: { key?: string } | null } | null): string | null {
  const k = row?.caller?.key
  return k || null
}
