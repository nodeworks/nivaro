import { db } from '../db/index.js'
import { findRecordInstance } from './branch-instances.js'
import { selectInChunks, whereInList } from './db-batch.js'
import {
  coerceBool,
  type OwnerResolutionTrace,
  resolveStateOwnersBatch
} from './pipeline-engine.js'
import { applyDirectoryListingRules } from './user-directory-cols.js'

/**
 * "Opened by the owner" (idea 21, 2026-11-14) — the pipeline panel tells someone who is NOT
 * an owner of the current step (the requester, a watcher, an admin looking in) whether any
 * of that step's owners has opened the record since it arrived there: "Jane Smith (Finance)
 * opened this 2h ago" or "Not opened yet by the owners of this step". It answers "should I
 * chase?" without asking anyone.
 *
 * Builds on what the app already keeps — no new table, no tracking of its own:
 * - when the record entered its step: the newest workflow history row into the current
 *   state (else the instance start);
 * - who owns the step now: the owner resolver (groups, manual owners, fallback field);
 * - when each of them last opened the record: nivaro_record_views (last/prev watermarks),
 *   the same marks behind mention read receipts (#2117) and the admin first-open metric.
 *
 * Rules:
 * - "Opened" = an owner's open at or after the entry. The person who moved the record into
 *   the step was on the record when they moved it; when they also own the step, only a later
 *   visit (past the 30-minute session grace /touch uses) counts.
 * - A delegate covering an out-of-office owner of the step counts too ("Mark Lee (covering
 *   for Jane Smith) opened this", Rob 2026-11-14), by the resolver's own delegation rule (out
 *   of office, a delegate set, not expired — and only where the resolver delegates: steps
 *   with owner groups), judged AT THE TIME OF THE VIEW: the owner's recorded out-of-office
 *   window (ooo_start/ooo_end) held the view, else they are out now; the delegation had not
 *   expired by then. Someone who owns the step themselves always counts as an owner.
 * - A View-as open never counts: /touch does not roll the person's watermark under View-as.
 * - Names follow the people directory (applyDirectoryListingRules): an opener the directory
 *   does not list (suspended, redacted, machine or placeholder account) is "an owner of this
 *   step", never a name. Everyone — administrators included — gets the same answer.
 * - The viewer who owns the step (or covers it as a working delegate now) gets `owner` and
 *   the panel shows nothing (it is their move).
 *
 * Cost: read only when the panel asks (it skips the read when the viewer is in the roster it
 * already shows): one instance read, one state read, one history read, the owner resolver
 * (its group cache is shared with the panel's own owner reads), one users read for the
 * owners' delegations, one record_views read for owners + delegates and one users read for
 * the people named.
 */

/** Same grace /touch uses: views by the mover inside it are the move itself. */
export const MOVER_GRACE_MS = 30 * 60 * 1000

export interface OpenedState {
  id: string
  label: string
}

export interface OpenedBy {
  id: string
  name: string
  /** Department, else job title — "(Finance)". */
  group: string | null
  /** Set when the opener is a delegate: the out-of-office owner they covered for
   *  ("an owner of this step" when the directory does not list that owner). */
  covering_for: string | null
}

export type OwnerOpened =
  | { status: 'none' }
  | { status: 'owner' }
  | { status: 'not_opened'; state: OpenedState; entered_at: string }
  | {
      status: 'opened'
      state: OpenedState
      entered_at: string
      opened_at: string
      /** null = the opener is not someone the people directory lists. */
      by: OpenedBy | null
      /** The opener was a delegate covering an out-of-office owner. */
      delegate: boolean
      /** Other owners (or their delegates) of the step who opened it too. */
      others: number
    }

export interface DirectoryPerson {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  department?: string | null
  title?: string | null
}

/** One owner's delegation as it stands (nivaro_users), times in ms. */
export interface OwnerDelegation {
  ownerId: string
  delegateId: string
  /** delegate_expires_at; null = open-ended. */
  expiresAt: number | null
  /** Recorded out-of-office window (ooo_start / ooo_end). */
  outFrom: number | null
  outTo: number | null
  /** is_out_of_office right now. */
  outNow: boolean
}

