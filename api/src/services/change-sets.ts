import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { clearMetadataCache } from '../services/collections.js'
import { buildImpactReport, type ImpactReport } from './schema-impact.js'

/**
 * Schema change sets (#653) — batch schema edits reviewed before applying.
 *
 * plan  → validates every operation against the LIVE schema and returns a
 *         per-op impact report (drop/rename ops run the same schema-impact
 *         scan the TableEditor delete confirm uses). Nothing is persisted —
 *         a change set is a reviewed intention, not a stored artifact.
 * apply → re-validates, then executes ops SEQUENTIALLY through the exact
 *         same knex schema calls routes/data-model.ts performs, stopping at
 *         the first failure. Schema statements are not transactional across
 *         operations on this stack, so there is NO rollback — the report
 *         says honestly which ops landed.
 */

export type ChangeOp =
  | { op: 'add_collection'; collection: string }
  | {
      op: 'add_column'
      collection: string
      field: string
      type: string
      options?: {
        nullable?: boolean
        unique?: boolean
        default_value?: string | number | boolean | null
        max_length?: number
        precision?: number
        scale?: number
      }
    }
  | { op: 'drop_column'; collection: string; field: string }
  | { op: 'rename_column'; collection: string; field: string; new_name: string }

export interface OpValidation {
  op: ChangeOp
  /** ok = safe; warning = will apply but references exist; blocked = will not apply. */
  status: 'ok' | 'warning' | 'blocked'
  messages: string[]
  /** Config surfaces referencing the field (drop/rename ops only). */
  impact: ImpactReport | null
}

export interface ApplyOpResult {
  op: ChangeOp
  status: 'applied' | 'failed' | 'not_attempted'
  error?: string
}

// Same identifier rules as routes/data-model.ts
const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const COLUMN_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

// Same physical column types data-model's POST /tables/:table/columns accepts
export const COLUMN_TYPES = [
  'string',
  'text',
  'integer',
  'bigInteger',
  'boolean',
  'decimal',
  'float',
  'date',
  'datetime',
  'uuid'
] as const

function isSystemTable(name: string): boolean {
  return name.toLowerCase().startsWith('nivaro_') || name.toLowerCase().startsWith('directus_')
}

