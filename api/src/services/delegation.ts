import { db } from '../db/index.js'
import { buildOooRunway, type RunwayEntry } from './coverage-gaps.js'

/**
 * Delegation overview — the one read model behind the Delegation console:
 * who is out right now, who is scheduled out, who covers whom, delegations
 * about to expire (or already expired while the person is still out), and
 * the approval load each absence touches (from the OOO runway). Computed
 * live; the coverage-gap record list (admin) is fetched separately by the
 * client because it costs seconds.
 */

export interface DelegationPerson {
  id: string
  name: string
  email: string | null
}

export interface DelegationEntry {
  user: DelegationPerson
  currently_out: boolean
  ooo_start: string | null
  ooo_end: string | null
  delegate: DelegationPerson | null
  delegate_expires_at: string | null
  /** Delegate exists, is active, not out themselves, and not expired. */
  delegate_ok: boolean
  /** Why the delegate does not resolve (null when ok or no delegate). */
  delegate_problem: 'none' | 'expired' | 'suspended' | 'out' | null
  group_seats: number
  states: string[]
  pending_estimate: number
}

export interface CoveringEntry {
  delegate: DelegationPerson
  covers: Array<DelegationPerson & { expires_at: string | null; currently_out: boolean }>
}

export interface ExpiringEntry {
  user: DelegationPerson
  delegate: DelegationPerson
  expires_at: string
  /** Already past while the person is still out — approvals are stalling. */
  expired: boolean
  currently_out: boolean
}

export interface DelegationOverview {
  days: number
  generated_at: string
  out_now: DelegationEntry[]
  upcoming: DelegationEntry[]
  covering: CoveringEntry[]
  expiring: ExpiringEntry[]
  /** People out (now or within 24h) whose delegate does not resolve — the
   *  approvals in their states are what "would go unowned tomorrow". */
  uncovered: DelegationEntry[]
  totals: {
    out_now: number
    upcoming: number
    covering: number
    expiring: number
    uncovered: number
    pending_uncovered: number
  }
}

const person = (id: unknown, first: unknown, last: unknown, email: unknown): DelegationPerson => ({
  id: String(id),
  name: [first, last].filter(Boolean).join(' ') || String(email ?? id),
  email: (email as string | null) ?? null
})

const bool = (v: unknown) => v === true || v === 1

export async function buildDelegationOverview(days = 14): Promise<DelegationOverview> {
  const now = new Date()
  const horizon = new Date(now.getTime() + days * 86_400_000)
  const soon = new Date(now.getTime() + 24 * 3_600_000)

  const rows = (await db('nivaro_users as u')
    .leftJoin('nivaro_users as d', 'd.id', 'u.delegate_id')
    .where((qb) => qb.whereNull('u.status').orWhereNot('u.status', 'suspended'))
    .where('u.is_redacted', 0)
    .where((qb) => {
      qb.where('u.is_out_of_office', true)
        .orWhereNotNull('u.delegate_id')
        .orWhere((w) => {
          w.whereNotNull('u.ooo_start')
            .where('u.ooo_start', '<=', horizon)
            .where((e) => e.whereNull('u.ooo_end').orWhere('u.ooo_end', '>=', now))
        })
    })
    .select(
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.email',
      'u.is_out_of_office',
      'u.ooo_start',
      'u.ooo_end',
      'u.delegate_id',
      'u.delegate_expires_at',
      'd.id as d_id',
      'd.first_name as d_first',
      'd.last_name as d_last',
      'd.email as d_email',
      'd.status as d_status',
      'd.is_out_of_office as d_ooo'
    )) as Array<Record<string, unknown>>

  let runway: RunwayEntry[] = []
  try {
    runway = await buildOooRunway(days)
  } catch {
    runway = []
  }
  const runwayBy = new Map(runway.map((r) => [r.user_id.toUpperCase(), r]))

  const entries: DelegationEntry[] = rows.map((r) => {
    const rw = runwayBy.get(String(r.id).toUpperCase())
    const delegate = r.d_id ? person(r.d_id, r.d_first, r.d_last, r.d_email) : null
    const expiresAt = r.delegate_expires_at ? new Date(String(r.delegate_expires_at)) : null
    const expired = !!expiresAt && expiresAt < now
    let problem: DelegationEntry['delegate_problem'] = null
    if (!delegate) problem = 'none'
    else if (expired) problem = 'expired'
    else if (String(r.d_status ?? '').toLowerCase() === 'suspended') problem = 'suspended'
    else if (bool(r.d_ooo)) problem = 'out'
    return {
      user: person(r.id, r.first_name, r.last_name, r.email),
      currently_out: bool(r.is_out_of_office),
      ooo_start: r.ooo_start ? new Date(String(r.ooo_start)).toISOString() : null,
      ooo_end: r.ooo_end ? new Date(String(r.ooo_end)).toISOString() : null,
      delegate,
      delegate_expires_at: expiresAt ? expiresAt.toISOString() : null,
      delegate_ok: !!delegate && problem === null,
      delegate_problem: problem,
      group_seats: rw?.group_seats ?? 0,
      states: rw?.states ?? [],
      pending_estimate: rw?.pending_estimate ?? 0
    }
  })

  const out_now = entries
    .filter((e) => e.currently_out)
    .sort((a, b) => b.pending_estimate - a.pending_estimate)
  const upcoming = entries
    .filter((e) => !e.currently_out && e.ooo_start && new Date(e.ooo_start) > now)
    .sort((a, b) => String(a.ooo_start).localeCompare(String(b.ooo_start)))

  // Who covers whom: active delegations (person out, delegate set).
  const coverMap = new Map<string, CoveringEntry>()
  for (const e of entries) {
    if (!e.delegate || !e.currently_out) continue
    const key = e.delegate.id.toUpperCase()
    const cur = coverMap.get(key) ?? { delegate: e.delegate, covers: [] }
    cur.covers.push({ ...e.user, expires_at: e.delegate_expires_at, currently_out: true })
    coverMap.set(key, cur)
  }
  const covering = [...coverMap.values()].sort((a, b) => b.covers.length - a.covers.length)

  const expiring: ExpiringEntry[] = entries
    .filter(
      (e) =>
        e.delegate &&
        e.delegate_expires_at &&
        new Date(e.delegate_expires_at) <= horizon &&
        // an expired delegation only matters while the person is still out
        (new Date(e.delegate_expires_at) >= now || e.currently_out)
    )
    .map((e) => ({
      user: e.user,
      delegate: e.delegate as DelegationPerson,
      expires_at: e.delegate_expires_at as string,
      expired: new Date(e.delegate_expires_at as string) < now,
      currently_out: e.currently_out
    }))
    .sort((a, b) => a.expires_at.localeCompare(b.expires_at))

  const uncovered = entries
    .filter(
      (e) =>
        // Anyone out (or entering a window by tomorrow) whose delegate does
        // not resolve — with or without matrix seats: a fallback-field owner
        // (record creator) blocks records just the same.
        !e.delegate_ok && (e.currently_out || (e.ooo_start && new Date(e.ooo_start) <= soon))
    )
    .sort((a, b) => b.pending_estimate - a.pending_estimate)

  return {
    days,
    generated_at: now.toISOString(),
    out_now,
    upcoming,
    covering,
    expiring,
    uncovered,
    totals: {
      out_now: out_now.length,
      upcoming: upcoming.length,
      covering: covering.length,
      expiring: expiring.length,
      uncovered: uncovered.length,
      pending_uncovered: uncovered.reduce((s, e) => s + e.pending_estimate, 0)
    }
  }
}
