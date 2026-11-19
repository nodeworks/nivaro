import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { whereInList } from './db-batch.js'

/**
 * Resends on the mail log (migration 534): a resend's row names the original
 * it replays (`resend_of`) and who pressed Resend (`resent_by`), so the log
 * can say "Resent · Sent" on the original and "Resend of #12" on the copy.
 *
 * Every reader and the logger probe the columns first (per tenant; a hit is
 * kept, a miss is re-checked after a minute) — a database behind 534 keeps
 * logging, listing and resending exactly as before, just without the trail.
 */

const MISS_TTL_MS = 60_000
interface ProbeState {
  hit: boolean
  at: number
  inflight: Promise<boolean> | null
}
const probes = new Map<string, ProbeState>()

export async function hasResendColumns(): Promise<boolean> {
  const key = getTenantId() ?? ''
  const state = probes.get(key)
  if (state?.hit) return true
  if (state?.inflight) return state.inflight
  if (state && Date.now() - state.at < MISS_TTL_MS) return false
  const inflight = (async () => {
    try {
      const [a, b] = await Promise.all([
        db.schema.hasColumn('nivaro_mail_log', 'resend_of'),
        db.schema.hasColumn('nivaro_mail_log', 'resent_by')
      ])
      return a && b
    } catch {
      return false
    }
  })()
  probes.set(key, { hit: false, at: state?.at ?? 0, inflight })
  const hit = await inflight
  probes.set(key, { hit, at: Date.now(), inflight: null })
  return hit
}

export function resetResendColumnProbe(): void {
  probes.clear()
}

export interface ResendMark {
  /** The original row this send replays. */
  resendOf?: number | null
  /** The person who pressed Resend. */
  resentBy?: string | null
}

/** The two columns to spread into a mail-log insert, or {} (not a resend / no columns). */
export async function resendFields(mark: ResendMark | undefined): Promise<Record<string, unknown>> {
  const of = Number(mark?.resendOf)
  if (!mark || !Number.isInteger(of) || of <= 0) return {}
  if (!(await hasResendColumns())) return {}
  return { resend_of: of, resent_by: mark.resentBy ? String(mark.resentBy) : null }
}

/** What an original's list row says about its resends. */
export interface ResendSummary {
  count: number
  last_status: string
  last_at: string
  last_by: string | null
  last_by_name: string | null
}

/** One row per original: its NEWEST resend, plus how many it has. */
export interface LatestResendRow {
  resend_of: number | string
  status: string
  created_at: string | Date
  resent_by: string | null
  cnt: number | string
}

export interface PersonRow {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}

export function personLabel(p: PersonRow | undefined): string | null {
  if (!p) return null
  const name = [p.first_name, p.last_name].filter((s) => s && String(s).trim()).join(' ')
  return name || p.email || null
}

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v))

/** Pure: the newest-resend rows + people → summary per original id. */
export function summarizeResends(
  latest: LatestResendRow[],
  people: PersonRow[]
): Map<number, ResendSummary> {
  const byId = new Map(people.map((p) => [String(p.id).toLowerCase(), p]))
  const out = new Map<number, ResendSummary>()
  for (const r of latest) {
    const of = Number(r.resend_of)
    if (!Number.isInteger(of)) continue
    const by = r.resent_by ? String(r.resent_by) : null
    out.set(of, {
      count: Number(r.cnt) || 1,
      last_status: String(r.status),
      last_at: iso(r.created_at),
      last_by: by,
      last_by_name: by ? personLabel(byId.get(by.toLowerCase())) : null
    })
  }
  return out
}

async function peopleFor(ids: Array<string | null | undefined>): Promise<PersonRow[]> {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))]
  if (wanted.length === 0) return []
  try {
    return (await db('nivaro_users')
      .whereIn('id', wanted)
      .select('id', 'first_name', 'last_name', 'email')) as PersonRow[]
  } catch {
    return []
  }
}

/**
 * Resend summaries for one page of originals — ONE windowed read (newest
 * resend + count per original) and one name lookup, never a query per row.
 */
