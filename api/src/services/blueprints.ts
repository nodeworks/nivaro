import { db } from '../db/index.js'

/**
 * App blueprints — one installable artifact bundling everything that makes a
 * "mini app": schema (collections/fields/relations), workflows, layouts,
 * queues, and automation rules.
 *
 * Export walks the metadata registry for a chosen collection set. Install
 * replays idempotently: physical tables/columns are created when missing
 * (int-identity id + created_at, typed columns for physical field types),
 * metadata rows insert skip-if-exists (uuid-keyed rows keep their ids so a
 * reinstall is a no-op; int-keyed rows match on natural keys and remap).
 * Data rows are deliberately NOT part of a blueprint — that's what content
 * promotion is for.
 */

export interface Blueprint {
  type: 'nivaro-blueprint'
  version: 1
  name: string
  exported_at: string
  collections: Array<{
    meta: Record<string, unknown>
    fields: Array<Record<string, unknown>>
  }>
  relations: Array<Record<string, unknown>>
  workflows: Array<{
    template: Record<string, unknown>
    states: Array<Record<string, unknown>>
    transitions: Array<Record<string, unknown>>
    bindings: Array<Record<string, unknown>>
  }>
  layouts: Array<{
    layout: Record<string, unknown>
    groups: Array<Record<string, unknown>>
    assignments: Array<Record<string, unknown>>
  }>
  queues: Array<{
    queue: Record<string, unknown>
    sources: Array<Record<string, unknown>>
  }>
  rules: Array<Record<string, unknown>>
}

const PHYSICAL_TYPES = new Set([
  'string', 'text', 'integer', 'bigInteger', 'boolean', 'decimal', 'float', 'date', 'datetime', 'uuid'
])

function strip<T extends Record<string, unknown>>(row: T, drop: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const k of drop) delete out[k]
  return out
}

export function isBlueprint(v: unknown): v is Blueprint {
  return !!v && typeof v === 'object' && (v as Blueprint).type === 'nivaro-blueprint'
}

// ─── Export ─────────────────────────────────────────────────────────────────

export async function exportBlueprint(name: string, collections: string[]): Promise<Blueprint> {
  const set = new Set(collections)

  const colRows = await db('nivaro_collections').whereIn('collection', collections)
  const cols: Blueprint['collections'] = []
  for (const meta of colRows as Array<Record<string, unknown>>) {
    const fields = (await db('nivaro_fields')
      .where({ collection: meta.collection })
      .orderBy('sort')) as Array<Record<string, unknown>>
    cols.push({
      meta: strip(meta, ['workspace', 'created_at', 'updated_at']),
      fields: fields.map((f) => strip(f, ['id', 'created_at', 'updated_at']))
    })
  }

  // Relations where both endpoints (or the junction chain) live in the set
  const rels = (await db('nivaro_relations')
    .whereIn('many_collection', collections)
    .orWhereIn('one_collection', collections)) as Array<Record<string, unknown>>
  const relations = rels
    .filter((r) => {
      const mc = String(r.many_collection ?? '')
      const oc = r.one_collection ? String(r.one_collection) : null
      return set.has(mc) && (oc == null || set.has(oc) || oc === 'nivaro_files')
    })
    .map((r) => strip(r, ['id']))

  // Workflows bound to the set
  const bindings = (await db('nivaro_workflow_bindings').whereIn(
    'collection',
    collections
  )) as Array<Record<string, unknown>>
  const templateIds = [...new Set(bindings.map((b) => String(b.template)))]
  const workflows: Blueprint['workflows'] = []
  for (const tid of templateIds) {
    const template = await db('nivaro_workflow_templates').where({ id: tid }).first()
    if (!template) continue
    workflows.push({
      template: strip(template, ['created_at', 'updated_at']),
      states: (
        (await db('nivaro_workflow_states').where({ template: tid }).orderBy('sort')) as Array<
          Record<string, unknown>
        >
      ).map((r) => strip(r, ['created_at', 'updated_at'])),
      transitions: (
        (await db('nivaro_workflow_transitions').where({ template: tid }).orderBy('sort')) as Array<
          Record<string, unknown>
        >
      ).map((r) => strip(r, ['created_at', 'updated_at'])),
      bindings: bindings
        .filter((b) => String(b.template) === tid)
        .map((b) => strip(b, ['id', 'created_at', 'updated_at']))
    })
  }

  // Layouts for the set (groups are layout-scoped)
  const layoutRows = (await db('nivaro_collection_layouts').whereIn(
    'collection',
    collections
  )) as Array<Record<string, unknown>>
  const layouts: Blueprint['layouts'] = []
  for (const layout of layoutRows) {
    const lid = Number(layout.id)
    layouts.push({
      layout: strip(layout, ['id', 'created_at', 'updated_at', 'addendum_layout_id']),
      groups: (
        (await db('nivaro_field_groups').where({ layout_id: lid })) as Array<Record<string, unknown>>
      ).map((g) => strip(g, ['id', 'layout_id'])),
      assignments: (
        (await db('nivaro_layout_field_assignments').where({ layout_id: lid })) as Array<
          Record<string, unknown>
        >
      ).map((a) => strip(a, ['id', 'layout_id']))
    })
  }

  // Queues whose sources all target the set
  const allQueues = (await db('nivaro_queues')) as Array<Record<string, unknown>>
  const queues: Blueprint['queues'] = []
  for (const queue of allQueues) {
    const sources = (await db('nivaro_queue_sources').where({
      queue_id: queue.id
    })) as Array<Record<string, unknown>>
    if (sources.length === 0) continue
    const inSet = sources.every(
      (s) => s.type !== 'collection' || set.has(String(s.collection ?? ''))
    )
    if (!inSet) continue
    queues.push({
      queue: strip(queue, ['owner', 'created_at', 'updated_at', 'materialized']),
      sources: sources.map((s) => strip(s, ['id', 'queue_id']))
    })
  }

  const rules = (
    (await db('nivaro_rules').whereIn('collection', collections)) as Array<Record<string, unknown>>
  ).map((r) => strip(r, ['id', 'created_at', 'updated_at']))

  return {
    type: 'nivaro-blueprint',
    version: 1,
    name,
    exported_at: new Date().toISOString(),
    collections: cols,
    relations,
    workflows,
    layouts,
    queues,
    rules
  }
}

