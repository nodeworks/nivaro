import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { type LogFilter, requestMatches } from './log-filters.js'

/**
 * Suggested log alerts (#2013): errors that keep coming back with no rule
 * watching them, proposed with the pattern, a threshold and a cooldown filled
 * in. Two sources: failing requests in the request log over the last day
 * (every replica), and error lines in this replica's log ring. Nothing is
 * created here — an admin accepts a suggestion and it is saved as an
 * ordinary rule (origin 'suggested'). No AI involved.
 */

export interface RuleSuggestion {
  key: string
  name: string
  /** Ring rules carry a regex; request rules a filter. */
  pattern: string | null
  level: 'error' | null
  filters: LogFilter
  threshold: number
  window_minutes: number
  cooldown_minutes: number
  evidence: {
    count: number
    /** Distinct hours it happened in (request log) or minutes (ring). */
    spread: number
    first_at: string
    last_at: string
    sample: string
  }
}

export interface ExistingRule {
  pattern: string
  level: string | null
  filters: string | null
  is_active?: boolean
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** '/api/items/orders/1234?x=1' → '/api/items/orders/*' */
export function normalizePath(path: string): string {
  return (
    path
      .split('?')[0]
      .split('/')
      .map((seg) =>
        /^\d+$/.test(seg) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) ||
        /^[0-9a-f]{16,}$/i.test(seg) ||
        /^[A-Z]{1,6}\d*-\d+$/i.test(seg)
          ? '*'
          : seg
      )
      .join('/') || '/'
  )
}

/** The literal part of a normalized path a "path contains" filter can use. */
export function pathPrefix(normalized: string): string {
  const cut = normalized.indexOf('*')
  return (cut >= 0 ? normalized.slice(0, cut) : normalized).slice(0, 200)
}

/** Where a normalized message had a variable part. */
export const BLANK = '\u2400'
const BLANKS = new RegExp(`(${BLANK}[\\s,:/.-]*)+`, 'g')
const ALL_BLANKS = new RegExp(BLANK, 'g')

