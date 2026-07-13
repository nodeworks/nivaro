import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Content promotion — move records between instances (staging → prod).
 *
 *   export  → self-contained JSON bundle of selected collections
 *   preview → diff a bundle against THIS instance: create/update/unchanged
 *   apply   → upsert by primary key (id) — updates existing rows, inserts
 *             missing ones (IDENTITY_INSERT-aware for int identity PKs)
 *
 * Deliberate limits: business collections only (no nivaro_* config — that's
 * what workspace templates and schema snapshots are for), id-keyed upserts
 * (no deletes — promotion never removes target data), 10k rows/collection
 * per bundle.
 */

const MAX_ROWS = 10_000

interface Bundle {
  type: 'nivaro-content-bundle'
  version: 1
  exported_at: string
  collections: Record<string, Array<Record<string, unknown>>>
}

function isBundle(v: unknown): v is Bundle {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as Bundle).type === 'nivaro-content-bundle' &&
    typeof (v as Bundle).collections === 'object'
  )
}

function assertSafeCollection(name: string): boolean {
  return (
    /^[a-zA-Z0-9_]+$/.test(name) && !name.startsWith('nivaro_') && !name.startsWith('directus_')
  )
}

/** Loose column equality — bundle values are JSON (strings/numbers/null),
 *  DB values may be Date/boolean/Buffer. */
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : Date.parse(String(a))
    const tb = b instanceof Date ? b.getTime() : Date.parse(String(b))
    return !Number.isNaN(ta) && ta === tb
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return (a === true || a === 1) === (b === true || b === 1)
  }
  return String(a) === String(b)
}

function rowChanged(bundleRow: Record<string, unknown>, dbRow: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(bundleRow)) {
    if (k === 'id') continue
    if (!(k in dbRow)) continue // column dropped on target — ignore
    if (!valueEquals(v, dbRow[k])) return true
  }
  return false
}

async function hasIdentityId(table: string): Promise<boolean> {
  const rows = (await db.raw(
    `SELECT 1 AS x FROM sys.identity_columns ic
     WHERE ic.object_id = OBJECT_ID(?) AND ic.name = 'id'`,
    [table]
  )) as Array<{ x: number }>
  return rows.length > 0
}