/** One person's last two opens (nivaro_record_views watermarks), ms. */
export interface ViewMarks {
  last: number | null
  prev: number | null
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

/**
 * Did this delegation cover the owner at `t`? The resolver's rule (out, delegate set, not
 * expired) at that moment: a recorded out-of-office window must hold `t`; with no window the
 * owner counts as out only while they are out now (the flag keeps no history).
 */
export function delegationActiveAt(d: OwnerDelegation, t: number, now: number): boolean {
  if (t > now) return false
  if (d.expiresAt != null && d.expiresAt <= t) return false
  if (d.outFrom != null) return d.outFrom <= t && (d.outTo == null || t < d.outTo)
  return d.outNow
}

export interface Opener {
  id: string
  at: number
  /** The owner covered for, when the open was a delegate's. */
  coveringFor?: string
}

/** Owners — and delegates covering an out-of-office owner — who opened the record since
 *  `enteredAt`, newest open first. Pure. */
export function ownersWhoOpened(input: {
  enteredAt: number
  mover: string | null
  ownerIds: string[]
  /** USER (upper-cased) → watermarks. */
  views: Map<string, ViewMarks>
  delegations?: OwnerDelegation[]
  now?: number
}): Opener[] {
  const now = input.now ?? Date.now()
  const opensOf = (k: string) => {
    const from =
      input.mover && up(input.mover) === k ? input.enteredAt + MOVER_GRACE_MS : input.enteredAt
    const m = input.views.get(k)
    return [m?.last, m?.prev]
      .filter((t): t is number => t != null && Number.isFinite(t) && t >= from)
      .sort((a, b) => b - a)
  }
  const owners = new Set(input.ownerIds.map(up))
  const seen = new Set<string>()
  const out: Opener[] = []
  for (const id of input.ownerIds) {
    const k = up(id)
    if (seen.has(k)) continue
    seen.add(k)
    const [at] = opensOf(k)
    if (at != null) out.push({ id, at })
  }
  // Delegates who do not own the step themselves: their newest open made while a delegation
  // from one of the step's owners was active.
  const byDelegate = new Map<string, OwnerDelegation[]>()
  for (const d of input.delegations ?? []) {
    const dk = up(d.delegateId)
    if (!owners.has(up(d.ownerId)) || owners.has(dk)) continue
    byDelegate.set(dk, [...(byDelegate.get(dk) ?? []), d])
  }
  for (const [dk, list] of byDelegate) {
    for (const t of opensOf(dk)) {
      const d = list.find((x) => delegationActiveAt(x, t, now))
      if (d) {
        out.push({ id: d.delegateId, at: t, coveringFor: d.ownerId })
        break
      }
    }
  }
  return out.sort((a, b) => b.at - a.at)
}

export function personName(p: DirectoryPerson): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || String(p.email ?? '')
}

/** The viewer owns the step: one of its owners, or the working delegate of one right now
 *  (the post-delegation roster the panel shows). */
export function viewerOwnsStep(
  viewerId: string,
  ownerIds: string[],
  delegations: OwnerDelegation[],
  now: number
): boolean {
  const v = up(viewerId)
  if (ownerIds.some((id) => up(id) === v)) return true
  const owners = new Set(ownerIds.map(up))
  return delegations.some(
    (d) => up(d.delegateId) === v && owners.has(up(d.ownerId)) && delegationActiveAt(d, now, now)
  )
}

/**
 * The answer, from the facts. Pure. `listed` holds the people the directory lists (USER →
 * row); anyone else opens anonymously. The named opener is the newest LISTED one; with none
 * listed, the newest open stands unnamed.
 */
export function decideOwnerOpened(input: {
  viewerId: string
  state: OpenedState
  enteredAt: number
  mover: string | null
  ownerIds: string[]
  views: Map<string, ViewMarks>
  listed: Map<string, DirectoryPerson>
  delegations?: OwnerDelegation[]
  now?: number
}): OwnerOpened {
  const now = input.now ?? Date.now()
  const delegations = input.delegations ?? []
  if (input.ownerIds.length === 0) return { status: 'none' }
  if (viewerOwnsStep(input.viewerId, input.ownerIds, delegations, now)) return { status: 'owner' }
  const entered_at = new Date(input.enteredAt).toISOString()
  const openers = ownersWhoOpened({ ...input, delegations, now })
  if (openers.length === 0) return { status: 'not_opened', state: input.state, entered_at }
  const named = openers.find((o) => input.listed.has(up(o.id)))
  const pick = named ?? openers[0]
  const person = named ? input.listed.get(up(named.id)) : undefined
  const covered = pick.coveringFor ? input.listed.get(up(pick.coveringFor)) : undefined
  return {
    status: 'opened',
    state: input.state,
    entered_at,
    opened_at: new Date(pick.at).toISOString(),
    by: person
      ? {
          id: String(person.id),
          name: personName(person),
          group: (person.department || person.title || '').trim() || null,
          covering_for: pick.coveringFor
            ? covered
              ? personName(covered)
              : 'an owner of this step'
            : null
        }
      : null,
    delegate: !!pick.coveringFor,
    others: openers.length - 1
  }
}

const ms = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const t = new Date(v as string).getTime()
  return Number.isFinite(t) ? t : null
}

