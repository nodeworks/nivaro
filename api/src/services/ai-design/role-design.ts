import { createHash, randomUUID } from 'node:crypto'
import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { applyRowFilter, parseRowFilter, type RowCondition } from '../permissions.js'
import { type AiComplete, asArray, cleanText, parseJsonLoose } from './model.js'

/**
 * Design a role from a description (#2010).
 *
 * "Reads invoices in Zone 3, approves inventory requests, cannot export"
 * becomes a PROPOSED role — policies with field limits and row filters, UI
 * routes to switch off, and User Scopes to give its members. Nothing is
 * written until an admin has edited the proposal, run the permission
 * simulator on exactly what will be saved (the apply call carries the hash
 * the simulation returned), and confirmed.
 *
 * The model's answer is data. Every collection, action, field, row-filter
 * column, UI route and scope value is checked against the instance's own
 * schema; anything unknown is dropped and SAID so. A policy is dropped whole
 * rather than widened: if a field limit or a row filter cannot be kept, the
 * grant goes with it. The designer never proposes admin access.
 */

export const ACTIONS = ['create', 'read', 'update', 'delete'] as const
export type DesignAction = (typeof ACTIONS)[number]

export interface ProposedPolicy {
  collection: string
  action: DesignAction
  fields: string[] | null
  row_filter: RowCondition[] | null
  why: string | null
}

export interface ProposedScope {
  dimension: string
  values: string[]
  labels: string[]
}

export interface RoleProposal {
  name: string
  description: string
  app_access: boolean
  policies: ProposedPolicy[]
  ui_disabled: string[]
  scopes: ProposedScope[]
  notes: string[]
}

export interface CatalogCollection {
  label: string
  fields: Set<string>
  /** Physical columns — row filters compile to SQL, so only these may appear. */
  columns: Set<string>
  /** M2O field → target collection (row filters on dimension links). */
  links: Map<string, string>
}

export interface RoleCatalog {
  collections: Map<string, CatalogCollection>
  dimensions: Array<{
    name: string
    label: string
    target_collection: string
    values: Array<{ id: string; label: string }>
  }>
  ui_routes: Array<{ path: string; label: string }>
}

const MAX_POLICIES = 200
const MAX_DETAILED = 10
const MAX_DIM_VALUES = 40

const isSystem = (c: string) => /^(nivaro|directus)_/i.test(c)

// ── Catalog ───────────────────────────────────────────────────────────────────