/** A log line with its variable parts (ids, numbers, quoted values) blanked. */
export function normalizeMessage(msg: string): string {
  return msg
    .replace(UUID, BLANK)
    .replace(/"[^"]{0,200}"|'[^']{0,200}'/g, BLANK)
    .replace(/\b[0-9a-f]{12,}\b/gi, BLANK)
    .replace(/\d+(\.\d+)?/g, BLANK)
    .replace(BLANKS, `${BLANK} `)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/**
 * A ring-rule regex from a normalized message: literal text escaped, blanks
 * as `.*`. No nested quantifiers (the ring refuses those), ≤ 200 characters.
 */
export function messagePattern(template: string): string {
  const parts = template.split(BLANK).map((p) => p.trim())
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  let out = parts
    .map(esc)
    .filter((p, i) => p || i === 0)
    .join('.*')
  out = out.replace(/(\.\*)+/g, '.*').replace(/^\.\*|\.\*$/g, '')
  if (out.length > 200) {
    out = out.slice(0, 200)
    // never end inside an escape
    while (out.endsWith('\\')) out = out.slice(0, -1)
  }
  return out
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

/** Whether a rule an admin already has would catch this failure. */
export function coveredByRequestRule(
  rules: ExistingRule[],
  row: { method: string; path: string; status: number; auth?: string | null }
): boolean {
  for (const r of rules) {
    if (r.filters) {
      try {
        const f = JSON.parse(r.filters) as LogFilter
        if (f.target !== 'log' && requestMatches({ ...f, target: 'requests' }, row)) return true
      } catch {
        /* unreadable rule */
      }
    }
  }
  return false
}

export function coveredByRingRule(rules: ExistingRule[], sample: string): boolean {
  for (const r of rules) {
    let pattern = r.pattern
    if (r.filters) {
      try {
        const f = JSON.parse(r.filters) as LogFilter
        if (f.target !== 'log') continue
      } catch {
        /* fall back to the pattern */
      }
    }
    if (!pattern) continue
    if (pattern.length > 200) pattern = pattern.slice(0, 200)
    if (safeRegex(pattern)?.test(sample)) return true
  }
  return false
}

const key = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16)
const iso = (t: number) => new Date(t).toISOString()

export interface FailedRequest {
  method: string
  path: string
  status: number
  auth: string | null
  at: number
}

/**
 * Failing requests → suggestions. Recurring = at least 5 failures spread over
 * at least 2 different hours. The threshold is twice the busiest hour's
 * quarter-hour rate (at least 3) over 15 minutes; the cooldown an hour.
 */
export function suggestFromRequests(
  rows: FailedRequest[],
  rules: ExistingRule[]
): RuleSuggestion[] {
  const groups = new Map<
    string,
    {
      method: string
      path: string
      status: number
      auth: string | null
      times: number[]
      sample: string
    }
  >()
  for (const r of rows) {
    const norm = normalizePath(r.path)
    const cls = r.status >= 500 ? '5xx' : String(r.status)
    const k = `${r.method} ${norm} ${cls}`
    let g = groups.get(k)
    if (!g) {
      g = {
        method: r.method,
        path: norm,
        status: r.status,
        auth: r.auth,
        times: [],
        sample: `${r.method} ${r.path.split('?')[0]} → ${r.status}`
      }
      groups.set(k, g)
    }
    g.times.push(r.at)
  }
  const out: RuleSuggestion[] = []
  for (const [k, g] of groups) {
    if (g.times.length < 5) continue
    const hours = new Map<number, number>()
    for (const t of g.times) {
      const h = Math.floor(t / 3_600_000)
      hours.set(h, (hours.get(h) ?? 0) + 1)
    }
    if (hours.size < 2) continue
    if (
      coveredByRequestRule(rules, {
        method: g.method,
        path: g.path.replace(/\*/g, '1'),
        status: g.status,
        auth: g.auth
      })
    )
      continue
    const busiest = Math.max(...hours.values())
    const threshold = Math.max(3, Math.ceil((busiest / 4) * 2))
    const status = g.status >= 500 ? '5xx' : String(g.status)
    const filters: LogFilter = {
      target: 'requests',
      method: g.method,
      path: pathPrefix(g.path),
      status
    }
    out.push({
      key: key(`req ${k}`),
      name: `${g.method} ${g.path} ${status}`.slice(0, 200),
      pattern: null,
      level: null,
      filters,
      threshold,
      window_minutes: 15,
      cooldown_minutes: 60,
      evidence: {
        count: g.times.length,
        spread: hours.size,
        first_at: iso(Math.min(...g.times)),
        last_at: iso(Math.max(...g.times)),
        sample: g.sample
      }
    })
  }
  return out.sort((a, b) => b.evidence.count - a.evidence.count)
}

/**
 * Error lines in the ring → suggestions. Recurring = the same message shape
 * at least 3 times in at least 2 different minutes.
 */
export function suggestFromLog(
  lines: Array<{ ts: number; level: number; msg: string }>,
  rules: ExistingRule[]
): RuleSuggestion[] {
  const groups = new Map<string, { times: number[]; sample: string }>()
  for (const l of lines) {
    if (l.level < 50) continue
    const t = normalizeMessage(l.msg)
    if (t.replace(ALL_BLANKS, '').trim().length < 8) continue
    const g = groups.get(t) ?? { times: [], sample: l.msg.slice(0, 300) }
    g.times.push(l.ts)
    groups.set(t, g)
  }
  const out: RuleSuggestion[] = []
  for (const [template, g] of groups) {
    if (g.times.length < 3) continue
    const minutes = new Set(g.times.map((t) => Math.floor(t / 60_000)))
    if (minutes.size < 2) continue
    if (coveredByRingRule(rules, g.sample)) continue
    const pattern = messagePattern(template)
    const re = safeRegex(pattern)
    if (!pattern || !re?.test(g.sample)) continue
    out.push({
      key: key(`log ${template}`),
      name: template.replace(ALL_BLANKS, '…').slice(0, 80),
      pattern,
      level: 'error',
      filters: { target: 'log', level: 'error' },
      threshold: 3,
      window_minutes: 15,
      cooldown_minutes: 60,
      evidence: {
        count: g.times.length,
        spread: minutes.size,
        first_at: iso(Math.min(...g.times)),
        last_at: iso(Math.max(...g.times)),
        sample: g.sample
      }
    })
  }
  return out.sort((a, b) => b.evidence.count - a.evidence.count)
}

/** Both sources, against every rule that exists (active or switched off). */
export async function buildRuleSuggestions(now = Date.now()): Promise<RuleSuggestion[]> {
  const { hasColumn } = await import('../lib/column-probe.js')
  const extended = await hasColumn('nivaro_log_alert_rules', 'filters')
  const rules = (await db('nivaro_log_alert_rules')
    .select('pattern', 'level', 'is_active', ...(extended ? ['filters'] : []))
    .catch(() => [])) as ExistingRule[]
  const { instanceScope } = await import('./api-log-instances.js')
  const sc = await instanceScope({})
  const failed = (await sc
    .apply(db('nivaro_api_logs as l'), 'l.instance')
    .where('l.created_at', '>=', new Date(now - 24 * 3_600_000))
    .where((w) =>
      w
        .where('l.status', '>=', 500)
        .orWhere((x) =>
          x
            .where('l.status', '>=', 400)
            .whereNotIn('l.status', [401, 404])
            .whereIn('l.auth', ['token', 'api_key'])
        )
    )
    .orderBy('l.created_at', 'desc')
    .limit(5000)
    .select('l.method', 'l.path', 'l.status', 'l.auth', 'l.created_at')
    .catch(() => [])) as Array<Record<string, unknown>>
  const { readLog } = await import('./log-ring.js')
  return [
    ...suggestFromRequests(
      failed.map((r) => ({
        method: String(r.method),
        path: String(r.path),
        status: Number(r.status),
        auth: (r.auth as string | null) ?? null,
        at: new Date(r.created_at as Date).getTime()
      })),
      rules
    ).slice(0, 15),
    ...suggestFromLog(readLog({ level: 50, limit: 2000 }), rules).slice(0, 10)
  ]
}