// ─── Install ────────────────────────────────────────────────────────────────

export interface InstallReport {
  collections: { created: number; skipped: number }
  columns: { created: number }
  fields: { created: number; skipped: number }
  relations: { created: number; skipped: number }
  workflows: { created: number; skipped: number }
  layouts: { created: number; skipped: number }
  queues: { created: number; skipped: number }
  rules: { created: number; skipped: number }
  errors: string[]
}

async function tableExists(name: string): Promise<boolean> {
  const rows = (await db.raw(
    `SELECT 1 AS x FROM information_schema.tables WHERE TABLE_NAME = ?`,
    [name]
  )) as Array<{ x: number }>
  return rows.length > 0
}

async function tableColumns(name: string): Promise<Set<string>> {
  const rows = (await db.raw(
    `SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE TABLE_NAME = ?`,
    [name]
  )) as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

export async function installBlueprint(bp: Blueprint, ownerId: string | null): Promise<InstallReport> {
  const report: InstallReport = {
    collections: { created: 0, skipped: 0 },
    columns: { created: 0 },
    fields: { created: 0, skipped: 0 },
    relations: { created: 0, skipped: 0 },
    workflows: { created: 0, skipped: 0 },
    layouts: { created: 0, skipped: 0 },
    queues: { created: 0, skipped: 0 },
    rules: { created: 0, skipped: 0 },
    errors: []
  }
  const now = new Date()
  const err = (msg: string) => {
    if (report.errors.length < 20) report.errors.push(msg)
  }

  // Collections: physical table + metadata + typed columns
  for (const col of bp.collections) {
    const name = String(col.meta.collection ?? '')
    if (!/^[a-zA-Z0-9_]+$/.test(name) || name.startsWith('nivaro_')) {
      err(`invalid collection name: ${name}`)
      continue
    }
    try {
      if (!(await tableExists(name))) {
        await db.schema.createTable(name, (t) => {
          t.increments('id').primary()
          t.timestamp('created_at').defaultTo(db.fn.now())
        })
      }
      const existingMeta = await db('nivaro_collections').where({ collection: name }).first()
      if (existingMeta) report.collections.skipped++
      else {
        await db('nivaro_collections').insert({ ...col.meta, created_at: now, updated_at: now })
        report.collections.created++
      }

      const columns = await tableColumns(name)
      for (const f of col.fields) {
        const fname = String(f.field ?? '')
        if (!/^[a-zA-Z0-9_]+$/.test(fname)) continue
        const ftype = String(f.type ?? '')
        if (PHYSICAL_TYPES.has(ftype) && !columns.has(fname)) {
          await db.schema.table(name, (t) => {
            switch (ftype) {
              case 'string': t.string(fname, 255); break
              case 'text': t.text(fname); break
              case 'integer': t.integer(fname); break
              case 'bigInteger': t.bigInteger(fname); break
              case 'boolean': t.boolean(fname); break
              case 'decimal': t.decimal(fname, 18, 4); break
              case 'float': t.float(fname); break
              case 'date': t.date(fname); break
              case 'datetime': t.datetime(fname); break
              case 'uuid': t.uuid(fname); break
            }
          })
          report.columns.created++
        }
        const existingField = await db('nivaro_fields')
          .where({ collection: name, field: fname })
          .first()
        if (existingField) report.fields.skipped++
        else {
          await db('nivaro_fields').insert({ ...f, collection: name, created_at: now, updated_at: now })
          report.fields.created++
        }
      }
    } catch (e) {
      err(`${name}: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
    }
  }

  // Relations: natural key (many_collection, many_field, one_collection)
  for (const r of bp.relations) {
    try {
      const existing = await db('nivaro_relations')
        .where({
          many_collection: r.many_collection as string,
          many_field: (r.many_field as string) ?? null,
          one_collection: (r.one_collection as string) ?? null
        })
        .first()
      if (existing) report.relations.skipped++
      else {
        await db('nivaro_relations').insert(r)
        report.relations.created++
      }
    } catch (e) {
      err(`relation: ${e instanceof Error ? e.message.slice(0, 120) : 'failed'}`)
    }
  }

  // Workflows: uuid-keyed — skip whole template when id exists
  for (const wf of bp.workflows) {
    try {
      const tid = String(wf.template.id)
      const existing = await db('nivaro_workflow_templates').where({ id: tid }).first()
      if (existing) {
        report.workflows.skipped++
        continue
      }
      await db('nivaro_workflow_templates').insert({ ...wf.template, created_at: now, updated_at: now })
      for (const st of wf.states) await db('nivaro_workflow_states').insert(st)
      for (const tx of wf.transitions) await db('nivaro_workflow_transitions').insert(tx)
      for (const b of wf.bindings) {
        const bound = await db('nivaro_workflow_bindings')
          .where({ collection: b.collection as string })
          .first()
        if (!bound) await db('nivaro_workflow_bindings').insert(b)
      }
      report.workflows.created++
    } catch (e) {
      err(`workflow: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
    }
  }

  // Layouts: (collection, name) natural key; remap new int id into children
  for (const l of bp.layouts) {
    try {
      const key = { collection: l.layout.collection as string, name: l.layout.name as string }
      const existing = await db('nivaro_collection_layouts').where(key).first()
      if (existing) {
        report.layouts.skipped++
        continue
      }
      const [idRow] = await db('nivaro_collection_layouts')
        .insert({ ...l.layout, created_at: now, updated_at: now })
        .returning('id')
      const newId = typeof idRow === 'object' ? (idRow as { id: number }).id : idRow
      for (const g of l.groups) await db('nivaro_field_groups').insert({ ...g, layout_id: newId })
      for (const a of l.assignments) {
        await db('nivaro_layout_field_assignments').insert({ ...a, layout_id: newId })
      }
      report.layouts.created++
    } catch (e) {
      err(`layout: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
    }
  }

  // Queues: uuid-keyed; installer becomes owner
  for (const q of bp.queues) {
    try {
      const existing = await db('nivaro_queues').where({ id: q.queue.id as string }).first()
      if (existing) {
        report.queues.skipped++
        continue
      }
      await db('nivaro_queues').insert({
        ...q.queue,
        owner: ownerId,
        materialized: false,
        created_at: now,
        updated_at: now
      })
      for (const src of q.sources) {
        await db('nivaro_queue_sources').insert({ ...src, queue_id: q.queue.id })
      }
      report.queues.created++
    } catch (e) {
      err(`queue: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
    }
  }

  // Rules: (collection, name) natural key
  for (const r of bp.rules) {
    try {
      const existing = await db('nivaro_rules')
        .where({ collection: r.collection as string, name: r.name as string })
        .first()
      if (existing) report.rules.skipped++
      else {
        await db('nivaro_rules').insert({ ...r, created_at: now, updated_at: now })
        report.rules.created++
      }
    } catch (e) {
      err(`rule: ${e instanceof Error ? e.message.slice(0, 120) : 'failed'}`)
    }
  }

  return report
}
