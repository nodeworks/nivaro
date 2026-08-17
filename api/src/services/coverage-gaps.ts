import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import {
  coerceBool,
  type OwnerResolutionRequest,
  resolveStateOwnersBatch
} from './pipeline-engine.js'
import { getLabels } from './queues.js'

/**
 * Coverage gaps — records whose ENTIRE resolved owner set cannot act.
 *
 * Delegation handles the planned case: someone marks themselves out of office
 * with a delegate, and owner resolution substitutes the delegate everywhere.
 * Nothing handled the unplanned ones — an owner suspended, redacted, or out
 * of office with NO delegate (or an expired one) — and a record whose only
 * owners are unavailable just sits. Nobody's queue shows it as theirs, no
 * SLA escalation names a working human, and it surfaces weeks later as
 * "why is this still in finance review".
 *
 * IMPORTANT resolution nuance: resolveStateOwnersBatch has ALREADY applied
 * delegation, so a resolved owner who is out of office means "no valid
 * delegate exists" by construction — that IS the gap, not a false positive.
 *
 * Computed live on request (admin page + digest candidates), not persisted:
 * availability changes with every status/OOO flip and a stale gap report is
 * worse than a slow one. ~2k open instances resolve in a few seconds.
 */

export interface UnavailableOwner {
  id: string
  name: string
  reason: 'suspended' | 'inactive' | 'redacted' | 'ooo_no_delegate'
}

export interface CoverageGapItem {
  collection: string
  item: string
  label: string
  state: string | null
  template: string
  kind: 'all_unavailable' | 'no_owners'
  owners: UnavailableOwner[]
}

export interface CoverageGapReport {
  open_instances: number
  evaluated: number
  truncated: boolean
  blocked: CoverageGapItem[]
  no_owner_count: number
  by_user: Array<{
    id: string
    name: string
    reason: UnavailableOwner['reason']
    blocked_count: number
  }>
}

const EVAL_CAP = 3000

interface UserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  status: string | null
  is_redacted: boolean | number | null
  is_out_of_office: boolean | number | null
  delegate_id: string | null
  delegate_expires_at: Date | null
}

function displayName(u: { first_name?: string | null; last_name?: string | null; email?: string }) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Unknown'
}

function unavailabilityReason(u: UserRow): UnavailableOwner['reason'] | null {
  if (coerceBool(u.is_redacted)) return 'redacted'
  if (u.status === 'suspended') return 'suspended'
  if (u.status != null && u.status !== 'active') return 'inactive'
  // Post-delegation OOO: substitution already ran, so still-OOO means the
  // delegate chain failed (none set, expired, or the delegate is unavailable
  // themselves — resolution substitutes one hop only).
  if (
    coerceBool(u.is_out_of_office) &&
    (!u.delegate_id || (u.delegate_expires_at && new Date(u.delegate_expires_at) < new Date()))
  ) {
    return 'ooo_no_delegate'
  }
  if (coerceBool(u.is_out_of_office) && u.delegate_id) {
    // Delegate configured but the resolved owner is still this person —
    // resolution would have substituted a working delegate, so the delegate
    // did not resolve. Same gap, same label.
    return 'ooo_no_delegate'
  }
  return null
}

export async function buildCoverageGapReport(): Promise<CoverageGapReport> {
  const instances = (await db('nivaro_workflow_instances as wi')
    .join('nivaro_workflow_states as s', 'wi.current_state', 's.id')
    .where('s.is_terminal', 0)
    .orderBy('wi.started_at', 'desc')
    .limit(EVAL_CAP + 1)
    .select(
      'wi.id as instance_id',
      'wi.collection',
      'wi.item',
      'wi.current_state',
      's.label as state_label',
      's.template'
    )) as Array<{
    instance_id: string
    collection: string
    item: string
    current_state: string
    state_label: string
    template: string
  }>
  const truncated = instances.length > EVAL_CAP
  const sample = instances.slice(0, EVAL_CAP)

  const requests: OwnerResolutionRequest[] = sample.map((i) => ({
    key: i.instance_id,
    stateId: i.current_state,
    instanceId: i.instance_id,
    collection: i.collection,
    itemId: String(i.item)
  }))
  const ownersByKey = await resolveStateOwnersBatch(requests)

  // Availability for every distinct resolved owner, one lookup.
  const ownerIds = new Set<string>()
  for (const owners of ownersByKey.values()) {
    for (const o of owners) ownerIds.add(String(o.id).toUpperCase())
  }
  const userRows =
    ownerIds.size > 0
      ? ((await selectInChunks([...ownerIds], 2000, (chunk) =>
          db('nivaro_users')
            .whereIn('id', chunk)
            .select(
              'id',
              'first_name',
              'last_name',
              'email',
              'status',
              'is_redacted',
              'is_out_of_office',
              'delegate_id',
              'delegate_expires_at'
            )
        )) as UserRow[])
      : []
  const userById = new Map(userRows.map((u) => [String(u.id).toUpperCase(), u]))

  const blocked: CoverageGapItem[] = []
  let noOwnerCount = 0
  const byUser = new Map<
    string,
    { user: UserRow; reason: UnavailableOwner['reason']; count: number }
  >()

  for (const inst of sample) {
    const owners = ownersByKey.get(inst.instance_id) ?? []
    if (owners.length === 0) {
      noOwnerCount++
      continue
    }
    const unavailable: UnavailableOwner[] = []
    for (const o of owners) {
      const u = userById.get(String(o.id).toUpperCase())
      const reason = u ? unavailabilityReason(u) : 'inactive'
      if (reason) {
        unavailable.push({ id: o.id, name: displayName(u ?? o), reason })
      }
    }
    // The gap is EVERY owner unavailable — one working owner means the record
    // is covered, however many colleagues are out.
    if (unavailable.length === owners.length) {
      blocked.push({
        collection: inst.collection,
        item: String(inst.item),
        label: String(inst.item),
        state: inst.state_label,
        template: inst.template,
        kind: 'all_unavailable',
        owners: unavailable
      })
      for (const o of unavailable) {
        const key = String(o.id).toUpperCase()
        const entry = byUser.get(key)
        if (entry) entry.count++
        else {
          const u = userById.get(key)
          if (u) byUser.set(key, { user: u, reason: o.reason, count: 1 })
        }
      }
    }
  }

  // Human labels for the blocked records (capped — the page shows the first 200).
  const shown = blocked.slice(0, 200)
  try {
    const wanted = new Map<string, Set<string>>()
    for (const b of shown) {
      const set = wanted.get(b.collection) ?? new Set<string>()
      set.add(b.item)
      wanted.set(b.collection, set)
    }
    const labels = await getLabels(wanted)
    for (const b of shown) b.label = labels[`${b.collection}:${b.item}`] ?? b.item
  } catch {
    /* labels are decoration */
  }

  return {
    open_instances: sample.length,
    evaluated: sample.length,
    truncated,
    blocked: shown,
    no_owner_count: noOwnerCount,
    by_user: [...byUser.values()]
      .map((e) => ({
        id: e.user.id,
        name: displayName(e.user),
        reason: e.reason,
        blocked_count: e.count
      }))
      .sort((a, b) => b.blocked_count - a.blocked_count)
  }
}
