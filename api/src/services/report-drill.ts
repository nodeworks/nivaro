import { db } from '../db/index.js'
import type { User } from '../types.js'
import { readItems } from './items.js'

/**
 * Automatic drill-down for NON-NATIVE (query) widgets: a stored-proc result
 * row carries no collection/filters, but its columns usually carry business
 * identifiers ("workflow_id", "project_id"). This infers which record a row
 * points at:
 *
 *  1. The entity-room registry (nivaro_chat_room_types) — deployment-declared
 *     "this column identifies that collection" pairs, highest confidence.
 *  2. `<base>_id` columns where a registered collection named `<base>` or
 *     `<base>s` HAS that column — look the value up by it.
 *  3. Columns exactly named after a registered collection — treated as that
 *     collection's internal id.
 *
 * Every lookup runs through readItems AS THE USER, so RBAC/RLS/scopes bind
 * exactly like any other read; an ambiguous match (2+ rows) is a miss, never
 * a guess.
 */

interface DrillCandidate {
  collection: string
  column: string
  byInternalId: boolean
}

let cache: {
  at: number
  registry: Array<{ collection: string; match_field: string }>
  collections: Set<string>
} | null = null

async function loadMeta() {
  if (cache && Date.now() - cache.at < 60_000) return cache
  const [registry, cols] = await Promise.all([
    db('nivaro_chat_room_types')
      .where({ is_active: true })
      .select('collection', 'match_field')
      .catch(() => [] as Array<{ collection: string; match_field: string }>),
    db('nivaro_collections').select('collection')
  ])
  cache = {
    at: Date.now(),
    registry: registry.map((r) => ({
      collection: String(r.collection),
      match_field: String(r.match_field)
    })),
    collections: new Set(
      (cols as Array<{ collection: string }>)
        .map((c) => String(c.collection))
        .filter((c) => !/^nivaro_/i.test(c) && !/^directus_/i.test(c))
    )
  }
  return cache
}

function candidatesFor(columns: string[], meta: NonNullable<typeof cache>): DrillCandidate[] {
  const out: DrillCandidate[] = []
  const seen = new Set<string>()
  const push = (c: DrillCandidate) => {
    const key = `${c.collection}:${c.column}:${c.byInternalId}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(c)
    }
  }
  for (const col of columns) {
    const reg = meta.registry.find((r) => r.match_field === col)
    if (reg && meta.collections.has(reg.collection)) {
      push({ collection: reg.collection, column: col, byInternalId: reg.match_field === 'id' })
    }
  }
  for (const col of columns) {
    if (col.endsWith('_id')) {
      const base = col.slice(0, -3)
      for (const cand of [base, `${base}s`]) {
        if (meta.collections.has(cand)) push({ collection: cand, column: col, byInternalId: false })
      }
    }
  }
  for (const col of columns) {
    if (meta.collections.has(col)) push({ collection: col, column: 'id', byInternalId: true })
  }
  return out.slice(0, 6)
}

export async function inferDrillTarget(
  user: User,
  values: Record<string, unknown>
): Promise<{ collection: string; item_id: string } | null> {
  const meta = await loadMeta()
  const columns = Object.keys(values).filter(
    (k) => values[k] != null && values[k] !== '' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)
  )
  for (const cand of candidatesFor(columns, meta)) {
    const rawValue = cand.column === 'id' ? values[cand.collection] : values[cand.column]
    if (rawValue == null || typeof rawValue === 'object') continue
    try {
      const filterCol = cand.byInternalId || cand.column === 'id' ? 'id' : cand.column
      const res = await readItems(user, cand.collection, {
        filter: { [filterCol]: { _eq: rawValue } },
        fields: ['id'],
        limit: 2
      })
      const rows = res.data ?? []
      if (rows.length === 1) return { collection: cand.collection, item_id: String(rows[0].id) }
    } catch {
      // a candidate collection the user can't read (or a bad column) just
      // falls through to the next candidate
    }
  }
  return null
}
