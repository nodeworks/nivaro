import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// ─── JSON helpers ───────────────────────────────────────────────────────────

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  if (typeof val !== 'string') return val as T
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

// Best-effort select — returns [] if the table does not exist in this deployment.
async function safeSelect(table: string): Promise<Record<string, unknown>[]> {
  try {
    return (await db(table).select('*')) as Record<string, unknown>[]
  } catch {
    return []
  }
}

// Parse JSON-text fields on a set of rows in place (non-destructive copy).
function parseFields(rows: Record<string, unknown>[], fields: string[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out = { ...row }
    for (const f of fields) {
      if (typeof out[f] === 'string') out[f] = parseJson(out[f] as string)
    }
    return out
  })
}

const SNAPSHOT_TYPE = 'nivaro/schema-snapshot'

// ─── Environment sync — diff helpers ─────────────────────────────────────────

interface SyncSnapshot {
  collections?: Record<string, unknown>[]
  fields?: Record<string, unknown>[]
  relations?: Record<string, unknown>[]
  version?: string
  exported_at?: string
}

interface FieldChange {
  collection: string
  field: string
  change: 'added' | 'removed' | 'modified'
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

interface SchemaDiff {
  added_collections: string[]
  removed_collections: string[]
  changed_fields: FieldChange[]
  added_relations: Record<string, unknown>[]
  removed_relations: Record<string, unknown>[]
  conflicts: FieldChange[]
}

const FIELD_COMPARE_PROPS = [
  'type',
  'interface',
  'display',
  'note',
  'hidden',
  'readonly',
  'required',
  'options',
  'special',
  'computed_formula',
  'computed_type'
]

function normalizeVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') return JSON.stringify(v)
  // booleans come back as 0/1 from MSSQL
  if (v === 'true') return '1'
  if (v === 'false') return '0'
  return String(v)
}

function fieldKey(row: Record<string, unknown>): string {
  return `${row.collection}::${row.field}`
}

function relationKey(row: Record<string, unknown>): string {
  return `${row.many_collection}::${row.many_field}::${row.one_collection ?? row.one_collection_field ?? ''}`
}

function pickFieldProps(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const p of FIELD_COMPARE_PROPS) out[p] = row[p] ?? null
  return out
}

async function computeSchemaDiff(snapshot: SyncSnapshot): Promise<SchemaDiff> {
  const [liveCollections, liveFields, liveRelations] = await Promise.all([
    safeSelect('nivaro_collections'),
    safeSelect('nivaro_fields'),
    safeSelect('nivaro_relations')
  ])

  const snapCollections = Array.isArray(snapshot.collections) ? snapshot.collections : []
  const snapFields = Array.isArray(snapshot.fields) ? snapshot.fields : []
  const snapRelations = Array.isArray(snapshot.relations) ? snapshot.relations : []

  const liveColSet = new Set(liveCollections.map((c) => String(c.collection)))
  const snapColSet = new Set(snapCollections.map((c) => String(c.collection)))

  const added_collections = [...snapColSet].filter((c) => !liveColSet.has(c)).sort()
  const removed_collections = [...liveColSet].filter((c) => !snapColSet.has(c)).sort()

  const liveFieldMap = new Map(liveFields.map((f) => [fieldKey(f), f]))
  const snapFieldMap = new Map(snapFields.map((f) => [fieldKey(f), f]))

  const changed_fields: FieldChange[] = []
  for (const [key, snapField] of snapFieldMap) {
    const liveField = liveFieldMap.get(key)
    if (!liveField) {
      changed_fields.push({
        collection: String(snapField.collection),
        field: String(snapField.field),
        change: 'added',
        before: null,
        after: pickFieldProps(snapField)
      })
      continue
    }
    const before = pickFieldProps(liveField)
    const after = pickFieldProps(snapField)
    const isModified = FIELD_COMPARE_PROPS.some(
      (p) => normalizeVal(before?.[p]) !== normalizeVal(after?.[p])
    )
    if (isModified) {
      changed_fields.push({
        collection: String(snapField.collection),
        field: String(snapField.field),
        change: 'modified',
        before,
        after
      })
    }
  }
  for (const [key, liveField] of liveFieldMap) {
    if (!snapFieldMap.has(key)) {
      changed_fields.push({
        collection: String(liveField.collection),
        field: String(liveField.field),
        change: 'removed',
        before: pickFieldProps(liveField),
        after: null
      })
    }
  }

  const liveRelMap = new Map(liveRelations.map((r) => [relationKey(r), r]))
  const snapRelMap = new Map(snapRelations.map((r) => [relationKey(r), r]))
  const added_relations = [...snapRelMap.entries()]
    .filter(([k]) => !liveRelMap.has(k))
    .map(([, r]) => r)
  const removed_relations = [...liveRelMap.entries()]
    .filter(([k]) => !snapRelMap.has(k))
    .map(([, r]) => r)

  // Conflicts: field type changes — applying them would require a destructive ALTER
  const conflicts = changed_fields.filter(
    (c) => c.change === 'modified' && normalizeVal(c.before?.type) !== normalizeVal(c.after?.type)
  )

  return {
    added_collections,
    removed_collections,
    changed_fields,
    added_relations,
    removed_relations,
    conflicts
  }
}

