/**
 * Ready-to-send board (idea 37) — the stored result's shape and the read side: which entries a
 * viewer may see, and how they group by partner and by problem. Pure except `visibleEntries`,
 * whose gate reads are injectable (tests).
 */
import type { User } from '../../types.js'
import type { PreflightIssue } from '../integration-preview.js'
import { type AccessGates, compileAccessGates, visibleIds } from '../record-access.js'

export const READY_JOB_ID = 'ready-to-send'

export type Severity = PreflightIssue['severity']

/** One record's next manual move that pushes to a partner, and what stands in its way. */
export interface ReadyEntry {
  collection: string
  item: string
  label: string
  /** The record's current step. */
  state: string | null
  transition: { id: string; label: string }
  /** Partners the move would send to (pushes that apply to this record). */
  partners: string[]
  /** Who owns the current step (names only). */
  owners: Array<{ id: string; name: string }>
  issues: PreflightIssue[]
  worst: Severity
  checked_at: string
  /** Set when a person ran "Check again" (their name). */
  checked_by?: string | null
}

export interface ReadyResult {
  kind: 'ready-to-send'
  generated_at: string
  trigger: string
  /** Open records whose next manual move pushes to a partner. */
  candidates: number
  /** Records actually checked (fewer when the run hit its cap or its time box). */
  checked: number
  /** Checked records with nothing in the way. */
  ready: number
  /** Records the check itself failed on (left out of the board). */
  errors: number
  partial: { reason: 'cap' | 'time'; checked: number; total: number } | null
  collections: Record<string, string>
  entries: ReadyEntry[]
  duration_ms: number
}

const RANK: Record<Severity, number> = { block: 0, warn: 1, ask: 2 }

export function worstOf(issues: PreflightIssue[]): Severity | null {
  let worst: Severity | null = null
  for (const i of issues) if (worst == null || RANK[i.severity] < RANK[worst]) worst = i.severity
  return worst
}

/** "Asks for Sales order on 2 lines" → "Asks for Sales order on some lines": one problem, many
 *  records. The record's own row keeps the exact count. */
export function problemLabel(message: string): string {
  return message.replace(/\bon \d+ lines?\b/, 'on some lines').trim()
}

export const problemKey = (i: Pick<PreflightIssue, 'severity' | 'message'>) =>
  `${i.severity}|${problemLabel(i.message)}`

export interface PartnerGroup {
  partner: string
  records: number
  refused: number
  warnings: number
  asks: number
}

export interface ProblemGroup {
  key: string
  label: string
  severity: Severity
  kind: PreflightIssue['kind'] | null
  /** Partners whose records carry it. */
  partners: string[]
  records: number
  /** Lines involved across those records (line-level problems only). */
  lines: number
}

const recordKey = (e: Pick<ReadyEntry, 'collection' | 'item'>) =>
  `${e.collection}:${String(e.item).toLowerCase()}`

/** Counts by partner and by problem — over the entries given (already the viewer's). Counts are
 *  of distinct records, never of moves (a record with two send moves counts once). */
export function boardGroups(entries: ReadyEntry[]): {
  partners: PartnerGroup[]
  problems: ProblemGroup[]
  totals: { records: number; refused: number; warnings: number; asks: number }
} {
  const worstByRecord = new Map<string, Severity>()
  const partnerRecords = new Map<string, Map<string, Severity>>()
  const problems = new Map<
    string,
    ProblemGroup & { recordSet: Set<string>; partnerSet: Set<string> }
  >()
  for (const e of entries) {
    const rk = recordKey(e)
    const prev = worstByRecord.get(rk)
    if (prev == null || RANK[e.worst] < RANK[prev]) worstByRecord.set(rk, e.worst)
    for (const p of e.partners.length ? e.partners : ['A partner']) {
      const m = partnerRecords.get(p) ?? new Map<string, Severity>()
      const pw = m.get(rk)
      if (pw == null || RANK[e.worst] < RANK[pw]) m.set(rk, e.worst)
      partnerRecords.set(p, m)
    }
    for (const i of e.issues) {
      const key = problemKey(i)
      let g = problems.get(key)
      if (!g) {
        g = {
          key,
          label: problemLabel(i.message),
          severity: i.severity,
          kind: i.kind ?? null,
          partners: [],
          records: 0,
          lines: 0,
          recordSet: new Set(),
          partnerSet: new Set()
        }
        problems.set(key, g)
      }
      if (!g.recordSet.has(rk)) {
        g.recordSet.add(rk)
        g.lines += i.rows?.length ?? 0
      }
      for (const p of i.partner ? [i.partner] : e.partners) g.partnerSet.add(p)
    }
  }
  const count = (m: Map<string, Severity>, s: Severity) =>
    [...m.values()].filter((v) => v === s).length
  return {
    totals: {
      records: worstByRecord.size,
      refused: count(worstByRecord, 'block'),
      warnings: count(worstByRecord, 'warn'),
      asks: count(worstByRecord, 'ask')
    },
    partners: [...partnerRecords.entries()]
      .map(([partner, m]) => ({
        partner,
        records: m.size,
        refused: count(m, 'block'),
        warnings: count(m, 'warn'),
        asks: count(m, 'ask')
      }))
      .sort(
        (a, b) =>
          b.refused - a.refused || b.records - a.records || a.partner.localeCompare(b.partner)
      ),
    problems: [...problems.values()]
      .map(({ recordSet, partnerSet, ...g }) => ({
        ...g,
        records: recordSet.size,
        partners: [...partnerSet].sort()
      }))
      .sort(
        (a, b) =>
          RANK[a.severity] - RANK[b.severity] ||
          b.records - a.records ||
          a.label.localeCompare(b.label)
      )
  }
}

