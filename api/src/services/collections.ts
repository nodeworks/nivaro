import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import type { CMSCollection, CMSField, CMSRelation } from '../types.js'

function parseJson<T>(val: unknown): T | null {
  if (!val) return null
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T
    } catch {
      return null
    }
  }
  return val as T
}

function serializeCollection(col: CMSCollection): CMSCollection {
  return {
    ...col,
    picker_filter: parseJson(col.picker_filter)
  }
}

export async function listCollections(workspaceId?: string | null): Promise<CMSCollection[]> {
  const q = db<CMSCollection>('nivaro_collections')
    .orderBy('sort', 'asc')
    .orderBy('display_name', 'asc')
  if (workspaceId) {
    q.where(function () {
      this.where('workspace', workspaceId).orWhereNull('workspace')
    })
  }
  const rows = await q
  return rows.map(serializeCollection)
}

export async function listTableCollections(): Promise<CMSCollection[]> {
  const all = await listCollections()
  const rows = rawRows<{ TABLE_NAME: string }>(await db.raw(
    `SELECT TABLE_NAME AS "TABLE_NAME" FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`
  ))
  const tableNames = new Set(rows.map((r) => r.TABLE_NAME))
  return all.filter((c) => tableNames.has(c.collection))
}

const SYNTHETIC_COLLECTIONS: Record<string, Partial<CMSCollection>> = {
  nivaro_users: {
    display_name: 'Users',
    display_template: '{{first_name}} {{last_name}}',
    hidden: false,
    singleton: false,
    accountability: 'all',
    versioning: false,
  }
}

// ─── Metadata cache ──────────────────────────────────────────────────────────
// getCollection/getFields sit on the hot path of every items request (often
// several times each, plus once per expanded relation). Against a remote SQL
// Server every call costs a full round trip (~40-70ms measured), which was a
// large share of the ~600ms floor on ANY list read. Schema metadata changes
// only through the data-model/collections/field-config routes, which call
// clearMetadataCache() — the short TTL is just a backstop for direct DB edits.
const META_TTL_MS = 30_000
const collectionCache = new Map<string, { value: CMSCollection | undefined; at: number }>()
const fieldsCache = new Map<string, { value: CMSField[]; at: number }>()

/** Drop cached collection/field metadata (all, or one collection). */
export function clearMetadataCache(collection?: string): void {
  if (collection) {
    collectionCache.delete(collection)
    fieldsCache.delete(collection)
    return
  }
  collectionCache.clear()
  fieldsCache.clear()
}

export async function getCollection(name: string): Promise<CMSCollection | undefined> {
  const hit = collectionCache.get(name)
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.value
  const value = await loadCollection(name)
  collectionCache.set(name, { value, at: Date.now() })
  return value
}

async function loadCollection(name: string): Promise<CMSCollection | undefined> {
  const col = await db<CMSCollection>('nivaro_collections').where({ collection: name }).first()
  if (col) return serializeCollection(col)
  const synthetic = SYNTHETIC_COLLECTIONS[name]
  if (!synthetic) return undefined
  return {
    id: 0,
    collection: name,
    display_name: null,
    singular: null,
    plural: null,
    icon: null,
    note: null,
    color: null,
    hidden: false,
    singleton: false,
    sort_field: null,
    archive_field: null,
    archive_value: null,
    unarchive_value: null,
    display_template: null,
    group: null,
    sort: null,
    accountability: 'all',
    versioning: false,
    workspace: null,
    picker_filter: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...synthetic,
  } as CMSCollection
}

export async function createCollection(
  data: Omit<CMSCollection, 'id' | 'created_at' | 'updated_at'>
): Promise<CMSCollection> {
  const [id] = (await db('nivaro_collections')
    .insert({ ...data, created_at: new Date(), updated_at: new Date() })
    .returning('id')) as unknown as [number]
  return db<CMSCollection>('nivaro_collections').where({ id }).first() as Promise<CMSCollection>
}

export async function updateCollection(
  name: string,
  data: Partial<CMSCollection>
): Promise<CMSCollection | undefined> {
  await db('nivaro_collections')
    .where({ collection: name })
    .update({ ...data, updated_at: new Date() })
  return getCollection(name)
}

export async function deleteCollection(name: string): Promise<void> {
  await db('nivaro_collections').where({ collection: name }).delete()
  await db('nivaro_fields').where({ collection: name }).delete()
  await db('nivaro_relations')
    .where({ many_collection: name })
    .orWhere({ one_collection: name })
    .delete()
}

// ─── Fields ───────────────────────────────────────────────────────────────────

export async function getFields(collection: string): Promise<CMSField[]> {
  const hit = fieldsCache.get(collection)
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit.value
  const value = await loadFields(collection)
  fieldsCache.set(collection, { value, at: Date.now() })
  return value
}

async function loadFields(collection: string): Promise<CMSField[]> {
  const rows = await db<CMSField>('nivaro_fields').where({ collection }).orderBy('sort', 'asc')
  return rows.map((f) => ({
    ...f,
    display_options: parseJson(f.display_options),
    options: parseJson(f.options),
    special: parseJson<string[]>(f.special),
    validation: parseJson(f.validation)
  }))
}

export async function upsertField(
  collection: string,
  field: string,
  data: Partial<CMSField>
): Promise<void> {
  const existing = await db('nivaro_fields').where({ collection, field }).first()
  const payload = {
    ...data,
    display_options: data.display_options ? JSON.stringify(data.display_options) : undefined,
    options: data.options ? JSON.stringify(data.options) : undefined,
    special: data.special ? JSON.stringify(data.special) : undefined,
    validation: data.validation ? JSON.stringify(data.validation) : undefined,
    updated_at: new Date()
  }
  if (existing) {
    await db('nivaro_fields').where({ collection, field }).update(payload)
  } else {
    await db('nivaro_fields').insert({ collection, field, ...payload, created_at: new Date() })
  }
}

// ─── Relations ────────────────────────────────────────────────────────────────

export async function getRelations(collection?: string): Promise<CMSRelation[]> {
  if (!collection) {
    const rows = await db<CMSRelation>('nivaro_relations')
    return rows.map((r) => ({
      ...r,
      one_allowed_collections: parseJson<string[]>(r.one_allowed_collections)
    }))
  }

  const direct = await db<CMSRelation>('nivaro_relations')
    .where({ many_collection: collection })
    .orWhere({ one_collection: collection })

  // For M2M where this collection is the parent (one_collection), also include
  // the junction table's other FK so callers can resolve the related collection.
  const junctionTables = direct
    .filter((r) => r.junction_field != null && r.one_collection === collection)
    .map((r) => r.many_collection)

  if (junctionTables.length === 0) {
    return direct.map((r) => ({
      ...r,
      one_allowed_collections: parseJson<string[]>(r.one_allowed_collections)
    }))
  }

  const directIds = new Set(direct.map((r) => r.id))
  const junctionRels = await db<CMSRelation>('nivaro_relations')
    .whereIn('many_collection', junctionTables)
    .whereNotIn('id', [...directIds])

  return [...direct, ...junctionRels].map((r) => ({
    ...r,
    one_allowed_collections: parseJson<string[]>(r.one_allowed_collections)
  }))
}
