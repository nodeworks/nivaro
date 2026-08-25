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
    const rows = (await db('nivaro_log_alert_rules')
      .where({ is_active: true })
      .select('id', 'name', 'pattern', 'level')) as Array<{
      id: number
      name: string
      pattern: string
      level: string | null
    }>
    rules = rows.map((r) => {
      let regex: RegExp | null = null
      try {
        regex = new RegExp(r.pattern, 'i')
      } catch {
        /* invalid pattern — rule inert until fixed */
      }
      return { ...r, regex }
    })
  } catch {
    rules = []
  }
}

const ruleCooldown = new Map<number, number>()

export function pushLog(level: number, msg: string): void {
  ring.push({ ts: Date.now(), level, msg: msg.slice(0, 1000) })
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  void loadRules()
  for (const r of rules) {
    if (!r.regex) continue
    if (r.level && level < (LEVEL_NUM[r.level] ?? 0)) continue
    if (!r.regex.test(msg)) continue
    // 5-min per-rule cooldown — the error tracker dedupes too, but a chatty
    // match must not spend a DB write per log line.
    const last = ruleCooldown.get(r.id) ?? 0
    if (Date.now() - last < 5 * 60_000) continue
    ruleCooldown.set(r.id, Date.now())
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
          message: `Log alert "${r.name}" matched: ${msg.slice(0, 300)}`
        })
      )
      .catch(() => {})
  }
}

export function readLog(opts: { level?: number; q?: string; limit?: number }): LogLine[] {
  let out = ring
  if (opts.level) out = out.filter((l) => l.level >= (opts.level ?? 0))
  if (opts.q) {
    const q = opts.q.toLowerCase()
    out = out.filter((l) => l.msg.toLowerCase().includes(q))
  }
  return out.slice(-(opts.limit ?? 300))
}
