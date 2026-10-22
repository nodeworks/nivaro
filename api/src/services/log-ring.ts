import { db } from '../db/index.js'

/**
 * Log viewer (#156) + log alert rules (#253): an in-process ring buffer of the
 * server's pino log lines (per replica, bounded, nothing persisted) fed by a
 * logMethod hook on the fastify logger. Alert rules — regex over the rendered
 * line — are evaluated as lines enter the ring; a match raises a deduped issue
 * via the error tracker and stamps the rule's last_matched_at.
 */

export interface LogLine {
  ts: number
  level: number
  msg: string
}

const RING_MAX = 2000
const ring: LogLine[] = []

interface LogRule {
  id: number
  name: string
  pattern: string
  level: string | null
  regex: RegExp | null
  /** #1960 — fire when this many lines match inside window_minutes (null = every match). */
  threshold: number | null
  window_minutes: number | null
  /** Minutes between two firings (null = 5). */
  cooldown_minutes: number | null
}
let rules: LogRule[] = []
let rulesLoadedAt = 0

export function bustLogRules(): void {
  rulesLoadedAt = 0
}

const LEVEL_NUM: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
}

async function loadRules(): Promise<void> {
  if (Date.now() - rulesLoadedAt < 60_000) return
  rulesLoadedAt = Date.now()
  try {
    // Migration 442 columns: a rule over the request log (filters.target =
    // requests) is evaluated by services/log-alert-requests.ts, not here.
    const { hasColumn } = await import('../lib/column-probe.js')
    const extended = await hasColumn('nivaro_log_alert_rules', 'filters')
    const rows = (await db('nivaro_log_alert_rules')
      .where({ is_active: true })
      .select(
        'id',
        'name',
        'pattern',
        'level',
        ...(extended ? ['filters', 'threshold', 'window_minutes', 'cooldown_minutes'] : [])
      )) as Array<{
      id: number
      name: string
      pattern: string
      level: string | null
      filters?: string | null
      threshold?: number | null
      window_minutes?: number | null
      cooldown_minutes?: number | null
    }>
    rules = rows
      .filter((r) => !isRequestRule(r.filters))
      .map((r) => {
        let regex: RegExp | null = null
        try {
          // Admin-authored patterns (same trust tier as the SQL scratchpad) —
          // still cap complexity: JS regex has no timeout, so a catastrophic
          // pattern would stall log writes. Nested quantifiers are the classic
          // ReDoS shape; refuse them.
          if (
            r.pattern.length <= 200 &&
            !/(\([^)]*[+*][^)]*\)|\[[^\]]*\])[+*]\??[+*]/.test(r.pattern)
          ) {
            regex = new RegExp(r.pattern, 'i')
          }
        } catch {
          /* invalid pattern — rule inert until fixed */
        }
        return {
          id: r.id,
          name: r.name,
          pattern: r.pattern,
          level: r.level,
          regex,
          threshold: r.threshold ?? null,
          window_minutes: r.window_minutes ?? null,
          cooldown_minutes: r.cooldown_minutes ?? null
        }
      })
  } catch {
    rules = []
  }
}

/** A rule's stored filter says it watches the request log, not this ring. */
export function isRequestRule(filters: string | null | undefined): boolean {
  if (!filters) return false
  try {
    return (JSON.parse(filters) as { target?: string })?.target !== 'log'
  } catch {
    return false
  }
}

const ruleCooldown = new Map<number, number>()
const ruleHits = new Map<number, number[]>()

/**
 * Whether a match fires the rule now: enough matches inside the window (when
 * the rule has a threshold) and the cooldown since the last firing passed.
 * Pure over the two maps, exported for tests.
 */
export function ruleShouldFire(
  r: Pick<LogRule, 'id' | 'threshold' | 'window_minutes' | 'cooldown_minutes'>,
  now: number,
  hits: Map<number, number[]> = ruleHits,
  cooldowns: Map<number, number> = ruleCooldown
): boolean {
  if (r.threshold && r.threshold > 1) {
    const windowMs = Math.max(1, r.window_minutes ?? 5) * 60_000
    const list = (hits.get(r.id) ?? []).filter((t) => now - t < windowMs)
    list.push(now)
    hits.set(r.id, list.slice(-Math.max(r.threshold, 1) * 2))
    if (list.length < r.threshold) return false
  }
  // The cooldown — the error tracker dedupes too, but a chatty match must not
  // spend a DB write per log line.
  const last = cooldowns.get(r.id) ?? 0
  if (now - last < Math.max(1, r.cooldown_minutes ?? 5) * 60_000) return false
  cooldowns.set(r.id, now)
  hits.delete(r.id)
  return true
}

export function pushLog(level: number, msg: string): void {
  ring.push({ ts: Date.now(), level, msg: msg.slice(0, 1000) })
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  void loadRules()
  for (const r of rules) {
    if (!r.regex) continue
    if (r.level && level < (LEVEL_NUM[r.level] ?? 0)) continue
    if (!r.regex.test(msg)) continue
    if (!ruleShouldFire(r, Date.now())) continue
    void db('nivaro_log_alert_rules')
      .where({ id: r.id })
      .update({ last_matched_at: new Date() })
      .catch(() => {})
    void import('./error-tracking.js')
      .then(({ trackError }) =>
        trackError({
          source: 'server',
          route: `log-alert/${r.name}`,
          severity: 'medium',
          message:
            r.threshold && r.threshold > 1
              ? `Log alert "${r.name}": ${r.threshold}+ matches in ${r.window_minutes ?? 5} min — last: ${msg.slice(0, 300)}`
              : `Log alert "${r.name}" matched: ${msg.slice(0, 300)}`
        })
      )
      .catch(() => {})
  }
}

export function readLog(opts: {
  level?: number
  q?: string
  limit?: number
  /** Treat `q` as a case-insensitive regular expression (#82). An invalid
   *  pattern falls back to a plain substring match rather than matching nothing. */
  regex?: boolean
  /** Time window, ms since epoch (inclusive). */
  since?: number
  until?: number
}): LogLine[] {
  let out = ring
  if (opts.level) out = out.filter((l) => l.level >= (opts.level ?? 0))
  if (opts.since != null) out = out.filter((l) => l.ts >= (opts.since as number))
  if (opts.until != null) out = out.filter((l) => l.ts <= (opts.until as number))
  if (opts.q) {
    let re: RegExp | null = null
    if (opts.regex) {
      try {
        re = new RegExp(opts.q, 'i')
      } catch {
        re = null
      }
    }
    const q = opts.q.toLowerCase()
    out = re
      ? out.filter((l) => (re as RegExp).test(l.msg))
      : out.filter((l) => l.msg.toLowerCase().includes(q))
  }
  return out.slice(-(opts.limit ?? 300))
}
