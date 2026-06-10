import { db } from '../db/index.js'
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

export async function listCollections(workspaceId?: string | null): Promise<CMSCollection[]> {
  const q = db<CMSCollection>('nivaro_collections')
    .orderBy('sort', 'asc')
    .orderBy('display_name', 'asc')
  if (workspaceId) {
    q.where(function () {
      this.where('workspace', workspaceId).orWhereNull('workspace')
    })
  }
  return q
}

export async function listTableCollections(): Promise<CMSCollection[]> {
  const all = await listCollections()
  const rows = (await db.raw(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`
  )) as Array<{ TABLE_NAME: string }>
  const tableNames = new Set(rows.map((r) => r.TABLE_NAME))
  return all.filter((c) => tableNames.has(c.collection))
}

export async function getCollection(name: string): Promise<CMSCollection | undefined> {
  return db<CMSCollection>('nivaro_collections').where({ collection: name }).first()
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
