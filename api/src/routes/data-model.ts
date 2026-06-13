import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TableRow {
  TABLE_NAME: string
  TABLE_SCHEMA: string
  column_count: number
}

interface ColumnRow {
  COLUMN_NAME: string
  DATA_TYPE: string
  CHARACTER_MAXIMUM_LENGTH: number | null
  IS_NULLABLE: string
  COLUMN_DEFAULT: string | null
  ORDINAL_POSITION: number
}

interface PKRow {
  COLUMN_NAME: string
}

interface FKRow {
  constraint_name: string
  column_name: string
  referenced_table: string
  referenced_column: string
}

interface CMSCollection {
  collection: string
  display_name: string | null
  icon: string | null
  note: string | null
  hidden: boolean
  singleton: boolean
}

interface CMSField {
  id: number
  collection: string
  field: string
  type: string
  interface: string | null
  display: string | null
  display_options: string | null
  options: string | null
  special: string | null
  note: string | null
  hidden: boolean | number
  readonly: boolean | number
  required: boolean | number
  sort: number | null
  group: string | null
  computed_formula: string | null
  computed_type: 'read' | 'write' | null
  computed_store: boolean | number
}

interface CMSRelation {
  id: number
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  one_collection_field: string | null
  one_allowed_collections: string | null
  junction_field: string | null
  sort_field: string | null
  one_deselect_action: string
}

type ColumnType =
  | 'string'
  | 'text'
  | 'integer'
  | 'bigInteger'
  | 'boolean'
  | 'decimal'
  | 'float'
  | 'date'
  | 'datetime'
  | 'uuid'

interface AddColumnBody {
  name: string
  type: ColumnType
  nullable?: boolean
  unique?: boolean
  default_value?: string | number | boolean | null
  max_length?: number
  precision?: number
  scale?: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const COLUMN_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function isSystemTable(name: string): boolean {
  return name.toLowerCase().startsWith('nivaro_')
}

// db.raw() returns different shapes per dialect:
//   pg:     { rows: T[], rowCount, ... }
//   mssql:  T[]  (rows directly)
//   mysql2: [T[], FieldDef[]]
function rawRows<T>(result: unknown): T[] {
  if (!result) return []
  if (!Array.isArray(result) && typeof result === 'object' && 'rows' in result) {
    return ((result as { rows: T[] }).rows) ?? []
  }
  if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
    return result[0] as T[]
  }
  if (Array.isArray(result)) return result as T[]
  return []
}