/** The answer for one record, as `viewerId` would see it. The caller has already checked the
 *  viewer may read the record. */
export async function loadOwnerOpened(
  collection: string,
  item: string,
  viewerId: string
): Promise<OwnerOpened> {
  const instance = (await findRecordInstance(collection, item)) as
    | {
        id: string | number
        current_state?: string | null
        completed_at?: Date | string | null
        started_at?: Date | string | null
      }
    | undefined
  if (!instance?.current_state || instance.completed_at) return { status: 'none' }
  const stateId = String(instance.current_state)
  // RAW owners (no out-of-office swap): a delegate's open is judged by the delegation active
  // when they opened it, not today's. The trace says whether the resolver delegates here.
  const trace = new Map<string, OwnerResolutionTrace>()
  // State, entry and owners need only the instance: one round of reads, side by side.
  const [stateRow, entry, resolved] = await Promise.all([
    db('nivaro_workflow_states').where({ id: stateId }).first('id', 'label', 'is_terminal') as
      | Promise<{ id: string; label: string | null; is_terminal: boolean | number | null }>
      | Promise<undefined>,
    db('nivaro_workflow_history')
      .where({ instance: instance.id, to_state: stateId })
      .orderBy([
        { column: 'timestamp', order: 'desc' },
        { column: 'id', order: 'desc' }
      ])
      .first('timestamp', 'user') as Promise<
      { timestamp: Date | string; user: string | null } | undefined
    >,
    resolveStateOwnersBatch(
      [{ key: 'x', stateId, instanceId: String(instance.id), collection, itemId: String(item) }],
      db,
      { skipDelegation: true, trace }
    )
  ])
  if (!stateRow || stateRow.is_terminal === true || stateRow.is_terminal === 1)
    return { status: 'none' }
  const enteredAt = ms(entry?.timestamp) ?? ms(instance.started_at)
  if (enteredAt == null) return { status: 'none' }

  const ownerIds = [...new Set((resolved.get('x') ?? []).map((o) => String(o.id)))]
  if (ownerIds.length === 0) return { status: 'none' }
  const now = Date.now()

  // The owners' delegations — only where the resolver delegates (a step with owner groups).
  const delegations: OwnerDelegation[] = []
  if (trace.get('x')?.hasGroups) {
    const rows = (await selectInChunks(ownerIds, 1000, (chunk) =>
      whereInList(db('nivaro_users'), 'id', chunk)
        .whereNotNull('delegate_id')
        .select(
          'id',
          'delegate_id',
          'delegate_expires_at',
          'is_out_of_office',
          'ooo_start',
          'ooo_end'
        )
    )) as Array<Record<string, unknown>>
    for (const r of rows)
      delegations.push({
        ownerId: String(r.id),
        delegateId: String(r.delegate_id),
        expiresAt: ms(r.delegate_expires_at),
        outFrom: ms(r.ooo_start),
        outTo: ms(r.ooo_end),
        outNow: coerceBool(r.is_out_of_office)
      })
  }
  const base = {
    viewerId,
    state: { id: stateId, label: stateRow.label ?? '' },
    enteredAt,
    mover: entry?.user ? String(entry.user) : null,
    ownerIds,
    delegations,
    now
  }
  // The viewer owns the step: nothing more to read.
  if (viewerOwnsStep(viewerId, ownerIds, delegations, now)) return { status: 'owner' }

  const people = [...new Set([...ownerIds, ...delegations.map((d) => d.delegateId)])]
  const viewRows = (await selectInChunks(people, 1000, (chunk) =>
    whereInList(
      db('nivaro_record_views').where({ collection, item_id: String(item) }),
      'user',
      chunk
    ).select('user', 'last_viewed_at', 'prev_viewed_at')
  )) as Array<{ user: string; last_viewed_at: unknown; prev_viewed_at: unknown }>
  const views = new Map<string, ViewMarks>()
  for (const v of viewRows)
    views.set(up(v.user), { last: ms(v.last_viewed_at), prev: ms(v.prev_viewed_at) })
  const openers = ownersWhoOpened({ ...base, views })
  const listed = new Map<string, DirectoryPerson>()
  const named = [
    ...new Set(openers.flatMap((o) => (o.coveringFor ? [o.id, o.coveringFor] : [o.id])))
  ]
  if (named.length > 0) {
    const rows = (await selectInChunks(named, 1000, (chunk) =>
      applyDirectoryListingRules(whereInList(db('nivaro_users'), 'id', chunk) as never).select(
        'id',
        'first_name',
        'last_name',
        'email',
        'department',
        'title'
      )
    )) as DirectoryPerson[]
    for (const p of rows) listed.set(up(p.id), p)
  }
  return decideOwnerOpened({ ...base, views, listed })
}
