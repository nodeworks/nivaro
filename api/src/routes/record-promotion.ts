import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * One-record promotion (#695) — move a SINGLE record (optionally with its
 * O2M children) between instances, instead of a whole content bundle.
 *
 *   export  → {collection, record, children[], exported_at, source_version}
 *   preview → target-side diff: field-level old/new for an existing record,
 *             create/update counts per child relation
 *   apply   → create (IDENTITY_INSERT single-batch for explicit int ids),
 *             update, or upsert; children upserted by id
 *
 * Same trust posture as routes/promotion.ts: bundle keys are untrusted —
 * only plain identifiers that exist on the target schema reach SQL.
 */

const CHILD_ROW_CAP = 200

interface RecordBundle {
  type: 'nivaro-record-bundle'
  version: 1
  collection: string
  record: Record<string, unknown>
  children: Array<{
    collection: string
    fk_field: string
    rows: Array<Record<string, unknown>>
    truncated?: boolean
  }>
  exported_at: string
  source_version: string
}

function isRecordBundle(v: unknown): v is RecordBundle {
  const b = v as RecordBundle
  return (
    !!v &&
    typeof v === 'object' &&
    b.type === 'nivaro-record-bundle' &&
    typeof b.collection === 'string' &&
    !!b.record &&
    typeof b.record === 'object' &&
    Array.isArray(b.children ?? [])
  )
}

function safeCollection(name: string): boolean {
  return (
    /^[a-zA-Z0-9_]+$/.test(name) && !name.startsWith('nivaro_') && !name.startsWith('directus_')
  )
}

function safeColumn(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)
}

async function collectionRegistered(name: string): Promise<boolean> {
  return !!(await db('nivaro_collections').where({ collection: name }).first())
}

