import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { isMultiTenant } from './deployment-mode.js'

/**
 * The issue-write funnel. Every code path that creates an issue or bumps / changes one calls
 * `noteIssueWrite` AFTER its own write (each writer keeps its own dedupe SQL). The call
 *  - records durable hit counters (hourly totals + distinct people per day, kept 90 days), and
 *  - tells in-process listeners (the tracker rule engine) that an issue was raised / recurred /
 *    changed.
 * It is fire-and-forget on the background pool and never throws into, or slows, the writer. In
 * cloud mode no counters are written (GitLab sync, their only reader, is off there). `issue-raise.guard.test.ts`
 * fails when a file that writes nivaro_issues does not import this.
 */

export interface IssueHit {
  userId?: string | null
  at?: Date
}
export type IssueWriteKind = 'raised' | 'recurred' | 'changed'
export interface IssueWriteEvent {
  issueId: number
  kind: IssueWriteKind
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const KEEP_DAYS = 90
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Listener = (e: IssueWriteEvent) => void | Promise<void>
const listeners = new Set<Listener>()

/** Subscribe to issue writes (in-process only). Returns the unsubscribe function. */
export function onIssueWrite(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The key hit counters are stored under: the fingerprint, else `issue:<id>`. */
export function hitKey(issue: { id: number; fingerprint?: string | null }): string {
  return (issue.fingerprint ? String(issue.fingerprint) : `issue:${issue.id}`).slice(0, 80)
}

const hourFloor = (d: Date) => new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS)
const dayString = (d: Date) => d.toISOString().slice(0, 10)

async function addHits(key: string, hour: Date, n: number): Promise<void> {
  if (n <= 0) return
  const bump = () =>
    db('nivaro_issue_hits')
      .where({ key, hour })
      .update({ hits: db.raw('hits + ?', [n]) })
  if ((await bump()) > 0) return
  try {
    await db('nivaro_issue_hits').insert({ key, hour, hits: n })
  } catch {
    // two writers raced on the unique (key, hour): the row exists now — add to it
    await bump()
  }
}

async function addPeople(key: string, users: Array<{ day: string; user: string }>): Promise<void> {
  const seen = new Set<string>()
  for (const u of users) {
    const id = u.user.toLowerCase()
    const tag = `${u.day}|${id}`
    if (seen.has(tag)) continue
    seen.add(tag)
    const exists = await db('nivaro_issue_hit_people')
      .where({ key, day: u.day, user_id: id })
      .first('id')
    if (exists) continue
    try {
      await db('nivaro_issue_hit_people').insert({ key, day: u.day, user_id: id })
    } catch {
      // unique violation: another writer counted this person first
    }
  }
}

async function recordHits(
  key: string,
  hits: IssueHit[] | undefined,
  count: number | undefined
): Promise<void> {
  const now = new Date()
  const list = hits ?? []
  if (count !== undefined || list.length === 0) {
    // the writer knows a total, or nothing per hit: one bucket at the latest hit (else now)
    const at = list.reduce<Date>((m, h) => (h.at && h.at > m ? h.at : m), list[0]?.at ?? now)
    await addHits(key, hourFloor(at), Math.max(1, Math.floor(count ?? 1)))
  } else {
    const buckets = new Map<number, number>()
    for (const h of list) {
      const t = hourFloor(h.at ?? now).getTime()
      buckets.set(t, (buckets.get(t) ?? 0) + 1)
    }
    for (const [t, n] of buckets) await addHits(key, new Date(t), n)
  }
  const people = list
    .filter((h) => typeof h.userId === 'string' && UUID.test(h.userId))
    .map((h) => ({ day: dayString(h.at ?? now), user: String(h.userId) }))
  if (people.length > 0) await addPeople(key, people)
}

/**
 * Tell the funnel an issue row was just written. `issueId` may be null when the writer's
 * dedupe insert does not know the id: pass the fingerprint and it is resolved here.
 * Fire-and-forget; never throws.
 */
export function noteIssueWrite(
  issueId: number | null,
  kind: IssueWriteKind,
  opts: { fingerprint?: string | null; hits?: IssueHit[]; count?: number } = {}
): void {
  const cloud = isMultiTenant()
  // Cloud: no counters (tracker-prune never runs there, final review M5) and, with no listener
  // (GitLab sync is off in cloud), nothing to tell — skip the lookup too.
  if (cloud && listeners.size === 0) return
  // The funnel runs on the background pool: it fires on every 5xx and client crash, and must
  // never take a connection a request is waiting for (final review M6).
  void runInBackgroundPool(async () => {
    try {
      let id = issueId != null && Number.isFinite(Number(issueId)) ? Number(issueId) : null
      let fingerprint = opts.fingerprint ?? null
      // Neither id nor fingerprint: a lookup would match `fingerprint IS NULL` — the newest
      // manual issue, not this one (final review M2).
      if (id == null && !fingerprint) return
      if (id == null || (kind !== 'changed' && !fingerprint)) {
        const row = (await (id != null
          ? db('nivaro_issues').where({ id })
          : db('nivaro_issues').where({ fingerprint }).orderBy('id', 'desc')
        ).first('id', 'fingerprint')) as { id?: unknown; fingerprint?: string | null } | undefined
        if (row) {
          id = Number(row.id)
          fingerprint = fingerprint ?? row.fingerprint ?? null
        }
      }
      if (id == null || !Number.isFinite(id)) return
      if (kind !== 'changed' && !cloud) {
        try {
          await recordHits(hitKey({ id, fingerprint }), opts.hits, opts.count)
        } catch {
          // counters are best-effort; listeners still hear about the write
        }
      }
      for (const fn of [...listeners]) {
        try {
          await fn({ issueId: id, kind })
        } catch {
          // one listener's failure never reaches another or the writer
        }
      }
    } catch {
      // a funnel must never break its writer
    }
  }).catch(() => {})
}

/** Hits and distinct people recorded under `key` since `since` (hour / day granularity). */
export async function hitCounts(
  key: string,
  since: Date
): Promise<{ hits: number; people: number }> {
  const h = (await db('nivaro_issue_hits')
    .where('key', key)
    .where('hour', '>=', hourFloor(since))
    .sum({ n: 'hits' })
    .first()) as { n?: number | string | null } | undefined
  const p = (await db('nivaro_issue_hit_people')
    .where('key', key)
    .where('day', '>=', dayString(since))
    .countDistinct({ n: 'user_id' })
    .first()) as { n?: number | string | null } | undefined
  return { hits: Number(h?.n ?? 0) || 0, people: Number(p?.n ?? 0) || 0 }
}

/** Drop counters older than 90 days. */
export async function pruneHits(): Promise<void> {
  const cutoff = new Date(Date.now() - KEEP_DAYS * DAY_MS)
  await db('nivaro_issue_hits').where('hour', '<', cutoff).delete()
  await db('nivaro_issue_hit_people').where('day', '<', dayString(cutoff)).delete()
}