async function tableExists(name: string): Promise<boolean> {
  const rows = rawRows<{ cnt: number }>(
    await db.raw(
      `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'`,
      [name]
    )
  )
  return Number(rows[0]?.cnt ?? 0) > 0
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = rawRows<{ cnt: number }>(
    await db.raw(
      `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    )
  )
  return Number(rows[0]?.cnt ?? 0) > 0
}

async function isPrimaryKeyColumn(table: string, column: string): Promise<boolean> {
  const rows = rawRows<{ cnt: number }>(
    await db.raw(
      `SELECT COUNT(*) AS cnt
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_NAME = kcu.TABLE_NAME
       WHERE tc.TABLE_NAME = ? AND kcu.COLUMN_NAME = ? AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`,
      [table, column]
    )
  )
  return Number(rows[0]?.cnt ?? 0) > 0
}

/** Structural parse of an untrusted operations array — bad shapes throw. */
export function parseOperations(raw: unknown): ChangeOp[] {
  if (!Array.isArray(raw)) throw new Error('operations must be an array')
  if (raw.length === 0) throw new Error('operations is empty')
  if (raw.length > 50) throw new Error('operations cap at 50 per change set')
  const ops: ChangeOp[] = []
  for (const [i, entry] of raw.entries()) {
    const e = entry as Record<string, unknown>
    const op = String(e?.op ?? '')
    const collection = String(e?.collection ?? '')
    const at = `operation ${i + 1}`
    if (!['add_collection', 'add_column', 'drop_column', 'rename_column'].includes(op)) {
      throw new Error(`${at}: unknown op "${op}"`)
    }
    if (!collection) throw new Error(`${at}: collection is required`)
    if (op === 'add_collection') {
      ops.push({ op, collection })
      continue
    }
    const field = String(e?.field ?? '')
    if (!field) throw new Error(`${at}: field is required`)
    if (op === 'add_column') {
      const type = String(e?.type ?? '')
      if (!type) throw new Error(`${at}: type is required`)
      ops.push({
        op,
        collection,
        field,
        type,
        options:
          e?.options && typeof e.options === 'object'
            ? (e.options as Extract<ChangeOp, { op: 'add_column' }>['options'])
            : undefined
      })
    } else if (op === 'drop_column') {
      ops.push({ op, collection, field })
    } else {
      const newName = String(e?.new_name ?? '')
      if (!newName) throw new Error(`${at}: new_name is required`)
      ops.push({ op: 'rename_column', collection, field, new_name: newName })
    }
  }
  return ops
}

/**
 * Validate one op against the live schema, ALSO accounting for what earlier
 * ops in the same set will have done by the time this one runs (a set that
 * adds a collection then adds columns to it must plan clean).
 */
async function validateOp(
  op: ChangeOp,
  pendingTables: Set<string>,
  pendingColumns: Set<string>, // "table.column" earlier ops add
  pendingDrops: Set<string>, // "table.column" earlier ops drop/rename away
  withImpact: boolean
): Promise<OpValidation> {
  const messages: string[] = []
  let blocked = false
  let impact: ImpactReport | null = null

  const block = (m: string) => {
    blocked = true
    messages.push(m)
  }

  if (!TABLE_NAME_RE.test(op.collection) || op.collection.length > 128) {
    block('Invalid collection name')
  } else if (isSystemTable(op.collection)) {
    block('System tables cannot be modified by a change set')
  }

  const tableIsLive = blocked ? false : await tableExists(op.collection)
  const tablePresent = tableIsLive || pendingTables.has(op.collection)

  const colKey = (f: string) => `${op.collection}.${f}`
  const colPresent = async (f: string) => {
    if (pendingDrops.has(colKey(f))) return false
    if (pendingColumns.has(colKey(f))) return true
    return tableIsLive ? columnExists(op.collection, f) : false
  }

  switch (op.op) {
    case 'add_collection': {
      if (!blocked && tablePresent) block(`Table "${op.collection}" already exists`)
      if (!blocked) messages.push(`Creates table "${op.collection}" (id + created_at)`)
      break
    }
    case 'add_column': {
      if (!COLUMN_NAME_RE.test(op.field) || op.field.length > 128) block('Invalid column name')
      if (!(COLUMN_TYPES as readonly string[]).includes(op.type)) {
        block(`Invalid type "${op.type}" — must be one of: ${COLUMN_TYPES.join(', ')}`)
      }
      if (!blocked && !tablePresent) block(`Table "${op.collection}" does not exist`)
      if (!blocked && (await colPresent(op.field))) {
        block(`Column "${op.field}" already exists on "${op.collection}"`)
      }
      if (!blocked) messages.push(`Adds ${op.type} column "${op.field}"`)
      break
    }
    case 'drop_column': {
      if (!COLUMN_NAME_RE.test(op.field)) block('Invalid column name')
      if (!blocked && !tablePresent) block(`Table "${op.collection}" does not exist`)
      if (!blocked && !(await colPresent(op.field))) {
        block(`Column "${op.field}" not found on "${op.collection}"`)
      }
      if (!blocked && tableIsLive && (await isPrimaryKeyColumn(op.collection, op.field))) {
        block('Cannot drop a primary key column')
      }
      if (!blocked && withImpact) {
        try {
          impact = await buildImpactReport(op.collection, op.field)
          if (impact.total > 0) {
            messages.push(
              `${impact.total} config reference(s) will break: ${impact.surfaces
                .filter((s) => s.hits.length > 0)
                .map((s) => `${s.surface} (${s.hits.length})`)
                .join(', ')}`
            )
          }
        } catch {
          impact = null
        }
      }
      if (!blocked && messages.length === 0) messages.push('No config references found')
      break
    }
    case 'rename_column': {
      if (!COLUMN_NAME_RE.test(op.field)) block('Invalid column name')
      if (!COLUMN_NAME_RE.test(op.new_name) || op.new_name.length > 128) {
        block('Invalid new name')
      }
      if (!blocked && op.new_name === op.field) block('New name matches the current name')
      if (!blocked && !tablePresent) block(`Table "${op.collection}" does not exist`)
      if (!blocked && !(await colPresent(op.field))) {
        block(`Column "${op.field}" not found on "${op.collection}"`)
      }
      if (!blocked && (await colPresent(op.new_name))) {
        block(`Column "${op.new_name}" already exists on "${op.collection}"`)
      }
      if (!blocked && withImpact) {
        try {
          impact = await buildImpactReport(op.collection, op.field)
          if (impact.total > 0) {
            messages.push(
              `${impact.total} config reference(s) still point at the old name after rename (direct relation/layout config is carried over automatically): ${impact.surfaces
                .filter((s) => s.hits.length > 0)
                .map((s) => `${s.surface} (${s.hits.length})`)
                .join(', ')}`
            )
          }
        } catch {
          impact = null
        }
      }
      if (!blocked && messages.length === 0) {
        messages.push(`Renames "${op.field}" → "${op.new_name}"`)
      }
      break
    }
  }

  // Track this op's own effect for later ops in the set
  if (!blocked) {
    if (op.op === 'add_collection') pendingTables.add(op.collection)
    if (op.op === 'add_column') pendingColumns.add(colKey(op.field))
    if (op.op === 'drop_column') pendingDrops.add(colKey(op.field))
    if (op.op === 'rename_column') {
      pendingDrops.add(colKey(op.field))
      pendingColumns.add(colKey(op.new_name))
    }
  }

  return {
    op,
    status: blocked ? 'blocked' : impact && impact.total > 0 ? 'warning' : 'ok',
    messages,
    impact
  }
}

export async function planChangeSet(
  ops: ChangeOp[],
  opts: { withImpact?: boolean } = {}
): Promise<OpValidation[]> {
  const pendingTables = new Set<string>()
  const pendingColumns = new Set<string>()
  const pendingDrops = new Set<string>()
  const out: OpValidation[] = []
  for (const op of ops) {
    out.push(
      await validateOp(op, pendingTables, pendingColumns, pendingDrops, opts.withImpact !== false)
    )
  }
  return out
}

/** Execute ONE op — the exact schema calls routes/data-model.ts performs. */
async function executeOp(op: ChangeOp): Promise<void> {
  switch (op.op) {
    case 'add_collection': {
      // Mirrors POST /data-model/tables
      await db.schema.createTable(op.collection, (t) => {
        t.increments('id').primary()
        t.timestamp('created_at').defaultTo(db.fn.now())
      })
      return
    }
    case 'add_column': {
      // Mirrors POST /data-model/tables/:table/columns
      const o = op.options ?? {}
      await db.schema.table(op.collection, (t) => {
        let col: ReturnType<typeof t.string>
        switch (op.type) {
          case 'string':
            col = t.string(op.field, o.max_length ?? 255)
            break
          case 'text':
            col = t.text(op.field)
            break
          case 'integer':
            col = t.integer(op.field)
            break
          case 'bigInteger':
            col = t.bigInteger(op.field)
            break
          case 'boolean':
            col = t.boolean(op.field)
            break
          case 'decimal':
            col = t.decimal(op.field, o.precision ?? 10, o.scale ?? 2)
            break
          case 'float':
            col = t.float(op.field, o.precision ?? 8)
            break
          case 'date':
            col = t.date(op.field)
            break
          case 'datetime':
            col = t.datetime(op.field)
            break
          case 'uuid':
            col = t.uuid(op.field)
            break
          default:
            col = t.string(op.field, 255)
        }
        if (o.nullable !== false) col.nullable()
        else col.notNullable()
        if (o.unique) col.unique()
        if (o.default_value !== undefined && o.default_value !== null) {
          col.defaultTo(o.default_value)
        }
      })
      return
    }
    case 'drop_column': {
      // Mirrors DELETE /data-model/tables/:table/columns/:column
      await db.schema.table(op.collection, (t) => {
        t.dropColumn(op.field)
      })
      return
    }
    case 'rename_column': {
      // Mirrors POST /data-model/collections/:c/fields/:f/rename — the column
      // rename plus the DIRECT render/relation config carried along.
      await db.transaction(async (trx) => {
        await trx.raw(`EXEC sp_rename ?, ?, 'COLUMN'`, [
          `${op.collection}.${op.field}`,
          op.new_name
        ])
        await trx('nivaro_fields')
          .where({ collection: op.collection, field: op.field })
          .update({ field: op.new_name })
        await trx('nivaro_relations')
          .where({ many_collection: op.collection, many_field: op.field })
          .update({ many_field: op.new_name })
        await trx('nivaro_relations')
          .where({ one_collection: op.collection, one_field: op.field })
          .update({ one_field: op.new_name })
        await trx('nivaro_relations')
          .where({ many_collection: op.collection, junction_field: op.field })
          .update({ junction_field: op.new_name })
        const layoutIds = (await trx('nivaro_collection_layouts')
          .where({ collection: op.collection })
          .pluck('id')) as number[]
        if (layoutIds.length > 0) {
          await trx('nivaro_layout_field_assignments')
            .whereIn('layout_id', layoutIds)
            .where({ field: op.field })
            .update({ field: op.new_name })
        }
      })
      return
    }
  }
}

export function describeOp(op: ChangeOp): string {
  switch (op.op) {
    case 'add_collection':
      return `add_collection ${op.collection}`
    case 'add_column':
      return `add_column ${op.collection}.${op.field} (${op.type})`
    case 'drop_column':
      return `drop_column ${op.collection}.${op.field}`
    case 'rename_column':
      return `rename_column ${op.collection}.${op.field} → ${op.new_name}`
  }
}

export interface ApplyReport {
  applied: number
  failed: number
  not_attempted: number
  results: ApplyOpResult[]
}

/**
 * Execute a validated set sequentially, stopping at the first failure.
 * Caller is responsible for having re-validated (planChangeSet) first.
 */
export async function applyChangeSet(ops: ChangeOp[]): Promise<ApplyReport> {
  const results: ApplyOpResult[] = ops.map((op) => ({ op, status: 'not_attempted' as const }))
  let applied = 0
  let failed = 0
  for (let i = 0; i < ops.length; i++) {
    try {
      await executeOp(ops[i])
      results[i] = { op: ops[i], status: 'applied' }
      applied++
    } catch (err) {
      results[i] = {
        op: ops[i],
        status: 'failed',
        error: err instanceof Error ? err.message.slice(0, 300) : String(err)
      }
      failed++
      break // no rollback — schema ops aren't transactional across statements
    }
  }
  // Change-set routes don't match the central data-model cache-bust hook —
  // clear explicitly so forms/pickers see the new shape without a restart.
  try {
    clearMetadataCache()
  } catch {
    /* cache bust is best-effort */
  }
  return { applied, failed, not_attempted: ops.length - applied - failed, results }
}
