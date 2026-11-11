/**
 * Daily operations report — leads (#ops-report). Before the AI starts, plain SQL works out what
 * else happened at the minute of each burst, deadlock, server error and partner-refusal cluster,
 * so the investigation starts from the coincidences instead of spending its drill calls finding
 * them (the gateway re-bills every tool result each round; SQL is free).
 */
import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { aroundBlock, columnHint, type DrillWindow, minuteOf } from './drill.js'
import type { OpsDigest } from './types.js'
import { clock } from './window.js'

type Lead = NonNullable<OpsDigest['leads']>[number]

async function rows(sql: string, b: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
  try {
    const r = (await db.raw(sql, b as Knex.RawBinding[])) as unknown
    return Array.isArray(r) ? (r as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}

export async function buildLeads(win: DrillWindow, d: OpsDigest): Promise<Lead[]> {
  const leads: Lead[] = []
  const add = async (what: string, at: Date | null, hint: string | null = null) => {
    if (!at) return
    const ctx = await aroundBlock(at, win.tz, 2)
    leads.push({ what, at: clock(at, win.tz), context: ctx.text, hint })
  }
  for (const b of d.speed.bursts.slice(0, 4))
    await add(
      `Burst: ${b.n} slow ${b.route} (${b.people} people, up to ${Math.round(b.max_ms / 1000)} s)`,
      minuteOf(win, b.at)
    )
  for (const x of d.database.deadlocks.slice(0, 4))
    await add(`Deadlock: ${x.victim.slice(0, 100)}`, minuteOf(win, x.at))
  // Server errors: one lead per minute, with the data-model hint for an "Invalid column" error.
  const seen = new Set<string>()
  for (const e of d.errors.server.slice(0, 10)) {
    if (seen.has(e.at)) continue
    seen.add(e.at)
    const [issue] = await rows(
      `SELECT TOP 1 title, details FROM nivaro_issues WHERE source = 'server' AND title LIKE ? AND last_seen_at >= ? ORDER BY last_seen_at DESC`,
      // Issue titles carry the route template (`/api/lineage/:collection/…`): match on its first
      // two segments, which a folded path always shares.
      [`%${(e.route.split(' ')[1] ?? '').split('/').slice(0, 3).join('/')}%`, win.start]
    )
    const hint = issue
      ? await columnHint(`${issue.title} ${String(issue.details ?? '').slice(0, 4000)}`)
      : null
    await add(`Server error: ${e.route} (${e.person ?? 'someone'})`, minuteOf(win, e.at), hint)
  }
  // Partner refusals in clusters (5+ failed calls to one partner within 10 minutes).
  const clusters = await rows(
    `SELECT a.name api, MIN(x.created_at) f, COUNT(*) n FROM nivaro_external_api_logs x LEFT JOIN nivaro_external_apis a ON a.id = x.api_id
      WHERE x.created_at >= ? AND x.created_at < ? AND (x.response_status >= 400 OR x.error IS NOT NULL)
      GROUP BY a.name, DATEPART(dayofyear, x.created_at), DATEPART(hour, x.created_at), DATEPART(minute, x.created_at) / 10
      HAVING COUNT(*) >= 5 ORDER BY COUNT(*) DESC`,
    [win.start, win.end]
  )
  for (const c of clusters.slice(0, 3))
    await add(`Partner refusals: ${c.n} failed calls to ${c.api}`, new Date(String(c.f)))
  return leads
}
