import { randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import { inThisSchema } from '../db/dialect/h1.js'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import {
  getTemplate,
  installTemplateDraft,
  type PayloadTemplateBundle
} from './payload-templates/index.js'

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
 *
 * Payload templates referenced by a transition action (`payload_template_key`)
 * ride along with their PUBLISHED body; install brings them in as DRAFTS only
 * (a missing one is created unpublished), so nothing a sender uses changes
 * until someone publishes it on the receiving instance.
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
    /**
     * Hub enhancement 46 (structure export): the pipeline's owner-matrix dimensions, one per
     * binding (`collection` names the binding; `binding` ids mean nothing on another instance).
     */
    dimensions?: Array<Record<string, unknown>>
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
  /** Templates the workflows' actions reference. Absent on blueprints made before them. */
  payload_templates?: PayloadTemplateBundle[]
  /**
   * Hub enhancement 46 (structure export only, `exportBlueprint(…, {structure: true})`): roles
   * with their policies (no people), keyed by the role's uuid so the role ids that transitions,
   * layouts and queues name still resolve. Absent on every other blueprint.
   */
  roles?: Array<{ role: Record<string, unknown>; policies: Array<Record<string, unknown>> }>
  /**
   * Hub enhancement 46 (structure export only): flows with their operations. Always exported and
   * installed INACTIVE (an administrator turns each one on after review).
   */
  flows?: Array<{ flow: Record<string, unknown>; operations: Array<Record<string, unknown>> }>
}

export interface ExportOptions {
  /**
   * Hub enhancement 46 (app cloning): also roles + policies, flows + operations and the
   * pipelines' owner dimensions — the whole structure of an app, never its people or records.
   */
  structure?: boolean
}

const PHYSICAL_TYPES = new Set([
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
])

function strip<T extends Record<string, unknown>>(row: T, drop: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const k of drop) delete out[k]
  return out
}

export function isBlueprint(v: unknown): v is Blueprint {
  return !!v && typeof v === 'object' && (v as Blueprint).type === 'nivaro-blueprint'
}

// ─── Published packages (#661) ──────────────────────────────────────────────
// A publish wraps the plain blueprint with a manifest so a receiving instance
// can show what it is (and diff it) BEFORE installing. Bare blueprints stay
// valid everywhere — unwrapBlueprint() accepts both shapes.

export interface BlueprintManifest {
  name: string
  description: string | null
  version: string | null
  exported_at: string
  nivaro_version: string
  collections: string[]
  counts: {
    collections: number
    fields: number
    relations: number
    workflows: number
    layouts: number
    queues: number
    rules: number
    /** Structure exports only (Hub enhancement 46). */
    roles?: number
    flows?: number
  }
}

export interface PublishedBlueprint {
  type: 'nivaro-blueprint-package'
  version: 1
  manifest: BlueprintManifest
  blueprint: Blueprint
}

export function isPublishedBlueprint(v: unknown): v is PublishedBlueprint {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as PublishedBlueprint).type === 'nivaro-blueprint-package' &&
    isBlueprint((v as PublishedBlueprint).blueprint)
  )
}

/** Accept a bare blueprint OR a published package — null when neither. */
export function unwrapBlueprint(v: unknown): Blueprint | null {
  if (isPublishedBlueprint(v)) return v.blueprint
  if (isBlueprint(v)) return v
  return null
}

export function buildManifest(
  bp: Blueprint,
  meta: { description?: string | null; version?: string | null; nivaroVersion: string }
): BlueprintManifest {
  return {
    name: bp.name,
    description: meta.description?.trim() || null,
    version: meta.version?.trim() || null,
    exported_at: bp.exported_at,
    nivaro_version: meta.nivaroVersion,
    collections: bp.collections.map((c) => String(c.meta.collection ?? '')),
    counts: {
      collections: bp.collections.length,
      fields: bp.collections.reduce((n, c) => n + c.fields.length, 0),
      relations: bp.relations.length,
      workflows: bp.workflows.length,
      layouts: bp.layouts.length,
      queues: bp.queues.length,
      rules: bp.rules.length,
      ...(bp.roles ? { roles: bp.roles.length } : {}),
      ...(bp.flows ? { flows: bp.flows.length } : {})
    }
  }
}

