import type { User } from '../types.js'
import { chunkArray } from './db-batch.js'
import { can } from './permissions.js'
import { ADDENDUM_COLLECTION, loadAddendums } from './pipeline-subject.js'

/**
 * Which of these records may the caller SEE — the gate every SLA read runs
 * before it answers, because an SLA status carries the record's state, its
 * timing and (since #1239) an override's free-text reason and author.
 *
 * Business collections: role read permission, then the record read AS THE
 * CALLER through readItems — row filters, User Scopes, tree permissions and
 * API-key restrictions all apply. An addendum is visible exactly when its
 * PARENT record is (the banner reads nivaro_addendums for the addendum view).
 * Any other system collection is admin-only. Anything that throws hides the
 * record. Ids come back as given (original spelling), so callers can filter
 * their own lists with `.has(id)`.
 */
export async function visibleRecordIds(
  user: User,
  collection: string,
  ids: string[],
  opts: { isAdmin?: boolean } = {}
): Promise<Set<string>> {
  const out = new Set<string>()
  const wanted = [...new Set(ids.map(String).filter(Boolean))]
  if (wanted.length === 0) return out

  if (collection === ADDENDUM_COLLECTION) {
    const infos = await loadAddendums(wanted)
    const byParent = new Map<string, Array<{ id: string; parentId: string }>>()
    for (const id of wanted) {
      const info = infos.get(id)
      if (!info?.parentCollection || !info.parentId) continue
      const arr = byParent.get(info.parentCollection) ?? []
      arr.push({ id, parentId: info.parentId })
      byParent.set(info.parentCollection, arr)
    }
    for (const [parentCollection, rows] of byParent) {
      const seen = await visibleRecordIds(
        user,
        parentCollection,
        rows.map((r) => r.parentId),
        opts
      )
      const seenUpper = new Set([...seen].map((s) => s.toUpperCase()))
      for (const r of rows) if (seenUpper.has(r.parentId.toUpperCase())) out.add(r.id)
    }
    return out
  }

  if (/^(nivaro_|directus_)/i.test(collection)) {
    if (opts.isAdmin) for (const id of wanted) out.add(id)
    return out
  }

  try {
    if (!(await can(user, 'read', collection))) return out
  } catch {
    return out
  }
  const { readItems } = await import('./items.js')
  const byUpper = new Map(wanted.map((id) => [id.toUpperCase(), id]))
  for (const chunk of chunkArray(wanted, 500)) {
    try {
      const res = (await readItems(user, collection, {
        filter: { id: { _in: chunk } },
        fields: ['id'],
        limit: chunk.length,
        count: false
      })) as { data?: Array<Record<string, unknown>> }
      for (const row of res.data ?? []) {
        const original = byUpper.get(String(row.id).toUpperCase())
        if (original) out.add(original)
      }
    } catch {
      /* unreadable → hidden */
    }
  }
  return out
}

/** One record — the single-status routes' 404 gate. */
export async function canSeeRecord(
  user: User,
  collection: string,
  id: string,
  opts: { isAdmin?: boolean } = {}
): Promise<boolean> {
  return (await visibleRecordIds(user, collection, [String(id)], opts)).has(String(id))
}
