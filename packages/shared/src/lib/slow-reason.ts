/**
 * "This is taking a while" with a reason (#3231) — the client half of
 * GET /api/background-runs/waiting.
 *
 * The server tells a page what ITS OWN unfinished read is waiting on (a free heavy-read slot and
 * where it stands in line, an external partner, an uncached query or widget, a statement still
 * running); this file turns that answer into one plain sentence. Pure — the hook and the notice
 * live in hooks/useSlowReason.ts and components/SlowNotice.tsx.
 */

export type WaitKind = 'slot' | 'external' | 'query' | 'widget' | 'database' | 'auth' | 'working'

/** The server's answer (api/src/services/wait-reasons.ts WaitAnswer). */
export interface WaitAnswer {
  found: boolean
  kind?: WaitKind
  subject?: string | null
  shared?: boolean
  position?: number | null
  of?: number | null
  age_ms?: number
  statement_ms?: number
  rows_so_far?: number
  collection?: string | null
  /** About how many rows the table holds — administrators only. */
  table_rows?: number | null
  peer?: boolean
}

export interface SlowReasonContext {
  /** Plural noun for what a list reads, e.g. "invoices". */
  noun?: string | null
  /** What the page calls this read, e.g. "PUB health" (a query or widget title). */
  label?: string | null
  /** Rows the person can see, when the page already knows (a total from an earlier load). */
  knownRows?: number | null
}

/** Ask the server once a read has been loading this long. */
export const SLOW_REASON_AFTER_MS = 3000
/** Ask again this often while it is still loading. */
export const SLOW_REASON_POLL_MS = 3000
/** Stop asking after this many answers (the elapsed time keeps counting). */
export const SLOW_REASON_MAX_POLLS = 40

/** 48000 → "48,000"; 1250000 → "1.3 million". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1_000_000) {
    const m = Math.round(n / 100_000) / 10
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)} million`
  }
  return Math.round(n).toLocaleString('en-US')
}

/** "fusion_erp" → "Fusion Erp"; "MWF" stays "MWF". */
function friendly(s: string): string {
  const t = s.replace(/[_-]+/g, ' ').trim()
  if (!t) return s
  return t
    .split(/\s+/)
    .map((w) => (w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
}

function nounOf(ctx: SlowReasonContext, answer: WaitAnswer): string | null {
  if (ctx.noun) return ctx.noun
  if (answer.collection) return answer.collection.replace(/_/g, ' ')
  return null
}

/**
 * One plain sentence for what a slow read is waiting on, or null when the server knows nothing
 * useful (the request already finished, another replica not seen yet, cloud mode).
 */
export function slowReasonText(
  answer: WaitAnswer | null | undefined,
  ctx: SlowReasonContext = {}
): string | null {
  if (!answer?.found || !answer.kind) return null
  const noun = nounOf(ctx, answer)
  switch (answer.kind) {
    case 'slot': {
      const pos = answer.position ?? null
      if (pos && pos > 1)
        return `Waiting for a free slot — busy right now (${pos - 1} ahead of you)`
      if (pos === 1) return 'Waiting for a free slot — busy right now (you are next)'
      return 'Waiting for a free slot — busy right now'
    }
    case 'external':
      return answer.subject
        ? `Waiting for ${friendly(answer.subject)}`
        : 'Waiting for a partner system'
    case 'query':
    case 'widget': {
      const what =
        ctx.label?.trim() ||
        (answer.subject
          ? friendly(answer.subject)
          : answer.kind === 'widget'
            ? 'this widget'
            : 'the query')
      if (answer.shared) return `Someone else is running ${what} too — sharing their answer`
      return answer.kind === 'widget'
        ? `Working out ${what} — not cached yet`
        : `Running ${what} — not cached yet`
    }
    case 'database': {
      const rows = ctx.knownRows ?? answer.table_rows ?? null
      const so =
        answer.rows_so_far && answer.rows_so_far > 0
          ? ` — ${formatCount(answer.rows_so_far)} so far`
          : ''
      if (rows && rows > 0) return `Reading ${formatCount(rows)} ${noun ?? 'records'}${so}`
      return noun ? `Reading ${noun} from the database${so}` : `Reading from the database${so}`
    }
    case 'auth':
      return 'Checking your sign-in'
    default:
      return noun ? `Preparing ${noun}` : null
  }
}

/** "8s", "1m 05s" — how long a read has been loading. */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * A total the person has already seen for this list, from any cached page of it (search, sort
 * and filters aside) — so "Reading 48,000 invoices" never counts rows they cannot see.
 */
export function knownTotalFrom(entries: ReadonlyArray<readonly [unknown, unknown]>): number | null {
  let best: number | null = null
  for (const [, data] of entries) {
    const t = (data as { total?: unknown } | undefined)?.total
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) best = Math.max(best ?? 0, t)
  }
  return best
}