export async function loadRoleCatalog(
  uiRoutes: Array<{ path: string; label: string }>
): Promise<RoleCatalog> {
  const [cols, fields, columns, rels, dims] = await Promise.all([
    db('nivaro_collections').select('collection', 'display_name', 'hidden') as Promise<
      Array<{ collection: string; display_name: string | null; hidden: unknown }>
    >,
    db('nivaro_fields').select('collection', 'field') as Promise<
      Array<{ collection: string; field: string }>
    >,
    db('information_schema.columns').select({
      table: 'TABLE_NAME',
      column: 'COLUMN_NAME'
    }) as Promise<Array<{ table: string; column: string }>>,
    db('nivaro_relations')
      .whereNotNull('one_collection')
      .select('many_collection', 'many_field', 'one_collection') as Promise<
      Array<{ many_collection: string; many_field: string; one_collection: string }>
    >,
    db('nivaro_scope_dimensions')
      .where((q) => {
        q.where({ is_active: 1 }).orWhereNull('is_active')
      })
      .select('name', 'label', 'target_collection', 'display_field')
      .catch(() => []) as Promise<
      Array<{
        name: string
        label: string
        target_collection: string
        display_field: string | null
      }>
    >
  ])
  const collections = new Map<string, CatalogCollection>()
  for (const c of cols) {
    if (isSystem(c.collection)) continue
    collections.set(c.collection, {
      label: c.display_name || c.collection,
      fields: new Set(),
      columns: new Set(),
      links: new Map()
    })
  }
  for (const f of fields) collections.get(f.collection)?.fields.add(f.field)
  for (const c of columns) collections.get(c.table)?.columns.add(c.column)
  for (const r of rels)
    collections.get(r.many_collection)?.links.set(r.many_field, r.one_collection)

  const dimensions: RoleCatalog['dimensions'] = []
  for (const d of dims) {
    const target = collections.get(d.target_collection)
    const labelCol =
      d.display_field && target?.columns.has(d.display_field)
        ? d.display_field
        : ['name', 'short_name', 'title', 'label'].find((c) => target?.columns.has(c))
    let values: Array<{ id: string; label: string }> = []
    try {
      const rows = (await db(d.target_collection)
        .select(labelCol ? ['id', labelCol] : ['id'])
        .orderBy('id')
        .limit(MAX_DIM_VALUES)) as Array<Record<string, unknown>>
      values = rows.map((r) => ({
        id: String(r.id),
        label: labelCol && r[labelCol] != null ? String(r[labelCol]) : String(r.id)
      }))
    } catch {
      /* a dimension whose table is gone offers no values */
    }
    dimensions.push({
      name: d.name,
      label: d.label,
      target_collection: d.target_collection,
      values
    })
  }
  return { collections, dimensions, ui_routes: uiRoutes }
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .map((w) => w.replace(/(ies)$/, 'y').replace(/s$/, ''))

/** Collections the description mentions — they get their full field list. */
export function relevantCollections(description: string, catalog: RoleCatalog): string[] {
  const want = new Set(words(description))
  const scored: Array<{ c: string; n: number }> = []
  for (const [c, meta] of catalog.collections) {
    const n = [...new Set([...words(c), ...words(meta.label)])].filter((w) => want.has(w)).length
    if (n > 0) scored.push({ c, n })
  }
  return scored
    .sort((a, b) => b.n - a.n || a.c.localeCompare(b.c))
    .slice(0, MAX_DETAILED)
    .map((s) => s.c)
}

const ROLE_SYSTEM = `You design access roles for a business data platform. You get a plain-language description of a role and the platform's catalog.
Answer with ONE JSON object and nothing else:
{"name":"<short role name>","description":"<one sentence>","app_access":true,
 "policies":[{"collection":"<collection key>","action":"create|read|update|delete","fields":null or ["<field>"],"row_filter":null or [{"field":"<column>","op":"eq|neq|gt|gte|lt|lte|contains|in|null|nnull","value":<value>}],"why":"<which words of the description this serves>"}],
 "ui_disabled":["<route path>"],
 "scopes":[{"dimension":"<dimension name>","values":["<value id>"]}],
 "notes":["<anything the description asks for that you could not express>"]}
Rules: grant the least access that satisfies the description. "Approves X" means read + update on X. Use only collection keys, field keys, columns, route paths, dimension names and value ids from the catalog. A row_filter restricts rows of THAT collection by its own columns (use a link column's target ids, e.g. a division column with ids from the dimension values). Put a restriction that cannot be written as a row filter into "scopes" (User Scopes for the role's members) or "notes". Never grant admin access. "Cannot export" and similar UI restrictions go in ui_disabled when a matching route exists, else in notes.`

export function buildRolePrompt(description: string, catalog: RoleCatalog): string {
  const detailed = relevantCollections(description, catalog)
  const lines: string[] = []
  lines.push(`Description: ${description}`)
  lines.push('')
  lines.push('Collections (key — label):')
  for (const [c, meta] of [...catalog.collections].slice(0, 400))
    lines.push(`- ${c} — ${meta.label}`)
  for (const c of detailed) {
    const meta = catalog.collections.get(c)
    if (!meta) continue
    lines.push('')
    lines.push(`Fields of ${c}: ${[...meta.fields].slice(0, 80).join(', ')}`)
    const links = [...meta.links].filter(([f]) => meta.columns.has(f))
    if (links.length)
      lines.push(
        `Link columns of ${c}: ${links
          .slice(0, 30)
          .map(([f, t]) => `${f} → ${t}`)
          .join(', ')}`
      )
  }
  if (catalog.dimensions.length) {
    lines.push('')
    lines.push('Scope dimensions:')
    for (const d of catalog.dimensions)
      lines.push(
        `- ${d.name} ("${d.label}", ${d.target_collection}): ${d.values
          .map((v) => `${v.id}=${v.label}`)
          .join(', ')}`
      )
  }
  if (catalog.ui_routes.length) {
    lines.push('')
    lines.push('UI routes (path — label):')
    for (const r of catalog.ui_routes.slice(0, 200)) lines.push(`- ${r.path} — ${r.label}`)
  }
  return lines.join('\n')
}

// ── Validation ────────────────────────────────────────────────────────────────

const CURRENT_TOKENS = new Set(['$CURRENT_USER', '$CURRENT_ROLE'])

/**
 * Check a proposal (from the model OR edited by the admin) against the
 * catalog. Returns the kept proposal and a sentence per thing dropped.
 */
export function normalizeRoleProposal(
  raw: unknown,
  catalog: RoleCatalog
): { proposal: RoleProposal; dropped: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const dropped: string[] = []
  const byKey = new Map<string, ProposedPolicy>()

  for (const p of asArray(r.policies).slice(0, MAX_POLICIES * 2)) {
    const o = (p ?? {}) as Record<string, unknown>
    const collection = typeof o.collection === 'string' ? o.collection : ''
    const action = String(o.action ?? '') as DesignAction
    const meta = catalog.collections.get(collection)
    if (!meta || isSystem(collection)) {
      dropped.push(`Dropped a ${action || 'policy'} grant on "${collection}" — no such collection.`)
      continue
    }
    if (!ACTIONS.includes(action)) {
      dropped.push(`Dropped a grant on ${collection} with unknown action "${String(o.action)}".`)
      continue
    }
    let fields: string[] | null = null
    if (Array.isArray(o.fields) && o.fields.length > 0) {
      const asked = o.fields.filter((f): f is string => typeof f === 'string')
      const kept = asked.filter((f) => meta.fields.has(f) || meta.columns.has(f))
      const unknown = asked.filter((f) => !kept.includes(f))
      if (kept.length === 0) {
        dropped.push(
          `Dropped ${action} on ${collection}: none of its field limits exist (${unknown.join(', ')}), and granting every field instead would widen it.`
        )
        continue
      }
      if (unknown.length)
        dropped.push(
          `Removed unknown fields from ${action} on ${collection}: ${unknown.join(', ')}.`
        )
      fields = [...new Set(kept)]
    }
    let rowFilter: RowCondition[] | null = null
    if (o.row_filter != null && !(Array.isArray(o.row_filter) && o.row_filter.length === 0)) {
      const parsed = parseRowFilter(o.row_filter)
      const bad = parsed
        ? parsed.filter((c) => !meta.columns.has(c.field)).map((c) => c.field)
        : ['(unreadable filter)']
      if (!parsed || bad.length) {
        dropped.push(
          `Dropped ${action} on ${collection}: its row filter uses ${bad.join(', ')}, which is not a column there — granting it unfiltered would widen it.`
        )
        continue
      }
      rowFilter = parsed.map((c) => {
        if (c.op === 'null' || c.op === 'nnull') return { field: c.field, op: c.op }
        const value =
          typeof c.value === 'string' && CURRENT_TOKENS.has(c.value)
            ? c.value
            : Array.isArray(c.value)
              ? c.value.map((v) => (typeof v === 'number' ? v : String(v)))
              : c.value
        return { field: c.field, op: c.op, value }
      })
    }
    const key = `${collection}:${action}`
    if (byKey.has(key)) {
      dropped.push(`Merged a duplicate ${action} grant on ${collection} (kept the first).`)
      continue
    }
    byKey.set(key, {
      collection,
      action,
      fields,
      row_filter: rowFilter,
      why: cleanText(o.why, 200)
    })
    if (byKey.size >= MAX_POLICIES) break
  }

  const routeSet = new Set(catalog.ui_routes.map((u) => u.path))
  const uiDisabled: string[] = []
  for (const u of asArray(r.ui_disabled)) {
    if (typeof u !== 'string') continue
    if (routeSet.size ? routeSet.has(u) : /^\/[A-Za-z0-9/_:-]{0,120}$/.test(u)) {
      if (!uiDisabled.includes(u)) uiDisabled.push(u)
    } else dropped.push(`Ignored UI route "${u}" — not a page in this app.`)
  }

  const scopes: ProposedScope[] = []
  for (const s of asArray(r.scopes)) {
    const o = (s ?? {}) as Record<string, unknown>
    const dim = catalog.dimensions.find((d) => d.name === o.dimension)
    if (!dim) {
      dropped.push(`Ignored a scope on unknown dimension "${String(o.dimension)}".`)
      continue
    }
    const known = new Map(dim.values.map((v) => [v.id.toUpperCase(), v]))
    const values: string[] = []
    const labels: string[] = []
    for (const v of asArray(o.values)) {
      const hit = known.get(String(v).toUpperCase())
      if (hit && !values.includes(hit.id)) {
        values.push(hit.id)
        labels.push(hit.label)
      } else if (!hit) dropped.push(`Ignored ${dim.label} value "${String(v)}" — not found.`)
    }
    if (values.length && !scopes.some((x) => x.dimension === dim.name))
      scopes.push({ dimension: dim.name, values, labels })
  }

  const notes = asArray(r.notes)
    .map((n) => cleanText(n, 300))
    .filter((n): n is string => !!n)
    .slice(0, 8)

  return {
    proposal: {
      name: cleanText(r.name, 80) ?? 'New role',
      description: cleanText(r.description, 300) ?? '',
      app_access: r.app_access !== false,
      policies: [...byKey.values()].sort(
        (a, b) =>
          a.collection.localeCompare(b.collection) ||
          ACTIONS.indexOf(a.action) - ACTIONS.indexOf(b.action)
      ),
      ui_disabled: uiDisabled.sort(),
      scopes,
      notes
    },
    dropped
  }
}

/** A stable fingerprint of exactly what an apply would write. */
export function proposalHash(p: RoleProposal): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        name: p.name,
        description: p.description,
        app_access: p.app_access,
        policies: p.policies.map((x) => [x.collection, x.action, x.fields, x.row_filter]),
        ui_disabled: p.ui_disabled
      })
    )
    .digest('hex')
}