export interface BlueprintDiff {
  collections: Array<{
    collection: string
    exists: boolean
    /** Fields in the bundle that this instance does not have yet. */
    new_fields: string[]
  }>
  workflows: { new: number; existing: number }
  layouts: { new: number; existing: number }
  queues: { new: number; existing: number }
  rules: { new: number; existing: number }
  /** new = installs as an unpublished template; existing = only its draft would change. */
  payload_templates: { new: number; existing: number }
}

/** What installing this blueprint would ADD to the live instance — the same
 *  natural keys installBlueprint() dedupes on, so the diff predicts install. */
export async function diffBlueprintAgainstInstance(bp: Blueprint): Promise<BlueprintDiff> {
  const diff: BlueprintDiff = {
    collections: [],
    workflows: { new: 0, existing: 0 },
    layouts: { new: 0, existing: 0 },
    queues: { new: 0, existing: 0 },
    rules: { new: 0, existing: 0 },
    payload_templates: { new: 0, existing: 0 }
  }

  for (const col of bp.collections) {
    const name = String(col.meta.collection ?? '')
    if (!/^[a-zA-Z0-9_]+$/.test(name) || name.startsWith('nivaro_')) continue
    const existing = await db('nivaro_collections').where({ collection: name }).first()
    const fieldRows = (await db('nivaro_fields')
      .where({ collection: name })
      .select('field')) as Array<{ field: string }>
    const have = new Set(fieldRows.map((f) => f.field))
    diff.collections.push({
      collection: name,
      exists: !!existing,
      new_fields: col.fields.map((f) => String(f.field ?? '')).filter((f) => f && !have.has(f))
    })
  }

  for (const wf of bp.workflows) {
    const existing = await db('nivaro_workflow_templates')
      .where({ id: String(wf.template.id) })
      .first()
    if (existing) diff.workflows.existing++
    else diff.workflows.new++
  }
  for (const l of bp.layouts) {
    const existing = await db('nivaro_collection_layouts')
      .where({ collection: l.layout.collection as string, name: l.layout.name as string })
      .first()
    if (existing) diff.layouts.existing++
    else diff.layouts.new++
  }
  for (const q of bp.queues) {
    const existing = await db('nivaro_queues')
      .where({ id: q.queue.id as string })
      .first()
    if (existing) diff.queues.existing++
    else diff.queues.new++
  }
  for (const r of bp.rules) {
    const existing = await db('nivaro_rules')
      .where({ collection: r.collection as string, name: r.name as string })
      .first()
    if (existing) diff.rules.existing++
    else diff.rules.new++
  }
  for (const t of Array.isArray(bp.payload_templates) ? bp.payload_templates : []) {
    let existing = false
    try {
      existing = !!(await getTemplate(String(t?.key ?? '')))
    } catch {
      existing = false
    }
    if (existing) diff.payload_templates.existing++
    else diff.payload_templates.new++
  }

  return diff
}

// ─── Export ─────────────────────────────────────────────────────────────────

export async function exportBlueprint(
  name: string,
  collections: string[],
  opts: ExportOptions = {}
): Promise<Blueprint> {
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
        .map((b) => strip(b, ['id', 'created_at', 'updated_at'])),
      ...(opts.structure
        ? { dimensions: await dimensionsOf(bindings.filter((b) => String(b.template) === tid)) }
        : {})
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
        (await db('nivaro_field_groups').where({ layout_id: lid })) as Array<
          Record<string, unknown>
        >
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

  const payload_templates = await bundleReferencedTemplates(
    workflows.flatMap((w) => w.transitions.map((t) => t.actions))
  )

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
    rules,
    payload_templates,
    ...(opts.structure ? { roles: await exportRoles(), flows: await exportFlows() } : {})
  }
}

