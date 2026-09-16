import { db } from '../db/index.js'

// ─── #25 — section-level locks ──────────────────────────────────────────────
// A layout group may list roles for which its fields are read-only
// (`nivaro_field_groups.locked_for_roles`, JSON role-id array). The form
// renders those fields locked; this is the server half — an update from a
// locked role silently drops those keys, the same posture as field lock
// conditions and row-rule locks (curation the form already enforces, not a
// permission error).

interface Entry {
  at: number
  fields: Set<string>
}
const cache = new Map<string, Entry>()
const TTL_MS = 60_000

export function bustSectionLockCache(): void {
  cache.clear()
}

/** Fields of `collection` locked for `roleId` on any active grouped layout. */
export async function sectionLockedFields(
  collection: string,
  roleId: string | null | undefined
): Promise<Set<string>> {
  if (!roleId) return new Set()
  const key = `${collection}:${String(roleId).toUpperCase()}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.fields
  const fields = new Set<string>()
  try {
    const layouts = (await db('nivaro_collection_layouts')
      .where({ collection })
      .andWhere((b) => b.whereNull('layout_type').orWhere('layout_type', 'grouped'))
      .select('id')) as Array<{ id: number }>
    if (layouts.length) {
      const ids = layouts.map((l) => l.id)
      const groups = (await db('nivaro_field_groups')
        .whereIn('layout_id', ids)
        .whereNotNull('locked_for_roles')
        .select('layout_id', 'key', 'locked_for_roles')) as Array<{
        layout_id: number
        key: string
        locked_for_roles: string | null
      }>
      const want = String(roleId).toUpperCase()
      const lockedKeys: Array<{ layout_id: number; key: string }> = []
      for (const g of groups) {
        try {
          const roles = JSON.parse(g.locked_for_roles ?? '[]') as string[]
          if (Array.isArray(roles) && roles.some((r) => String(r).toUpperCase() === want))
            lockedKeys.push({ layout_id: g.layout_id, key: g.key })
        } catch {
          /* ignore */
        }
      }
      if (lockedKeys.length) {
        const rows = (await db('nivaro_layout_field_assignments')
          .whereIn('layout_id', [...new Set(lockedKeys.map((k) => k.layout_id))])
          .whereIn('group_key', [...new Set(lockedKeys.map((k) => k.key))])
          .select('layout_id', 'group_key', 'field')) as Array<{
          layout_id: number
          group_key: string
          field: string
        }>
        const pairs = new Set(lockedKeys.map((k) => `${k.layout_id}:${k.key}`))
        for (const r of rows) {
          if (pairs.has(`${r.layout_id}:${r.group_key}`) && !r.field.startsWith('__'))
            fields.add(r.field)
        }
      }
    }
  } catch {
    /* a broken layout must never block a write */
  }
  cache.set(key, { at: Date.now(), fields })
  return fields
}

/** Drop the locked fields from an update payload (non-admins only). */
export async function applySectionLocks(
  collection: string,
  payload: Record<string, unknown>,
  roleId: string | null | undefined,
  isAdmin: boolean
): Promise<string[]> {
  if (isAdmin) return []
  const locked = await sectionLockedFields(collection, roleId)
  const dropped: string[] = []
  for (const k of Object.keys(payload)) {
    if (locked.has(k)) {
      delete payload[k]
      dropped.push(k)
    }
  }
  return dropped
}