export async function resendSummaries(originalIds: number[]): Promise<Map<number, ResendSummary>> {
  const ids = [...new Set(originalIds.filter((n) => Number.isInteger(n) && n > 0))]
  if (ids.length === 0 || !(await hasResendColumns())) return new Map()
  const inner = whereInList(
    db('nivaro_mail_log').select(
      'resend_of',
      'status',
      'created_at',
      'resent_by',
      db.raw('ROW_NUMBER() OVER (PARTITION BY resend_of ORDER BY id DESC) AS rn'),
      db.raw('COUNT(*) OVER (PARTITION BY resend_of) AS cnt')
    ),
    'resend_of',
    ids
  )
  const latest = (await db
    .from(inner.as('r'))
    .where('r.rn', 1)
    .select('r.resend_of', 'r.status', 'r.created_at', 'r.resent_by', 'r.cnt')) as LatestResendRow[]
  return summarizeResends(latest, await peopleFor(latest.map((r) => r.resent_by)))
}

export interface ResendEntry {
  id: number
  status: string
  error: string | null
  created_at: string
  resent_by: string | null
  resent_by_name: string | null
}

/** Every resend of one original, newest first (the detail panel's list). */
export async function resendsOf(originalId: number, limit = 50): Promise<ResendEntry[]> {
  if (!(await hasResendColumns())) return []
  const rows = (await db('nivaro_mail_log')
    .where('resend_of', originalId)
    .orderBy('id', 'desc')
    .limit(limit)
    .select('id', 'status', 'error', 'created_at', 'resent_by')) as Array<{
    id: number
    status: string
    error: string | null
    created_at: string | Date
    resent_by: string | null
  }>
  const people = await peopleFor(rows.map((r) => r.resent_by))
  const byId = new Map(people.map((p) => [String(p.id).toLowerCase(), p]))
  return rows.map((r) => ({
    id: Number(r.id),
    status: String(r.status),
    error: r.error ?? null,
    created_at: iso(r.created_at),
    resent_by: r.resent_by ?? null,
    resent_by_name: r.resent_by ? personLabel(byId.get(String(r.resent_by).toLowerCase())) : null
  }))
}

/** A delivery of an email the person did not see when they pressed Resend. */
export interface DeliveredSend {
  /** The mail-log row that went out. */
  id: number
  at: string
  /** 'original' = the email itself; 'automatic' = an automatic retry; 'resend' = someone's Resend. */
  how: 'original' | 'automatic' | 'resend'
  by: string | null
  by_name: string | null
}

/** Pure: how one delivered row went out (exported for tests). */
export function deliveryKind(
  row: { id: number | string; resend_of?: number | string | null; resent_by?: string | null },
  originalId: number
): DeliveredSend['how'] {
  if (Number(row.id) === originalId || row.resend_of == null) return 'original'
  return row.resent_by ? 'resend' : 'automatic'
}

/**
 * Resend's "already delivered" guard (realtime safety 2026-11-18): the newest `sent` row of
 * this email — the original or any resend / automatic retry of it — written AFTER `seenId`, the
 * newest row of the trail the person had on screen. Mail-log rows are append-only (a status is
 * never rewritten), so "a newer row id" is exactly "something happened after what they saw".
 * null = nothing went out since; resend away.
 */
export async function deliveredAfter(
  originalId: number,
  seenId: number
): Promise<DeliveredSend | null> {
  const trail = await hasResendColumns()
  const row = (await db('nivaro_mail_log')
    .where('status', 'sent')
    .where('id', '>', seenId)
    .where((qb) => {
      qb.where('id', originalId)
      if (trail) qb.orWhere('resend_of', originalId)
    })
    .orderBy('id', 'desc')
    .first(...(trail ? ['id', 'created_at', 'resend_of', 'resent_by'] : ['id', 'created_at']))) as
    | {
        id: number
        created_at: string | Date
        resend_of?: number | null
        resent_by?: string | null
      }
    | undefined
  if (!row) return null
  const by = row.resent_by ? String(row.resent_by) : null
  const people = by ? await peopleFor([by]) : []
  return {
    id: Number(row.id),
    at: iso(row.created_at),
    how: deliveryKind(row, originalId),
    by,
    by_name: by ? personLabel(people[0]) : null
  }
}