/** A pipeline's owner dimensions for these bindings, keyed by the binding's collection. */
async function dimensionsOf(
  bindings: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  const byId = new Map(bindings.map((b) => [Number(b.id), String(b.collection ?? '')]))
  const ids = [...byId.keys()].filter((id) => Number.isSafeInteger(id) && id > 0)
  if (!ids.length) return []
  try {
    const rows = (await db('nivaro_pipeline_owner_dimensions')
      .whereIn('binding', ids)
      .orderBy('sort')) as Array<Record<string, unknown>>
    return rows.map((d) => ({
      ...strip(d, ['id', 'binding']),
      collection: byId.get(Number(d.binding)) ?? null
    }))
  } catch {
    return [] // an instance without the owner matrix table
  }
}

/** Every role with its policies (no people: users are never part of a structure export). */
async function exportRoles(): Promise<NonNullable<Blueprint['roles']>> {
  const roles = (await db('nivaro_roles').orderBy('name')) as Array<Record<string, unknown>>
  const out: NonNullable<Blueprint['roles']> = []
  for (const role of roles) {
    const policies = (await db('nivaro_policies').where({ role: role.id as string })) as Array<
      Record<string, unknown>
    >
    out.push({
      role: strip(role, ['workspace', 'created_at', 'updated_at']),
      policies: policies.map((p) => strip(p, ['id', 'created_at']))
    })
  }
  return out
}

/** Every flow with its operations, each flow marked inactive (Hub enhancement 46). */
async function exportFlows(): Promise<NonNullable<Blueprint['flows']>> {
  const flows = (await db('nivaro_flows').orderBy('name')) as Array<Record<string, unknown>>
  const out: NonNullable<Blueprint['flows']> = []
  for (const flow of flows) {
    const operations = (await db('nivaro_flow_operations').where({
      flow: flow.id as string
    })) as Array<Record<string, unknown>>
    out.push({
      flow: { ...strip(flow, ['created_at', 'updated_at']), status: 'inactive' },
      operations: operations.map((o) => strip(o, ['created_at']))
    })
  }
  return out
}

/** Every `payload_template_key` named by the actions in these transition `actions` blobs. */
function referencedTemplateKeys(actionBlobs: unknown[]): string[] {
  const keys = new Set<string>()
  for (const blob of actionBlobs) {
    let actions: unknown
    try {
      actions = typeof blob === 'string' ? JSON.parse(blob) : blob
    } catch {
      continue
    }
    if (!Array.isArray(actions)) continue
    for (const a of actions) {
      const k = (a as { payload_template_key?: unknown } | null)?.payload_template_key
      if (typeof k === 'string' && k.trim()) keys.add(k.trim())
    }
  }
  return [...keys]
}

/** The published body + metadata of each referenced template; unpublished / missing ones are left out. */
async function bundleReferencedTemplates(actionBlobs: unknown[]): Promise<PayloadTemplateBundle[]> {
  const out: PayloadTemplateBundle[] = []
  for (const key of referencedTemplateKeys(actionBlobs)) {
    try {
      const t = await getTemplate(key)
      if (!t?.published_mode || t.published_body == null) continue
      out.push({
        key: t.key,
        label: t.label,
        description: t.description,
        external_api: t.external_api,
        endpoint_path: t.endpoint_path,
        collection: t.collection,
        mode: t.published_mode,
        body: t.published_body,
        locked_keys: t.locked_keys,
        lookups: t.lookups
      })
    } catch {
      /* templates table unreadable (pre-501 instance): nothing to bundle */
    }
  }
  return out
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
  /** created = new and unpublished; drafted = an existing template's draft replaced. */
  payload_templates: { created: number; drafted: number; skipped: number }
  /** Structure blueprints only (Hub enhancement 46): roles (with their policies) and flows. */
  roles?: { created: number; skipped: number }
  flows?: { created: number; skipped: number }
  errors: string[]
}