export async function promotionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // Build a bundle from this instance
  app.post('/export', async (req, reply) => {
    const body = req.body as { collections?: string[] }
    if (!Array.isArray(body.collections) || body.collections.length === 0) {
      return reply.code(400).send({ error: 'collections array is required' })
    }
    const bundle: Bundle = {
      type: 'nivaro-content-bundle',
      version: 1,
      exported_at: new Date().toISOString(),
      collections: {}
    }
    for (const name of body.collections) {
      if (!assertSafeCollection(name)) {
        return reply.code(400).send({ error: `Invalid collection: ${name}` })
      }
      const meta = await db('nivaro_collections').where({ collection: name }).first()
      if (!meta) return reply.code(404).send({ error: `Unknown collection: ${name}` })
      const [{ n }] = (await db(name).count({ n: '*' })) as Array<{ n: number | string }>
      if (Number(n) > MAX_ROWS) {
        return reply
          .code(400)
          .send({ error: `${name} has ${n} rows — bundles cap at ${MAX_ROWS} per collection` })
      }
      bundle.collections[name] = (await db(name).select('*')) as Array<Record<string, unknown>>
    }
    await logActivity({
      action: 'promotion-export',
      user: req.user?.id,
      comment: Object.keys(bundle.collections).join(', '),
      req
    })
    return reply.send({ data: bundle })
  })

  // Diff a bundle against this instance
  app.post('/preview', async (req, reply) => {
    const { bundle } = req.body as { bundle?: unknown }
    if (!isBundle(bundle)) return reply.code(400).send({ error: 'Not a nivaro-content-bundle' })

    const result: Record<
      string,
      { create: number; update: number; unchanged: number; missing_ids: number; error?: string }
    > = {}
    for (const [name, rows] of Object.entries(bundle.collections)) {
      if (!assertSafeCollection(name)) {
        result[name] = { create: 0, update: 0, unchanged: 0, missing_ids: 0, error: 'invalid name' }
        continue
      }
      const meta = await db('nivaro_collections').where({ collection: name }).first()
      if (!meta) {
        result[name] = {
          create: 0,
          update: 0,
          unchanged: 0,
          missing_ids: 0,
          error: 'collection does not exist on this instance'
        }
        continue
      }
      const stats = { create: 0, update: 0, unchanged: 0, missing_ids: 0 }
      const ids = rows.map((r) => r.id).filter((v) => v != null)
      stats.missing_ids = rows.length - ids.length
      const existing = new Map<string, Record<string, unknown>>()
      for (let i = 0; i < ids.length; i += 500) {
        const page = (await db(name).whereIn(
          'id',
          ids.slice(i, i + 500) as Array<string | number>
        )) as Array<Record<string, unknown>>
        for (const row of page) existing.set(String(row.id), row)
      }
      for (const row of rows) {
        if (row.id == null) continue
        const cur = existing.get(String(row.id))
        if (!cur) stats.create++
        else if (rowChanged(row, cur)) stats.update++
        else stats.unchanged++
      }
      result[name] = stats
    }
    return reply.send({ data: result })
  })

  // Upsert a bundle into this instance
  app.post('/apply', async (req, reply) => {
    const { bundle } = req.body as { bundle?: unknown }
    if (!isBundle(bundle)) return reply.code(400).send({ error: 'Not a nivaro-content-bundle' })

    const result: Record<
      string,
      { created: number; updated: number; skipped: number; errors: string[] }
    > = {}
    for (const [name, rows] of Object.entries(bundle.collections)) {
      const stats = { created: 0, updated: 0, skipped: 0, errors: [] as string[] }
      result[name] = stats
      if (!assertSafeCollection(name)) {
        stats.errors.push('invalid collection name')
        continue
      }
      const meta = await db('nivaro_collections').where({ collection: name }).first()
      if (!meta) {
        stats.errors.push('collection does not exist on this instance')
        continue
      }
      const identity = await hasIdentityId(name)
      for (const row of rows) {
        if (row.id == null) {
          stats.skipped++
          continue
        }
        try {
          const cur = (await db(name).where({ id: row.id as string | number }).first()) as
            | Record<string, unknown>
            | undefined
          if (cur) {
            if (!rowChanged(row, cur)) {
              stats.skipped++
              continue
            }
            const { id: _id, ...patch } = row
            // Only write columns that exist on the target
            const safePatch = Object.fromEntries(
              Object.entries(patch).filter(([k]) => k in cur)
            )
            await db(name).where({ id: row.id as string | number }).update(safePatch)
            stats.updated++
          } else {
            if (identity) {
              const cols = Object.keys(row)
              const colSql = cols.map((c) => `[${c}]`).join(', ')
              const params = cols.map(() => '?').join(', ')
              await db.raw(
                `SET IDENTITY_INSERT [${name}] ON;
                 INSERT INTO [${name}] (${colSql}) VALUES (${params});
                 SET IDENTITY_INSERT [${name}] OFF;`,
                cols.map((c) => row[c] as string | number | null)
              )
            } else {
              await db(name).insert(row)
            }
            stats.created++
          }
        } catch (err) {
          if (stats.errors.length < 10) {
            stats.errors.push(`id ${String(row.id)}: ${(err as Error).message.slice(0, 120)}`)
          }
        }
      }
    }
    await logActivity({
      action: 'promotion-apply',
      user: req.user?.id,
      comment: Object.entries(result)
        .map(([c, s]) => `${c}: +${s.created} ~${s.updated}`)
        .join('; ')
        .slice(0, 400),
      req
    })
    return reply.send({ data: result })
  })
}