async function tableExists(name: string): Promise<boolean> {
  const res = await db.raw(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN ('pg_catalog', 'information_schema')`,
    [name]
  )
  const rows = rawRows<{ cnt: number }>(res)
  return Number(rows[0]?.cnt ?? 0) > 0
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const res = await db.raw(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  )
  const rows = rawRows<{ cnt: number }>(res)
  return Number(rows[0]?.cnt ?? 0) > 0
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function dataModelRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // ─── GET / — list all tables ──────────────────────────────────────────────

  app.get('/', async (_req, reply) => {
    try {
      const tables = rawRows<TableRow>(await db.raw(`
        SELECT
          t.TABLE_NAME AS "TABLE_NAME",
          t.TABLE_SCHEMA AS "TABLE_SCHEMA",
          (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_NAME = t.TABLE_NAME AND c.TABLE_SCHEMA = t.TABLE_SCHEMA) AS "column_count"
        FROM INFORMATION_SCHEMA.TABLES t
        WHERE t.TABLE_TYPE = 'BASE TABLE'
          AND t.TABLE_SCHEMA NOT IN ('pg_catalog', 'information_schema')
        ORDER BY t.TABLE_NAME
      `))

      const collections = await db<CMSCollection>('nivaro_collections').select(
        'collection',
        'display_name',
        'icon',
        'color',
        'group',
        'sort'
      )
      const collectionMap = new Map(collections.map((c) => [c.collection, c]))

      const data = tables.map((t) => {
        const meta = collectionMap.get(t.TABLE_NAME)
        return {
          name: t.TABLE_NAME,
          schema: t.TABLE_SCHEMA,
          registered: !!meta,
          display_name: meta?.display_name ?? null,
          icon: meta?.icon ?? null,
          color: meta?.color ?? null,
          group: meta?.group ?? null,
          sort: meta?.sort ?? null,
          column_count: Number(t.column_count)
        }
      })

      return reply.send({ data })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── GET /:table — single table detail ───────────────────────────────────

  app.get('/:table', async (req, reply) => {
    const { table } = req.params as { table: string }

    try {
      if (!(await tableExists(table))) {
        return reply.code(404).send({ error: `Table "${table}" not found` })
      }

      const columnRows = rawRows<ColumnRow>(await db.raw(
        `SELECT
           COLUMN_NAME AS "COLUMN_NAME",
           DATA_TYPE AS "DATA_TYPE",
           CHARACTER_MAXIMUM_LENGTH AS "CHARACTER_MAXIMUM_LENGTH",
           IS_NULLABLE AS "IS_NULLABLE",
           COLUMN_DEFAULT AS "COLUMN_DEFAULT",
           ORDINAL_POSITION AS "ORDINAL_POSITION"
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [table]
      ))

      const pkRows = rawRows<PKRow>(await db.raw(
        `SELECT kcu.COLUMN_NAME AS "COLUMN_NAME"
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
           AND tc.TABLE_NAME = kcu.TABLE_NAME
         WHERE tc.TABLE_NAME = ?
           AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`,
        [table]
      ))
      const pkColumns = new Set(pkRows.map((r) => r.COLUMN_NAME))

      const fields = await db<CMSField>('nivaro_fields').where({ collection: table })
      const fieldMap = new Map(fields.map((f) => [f.field, f]))

      // sys.foreign_keys is MSSQL-only; returns empty on pg
      const fkRows = await db.raw(
        `SELECT
          fk.name AS constraint_name,
          COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name,
          OBJECT_NAME(fkc.referenced_object_id) AS referenced_table,
          COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS referenced_column
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        WHERE OBJECT_NAME(fkc.parent_object_id) = ?`,
        [table]
      ).then((r) => rawRows<FKRow>(r)).catch(() => [] as FKRow[])

      const collectionMeta = await db<CMSCollection>('nivaro_collections')
        .where({ collection: table })
        .first()

      const buildFieldMeta = (fm: CMSField) => ({
        id: fm.id,
        type: fm.type,
        interface: fm.interface,
        display: fm.display,
        display_options: fm.display_options,
        options: fm.options,
        special: fm.special,
        note: fm.note,
        hidden: Boolean(fm.hidden),
        readonly: Boolean(fm.readonly),
        required: Boolean(fm.required),
        sort: fm.sort,
        group: fm.group,
        computed_formula: fm.computed_formula ?? null,
        computed_type: fm.computed_type ?? null,
        computed_store: Boolean(fm.computed_store)
      })

      const dbColumnNames = new Set(columnRows.map((c) => c.COLUMN_NAME))

      const columns = columnRows.map((col) => {
        const fm = fieldMap.get(col.COLUMN_NAME)
        return {
          name: col.COLUMN_NAME,
          data_type: col.DATA_TYPE,
          max_length: col.CHARACTER_MAXIMUM_LENGTH,
          nullable: col.IS_NULLABLE === 'YES',
          default_value: col.COLUMN_DEFAULT,
          is_primary_key: pkColumns.has(col.COLUMN_NAME),
          ordinal_position: col.ORDINAL_POSITION,
          is_virtual: false,
          field_meta: fm ? buildFieldMeta(fm) : null
        }
      })

      // Append virtual computed fields — exist only in nivaro_fields, no DB column
      for (const fm of fields) {
        if (fm.computed_formula && !dbColumnNames.has(fm.field)) {
          columns.push({
            name: fm.field,
            data_type: 'virtual',
            max_length: null,
            nullable: true,
            default_value: null,
            is_primary_key: false,
            ordinal_position: 9999,
            is_virtual: true,
            field_meta: buildFieldMeta(fm)
          })
        }
      }

      return reply.send({
        data: {
          name: table,
          registered: !!collectionMeta,
          collection_meta: collectionMeta
            ? {
                display_name: collectionMeta.display_name,
                icon: collectionMeta.icon,
                note: collectionMeta.note
              }
            : null,
          columns,
          relations: fkRows
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── POST /sync-field-types — re-sync nivaro_fields.type from MSSQL column types ──

  app.post('/sync-field-types', { preHandler: requireAdmin }, async (_req, reply) => {
    const SQL_TO_ABSTRACT: Record<string, (l: number | null) => string> = {
      nvarchar: (l) => (l === -1 ? 'text' : 'string'),
      varchar: (l) => (l === -1 ? 'text' : 'string'),
      char: () => 'string', nchar: () => 'string',
      ntext: () => 'text', text: () => 'text',
      int: () => 'integer', bigint: () => 'bigInteger',
      smallint: () => 'integer', tinyint: () => 'boolean', bit: () => 'boolean',
      decimal: () => 'decimal', numeric: () => 'decimal',
      float: () => 'float', real: () => 'float',
      money: () => 'decimal', smallmoney: () => 'decimal',
      date: () => 'date',
      datetime: () => 'datetime', datetime2: () => 'datetime', smalldatetime: () => 'datetime',
      time: () => 'time', timestamp: () => 'datetime',
      uniqueidentifier: () => 'uuid',
    }
    const SKIP_TYPES = new Set(['alias', 'group-detail', 'group-raw', 'presentation-divider'])

    const colRows = (await db('INFORMATION_SCHEMA.COLUMNS')
      .where('TABLE_SCHEMA', 'dbo')
      .select('TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'CHARACTER_MAXIMUM_LENGTH')) as Array<{
      TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string; CHARACTER_MAXIMUM_LENGTH: number | null
    }>

    const lookup = new Map<string, string>()
    for (const row of colRows) {
      const mapper = SQL_TO_ABSTRACT[row.DATA_TYPE.toLowerCase()]
      if (mapper) lookup.set(`${row.TABLE_NAME}.${row.COLUMN_NAME}`, mapper(row.CHARACTER_MAXIMUM_LENGTH))
    }

    const fields = (await db('nivaro_fields').select('id', 'collection', 'field', 'type')) as Array<{ id: number; collection: string; field: string; type: string }>

    let updated = 0
    const changes: Array<{ collection: string; field: string; from: string; to: string }> = []
    for (const f of fields) {
      if (SKIP_TYPES.has(f.type)) continue
      const abstractType = lookup.get(`${f.collection}.${f.field}`)
      if (abstractType && abstractType !== f.type) {
        await db('nivaro_fields').where({ id: f.id }).update({ type: abstractType })
        changes.push({ collection: f.collection, field: f.field, from: f.type, to: abstractType })
        updated++
      }
    }

    return reply.send({ updated, total: fields.length, changes })
  })

  // ─── POST /tables — create a new table ───────────────────────────────────

  app.post('/tables', async (req, reply) => {
    const body = req.body as { name: string; primaryKey?: string }

    if (!body.name) return reply.code(400).send({ error: 'name is required' })
    if (!TABLE_NAME_RE.test(body.name)) {
      return reply.code(400).send({
        error:
          'Table name must start with a letter or underscore and contain only letters, numbers, and underscores'
      })
    }
    if (body.name.length > 128) {
      return reply.code(400).send({ error: 'Table name must be 128 characters or fewer' })
    }

    try {
      if (await tableExists(body.name)) {
        return reply.code(409).send({ error: `Table "${body.name}" already exists` })
      }

      const pkName = body.primaryKey ?? 'id'
      await db.schema.createTable(body.name, (t) => {
        t.increments(pkName).primary()
        t.timestamp('created_at').defaultTo(db.fn.now())
      })

      await logActivity({
        action: 'create',
        collection: 'schema',
        item: body.name,
        user: req.user?.id,
        req,
        comment: 'create table'
      })
      return reply.code(201).send({
        data: {
          name: body.name,
          schema: 'dbo',
          registered: false,
          display_name: null,
          icon: null,
          column_count: 2
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── DELETE /tables/:table — drop a table ─────────────────────────────────

  app.delete('/tables/:table', async (req, reply) => {
    const { table } = req.params as { table: string }

    if (isSystemTable(table)) {
      return reply.code(403).send({ error: 'Cannot drop CMS system tables' })
    }

    try {
      if (!(await tableExists(table))) {
        return reply.code(404).send({ error: `Table "${table}" not found` })
      }

      await db.schema.dropTableIfExists(table)
      await db('nivaro_collections').where({ collection: table }).delete()
      await db('nivaro_fields').where({ collection: table }).delete()
      await db('nivaro_relations')
        .where({ many_collection: table })
        .orWhere({ one_collection: table })
        .delete()

      await logActivity({
        action: 'delete',
        collection: 'schema',
        item: table,
        user: req.user?.id,
        req,
        comment: 'drop table'
      })
      return reply.code(204).send()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── POST /tables/:table/columns — add a column ───────────────────────────

  app.post('/tables/:table/columns', async (req, reply) => {
    const { table } = req.params as { table: string }
    const body = req.body as AddColumnBody

    if (!body.name) return reply.code(400).send({ error: 'name is required' })
    if (!COLUMN_NAME_RE.test(body.name)) {
      return reply.code(400).send({ error: 'Invalid column name' })
    }
    if (!body.type) return reply.code(400).send({ error: 'type is required' })

    const validTypes: ColumnType[] = [
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
    ]
    if (!validTypes.includes(body.type)) {
      return reply.code(400).send({
        error: `Invalid type. Must be one of: ${validTypes.join(', ')}`
      })
    }

    try {
      if (!(await tableExists(table))) {
        return reply.code(404).send({ error: `Table "${table}" not found` })
      }

      if (await columnExists(table, body.name)) {
        return reply.code(409).send({
          error: `Column "${body.name}" already exists on table "${table}"`
        })
      }

      await db.schema.table(table, (t) => {
        let col: ReturnType<typeof t.string>
        switch (body.type) {
          case 'string':
            col = t.string(body.name, body.max_length ?? 255)
            break
          case 'text':
            col = t.text(body.name)
            break
          case 'integer':
            col = t.integer(body.name)
            break
          case 'bigInteger':
            col = t.bigInteger(body.name)
            break
          case 'boolean':
            col = t.boolean(body.name)
            break
          case 'decimal':
            col = t.decimal(body.name, body.precision ?? 10, body.scale ?? 2)
            break
          case 'float':
            col = t.float(body.name, body.precision ?? 8)
            break
          case 'date':
            col = t.date(body.name)
            break
          case 'datetime':
            col = t.datetime(body.name)
            break
          case 'uuid':
            col = t.uuid(body.name)
            break
          default:
            col = t.string(body.name, 255)
        }

        if (body.nullable !== false) {
          col.nullable()
        } else {
          col.notNullable()
        }

        if (body.unique) col.unique()

        if (body.default_value !== undefined && body.default_value !== null) {
          col.defaultTo(body.default_value)
        }
      })

      await logActivity({
        action: 'create',
        collection: 'schema',
        item: `${table}.${body.name}`,
        user: req.user?.id,
        req,
        comment: 'add column'
      })
      return reply.code(201).send({ data: { table, column: body.name, type: body.type } })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── DELETE /tables/:table/columns/:column — drop a column ───────────────

  app.delete('/tables/:table/columns/:column', async (req, reply) => {
    const { table, column } = req.params as { table: string; column: string }

    if (isSystemTable(table)) {
      return reply.code(403).send({ error: 'Cannot modify CMS system tables' })
    }

    try {
      const pkRows = rawRows<{ cnt: number }>(await db.raw(
        `SELECT COUNT(*) AS cnt
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_NAME = kcu.TABLE_NAME
         WHERE tc.TABLE_NAME = ? AND kcu.COLUMN_NAME = ? AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`,
        [table, column]
      ))
      if (Number(pkRows[0]?.cnt ?? 0)) {
        return reply.code(400).send({ error: 'Cannot drop a primary key column' })
      }

      if (!(await columnExists(table, column))) {
        return reply.code(404).send({ error: `Column "${column}" not found on table "${table}"` })
      }

      await db.schema.table(table, (t) => {
        t.dropColumn(column)
      })

      await logActivity({
        action: 'delete',
        collection: 'schema',
        item: `${table}.${column}`,
        user: req.user?.id,
        req,
        comment: 'drop column'
      })
      return reply.code(204).send()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── POST /tables/:table/register — register as CMS collection ───────────

  app.post('/tables/:table/register', async (req, reply) => {
    const { table } = req.params as { table: string }
    const body = req.body as {
      display_name?: string
      icon?: string
      note?: string
      display_template?: string | null
    }

    try {
      const existing = await db<CMSCollection>('nivaro_collections')
        .where({ collection: table })
        .first()

      if (existing) {
        await db('nivaro_collections')
          .where({ collection: table })
          .update({
            display_name: body.display_name ?? existing.display_name,
            icon: body.icon ?? existing.icon,
            note: body.note ?? existing.note,
            ...(body.display_template !== undefined
              ? { display_template: body.display_template }
              : {}),
            updated_at: new Date()
          })
      } else {
        await db('nivaro_collections').insert({
          collection: table,
          display_name: body.display_name ?? null,
          icon: body.icon ?? null,
          note: body.note ?? null,
          display_template: body.display_template ?? null,
          hidden: false,
          singleton: false
        })
      }

      const updated = await db<CMSCollection>('nivaro_collections')
        .where({ collection: table })
        .first()
      await logActivity({
        action: 'update',
        collection: 'nivaro_collections',
        item: table,
        user: req.user?.id,
        req,
        comment: 'register table'
      })
      return reply.code(201).send({ data: updated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── DELETE /tables/:table/unregister — remove CMS registration ──────────

  app.delete('/tables/:table/unregister', async (req, reply) => {
    const { table } = req.params as { table: string }

    try {
      await db('nivaro_collections').where({ collection: table }).delete()
      await db('nivaro_fields').where({ collection: table }).delete()
      await db('nivaro_relations')
        .where({ many_collection: table })
        .orWhere({ one_collection: table })
        .delete()

      await logActivity({
        action: 'delete',
        collection: 'nivaro_collections',
        item: table,
        user: req.user?.id,
        req,
        comment: 'unregister table'
      })
      return reply.code(204).send()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── POST /tables/:table/fields — add/update CMS field metadata ──────────

  app.post('/tables/:table/fields', async (req, reply) => {
    const { table } = req.params as { table: string }
    const body = req.body as {
      field: string
      type: string
      interface?: string
      display?: string
      display_options?: string | null
      options?: string | null
      special?: string | null
      note?: string
      hidden?: boolean
      readonly?: boolean
      required?: boolean
      sort?: number
      group?: string | null
      computed_formula?: string | null
      computed_type?: 'read' | 'write' | null
      computed_store?: boolean
      is_encrypted?: boolean
      is_inheritable?: boolean
    }

    if (!body.field) return reply.code(400).send({ error: 'field is required' })
    if (!body.type) return reply.code(400).send({ error: 'type is required' })

    try {
      const existing = await db<CMSField>('nivaro_fields')
        .where({ collection: table, field: body.field })
        .first()

      const def = <T>(incoming: T | undefined, fallback: T): T =>
        incoming !== undefined ? incoming : fallback

      if (existing) {
        await db('nivaro_fields')
          .where({ collection: table, field: body.field })
          .update({
            type: def(body.type, existing.type),
            interface: def(body.interface, existing.interface),
            display: def(body.display, existing.display),
            display_options: def(body.display_options, existing.display_options),
            options: def(body.options, existing.options),
            special: def(body.special, existing.special),
            note: def(body.note, existing.note),
            hidden: body.hidden !== undefined ? (body.hidden ? 1 : 0) : existing.hidden,
            readonly: body.readonly !== undefined ? (body.readonly ? 1 : 0) : existing.readonly,
            required: body.required !== undefined ? (body.required ? 1 : 0) : existing.required,
            sort: def(body.sort, existing.sort),
            group: def(body.group, existing.group),
            computed_formula: def(body.computed_formula, existing.computed_formula ?? null),
            computed_type: def(body.computed_type, existing.computed_type ?? null),
            computed_store:
              body.computed_store !== undefined
                ? body.computed_store
                  ? 1
                  : 0
                : (existing.computed_store ?? 0),
            is_encrypted:
              body.is_encrypted !== undefined
                ? body.is_encrypted
                  ? 1
                  : 0
                : ((existing as CMSField & { is_encrypted?: number }).is_encrypted ?? 0),
            is_inheritable:
              body.is_inheritable !== undefined
                ? body.is_inheritable
                  ? 1
                  : 0
                : ((existing as CMSField & { is_inheritable?: number }).is_inheritable ?? 0)
          })
      } else {
        await db('nivaro_fields').insert({
          collection: table,
          field: body.field,
          type: body.type,
          interface: body.interface ?? null,
          display: body.display ?? null,
          display_options: body.display_options ?? null,
          options: body.options ?? null,
          special: body.special ?? null,
          note: body.note ?? null,
          hidden: body.hidden ? 1 : 0,
          readonly: body.readonly ? 1 : 0,
          required: body.required ? 1 : 0,
          sort: body.sort ?? null,
          group: body.group ?? null,
          computed_formula: body.computed_formula ?? null,
          computed_type: body.computed_type ?? null,
          computed_store: body.computed_store ? 1 : 0,
          is_encrypted: body.is_encrypted ? 1 : 0,
          is_inheritable: body.is_inheritable ? 1 : 0
        })
      }

      const updated = await db<CMSField>('nivaro_fields')
        .where({ collection: table, field: body.field })
        .first()
      await logActivity({
        action: 'update',
        collection: 'nivaro_fields',
        item: `${table}.${body.field}`,
        user: req.user?.id,
        req
      })
      return reply.code(201).send({ data: updated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── DELETE /tables/:table/fields/:field — remove CMS field metadata ──────

  app.delete('/tables/:table/fields/:field', async (req, reply) => {
    const { table, field } = req.params as { table: string; field: string }

    try {
      const deleted = await db('nivaro_fields').where({ collection: table, field }).delete()
      if (!deleted) return reply.code(404).send({ error: 'Field metadata not found' })
      await logActivity({
        action: 'delete',
        collection: 'nivaro_fields',
        item: `${table}.${field}`,
        user: req.user?.id,
        req
      })
      return reply.code(204).send()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── GET /relations — list all CMS relations ─────────────────────────────

  app.get('/relations', async (_req, reply) => {
    try {
      const relations = await db<CMSRelation>('nivaro_relations').select('*').orderBy('id')
      return reply.send({ data: relations })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── GET /relations/for/:collection — relations involving a collection ────

  app.get('/relations/for/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    try {
      const relations = await db<CMSRelation>('nivaro_relations')
        .where({ many_collection: collection })
        .orWhere({ one_collection: collection })
        .orderBy('id')

      // For matched M2M rows, also fetch companion rows from the same junction
      // table (the other side's FK row, junction_field NOT NULL) so the admin UI
      // can resolve the full M2M pair. Merge + dedupe by id.
      const junctionTables = [
        ...new Set(relations.filter((r) => r.junction_field).map((r) => r.many_collection))
      ]
      if (junctionTables.length > 0) {
        const companions = await db<CMSRelation>('nivaro_relations')
          .whereIn('many_collection', junctionTables)
        const seen = new Set(relations.map((r) => r.id))
        for (const c of companions) {
          if (!seen.has(c.id)) {
            relations.push(c)
            seen.add(c.id)
          }
        }
        relations.sort((a, b) => Number(a.id) - Number(b.id))
      }

      return reply.send({ data: relations })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── POST /relations — create a CMS relation ─────────────────────────────

  app.post('/relations', async (req, reply) => {
    const body = req.body as {
      many_collection: string
      many_field: string
      one_collection?: string
      one_field?: string
      one_collection_field?: string
      one_allowed_collections?: string | null
      junction_field?: string
      sort_field?: string
      one_deselect_action?: string
      create_fk?: boolean
    }

    if (!body.many_collection) return reply.code(400).send({ error: 'many_collection is required' })
    if (!body.many_field) return reply.code(400).send({ error: 'many_field is required' })

    // M2A requires one_collection_field; M2O/O2M/M2M require one_collection
    if (!body.one_collection && !body.one_collection_field) {
      return reply.code(400).send({ error: 'one_collection or one_collection_field is required' })
    }

    try {
      await db('nivaro_relations').insert({
        many_collection: body.many_collection,
        many_field: body.many_field,
        one_collection: body.one_collection ?? null,
        one_field: body.one_field ?? null,
        one_collection_field: body.one_collection_field ?? null,
        one_allowed_collections: body.one_allowed_collections ?? null,
        junction_field: body.junction_field ?? null,
        sort_field: body.sort_field ?? null,
        one_deselect_action: body.one_deselect_action ?? 'nullify'
      })

      if (body.create_fk && body.one_collection) {
        try {
          await db.schema.table(body.many_collection, (t) => {
            t.foreign(body.many_field)
              .references(body.one_field ?? 'id')
              .inTable(body.one_collection!)
              .onDelete('NO ACTION')
              .onUpdate('NO ACTION')
          })
        } catch {
          // FK creation is non-fatal — the CMS relation still exists
        }
      }

      const relation = await db<CMSRelation>('nivaro_relations')
        .where({ many_collection: body.many_collection, many_field: body.many_field })
        .orderBy('id', 'desc')
        .first()
      await logActivity({
        action: 'create',
        collection: 'nivaro_relations',
        item: String(relation?.id ?? ''),
        user: req.user?.id,
        req,
        comment: `${body.many_collection}.${body.many_field}`
      })
      return reply.code(201).send({ data: relation })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── PATCH /relations/:id — update a CMS relation ────────────────────────

  app.patch('/relations/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as Partial<Omit<CMSRelation, 'id'>>

    try {
      const existing = await db<CMSRelation>('nivaro_relations')
        .where({ id: Number(id) })
        .first()
      if (!existing) return reply.code(404).send({ error: 'Relation not found' })

      const def = <T>(incoming: T | undefined, fallback: T): T =>
        incoming !== undefined ? incoming : fallback

      await db('nivaro_relations')
        .where({ id: Number(id) })
        .update({
          many_collection: def(body.many_collection, existing.many_collection),
          many_field: def(body.many_field, existing.many_field),
          one_collection: def(body.one_collection, existing.one_collection),
          one_field: def(body.one_field, existing.one_field),
          one_collection_field: def(body.one_collection_field, existing.one_collection_field),
          one_allowed_collections: def(
            body.one_allowed_collections,
            existing.one_allowed_collections
          ),
          junction_field: def(body.junction_field, existing.junction_field),
          sort_field: def(body.sort_field, existing.sort_field),
          one_deselect_action: def(body.one_deselect_action, existing.one_deselect_action)
        })

      const updated = await db<CMSRelation>('nivaro_relations')
        .where({ id: Number(id) })
        .first()
      await logActivity({
        action: 'update',
        collection: 'nivaro_relations',
        item: id,
        user: req.user?.id,
        req
      })
      return reply.send({ data: updated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── POST /collections/:collection/fields/:field/change-type ─────────────
  //
  // Safe field type change: counts rows that would fail conversion via
  // TRY_CAST, returns 409 with samples when unsafe (unless body.force),
  // performs the ALTER inside a transaction.

  const SQL_TYPE_MAP: Record<string, string> = {
    string: 'nvarchar(255)',
    text: 'nvarchar(max)',
    integer: 'int',
    bigInteger: 'bigint',
    boolean: 'bit',
    decimal: 'decimal(18,4)',
    float: 'float',
    date: 'date',
    datetime: 'datetime2',
    uuid: 'uniqueidentifier'
  }

  app.post('/collections/:collection/fields/:field/change-type', async (req, reply) => {
    const { collection, field } = req.params as { collection: string; field: string }
    const body = req.body as { new_type?: string; max_length?: number; force?: boolean }

    if (isSystemTable(collection)) {
      return reply.code(403).send({ error: 'Cannot modify CMS system tables' })
    }
    if (!TABLE_NAME_RE.test(collection) || !COLUMN_NAME_RE.test(field)) {
      return reply.code(400).send({ error: 'Invalid table or column name' })
    }
    const newType = body?.new_type ?? ''
    let sqlType = SQL_TYPE_MAP[newType]
    if (!sqlType) {
      return reply.code(400).send({
        error: `Invalid new_type. Must be one of: ${Object.keys(SQL_TYPE_MAP).join(', ')}`
      })
    }
    if (
      newType === 'string' &&
      body.max_length &&
      Number.isInteger(body.max_length) &&
      body.max_length > 0 &&
      body.max_length <= 4000
    ) {
      sqlType = `nvarchar(${body.max_length})`
    }

    try {
      if (!(await tableExists(collection))) {
        return reply.code(404).send({ error: `Table "${collection}" not found` })
      }
      if (!(await columnExists(collection, field))) {
        return reply
          .code(404)
          .send({ error: `Column "${field}" not found on table "${collection}"` })
      }

      // Preserve current nullability
      const colMeta = rawRows<{ IS_NULLABLE: string }>(await db.raw(
        `SELECT IS_NULLABLE AS "IS_NULLABLE" FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [collection, field]
      ))
      const nullable = colMeta[0]?.IS_NULLABLE !== 'NO'

      // Safety check — count values that won't survive the conversion
      const failRows = rawRows<{ cnt: number }>(await db.raw(
        `SELECT COUNT(*) AS cnt FROM [${collection}] WHERE [${field}] IS NOT NULL AND TRY_CAST([${field}] AS ${sqlType}) IS NULL`
      ))
      const failingCount = Number(failRows[0]?.cnt ?? 0)
      if (failingCount > 0 && !body.force) {
        const samples = rawRows<Record<string, unknown>>(await db.raw(
          `SELECT TOP 5 [${field}] AS value FROM [${collection}] WHERE [${field}] IS NOT NULL AND TRY_CAST([${field}] AS ${sqlType}) IS NULL`
        ))
        return reply.code(409).send({
          error: `${failingCount} row(s) cannot be converted to ${newType}`,
          failing_rows: failingCount,
          samples: samples.map((s) => s.value),
          hint: 'Fix the values or re-submit with force: true (failing values become NULL or raise an error).'
        })
      }

      await db.transaction(async (trx) => {
        if (failingCount > 0 && body.force) {
          // Null out unconvertible values first so the ALTER cannot fail mid-way
          if (!nullable)
            throw new Error('Column is NOT NULL — cannot force-null unconvertible values')
          await trx.raw(
            `UPDATE [${collection}] SET [${field}] = NULL WHERE [${field}] IS NOT NULL AND TRY_CAST([${field}] AS ${sqlType}) IS NULL`
          )
        }
        await trx.raw(
          `ALTER TABLE [${collection}] ALTER COLUMN [${field}] ${sqlType} ${nullable ? 'NULL' : 'NOT NULL'}`
        )
        await trx('nivaro_fields').where({ collection, field }).update({ type: newType })
      })

      await logActivity({
        action: 'update',
        collection: 'schema',
        item: `${collection}.${field}`,
        user: req.user?.id,
        req,
        comment: `change type → ${newType}`
      })
      return reply.send({
        data: { collection, field, new_type: newType, nulled_rows: body.force ? failingCount : 0 }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── POST /collections/:collection/fields/:field/rename ──────────────────

  app.post('/collections/:collection/fields/:field/rename', async (req, reply) => {
    const { collection, field } = req.params as { collection: string; field: string }
    const body = req.body as { new_name?: string }

    if (isSystemTable(collection)) {
      return reply.code(403).send({ error: 'Cannot modify CMS system tables' })
    }
    if (!TABLE_NAME_RE.test(collection) || !COLUMN_NAME_RE.test(field)) {
      return reply.code(400).send({ error: 'Invalid table or column name' })
    }
    const newName = body?.new_name ?? ''
    if (!COLUMN_NAME_RE.test(newName) || newName.length > 128) {
      return reply.code(400).send({ error: 'Invalid new_name' })
    }
    if (newName === field)
      return reply.code(400).send({ error: 'new_name matches the current name' })

    try {
      if (!(await columnExists(collection, field))) {
        return reply
          .code(404)
          .send({ error: `Column "${field}" not found on table "${collection}"` })
      }
      if (await columnExists(collection, newName)) {
        return reply
          .code(409)
          .send({ error: `Column "${newName}" already exists on table "${collection}"` })
      }

      await db.transaction(async (trx) => {
        await trx.raw(`EXEC sp_rename ?, ?, 'COLUMN'`, [`${collection}.${field}`, newName])
        await trx('nivaro_fields').where({ collection, field }).update({ field: newName })
      })

      await logActivity({
        action: 'update',
        collection: 'schema',
        item: `${collection}.${field}`,
        user: req.user?.id,
        req,
        comment: `rename → ${newName}`
      })
      return reply.send({ data: { collection, field: newName, previous: field } })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── DELETE /relations/:id — delete a CMS relation ───────────────────────

  app.delete('/relations/:id', async (req, reply) => {
    const { id } = req.params as { id: string }

    try {
      const relation = await db('nivaro_relations').where({ id: Number(id) }).first()
      if (!relation) return reply.code(404).send({ error: 'Relation not found' })

      // Drop FK constraint if one exists on many_collection.many_field
      if (relation.many_collection && relation.many_field) {
        try {
          await db.raw(`
            DECLARE @fk NVARCHAR(256)
            DECLARE @sql NVARCHAR(MAX)
            SELECT @fk = fk.name
            FROM sys.foreign_keys fk
            INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
            INNER JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
            WHERE fk.parent_object_id = OBJECT_ID(?)
              AND c.name = ?
            IF @fk IS NOT NULL BEGIN
              SET @sql = N'ALTER TABLE ' + QUOTENAME(?) + N' DROP CONSTRAINT ' + QUOTENAME(@fk)
              EXEC sp_executesql @sql
            END
          `, [relation.many_collection, relation.many_field, relation.many_collection])
        } catch {
          // FK may not exist — non-fatal
        }
      }

      await db('nivaro_relations').where({ id: Number(id) }).delete()
      await logActivity({
        action: 'delete',
        collection: 'nivaro_relations',
        item: id,
        user: req.user?.id,
        req
      })
      return reply.code(204).send()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })
}