export interface VisibilityDeps {
  compile: (user: User, collection: string, opts: { actingAdmin?: boolean }) => Promise<AccessGates>
  visible: (gates: AccessGates, ids: string[]) => Promise<Set<string>>
}

const realDeps: VisibilityDeps = { compile: compileAccessGates, visible: visibleIds }

/**
 * The entries this viewer may read, judged NOW as the viewer (role policy, row filters, User
 * Scopes; an administrator skips policy + row filters but not their own restrict scopes). A
 * collection whose gates cannot be compiled hides its rows — never shows them.
 */
export async function visibleEntries(
  entries: ReadyEntry[],
  user: User,
  isAdmin: boolean,
  deps: VisibilityDeps = realDeps
): Promise<ReadyEntry[]> {
  const byCollection = new Map<string, ReadyEntry[]>()
  for (const e of entries) {
    const list = byCollection.get(e.collection) ?? []
    list.push(e)
    byCollection.set(e.collection, list)
  }
  const keep = new Set<ReadyEntry>()
  for (const [collection, list] of byCollection) {
    try {
      const gates = await deps.compile(user, collection, { actingAdmin: isAdmin })
      const ids = [...new Set(list.map((e) => String(e.item)))]
      const ok = gates.bypass ? null : await deps.visible(gates, ids)
      const okLower = ok ? new Set([...ok].map((i) => String(i).toLowerCase())) : null
      for (const e of list) if (!okLower || okLower.has(String(e.item).toLowerCase())) keep.add(e)
    } catch {
      /* gates unreadable: the rows stay hidden */
    }
  }
  return entries.filter((e) => keep.has(e))
}

/** "Check again": the record's stored entries replaced by the fresh ones (none = it is ready). */
export function applyCheck(
  result: ReadyResult,
  collection: string,
  item: string,
  fresh: ReadyEntry[],
  opts: { gone?: boolean } = {}
): ReadyResult {
  const rk = recordKey({ collection, item })
  const had = result.entries.some((e) => recordKey(e) === rk)
  const entries = [...result.entries.filter((e) => recordKey(e) !== rk), ...fresh]
  // Gone = its next move no longer sends: off the board, not counted as ready.
  if (opts.gone) return { ...result, entries }
  const ready =
    had && fresh.length === 0
      ? result.ready + 1
      : !had && fresh.length > 0
        ? Math.max(0, result.ready - 1)
        : result.ready
  return { ...result, entries, ready }
}

/** The Background Jobs list reads whole job rows, so a stored board stays well under a few MB
 *  (and only the newest run keeps it — older runs keep a summary, `summarizeResult`). */
const RESULT_MAX_CHARS = 1_500_000

/** Stored on the job row; rows lists are trimmed first, then entries, to stay under the cap. */
export function serializeResult(r: ReadyResult): string {
  let s = JSON.stringify(r)
  if (s.length <= RESULT_MAX_CHARS) return s
  const trimmed: ReadyResult = {
    ...r,
    entries: r.entries.map((e) => ({
      ...e,
      issues: e.issues.map((i) => (i.rows ? { ...i, rows: i.rows.slice(0, 3) } : i))
    }))
  }
  s = JSON.stringify(trimmed)
  let n = trimmed.entries.length
  while (s.length > RESULT_MAX_CHARS && n > 0) {
    n = Math.floor(n * 0.8)
    s = JSON.stringify({ ...trimmed, entries: trimmed.entries.slice(0, n) })
  }
  return s
}

/** What an older run keeps once a newer board is stored: the counts, never the entries. */
export function summarizeResult(r: ReadyResult): string {
  return JSON.stringify({
    kind: 'ready-to-send-summary',
    generated_at: r.generated_at,
    candidates: r.candidates,
    checked: r.checked,
    ready: r.ready,
    errors: r.errors,
    with_problems: new Set(r.entries.map((e) => `${e.collection}:${e.item}`)).size,
    partial: r.partial
  })
}

export function parseResult(raw: unknown): ReadyResult | null {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null
  try {
    const o = JSON.parse(raw)
    return o && o.kind === 'ready-to-send' && Array.isArray(o.entries) ? (o as ReadyResult) : null
  } catch {
    return null
  }
}
