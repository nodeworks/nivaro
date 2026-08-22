import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Collection snapshots (#78): point-in-time checkpoints for small REFERENCE
 * tables (regions, categories, thresholds…) taken before risky edits. Restore
 * upserts by id — updates changed rows, re-inserts deleted ones — and is
 * HONEST about extras: rows created after the snapshot are reported, never
 * deleted (deleting them would need the whole trash/FK machinery).
 */

const SNAPSHOT_ROW_CAP = 5000
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

async function hasIdentityPk(table: string): Promise<boolean> {
  const rows = (await db.raw(
    `SELECT c.name FROM sys.identity_columns c WHERE c.object_id = OBJECT_ID(?)`,
    [table]
  )) as Array<{ name: string }>
  return rows.length > 0
}

export async function collectionSnapshotRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get<{ Querystring: { collection?: string } }>('/', async (req) => {
    let q = db('nivaro_collection_snapshots as s')
      .leftJoin('nivaro_users as u', 'u.id', 's.created_by')
      .orderBy('s.id', 'desc')
      .limit(100)
      .select(
        's.id',
        's.collection',
        's.name',
        's.row_count',
        's.created_at',
        db.raw("CONCAT(u.first_name, ' ', u.last_name) as created_by_name")
      )
    if (req.query.collection) q = q.where('s.collection', req.query.collection)
    return { data: await q }
  })

  app.post<{ Body: { collection?: string; name?: string } }>('/', async (req, reply) => {
    const collection = String(req.body?.collection ?? '')
    const name = String(req.body?.name ?? '').trim() || `Snapshot ${new Date().toISOString().slice(0, 16)}`
    if (!IDENT.test(collection) || /^(nivaro|directus)_/i.test(collection)) {
      return reply.code(400).send({ error: 'Not a valid business collection' })
    }
    const registered = await db('nivaro_collections').where({ collection }).first('collection')
    if (!registered) return reply.code(404).send({ error: 'Unknown collection' })
    const countRow = (await db(collection).count({ c: '*' }).first()) as { c?: number | string }
    const total = Number(countRow?.c ?? 0)
    if (total > SNAPSHOT_ROW_CAP) {
      return reply.code(400).send({
        error: `${collection} has ${total.toLocaleString()} rows — snapshots are for reference tables (cap ${SNAPSHOT_ROW_CAP.toLocaleString()})`
      })
    }
    const rows = await db(collection).select('*')
    const [created] = (await db('nivaro_collection_snapshots')
      .insert({
        collection,
        name: name.slice(0, 200),
        row_count: rows.length,
        data: JSON.stringify(rows),
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
      .returning('id')) as Array<{ id: number } | number>
    await logActivity({
      action: 'collection-snapshot',
      user: req.user?.id,
      comment: `${collection}: ${rows.length} rows → "${name}"`,
      req
    })
    const id = typeof created === 'object' ? created.id : created
    return reply.code(201).send({ data: { id, row_count: rows.length } })
  })

  app.post<{ Params: { id: string } }>('/:id/restore', async (req, reply) => {
    const snap = (await db('nivaro_collection_snapshots')
      .where('id', req.params.id)
      .first()) as
      | { collection: string; name: string; data: string }
      | undefined
    if (!snap) return reply.code(404).send({ error: 'Snapshot not found' })
    const { collection } = snap
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    let rows: Array<Record<string, unknown>>
    try {
      rows = JSON.parse(snap.data)
      if (!Array.isArray(rows)) throw new Error('bad shape')
    } catch {
      return reply.code(500).send({ error: 'Snapshot data is unreadable' })
    }

    // Columns that still physically exist — the schema may have moved on.
    const cols = (await db.raw('SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?)', [
      collection
    ])) as Array<{ name: string }>
    const valid = new Set(cols.map((c) => c.name))
    const identity = await hasIdentityPk(collection)

    const currentIds = new Set(
      ((await db(collection).pluck('id')) as Array<string | number>).map(String)
    )
    const snapIds = new Set<string>()
    let updated = 0
    let inserted = 0
    for (const raw of rows) {
      const row = Object.fromEntries(Object.entries(raw).filter(([k]) => valid.has(k)))
      const id = row.id
      if (id == null) continue
      snapIds.add(String(id))
      if (currentIds.has(String(id))) {
        const { id: _pk, ...rest } = row
        if (Object.keys(rest).length > 0) {
          await db(collection).where('id', id as string | number).update(rest)
          updated++
        }
      } else if (identity) {
        const keys = Object.keys(row)
        await db.raw(
          `SET IDENTITY_INSERT [${collection}] ON;
           INSERT INTO [${collection}] (${keys.map((k) => `[${k}]`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')});
           SET IDENTITY_INSERT [${collection}] OFF;`,
          keys.map((k) => row[k] as never)
        )
        inserted++
      } else {
        await db(collection).insert(row)
        inserted++
      }
    }
    const extra = [...currentIds].filter((id) => !snapIds.has(id))
    await logActivity({
      action: 'collection-snapshot-restore',
      user: req.user?.id,
      comment: `${collection} ← "${snap.name}": ${updated} updated, ${inserted} re-inserted, ${extra.length} newer rows left alone`,
      req
    })
    return {
      data: { updated, inserted, extra_rows: extra.length, extra_ids: extra.slice(0, 50) }
    }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const n = await db('nivaro_collection_snapshots').where('id', req.params.id).del()
    if (n === 0) return reply.code(404).send({ error: 'Not found' })
    return { data: { deleted: true } }
  })
}
