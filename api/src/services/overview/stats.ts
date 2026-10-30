import type { Knex } from 'knex'
import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import type { User } from '../../types.js'
import { tenantState } from '../ai-tenant-state.js'
import { compileAccessGates, visibleIds } from '../record-access.js'
import {
  bucketsFromOffsets,
  DAY_MS,
  distinctRecords,
  hourlyBuckets,
  type OverviewFigure,
  openIssuesBefore,
  overviewWindows,
  RECORD_CHANGE_ACTIONS,
  type Window
} from './model.js'
import { myRecordSet, whereInRecordSet } from './my-records.js'

/**
 * The Overview's figures, computed AS THE VIEWER.
 *
 *   administrators — every record change, people active, failed jobs, every open issue
 *   everyone else  — record changes on records they can read (role policy, row filters,
 *                    User Scopes per record), and their own open issues; no people / jobs
 *
 * Reads go through the read gate (one flight per viewer + day; administrators share one) and
 * are kept 30 s per tenant.
 */

const ROW_CAP = 20_000
const CACHE_MS = 30_000

export interface OverviewStats {
  figures: OverviewFigure[]
  /** Record changes per hour, the last 24 hours, oldest first. */
  hourly: number[]
  day_start: string
  scope: 'all' | 'readable'
  computed_at: string
}

const statsCache = tenantState(() => new Map<string, { at: number; value: unknown }>())

/** A 30 s per-tenant memo around a single flight. */
export async function memo<T>(key: string, fn: () => Promise<T>, ms = CACHE_MS): Promise<T> {
  const c = statsCache()
  const hit = c.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.value as T
  const value = await fn()
  c.set(key, { at: Date.now(), value })
  if (c.size > 5000) c.clear()
  return value
}

function notSystem(q: Knex.QueryBuilder, alias = 'a'): Knex.QueryBuilder {
  return q
    .whereNotNull(`${alias}.collection`)
    .whereNot(`${alias}.collection`, 'like', 'nivaro_%')
    .whereNot(`${alias}.collection`, 'like', 'directus_%')
}

function recordChanges(w: Window): Knex.QueryBuilder {
  return notSystem(
    db('nivaro_activity as a')
      .whereIn('a.action', [...RECORD_CHANGE_ACTIONS])
      .whereNotNull('a.item')
      .where('a.timestamp', '>=', w.from)
      .where('a.timestamp', '<=', w.to)
  )
}

const countOf = (rows: unknown) => Number((rows as Array<{ n?: number | string }>)[0]?.n ?? 0) || 0

/** Distinct records changed inside a window, every collection (administrators). */
async function distinctRecordsAll(w: Window): Promise<number> {
  const inner = recordChanges(w).groupBy('a.collection', 'a.item').select('a.collection', 'a.item')
  return countOf(await db.count({ n: '*' }).from(inner.as('x')))
}

async function hourlyAll(now: Date): Promise<number[]> {
  const start = new Date(now.getTime() - DAY_MS)
  const w = { from: start, to: now }
  if (isMssql(db)) {
    // Elapsed whole hours since `start` (DATEDIFF(hour) counts clock boundaries instead). The
    // expression lives in a derived table: a bound parameter in both SELECT and GROUP BY is two
    // different expressions to SQL Server.
    const inner = recordChanges(w).select(
      db.raw('DATEDIFF(minute, ?, a.timestamp) / 60 as h', [start])
    )
    const rows = (await db
      .from(inner.as('x'))
      .select('x.h')
      .count({ n: '*' })
      .groupBy('x.h')) as Array<{ h: number; n: number }>
    return bucketsFromOffsets(rows)
  }
  const rows = (await recordChanges(w).limit(ROW_CAP).select('a.timestamp')) as Array<{
    timestamp: Date
  }>
  return hourlyBuckets(
    rows.map((r) => r.timestamp),
    now
  )
}

async function distinctUsers(w: Window): Promise<number> {
  const inner = db('nivaro_activity as a')
    .whereNotNull('a.user')
    .where('a.timestamp', '>=', w.from)
    .where('a.timestamp', '<=', w.to)
    .groupBy('a.user')
    .select('a.user')
  return countOf(await db.count({ n: '*' }).from(inner.as('x')))
}

async function failedJobs(w: Window): Promise<number> {
  return countOf(
    await db('nivaro_job_runs')
      .where('status', 'error')
      .where('started_at', '>=', w.from)
      .where('started_at', '<=', w.to)
      .count({ n: '*' })
      .catch(() => [{ n: 0 }])
  )
}