// ── Simulation ────────────────────────────────────────────────────────────────

export interface SimulatedAction {
  allowed: boolean
  reason: string
  fields: string[] | null
  row_filter: RowCondition[] | null
}

export interface SimulatedCollection {
  collection: string
  label: string
  actions: Record<DesignAction, SimulatedAction>
  /** Read impact: rows visible under the row filter (null = not counted). */
  rows: { total: number; visible: number } | null
  rows_error?: string
}

/**
 * The permission simulator's rules, run on the proposal instead of saved
 * policies: an exact-collection policy wins over none, fields null = all,
 * the row filter is what the role's members would be held to.
 */
export function simulateRoleProposal(
  proposal: RoleProposal,
  catalog: RoleCatalog,
  extraCollections: string[] = []
): SimulatedCollection[] {
  const names = [
    ...new Set([...proposal.policies.map((p) => p.collection), ...extraCollections])
  ].filter((c) => catalog.collections.has(c))
  return names.map((collection) => {
    const actions = {} as Record<DesignAction, SimulatedAction>
    for (const action of ACTIONS) {
      const p = proposal.policies.find((x) => x.collection === collection && x.action === action)
      actions[action] = p
        ? {
            allowed: true,
            reason: p.why ? `Granted: ${p.why}` : `Granted by the ${action} policy`,
            fields: p.fields,
            row_filter: p.row_filter
          }
        : {
            allowed: false,
            reason: `No ${action} policy on ${collection} — requests answer 403`,
            fields: null,
            row_filter: null
          }
    }
    return {
      collection,
      label: catalog.collections.get(collection)?.label ?? collection,
      actions,
      rows: null
    }
  })
}