async function tableColumns(name: string): Promise<Set<string>> {
  const rows = (await db.raw(
    `SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE TABLE_NAME = ?`,
    [name]
  )) as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

async function hasIdentityId(table: string): Promise<boolean> {
  const rows = (await db.raw(
    `SELECT 1 AS x FROM sys.identity_columns ic
     WHERE ic.object_id = OBJECT_ID(?) AND ic.name = 'id'`,
    [table]
  )) as Array<{ x: number }>
  return rows.length > 0
}

/** Loose equality — bundle values are JSON, DB values may be Date/boolean. */
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

/** Insert a row keeping its explicit id — single-batch IDENTITY_INSERT
 *  (tedious runs raw SQL through sp_executesql, so SET IDENTITY_INSERT only
 *  survives within one batch — the services/trash.ts restore pattern). */
async function insertKeepingId(
  table: string,
  row: Record<string, unknown>,
  cols: string[],
  identity: boolean
): Promise<void> {
  if (identity) {
    const colSql = cols.map((c) => `[${c}]`).join(', ')
    const params = cols.map(() => '?').join(', ')
    await db.raw(
      `SET IDENTITY_INSERT [${table}] ON;
       INSERT INTO [${table}] (${colSql}) VALUES (${params});
       SET IDENTITY_INSERT [${table}] OFF;`,
      cols.map((c) => row[c] as string | number | null)
    )
  } else {
    await db(table).insert(Object.fromEntries(cols.map((k) => [k, row[k]])))
  }
}

export async function recordPromotionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // Build a single-record bundle from this instance
  app.post('/export', async (req, reply) => {
    const body = req.body as {
      collection?: string
      id?: string | number
      include_children?: boolean
    }
    const collection = String(body?.collection ?? '')
    if (!safeCollection(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    if (body?.id == null || body.id === '') {
      return reply.code(400).send({ error: 'id is required' })
    }
    if (!(await collectionRegistered(collection))) {
      return reply.code(404).send({ error: `Unknown collection: ${collection}` })
    }
    const record = (await db(collection)
      .where({ id: body.id as string | number })
      .first()) as Record<string, unknown> | undefined
    if (!record) return reply.code(404).send({ error: 'Record not found' })

    const children: RecordBundle['children'] = []
    if (body.include_children) {
      // O2M via the relation registry: every registered M2O into this
      // collection is a child set (junction legs included — that carries the
      // record's M2M links along too).
      const rels = (await db('nivaro_relations')
        .where({ one_collection: collection })
        .whereNotNull('many_collection')) as Array<{
        many_collection: string
        many_field: string | null
      }>
      const seen = new Set<string>()
      for (const rel of rels) {
        const child = String(rel.many_collection ?? '')
        const fk = String(rel.many_field ?? '')
        const key = `${child}.${fk}`
        if (!fk || !safeCollection(child) || !safeColumn(fk) || seen.has(key)) continue
        seen.add(key)
        try {
          const rows = (await db(child)
            .where(fk, body.id as string | number)
            .limit(CHILD_ROW_CAP + 1)) as Array<Record<string, unknown>>
          if (rows.length === 0) continue
          children.push({
            collection: child,
            fk_field: fk,
            rows: rows.slice(0, CHILD_ROW_CAP),
            ...(rows.length > CHILD_ROW_CAP ? { truncated: true } : {})
          })
        } catch {
          // A relation row can outlive the physical table — skip, never 500
        }
      }
    }

    const bundle: RecordBundle = {
      type: 'nivaro-record-bundle',
      version: 1,
      collection,
      record,
      children,
      exported_at: new Date().toISOString(),
      source_version: NIVARO_VERSION
    }
    await logActivity({
      action: 'record-promotion-export',
      user: req.user?.id,
      collection,
      item: String(body.id),
      comment:
        `children: ${children.map((c) => `${c.collection}(${c.rows.length})`).join(', ') || 'none'}`.slice(
          0,
          400
        ),
      req
    })
    return reply.send({ data: bundle })
  })

  // Target-side diff of an uploaded bundle
  app.post('/preview', async (req, reply) => {
    const { bundle } = req.body as { bundle?: unknown }
    if (!isRecordBundle(bundle)) {
      return reply.code(400).send({ error: 'Not a nivaro-record-bundle' })
    }
    if (!safeCollection(bundle.collection)) {
      return reply.code(400).send({ error: 'Invalid collection in bundle' })
    }
    if (!(await collectionRegistered(bundle.collection))) {
      return reply
        .code(400)
        .send({ error: `Collection "${bundle.collection}" does not exist on this instance` })
    }
    if (bundle.record.id == null) {
      return reply.code(400).send({ error: 'Bundle record has no id' })
    }

    const cols = await tableColumns(bundle.collection)
    const unknownColumns = Object.keys(bundle.record).filter((k) => !safeColumn(k) || !cols.has(k))
    const cur = (await db(bundle.collection)
      .where({ id: bundle.record.id as string | number })
      .first()) as Record<string, unknown> | undefined

    const changes: Array<{ field: string; current: unknown; incoming: unknown }> = []
    if (cur) {
      for (const [k, v] of Object.entries(bundle.record)) {
        if (k === 'id' || !safeColumn(k) || !cols.has(k)) continue
        if (!valueEquals(v, cur[k])) changes.push({ field: k, current: cur[k], incoming: v })
      }
    }

    const children: Array<{
      collection: string
      create: number
      update: number
      unchanged: number
      error?: string
    }> = []
    for (const child of bundle.children ?? []) {
      const name = String(child.collection ?? '')
      const stats = {
        collection: name,
        create: 0,
        update: 0,
        unchanged: 0
      } as (typeof children)[number]
      children.push(stats)
      if (!safeCollection(name) || !(await collectionRegistered(name))) {
        stats.error = 'collection does not exist on this instance'
        continue
      }
      const ids = (child.rows ?? []).map((r) => r.id).filter((v) => v != null)
      const existing = new Map<string, Record<string, unknown>>()
      for (let i = 0; i < ids.length; i += 500) {
        const page = (await db(name).whereIn(
          'id',
          ids.slice(i, i + 500) as Array<string | number>
        )) as Array<Record<string, unknown>>
        for (const row of page) existing.set(String(row.id), row)
      }
      for (const row of child.rows ?? []) {
        if (row.id == null) continue
        const curRow = existing.get(String(row.id))
        if (!curRow) stats.create++
        else {
          const changed = Object.entries(row).some(
            ([k, v]) => k !== 'id' && k in curRow && !valueEquals(v, curRow[k])
          )
          if (changed) stats.update++
          else stats.unchanged++
        }
      }
    }

    return reply.send({
      data: {
        collection: bundle.collection,
        id: bundle.record.id,
        exists: !!cur,
        changes,
        unknown_columns: unknownColumns,
        children
      }
    })
  })

  // Apply a bundle to this instance
  app.post('/apply', async (req, reply) => {
    const { bundle, mode } = req.body as { bundle?: unknown; mode?: string }
    if (!isRecordBundle(bundle)) {
      return reply.code(400).send({ error: 'Not a nivaro-record-bundle' })
    }
    if (!['create', 'update', 'upsert'].includes(mode ?? '')) {
      return reply.code(400).send({ error: "mode must be 'create', 'update' or 'upsert'" })
    }
    if (!safeCollection(bundle.collection)) {
      return reply.code(400).send({ error: 'Invalid collection in bundle' })
    }
    if (!(await collectionRegistered(bundle.collection))) {
      return reply
        .code(400)
        .send({ error: `Collection "${bundle.collection}" does not exist on this instance` })
    }
    if (bundle.record.id == null) {
      return reply.code(400).send({ error: 'Bundle record has no id' })
    }

    const cols = await tableColumns(bundle.collection)
    const safeCols = Object.keys(bundle.record).filter((k) => safeColumn(k) && cols.has(k))
    const cur = (await db(bundle.collection)
      .where({ id: bundle.record.id as string | number })
      .first()) as Record<string, unknown> | undefined

    if (mode === 'create' && cur) {
      return reply.code(409).send({ error: 'Record already exists on this instance' })
    }
    if (mode === 'update' && !cur) {
      return reply.code(404).send({ error: 'Record does not exist on this instance' })
    }

    const result = {
      record: 'unchanged' as 'created' | 'updated' | 'unchanged',
      children: [] as Array<{
        collection: string
        created: number
        updated: number
        skipped: number
        errors: string[]
      }>
    }

    if (cur) {
      const patch = Object.fromEntries(
        safeCols
          .filter((k) => k !== 'id' && !valueEquals(bundle.record[k], cur[k]))
          .map((k) => [k, bundle.record[k]])
      )
      if (Object.keys(patch).length > 0) {
        await db(bundle.collection)
          .where({ id: bundle.record.id as string | number })
          .update(patch)
        result.record = 'updated'
      }
    } else {
      await insertKeepingId(
        bundle.collection,
        bundle.record,
        safeCols,
        await hasIdentityId(bundle.collection)
      )
      result.record = 'created'
    }

    for (const child of bundle.children ?? []) {
      const name = String(child.collection ?? '')
      const stats = { collection: name, created: 0, updated: 0, skipped: 0, errors: [] as string[] }
      result.children.push(stats)
      if (!safeCollection(name) || !(await collectionRegistered(name))) {
        stats.errors.push('collection does not exist on this instance')
        continue
      }
      const childCols = await tableColumns(name)
      const identity = await hasIdentityId(name)
      for (const row of child.rows ?? []) {
        if (row.id == null) {
          stats.skipped++
          continue
        }
        try {
          const rowCols = Object.keys(row).filter((k) => safeColumn(k) && childCols.has(k))
          const curRow = (await db(name)
            .where({ id: row.id as string | number })
            .first()) as Record<string, unknown> | undefined
          if (curRow) {
            const patch = Object.fromEntries(
              rowCols
                .filter((k) => k !== 'id' && !valueEquals(row[k], curRow[k]))
                .map((k) => [k, row[k]])
            )
            if (Object.keys(patch).length === 0) {
              stats.skipped++
              continue
            }
            await db(name)
              .where({ id: row.id as string | number })
              .update(patch)
            stats.updated++
          } else {
            await insertKeepingId(name, row, rowCols, identity)
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
      action: 'record-promotion-apply',
      user: req.user?.id,
      collection: bundle.collection,
      item: String(bundle.record.id),
      comment: `${mode}: record ${result.record}; ${result.children
        .map((c) => `${c.collection}: +${c.created} ~${c.updated}`)
        .join('; ')}`.slice(0, 400),
      req
    })
    return reply.send({ data: result })
  })
}