async function tableExists(name: string): Promise<boolean> {
  const rows = rawRows<{ x: number }>(
    await db.raw(
      `SELECT 1 AS x FROM information_schema.tables WHERE TABLE_NAME = ?${inThisSchema(db, 'TABLE_SCHEMA')}`,
      [name]
    )
  )
  return rows.length > 0
}

async function tableColumns(name: string): Promise<Set<string>> {
  const rows = rawRows<{ name: string }>(
    await db.raw(
      `SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE TABLE_NAME = ?${inThisSchema(db, 'TABLE_SCHEMA')}`,
      [name]
    )
  )
  return new Set(rows.map((r) => r.name))
}

export interface InstallOptions {
  /**
   * Hub enhancement 24 (review M5): each workflow, layout and queue goes in with its children in
   * ONE transaction, so a failure never leaves a parent whose children a retry would skip. The
   * collections part stays per field (DDL cannot share a transaction everywhere) and resumes
   * field by field anyway.
   */
  atomic?: boolean
  /** Called once per part with its outcome (`collection:<name>`, `workflow:<id>` …). */
  onPart?: (part: string, ok: boolean) => void
}

export async function installBlueprint(
  bp: Blueprint,
  ownerId: string | null,
  opts: InstallOptions = {}
): Promise<InstallReport> {
  const atomic = <T>(run: (k: Knex | Knex.Transaction) => Promise<T>): Promise<T> =>
    opts.atomic ? db.transaction((trx) => run(trx)) : run(db)
  const part = (key: string, ok: boolean) => opts.onPart?.(key, ok)
  const report: InstallReport = {
    collections: { created: 0, skipped: 0 },
    columns: { created: 0 },
    fields: { created: 0, skipped: 0 },
    relations: { created: 0, skipped: 0 },
    workflows: { created: 0, skipped: 0 },
    layouts: { created: 0, skipped: 0 },
    queues: { created: 0, skipped: 0 },
    rules: { created: 0, skipped: 0 },
    payload_templates: { created: 0, drafted: 0, skipped: 0 },
    errors: []
  }
  const now = new Date()
  const err = (msg: string) => {
    if (report.errors.length < 20) report.errors.push(msg)
  }

  // Collections: physical table + metadata + typed columns
  for (const col of bp.collections) {
    const name = String(col.meta.collection ?? '')
    if (!/^[a-zA-Z0-9_]+$/.test(name) || /^(nivaro_|directus_)/i.test(name)) {
      err(`invalid collection name: ${name}`)
      part(`collection:${name}`, false)
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
              case 'string':
                t.string(fname, 255)
                break
              case 'text':
                t.text(fname)
                break
              case 'integer':
                t.integer(fname)
                break
              case 'bigInteger':
                t.bigInteger(fname)
                break
              case 'boolean':
                t.boolean(fname)
                break
              case 'decimal':
                t.decimal(fname, 18, 4)
                break
              case 'float':
                t.float(fname)
                break
              case 'date':
                t.date(fname)
                break
              case 'datetime':
                t.datetime(fname)
                break
              case 'uuid':
                t.uuid(fname)
                break
            }
          })
          report.columns.created++
        }
        const existingField = await db('nivaro_fields')
          .where({ collection: name, field: fname })
          .first()
        if (existingField) report.fields.skipped++
        else {
          await db('nivaro_fields').insert({
            ...f,
            collection: name,
            created_at: now,
            updated_at: now
          })
          report.fields.created++
        }
      }
      part(`collection:${name}`, true)
    } catch (e) {
      err(`${name}: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
      part(`collection:${name}`, false)
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
      part(`relation:${String(r.many_collection)}.${String(r.many_field)}`, true)
    } catch (e) {
      err(`relation: ${e instanceof Error ? e.message.slice(0, 120) : 'failed'}`)
      part(`relation:${String(r.many_collection)}.${String(r.many_field)}`, false)
    }
  }

  // Roles before everything that names a role id (queues.role_id, transitions, layouts). Skipped
  // whole when its id or its name is here already (a new app has its own administrator role).
  if (Array.isArray(bp.roles)) {
    report.roles = { created: 0, skipped: 0 }
    for (const r of bp.roles) {
      const rid = String(r.role?.id ?? '')
      const rname = String(r.role?.name ?? '')
      try {
        const existing =
          (await db('nivaro_roles').where({ id: rid }).first('id')) ??
          (await db('nivaro_roles').where({ name: rname }).first('id'))
        if (!rid || !rname || existing) {
          report.roles.skipped++
          part(`role:${rname}`, true)
          continue
        }
        await atomic(async (k) => {
          await k('nivaro_roles').insert({ ...r.role, created_at: now, updated_at: now })
          for (const p of Array.isArray(r.policies) ? r.policies : [])
            await k('nivaro_policies').insert({ ...p, role: rid, created_at: now })
        })
        report.roles.created++
        part(`role:${rname}`, true)
      } catch (e) {
        err(`role ${rname}: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
        part(`role:${rname}`, false)
      }
    }
  }

  // Payload templates before the workflows whose actions reference them — as drafts only
  for (const t of Array.isArray(bp.payload_templates) ? bp.payload_templates : []) {
    try {
      const out = await installTemplateDraft(
        t,
        ownerId,
        `Draft installed from blueprint ${bp.name}`
      )
      if (out === 'created') report.payload_templates.created++
      else if (out === 'drafted') report.payload_templates.drafted++
      else report.payload_templates.skipped++
      part(`payload:${String(t?.key)}`, true)
    } catch (e) {
      err(`payload template ${t?.key}: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
      part(`payload:${String(t?.key)}`, false)
    }
  }

  // Workflows: uuid-keyed — skip whole template when id exists
  for (const wf of bp.workflows) {
    try {
      const tid = String(wf.template.id)
      const existing = await db('nivaro_workflow_templates').where({ id: tid }).first()
      if (existing) {
        report.workflows.skipped++
        part(`workflow:${tid}`, true)
        continue
      }
      await atomic(async (k) => {
        await k('nivaro_workflow_templates').insert({
          ...wf.template,
          created_at: now,
          updated_at: now
        })
        for (const st of wf.states) await k('nivaro_workflow_states').insert(st)
        for (const tx of wf.transitions) await k('nivaro_workflow_transitions').insert(tx)
        for (const b of wf.bindings) {
          const bound = await k('nivaro_workflow_bindings')
            .where({ collection: b.collection as string })
            .first()
          if (bound) continue
          await k('nivaro_workflow_bindings').insert(b)
          // Hub enhancement 46: the pipeline's owner dimensions of this (new) binding.
          const dims = (Array.isArray(wf.dimensions) ? wf.dimensions : []).filter(
            (d) => d.collection === b.collection
          )
          if (!dims.length) continue
          const made = (await k('nivaro_workflow_bindings')
            .where({ collection: b.collection as string, template: tid })
            .first('id')) as { id: number } | undefined
          if (!made) continue
          for (const d of dims) {
            const { collection: _c, ...row } = d
            await k('nivaro_pipeline_owner_dimensions').insert({ ...row, binding: Number(made.id) })
          }
        }
      })
      report.workflows.created++
      part(`workflow:${tid}`, true)
    } catch (e) {
      err(`workflow: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
      part(`workflow:${String(wf.template?.id)}`, false)
    }
  }

  // Layouts: (collection, name) natural key; remap new int id into children
  for (const l of bp.layouts) {
    try {
      const key = { collection: l.layout.collection as string, name: l.layout.name as string }
      const existing = await db('nivaro_collection_layouts').where(key).first()
      if (existing) {
        report.layouts.skipped++
        part(`layout:${key.collection}/${key.name}`, true)
        continue
      }
      await atomic(async (k) => {
        const [idRow] = await k('nivaro_collection_layouts')
          .insert({ ...l.layout, created_at: now, updated_at: now })
          .returning('id')
        const newId = typeof idRow === 'object' ? (idRow as { id: number }).id : idRow
        for (const g of l.groups) await k('nivaro_field_groups').insert({ ...g, layout_id: newId })
        for (const a of l.assignments) {
          await k('nivaro_layout_field_assignments').insert({ ...a, layout_id: newId })
        }
      })
      report.layouts.created++
      part(`layout:${key.collection}/${key.name}`, true)
    } catch (e) {
      err(`layout: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
      part(`layout:${String(l.layout?.collection)}/${String(l.layout?.name)}`, false)
    }
  }

  // Queues: uuid-keyed; installer becomes owner
  for (const q of bp.queues) {
    try {
      const existing = await db('nivaro_queues')
        .where({ id: q.queue.id as string })
        .first()
      if (existing) {
        report.queues.skipped++
        part(`queue:${String(q.queue.id)}`, true)
        continue
      }
      await atomic(async (k) => {
        await k('nivaro_queues').insert({
          ...q.queue,
          owner: ownerId,
          materialized: false,
          created_at: now,
          updated_at: now
        })
        for (const src of q.sources) {
          await k('nivaro_queue_sources').insert({ ...src, queue_id: q.queue.id })
        }
      })
      report.queues.created++
      part(`queue:${String(q.queue.id)}`, true)
    } catch (e) {
      err(`queue: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
      part(`queue:${String(q.queue?.id)}`, false)
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
      part(`rule:${String(r.collection)}/${String(r.name)}`, true)
    } catch (e) {
      err(`rule: ${e instanceof Error ? e.message.slice(0, 120) : 'failed'}`)
      part(`rule:${String(r.collection)}/${String(r.name)}`, false)
    }
  }

  // Flows last, always INACTIVE (Hub enhancement 46): a flow can run on a schedule or on every
  // write, so an administrator turns each one on after reading it. uuid-keyed: skipped when here.
  if (Array.isArray(bp.flows)) {
    report.flows = { created: 0, skipped: 0 }
    for (const f of bp.flows) {
      const fid = String(f.flow?.id ?? '')
      try {
        if (!fid || (await db('nivaro_flows').where({ id: fid }).first('id'))) {
          report.flows.skipped++
          part(`flow:${fid}`, true)
          continue
        }
        // A webhook trigger never arrives open: bearer auth with a secret made here (the source's
        // secret never leaves it; an empty one would be read as "misconfigured").
        const flowRow: Record<string, unknown> = { ...f.flow }
        if (String(flowRow.trigger ?? '') === 'webhook') {
          let opts: Record<string, unknown> = {}
          try {
            const raw = flowRow.trigger_options
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
              opts = parsed as Record<string, unknown>
          } catch {
            opts = {}
          }
          flowRow.trigger_options = JSON.stringify({
            ...opts,
            auth_type: 'bearer',
            secret: randomBytes(24).toString('hex')
          })
        }
        await atomic(async (k) => {
          await k('nivaro_flows').insert({
            ...flowRow,
            status: 'inactive',
            created_at: now,
            updated_at: now
          })
          for (const op of Array.isArray(f.operations) ? f.operations : [])
            await k('nivaro_flow_operations').insert({ ...op, flow: fid, created_at: now })
        })
        report.flows.created++
        part(`flow:${fid}`, true)
      } catch (e) {
        err(`flow: ${e instanceof Error ? e.message.slice(0, 150) : 'failed'}`)
        part(`flow:${fid}`, false)
      }
    }
  }

  return report
}