/** Count what a member would see under each read row filter (first 8). */
export async function countReadImpact(sims: SimulatedCollection[]): Promise<void> {
  const synthetic = {
    id: '00000000-0000-0000-0000-000000000000',
    role: '00000000-0000-0000-0000-000000000000',
    email: 'simulated@nivaro',
    status: 'active'
  } as unknown as User
  let counted = 0
  for (const s of sims) {
    if (!s.actions.read.allowed || counted >= 8) continue
    counted++
    try {
      const totalRow = (await db(s.collection).count({ n: '*' }).first()) as { n?: number }
      const total = Number(totalRow?.n ?? 0)
      let visible = total
      if (s.actions.read.row_filter?.length) {
        const q = db(s.collection).count({ n: '*' })
        applyRowFilter(q, s.actions.read.row_filter, synthetic)
        visible = Number(((await q.first()) as { n?: number })?.n ?? 0)
      }
      s.rows = { total, visible }
    } catch (err) {
      s.rows_error = (err instanceof Error ? err.message : String(err)).slice(0, 200)
    }
  }
}

// ── Model + apply ─────────────────────────────────────────────────────────────

export async function designRole(
  description: string,
  catalog: RoleCatalog,
  complete: AiComplete
): Promise<{ proposal: RoleProposal; dropped: string[] }> {
  const text = await complete({
    system: ROLE_SYSTEM,
    user: buildRolePrompt(description, catalog),
    maxTokens: 3000
  })
  const parsed = parseJsonLoose(text)
  if (!parsed) throw new Error('The AI answer could not be read as a role proposal')
  return normalizeRoleProposal(parsed, catalog)
}

export async function applyRoleProposal(
  proposal: RoleProposal,
  workspaceId: string | null
): Promise<{ id: string; policies: number }> {
  const exists = await db('nivaro_roles').where({ name: proposal.name }).first('id')
  if (exists)
    throw Object.assign(new Error(`A role named "${proposal.name}" already exists`), {
      statusCode: 409
    })
  const id = randomUUID()
  await db.transaction(async (trx) => {
    await trx('nivaro_roles').insert({
      id,
      name: proposal.name,
      description: proposal.description || null,
      admin_access: false,
      app_access: proposal.app_access,
      ui_permissions: JSON.stringify(proposal.ui_disabled),
      workspace: workspaceId ?? null,
      created_at: new Date(),
      updated_at: new Date()
    })
    const rows = proposal.policies.map((p) => ({
      role: id,
      collection: p.collection,
      action: p.action,
      fields: p.fields ? JSON.stringify(p.fields) : null,
      row_filter: p.row_filter ? JSON.stringify(p.row_filter) : null,
      created_at: new Date()
    }))
    for (let i = 0; i < rows.length; i += 100)
      await trx('nivaro_policies').insert(rows.slice(i, i + 100))
  })
  return { id, policies: proposal.policies.length }
}