const CLOSED_ISSUE = ['resolved', 'closed']

async function openIssues(
  userId: string | null,
  now: Date
): Promise<{ value: number; previous: number }> {
  const base = () => {
    const q = db('nivaro_issues')
    if (userId) q.where((w) => w.where('raised_by', userId).orWhere('assigned_to', userId))
    return q
  }
  const dayAgo = new Date(now.getTime() - DAY_MS)
  try {
    const [open, opened, closed] = await Promise.all([
      base().whereNotIn('status', CLOSED_ISSUE).count({ n: '*' }),
      base().whereNotIn('status', CLOSED_ISSUE).where('created_at', '>=', dayAgo).count({ n: '*' }),
      base()
        .whereIn('status', CLOSED_ISSUE)
        .where('updated_at', '>=', dayAgo)
        .where('created_at', '<', dayAgo)
        .count({ n: '*' })
    ])
    const value = countOf(open)
    return { value, previous: openIssuesBefore(value, countOf(opened), countOf(closed)) }
  } catch {
    return { value: 0, previous: 0 }
  }
}

export interface ReadableChanges {
  rows: Array<{ collection: string; item: string; timestamp: Date; user: string | null }>
  capped: boolean
}

/**
 * Record changes inside a window that the person can read: only collections their role may
 * read, newest ROW_CAP rows, then every record judged by the row filter and User Scopes.
 */
export async function readableChanges(user: User, w: Window): Promise<ReadableChanges> {
  const collections = (
    (await recordChanges(w).distinct('a.collection')) as Array<{ collection: string }>
  ).map((r) => r.collection)
  const gates = new Map<string, Awaited<ReturnType<typeof compileAccessGates>>>()
  for (const c of collections) {
    try {
      const g = await compileAccessGates(user, c)
      if (g.permitted && !g.strict) gates.set(c, g)
    } catch {
      /* unreadable collection: left out */
    }
  }
  if (gates.size === 0) return { rows: [], capped: false }
  const rows = (await recordChanges(w)
    .whereIn('a.collection', [...gates.keys()])
    .orderBy('a.timestamp', 'desc')
    .limit(ROW_CAP)
    .select('a.collection', 'a.item', 'a.timestamp', 'a.user')) as ReadableChanges['rows']
  const byCol = new Map<string, Set<string>>()
  for (const r of rows) {
    const ids = byCol.get(r.collection) ?? new Set<string>()
    ids.add(String(r.item))
    byCol.set(r.collection, ids)
  }
  const visible = new Map<string, Set<string>>()
  for (const [c, ids] of byCol) {
    const g = gates.get(c)
    if (!g) continue
    visible.set(c, await visibleIds(g, [...ids]).catch(() => new Set<string>()))
  }
  return {
    rows: rows.filter((r) => visible.get(r.collection)?.has(String(r.item))),
    capped: rows.length >= ROW_CAP
  }
}

export async function computeOverviewStats(
  user: User,
  opts: { isAdmin: boolean; dayStart: Date; now?: Date }
): Promise<OverviewStats> {
  const now = opts.now ?? new Date()
  const w = overviewWindows(opts.dayStart, now)
  const base = {
    day_start: opts.dayStart.toISOString(),
    computed_at: now.toISOString()
  }

  if (opts.isAdmin) {
    const [today, yesterday, hourly, people, peoplePrev, jobs, jobsPrev, issues] =
      await Promise.all([
        distinctRecordsAll(w.today),
        distinctRecordsAll(w.sameTimeYesterday),
        hourlyAll(now),
        distinctUsers(w.today),
        distinctUsers(w.sameTimeYesterday),
        failedJobs(w.last24),
        failedJobs(w.previous24),
        openIssues(null, now)
      ])
    return {
      ...base,
      scope: 'all',
      hourly,
      figures: [
        { key: 'records_changed', value: today, previous: yesterday, compare: 'yesterday' },
        { key: 'people_active', value: people, previous: peoplePrev, compare: 'yesterday' },
        { key: 'failed_jobs', value: jobs, previous: jobsPrev, compare: 'previous_24h' },
        {
          key: 'open_issues',
          value: issues.value,
          previous: issues.previous,
          compare: 'previous_24h'
        }
      ]
    }
  }

  const [changes, issues] = await Promise.all([
    readableChanges(user, w.span),
    openIssues(String(user.id), now)
  ])
  return {
    ...base,
    scope: 'readable',
    hourly: hourlyBuckets(
      changes.rows
        .filter((r) => new Date(r.timestamp).getTime() >= w.last24.from.getTime())
        .map((r) => r.timestamp),
      now
    ),
    figures: [
      {
        key: 'records_changed',
        value: distinctRecords(changes.rows, w.today),
        previous: changes.capped ? null : distinctRecords(changes.rows, w.sameTimeYesterday),
        compare: 'yesterday',
        ...(changes.capped ? { capped: true } : {})
      },
      {
        key: 'open_issues',
        value: issues.value,
        previous: issues.previous,
        compare: 'previous_24h'
      }
    ]
  }
}

