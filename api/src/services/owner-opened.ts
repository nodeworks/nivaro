import { db } from '../db/index.js'
import { findRecordInstance } from './branch-instances.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'
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
 * - when each of them last opened the record: nivaro_record_views.last_viewed_at, the same
 *   watermark behind mention read receipts (#2117) and the admin first-open metric (#1078).
 *
 * Rules:
 * - "Opened" = an owner's last open is at or after the entry. The person who moved the record
 *   into the step was on the record when they moved it; when they also own the step, only a
 *   later visit (past the 30-minute session grace /touch uses) counts.
 * - A View-as open never counts: /touch does not roll the person's watermark under View-as.
 * - Names follow the people directory (applyDirectoryListingRules): an opener the directory
 *   does not list (suspended, redacted, machine or placeholder account) is "an owner of this
 *   step", never a name. Everyone — administrators included — gets the same answer.
 * - The viewer who owns the step gets `owner` and the panel shows nothing (it is their move).
 *
 * Cost: read only when the panel asks (it skips the read when the viewer is in the roster it
 * already shows): one instance read, one state read, one history read, the owner resolver
 * (its group cache is shared with the panel's own owner reads), one record_views read for
 * the owners and one users read for the openers.
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
      /** Other owners of the step who opened it too. */
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

const up = (v: unknown) => String(v ?? '').toUpperCase()

/** Owners who opened the record since `enteredAt`, newest open first. Pure. */
export function ownersWhoOpened(input: {
  enteredAt: number
  mover: string | null
  ownerIds: string[]
  /** USER (upper-cased) → last_viewed_at in ms. */
  lastViews: Map<string, number>
}): Array<{ id: string; at: number }> {
  const seen = new Set<string>()
  const out: Array<{ id: string; at: number }> = []
  for (const id of input.ownerIds) {
    const k = up(id)
    if (seen.has(k)) continue
    seen.add(k)
    const at = input.lastViews.get(k)
    if (at == null || !Number.isFinite(at)) continue
    const from =
      input.mover && up(input.mover) === k ? input.enteredAt + MOVER_GRACE_MS : input.enteredAt
    if (at >= from) out.push({ id, at })
  }
  return out.sort((a, b) => b.at - a.at)
}

export function personName(p: DirectoryPerson): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || String(p.email ?? '')
}

/**
 * The answer, from the facts. Pure. `listed` holds the openers the people directory lists
 * (USER → row); anyone else opens anonymously. The named opener is the newest LISTED one;
 * with none listed, the newest open stands unnamed.
 */
export function decideOwnerOpened(input: {
  viewerId: string
  state: OpenedState
  enteredAt: number
  mover: string | null
  ownerIds: string[]
  lastViews: Map<string, number>
  listed: Map<string, DirectoryPerson>
}): OwnerOpened {
  if (input.ownerIds.length === 0) return { status: 'none' }
  if (input.ownerIds.some((id) => up(id) === up(input.viewerId))) return { status: 'owner' }
  const entered_at = new Date(input.enteredAt).toISOString()
  const openers = ownersWhoOpened(input)
  if (openers.length === 0) return { status: 'not_opened', state: input.state, entered_at }
  const named = openers.find((o) => input.listed.has(up(o.id)))
  const pick = named ?? openers[0]
  const person = named ? input.listed.get(up(named.id)) : undefined
  return {
    status: 'opened',
    state: input.state,
    entered_at,
    opened_at: new Date(pick.at).toISOString(),
    by: person
      ? {
          id: String(person.id),
          name: personName(person),
          group: (person.department || person.title || '').trim() || null
        }
      : null,
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
    resolveStateOwnersBatch([
      {
        key: 'x',
        stateId,
        instanceId: String(instance.id),
        collection,
        itemId: String(item)
      }
    ])
  ])
  if (!stateRow || stateRow.is_terminal === true || stateRow.is_terminal === 1)
    return { status: 'none' }
  const enteredAt = ms(entry?.timestamp) ?? ms(instance.started_at)
  if (enteredAt == null) return { status: 'none' }

  const ownerIds = [...new Set((resolved.get('x') ?? []).map((o) => String(o.id)))]
  const state = { id: stateId, label: stateRow.label ?? '' }
  const base = {
    viewerId,
    state,
    enteredAt,
    mover: entry?.user ? String(entry.user) : null,
    ownerIds
  }
  // No owners, or the viewer is one: nothing more to read.
  const early = decideOwnerOpened({ ...base, lastViews: new Map(), listed: new Map() })
  if (early.status === 'none' || early.status === 'owner') return early

  const viewRows = (await selectInChunks(ownerIds, 1000, (chunk) =>
    whereInList(
      db('nivaro_record_views').where({ collection, item_id: String(item) }),
      'user',
      chunk
    ).select('user', 'last_viewed_at')
  )) as Array<{ user: string; last_viewed_at: unknown }>
  const lastViews = new Map<string, number>()
  for (const v of viewRows) {
    const t = ms(v.last_viewed_at)
    if (t != null) lastViews.set(up(v.user), t)
  }
  const openers = ownersWhoOpened({ ...base, lastViews })
  const listed = new Map<string, DirectoryPerson>()
  if (openers.length > 0) {
    const people = (await selectInChunks(
      openers.map((o) => o.id),
      1000,
      (chunk) =>
        applyDirectoryListingRules(whereInList(db('nivaro_users'), 'id', chunk) as never).select(
          'id',
          'first_name',
          'last_name',
          'email',
          'department',
          'title'
        )
    )) as DirectoryPerson[]
    for (const p of people) listed.set(up(p.id), p)
  }
  return decideOwnerOpened({ ...base, lastViews, listed })
}