// ─── Environment sync — apply helpers ────────────────────────────────────────

const COLUMN_TYPE_BUILDERS: Record<
  string,
  (t: import('knex').Knex.AlterTableBuilder, name: string) => void
> = {
  string: (t, n) => {
    t.string(n, 255).nullable()
  },
  text: (t, n) => {
    t.text(n).nullable()
  },
  integer: (t, n) => {
    t.integer(n).nullable()
  },
  bigInteger: (t, n) => {
    t.bigInteger(n).nullable()
  },
  boolean: (t, n) => {
    t.boolean(n).nullable()
  },
  decimal: (t, n) => {
    t.decimal(n).nullable()
  },
  float: (t, n) => {
    t.float(n).nullable()
  },
  date: (t, n) => {
    t.date(n).nullable()
  },
  datetime: (t, n) => {
    t.datetime(n).nullable()
  },
  timestamp: (t, n) => {
    t.timestamp(n).nullable()
  },
  uuid: (t, n) => {
    t.uuid(n).nullable()
  },
  json: (t, n) => {
    t.text(n).nullable()
  }
}

const FIELD_JSON_PROPS = ['options', 'display_options', 'special', 'validation']

function serializeFieldRow(raw: Record<string, unknown>): Record<string, unknown> {
  const row = { ...raw }
  delete row.id // identity / per-environment
  for (const p of FIELD_JSON_PROPS) {
    if (row[p] != null && typeof row[p] === 'object') row[p] = JSON.stringify(row[p])
  }
  return row
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function schemaSnapshotRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // Export the entire Nivaro config as a JSON snapshot.
  app.get('/export', async (req, reply) => {
    const [
      collections,
      fields,
      relations,
      roles,
      policies,
      workflowTemplates,
      workflowStates,
      workflowTransitions,
      workflowBindings,
      pipelineOwnerGroups,
      pipelineOwnerGroupUsers,
      pipelineOwnerDimensions,
      settingsRows
    ] = await Promise.all([
      safeSelect('nivaro_collections'),
      safeSelect('nivaro_fields'),
      safeSelect('nivaro_relations'),
      safeSelect('nivaro_roles'),
      safeSelect('nivaro_policies'),
      safeSelect('nivaro_workflow_templates'),
      safeSelect('nivaro_workflow_states'),
      safeSelect('nivaro_workflow_transitions'),
      safeSelect('nivaro_workflow_bindings'),
      safeSelect('nivaro_pipeline_owner_groups'),
      safeSelect('nivaro_pipeline_owner_group_users'),
      safeSelect('nivaro_pipeline_owner_dimensions'),
      safeSelect('nivaro_settings')
    ])

    const snapshot = {
      type: SNAPSHOT_TYPE,
      version: '1',
      exportedAt: new Date().toISOString(),
      collections,
      fields: parseFields(fields, ['options', 'display_options', 'special', 'validation']),
      relations: parseFields(relations, ['one_allowed_collections']),
      roles,
      policies: parseFields(policies, ['fields', 'permissions', 'validation', 'presets']),
      workflowTemplates,
      workflowStates,
      workflowTransitions: parseFields(workflowTransitions, ['required_roles', 'actions']),
      workflowBindings,
      // Pipelines share the workflow tables for states/bindings.
      pipelineStates: workflowStates,
      pipelineBindings: workflowBindings,
      pipelineOwnerGroups: parseFields(pipelineOwnerGroups, ['filters']),
      pipelineOwnerGroupUsers,
      pipelineOwnerDimensions,
      settings: settingsRows[0] ?? null
    }

    const date = new Date().toISOString().slice(0, 10)
    reply.header('Content-Disposition', `attachment; filename="nivaro-snapshot-${date}.json"`)
    reply.type('application/json')
    await logActivity({
      action: 'schema-snapshot-export',
      user: req.user?.id,
      collection: 'nivaro_collections',
      req
    })
    return snapshot
  })

  // ─── Environment Sync ───────────────────────────────────────────────────

  async function tableExists(name: string): Promise<boolean> {
    const rows = await db.raw<{ cnt: number }[]>(
      `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'`,
      [name]
    )
    return Number(rows[0]?.cnt ?? 0) > 0
  }

  async function columnExists(table: string, column: string): Promise<boolean> {
    const rows = await db.raw<{ cnt: number }[]>(
      `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    )
    return Number(rows[0]?.cnt ?? 0) > 0
  }

  function extractSyncSnapshot(raw: unknown): SyncSnapshot | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (!Array.isArray(o.collections) && !Array.isArray(o.fields) && !Array.isArray(o.relations)) {
      return null
    }
    return o as SyncSnapshot
  }

  // Compute a diff between an exported snapshot and the live schema.
  app.post<{ Body: Record<string, unknown> }>('/diff', async (req, reply) => {
    const snapshot = extractSyncSnapshot((req.body as { snapshot?: unknown })?.snapshot ?? req.body)
    if (!snapshot) {
      return reply
        .code(400)
        .send({ error: 'Body must be an exported schema snapshot (collections/fields/relations)' })
    }
    const diff = await computeSchemaDiff(snapshot)
    return reply.send({ data: diff })
  })

  // Apply non-destructive changes from a snapshot. Destructive changes (drops,
  // type changes) are NEVER auto-applied — returned in `skipped_destructive`.
  async function applySyncSnapshot(snapshot: SyncSnapshot, diff: SchemaDiff) {
    const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
    const applied = { collections: 0, fields: 0, field_metadata: 0, relations: 0 }
    const skipped_destructive: Array<{ kind: string; target: string; reason: string }> = []
    const errors: Array<{ target: string; error: string }> = []

    const conflictKeys = new Set(diff.conflicts.map((c) => `${c.collection}::${c.field}`))
    const snapFields = Array.isArray(snapshot.fields) ? snapshot.fields : []
    const snapCollections = Array.isArray(snapshot.collections) ? snapshot.collections : []

    // 1. Create missing collections (registry row + physical table, like data-model POST /tables)
    for (const name of diff.added_collections) {
      const meta = snapCollections.find((c) => String(c.collection) === name)
      try {
        if (!TABLE_NAME_RE.test(name)) throw new Error('invalid table name')
        if (!(await tableExists(name))) {
          await db.schema.createTable(name, (t) => {
            t.increments('id').primary()
            t.timestamp('created_at').defaultTo(db.fn.now())
          })
        }
        const existing = await db('nivaro_collections').where({ collection: name }).first()
        if (!existing && meta) {
          const row = { ...meta }
          delete (row as Record<string, unknown>).id
          await db('nivaro_collections').insert(row)
        }
        applied.collections++
      } catch (err) {
        errors.push({ target: name, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // 2. Added / modified fields
    for (const change of diff.changed_fields) {
      const target = `${change.collection}.${change.field}`
      if (change.change === 'removed') {
        skipped_destructive.push({
          kind: 'field',
          target,
          reason: 'field exists locally but not in snapshot — drop not auto-applied'
        })
        continue
      }
      if (conflictKeys.has(`${change.collection}::${change.field}`)) {
        skipped_destructive.push({
          kind: 'field',
          target,
          reason: `type change ${change.before?.type} → ${change.after?.type} requires a manual migration`
        })
        continue
      }
      const snapField = snapFields.find(
        (f) => String(f.collection) === change.collection && String(f.field) === change.field
      )
      if (!snapField) continue
      try {
        if (change.change === 'added') {
          // Physical column — only for concrete (non-computed) fields with a known type
          const isVirtual = snapField.computed_formula != null
          const builder = COLUMN_TYPE_BUILDERS[String(snapField.type)]
          if (
            !isVirtual &&
            builder &&
            TABLE_NAME_RE.test(change.collection) &&
            TABLE_NAME_RE.test(change.field)
          ) {
            if (
              (await tableExists(change.collection)) &&
              !(await columnExists(change.collection, change.field))
            ) {
              await db.schema.table(change.collection, (t) => builder(t, change.field))
            }
          }
          const existing = await db('nivaro_fields')
            .where({ collection: change.collection, field: change.field })
            .first()
          if (!existing) await db('nivaro_fields').insert(serializeFieldRow(snapField))
          applied.fields++
        } else {
          // modified, non-conflicting — metadata-only update
          const row = serializeFieldRow(snapField)
          delete row.collection
          delete row.field
          await db('nivaro_fields')
            .where({ collection: change.collection, field: change.field })
            .update(row)
          applied.field_metadata++
        }
      } catch (err) {
        errors.push({ target, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // 3. Removed collections — never dropped automatically
    for (const name of diff.removed_collections) {
      skipped_destructive.push({
        kind: 'collection',
        target: name,
        reason: 'collection exists locally but not in snapshot — drop not auto-applied'
      })
    }

    // 4. Added relations (metadata only — FK creation stays a manual data-model action)
    for (const rel of diff.added_relations) {
      const target = `${rel.many_collection}.${rel.many_field}`
      try {
        const row = { ...rel }
        delete (row as Record<string, unknown>).id
        if (
          row.one_allowed_collections != null &&
          typeof row.one_allowed_collections === 'object'
        ) {
          row.one_allowed_collections = JSON.stringify(row.one_allowed_collections)
        }
        await db('nivaro_relations').insert(row)
        applied.relations++
      } catch (err) {
        errors.push({ target, error: err instanceof Error ? err.message : String(err) })
      }
    }
    for (const rel of diff.removed_relations) {
      skipped_destructive.push({
        kind: 'relation',
        target: `${rel.many_collection}.${rel.many_field}`,
        reason: 'relation exists locally but not in snapshot — removal not auto-applied'
      })
    }

    return { applied, skipped_destructive, errors }
  }

  // Import a snapshot — upsert each resource in dependency order.
  app.post<{ Body: Record<string, unknown> }>('/import', async (req, reply) => {
    const body = req.body
    // Environment-sync style body { snapshot, mode }
    if (body && typeof body === 'object' && 'snapshot' in body && 'mode' in body) {
      const mode = body.mode === 'apply' ? 'apply' : 'dry-run'
      const snapshot = extractSyncSnapshot(body.snapshot)
      if (!snapshot)
        return reply.code(400).send({ error: '`snapshot` must be an exported schema snapshot' })
      const diff = await computeSchemaDiff(snapshot)
      if (mode === 'dry-run') {
        return reply.send({ data: { mode, diff } })
      }
      const result = await applySyncSnapshot(snapshot, diff)
      await logActivity({
        action: 'schema-snapshot-import',
        user: req.user?.id,
        collection: 'nivaro_collections',
        comment: 'environment-sync apply',
        req
      })
      return reply.send({ data: { mode, ...result, diff } })
    }
    if (!body || body.type !== SNAPSHOT_TYPE) {
      return reply.code(400).send({ error: 'Invalid snapshot: type mismatch' })
    }

    const imported: Record<string, number> = {}

    // Upsert rows into a table keyed by `keyField`. JSON-text columns listed in
    // `jsonFields` are re-serialized before write.
    async function upsert(
      table: string,
      rows: unknown,
      keyField = 'id',
      jsonFields: string[] = []
    ): Promise<number> {
      if (!Array.isArray(rows)) return 0
      let count = 0
      for (const raw of rows as Record<string, unknown>[]) {
        if (!raw || typeof raw !== 'object') continue
        const row: Record<string, unknown> = { ...raw }
        for (const f of jsonFields) {
          if (row[f] != null && typeof row[f] !== 'string') {
            row[f] = JSON.stringify(row[f])
          }
        }
        const keyVal = row[keyField]
        try {
          if (keyVal != null) {
            const existing = await db(table)
              .where({ [keyField]: keyVal })
              .first()
            if (existing) {
              await db(table)
                .where({ [keyField]: keyVal })
                .update(row)
            } else {
              await db(table).insert(row)
            }
          } else {
            await db(table).insert(row)
          }
          count++
        } catch (err) {
          app.log.warn({ err, table, keyVal }, 'Snapshot import row failed')
        }
      }
      return count
    }

    // Dependency order: roles → policies → collections → fields → relations →
    // workflow templates → states → transitions → bindings → dimensions → owner groups.
    imported.roles = await upsert('nivaro_roles', body.roles)
    imported.policies = await upsert('nivaro_policies', body.policies, 'id', [
      'fields',
      'permissions',
      'validation',
      'presets'
    ])
    imported.collections = await upsert('nivaro_collections', body.collections)
    imported.fields = await upsert('nivaro_fields', body.fields, 'id', [
      'options',
      'display_options',
      'special',
      'validation'
    ])
    imported.relations = await upsert('nivaro_relations', body.relations, 'id', [
      'one_allowed_collections'
    ])
    imported.workflowTemplates = await upsert('nivaro_workflow_templates', body.workflowTemplates)
    imported.workflowStates = await upsert('nivaro_workflow_states', body.workflowStates)
    imported.workflowTransitions = await upsert(
      'nivaro_workflow_transitions',
      body.workflowTransitions,
      'id',
      ['required_roles', 'actions']
    )
    imported.workflowBindings = await upsert('nivaro_workflow_bindings', body.workflowBindings)
    imported.pipelineOwnerDimensions = await upsert(
      'nivaro_pipeline_owner_dimensions',
      body.pipelineOwnerDimensions
    )
    imported.pipelineOwnerGroups = await upsert(
      'nivaro_pipeline_owner_groups',
      body.pipelineOwnerGroups,
      'id',
      ['filters']
    )
    imported.pipelineOwnerGroupUsers = await upsert(
      'nivaro_pipeline_owner_group_users',
      body.pipelineOwnerGroupUsers
    )

    if (body.settings && typeof body.settings === 'object') {
      imported.settings = await upsert('nivaro_settings', [body.settings])
    }

    await logActivity({
      action: 'schema-snapshot-import',
      user: req.user?.id,
      collection: 'nivaro_collections',
      req
    })

    return { imported }
  })
}