// ─── Since your last visit ───────────────────────────────────────────────────

export const SINCE_MAX_DAYS = 14

export interface SinceDigest {
  since: string
  /** The last visit was longer ago than SINCE_MAX_DAYS: the window starts there instead. */
  clamped: boolean
  records_changed: number
  records_capped: boolean
  /** Records the person owns, created or starred that someone ELSE changed. */
  my_records_changed: number
  my_records: Array<{ collection: string; item: string; changes: number; last_at: string }>
  /** Administrators only (null otherwise). */
  new_people: number | null
  people: Array<{ id: string; name: string }>
  failed_jobs: number | null
}

export async function computeSinceDigest(
  user: User,
  opts: { isAdmin: boolean; since: Date; now?: Date }
): Promise<SinceDigest> {
  const now = opts.now ?? new Date()
  const floor = new Date(now.getTime() - SINCE_MAX_DAYS * DAY_MS)
  const clamped = opts.since.getTime() < floor.getTime()
  const from = clamped ? floor : opts.since
  const w = { from, to: now }

  const [records, mine, people, jobs] = await Promise.all([
    opts.isAdmin
      ? distinctRecordsAll(w).then((n) => ({ n, capped: false }))
      : readableChanges(user, w).then((c) => ({
          n: distinctRecords(c.rows, w),
          capped: c.capped
        })),
    myRecordsChangedByOthers(user, opts.isAdmin, w),
    opts.isAdmin ? newPeople(from) : Promise.resolve(null),
    opts.isAdmin ? failedJobs(w) : Promise.resolve(null)
  ])
  return {
    since: from.toISOString(),
    clamped,
    records_changed: records.n,
    records_capped: records.capped,
    my_records_changed: mine.length,
    my_records: mine.slice(0, 5),
    new_people: people ? people.count : null,
    people: people ? people.list : [],
    failed_jobs: jobs
  }
}

async function myRecordsChangedByOthers(
  user: User,
  isAdmin: boolean,
  w: Window
): Promise<SinceDigest['my_records']> {
  const set = await myRecordSet(user, { isAdmin })
  if (set.size === 0) return []
  const q = whereInRecordSet(
    db('nivaro_activity as a')
      .whereIn('a.action', [...RECORD_CHANGE_ACTIONS])
      .where('a.timestamp', '>=', w.from)
      .where('a.timestamp', '<=', w.to)
      .where((x) => x.whereNull('a.user').orWhereNot('a.user', user.id)),
    set
  )
  const rows = (await q
    .groupBy('a.collection', 'a.item')
    .select('a.collection', 'a.item')
    .count({ n: '*' })
    .max({ last_at: 'a.timestamp' })
    .catch(() => [])) as Array<{ collection: string; item: string; n: number; last_at: Date }>
  return rows
    .map((r) => ({
      collection: r.collection,
      item: String(r.item),
      changes: Number(r.n) || 0,
      last_at: new Date(r.last_at).toISOString()
    }))
    .sort((a, b) => b.last_at.localeCompare(a.last_at))
}

async function newPeople(
  since: Date
): Promise<{ count: number; list: Array<{ id: string; name: string }> }> {
  try {
    const q = db('nivaro_users').where('created_at', '>=', since)
    // Machine accounts (integrations, bots, services) are not new people.
    if (await hasColumn('nivaro_users', 'account_kind')) q.whereNull('account_kind')
    const rows = (await q
      .orderBy('created_at', 'desc')
      .limit(50)
      .select('id', 'first_name', 'last_name', 'email')) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string
    }>
    return {
      count: rows.length,
      list: rows.slice(0, 5).map((r) => ({
        id: String(r.id),
        name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email
      }))
    }
  } catch {
    return { count: 0, list: [] }
  }
}
