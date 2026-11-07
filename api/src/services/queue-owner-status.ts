import { db } from '../db/index.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { isInactivePerson } from './pipeline-engine.js'

/** Why an owner on a queue row cannot act — the row says so (army 8 b08-N4). */
export type InactiveOwner = 'suspended' | 'former'

interface OwnerRef {
  id: string
  name: string
  inactive?: InactiveOwner
}

interface PersonRow {
  id: string
  status?: string | null
  is_redacted?: boolean | number | null
  first_name?: string | null
  last_name?: string | null
}

/**
 * Pure: an account's reason for not acting, or null for a person who can. The ONE
 * rule is `isInactivePerson` (pipeline-engine.ts — the same that decides "No
 * Owners"): suspended / inactive people keep their real name, so the row says
 * "suspended"; archived, deleted and redacted ones (flag or the legacy
 * "Redacted Redacted" name) read "former".
 */
export function inactiveOwnerReason(u: Omit<PersonRow, 'id'>): InactiveOwner | null {
  if (!isInactivePerson(u)) return null
  const status = String(u.status ?? '').toLowerCase()
  return status === 'suspended' || status === 'inactive' ? 'suspended' : 'former'
}

/** Owner entries already judged (the live path marks every row before scoping, the
 *  route marks the page again) — a second pass never reads the same people twice. */
const judged = new WeakSet<object>()

/**
 * Marks owners on queue rows who can no longer act (`inactive`) and rows whose
 * every owner is one of them (`no_active_owner` — what puts a row under "No
 * Owners", services/queues.ts isUnowned). A "No Owners" row listed "Joseph
 * Paolillo" with nothing saying he is suspended — counting him as no owner was
 * right, the row just could not say why. One batched people read for the owners
 * not judged yet; a failed read leaves the rows unmarked (never refuses the page).
 * Idempotent: a single-flight result shared by two requests may be marked twice.
 */
export async function markInactiveOwners(
  items: Array<{ owners?: OwnerRef[] | null; no_active_owner?: boolean }>,
  read: (ids: string[]) => Promise<PersonRow[]> = readPeople
): Promise<void> {
  const pending = new Map<string, OwnerRef[]>()
  for (const item of items)
    for (const o of item.owners ?? []) {
      if (judged.has(o)) continue
      const key = String(o.id).toUpperCase()
      const list = pending.get(key) ?? []
      list.push(o)
      pending.set(key, list)
    }
  if (pending.size > 0) {
    let rows: PersonRow[]
    try {
      rows = await read([...pending.keys()])
    } catch {
      return
    }
    const reason = new Map<string, InactiveOwner>()
    for (const r of rows) {
      const why = inactiveOwnerReason(r)
      if (why) reason.set(String(r.id).toUpperCase(), why)
    }
    for (const [key, owners] of pending)
      for (const o of owners) {
        const why = reason.get(key)
        if (why) o.inactive = why
        judged.add(o)
      }
  }
  for (const item of items) {
    const owners = item.owners ?? []
    if (owners.length > 0 && owners.every((o) => o.inactive)) item.no_active_owner = true
  }
}

async function readPeople(ids: string[]): Promise<PersonRow[]> {
  return selectInChunks(ids, 1000, (chunk) =>
    whereInList(db('nivaro_users'), 'id', chunk).select(
      'id',
      'status',
      'is_redacted',
      'first_name',
      'last_name'
    )
  ) as Promise<PersonRow[]>
}
