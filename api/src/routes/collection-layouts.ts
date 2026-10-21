import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { buildAddendumRenderOverlay } from '../services/addendum-render.js'
import { markConfigRead, nameConfigCollection } from '../services/config-live.js'
import { ForbiddenError, ItemNotFoundError, readOne } from '../services/items.js'
import { activateLayout, lockLayout, whereLayoutType } from '../services/layout-activation.js'
import { loadLayoutBundle, placementColumns, runLayoutOps } from '../services/layout-ops.js'
import { buildLayoutOverview, type OverviewLayoutInput } from '../services/layout-overview.js'
import {
  isLayoutType,
  isRowId,
  isUniqueViolation,
  LAYOUT_NAME_TAKEN,
  LAYOUT_TYPES,
  type LayoutPatchBody,
  normalizeLayoutPatch,
  parseConditions,
  parseDefaultValues,
  parseLayoutRow,
  parseQuickPicker,
  parseRecordConditions,
  type RecordConditionRule,
  slugify
} from '../services/layout-patch.js'
import { findLayoutReferences } from '../services/layout-references.js'
import {
  diffLayoutVersions,
  getLayoutVersion,
  layoutDriftSweep,
  restoreLayoutVersion,
  snapshotLayoutVersion
} from '../services/layout-versions.js'
import { generatePdfFromLayout } from '../services/pdf-layout.js'
import { classicTheme, executiveTheme, minimalTheme } from '../services/pdf-layout-themes.js'
import { can } from '../services/permissions.js'
import { registerReadinessCheck } from '../services/readiness.js'
import { getStorage, getStorageProviderName } from '../services/storage/index.js'

export { parseConditions, parseRecordConditions, type RecordConditionRule, slugify }

// Does every rule match the given record? eq/neq compare via
// String(raw ?? '') === String(value) (tolerant of numeric/string mismatches,
// e.g. workflow_type stored as 2 vs '2'); nnull checks raw != null.
export function matchesRecordConditions(
  rules: RecordConditionRule[],
  record: Record<string, unknown>
): boolean {
  return rules.every((rule) => {
    const raw = record[rule.field]
    if (rule.op === 'nnull') return raw != null
    if (rule.op === 'eq') return String(raw ?? '') === String(rule.value)
    return String(raw ?? '') !== String(rule.value)
  })
}

/** A slug base from a layout NAME: letters, digits and _ only (an explicit slug keeps its dashes). */
export function slugBaseFromName(name: string): string {
  return slugify(name)
    .replace(/-+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** The first free slug for `base` in `collection`: base, base_2, base_3, … */
export async function nextFreeSlug(
  collection: string,
  base: string,
  trx?: Knex | Knex.Transaction
): Promise<string> {
  const q = trx ?? db
  const root = slugify(base) || 'layout'
  const rows = (await q('nivaro_collection_layouts')
    .where({ collection })
    .whereNotNull('slug')
    .select('slug')) as Array<{ slug: string }>
  const taken = new Set(rows.map((r) => String(r.slug).toLowerCase()))
  if (!taken.has(root)) return root
  for (let n = 2; ; n++) {
    if (!taken.has(`${root}_${n}`)) return `${root}_${n}`
  }
}

/** Layout settings a clone carries over — every column except identity
 *  (id/collection/name/slug/sort/is_active/created_at) and the type (the
 *  clone request may change it). parent_layout_id is carried: a copy of a
 *  child inherits from the same parent, so it renders the same form.
 *  Retired settings nothing reads (summary_show_all, allow_clone,
 *  addendum_lock_fields) are not copied: their columns stay, unwritten. */
const CLONE_CARRIED_COLUMNS = [
  'parent_layout_id',
  'disable_comments',
  'disable_tasks',
  'tab_mode',
  'validate_before_next',
  'summary_enabled',
  'ai_enabled',
  'conditions',
  'allow_schedule',
  'allow_disable_pickers',
  'pdf_theme',
  'pdf_template_id',
  'pdf_cover_enabled',
  'pdf_cover_title_field',
  'pdf_cover_subtitle',
  'pdf_show_logo',
  'pdf_page_size',
  'pdf_orientation',
  'row_order_field',
  'disable_revisions',
  'disable_clone',
  'accordion_mode',
  'disable_delete',
  'summary_hide_empty',
  'pdf_button_label',
  'addendum_layout_id',
  'workflow_template_id',
  'single_active_addendum',
  'addendum_default_view',
  'record_conditions',
  'default_values',
  'create_label',
  'create_hidden',
  'display_mode',
  'hide_integrity_banner',
  'hide_sla_banner',
  'dossier_enabled',
  'dossier_label',
  'quick_picker',
  'sheet_width',
  'header_fields',
  'hide_empty',
  'changes_tray'
] as const

// Fetch the DB-ordered layout candidates for a collection (is_active desc,
// sort asc, id asc — the idiom both role- and record-condition tie-breaking
// rely on; id makes equal sorts resolve the way the overview names them).
async function fetchLayoutsForCollection(collection: string) {
  // Record-form resolution only — file/table/detail/addendum layouts must
  // never win the active-layout race for the editing form (an is_active
  // file layout used to hijack the whole record page).
  return db('nivaro_collection_layouts')
    .where({ collection })
    .where((b) => b.where({ layout_type: 'grouped' }).orWhereNull('layout_type'))
    .orderByRaw('is_active desc, sort asc, id asc')
}

// Union of field names referenced by any candidate layout's record_conditions.
// Used to restrict the item-record select to exactly what selection needs —
// the record fetch (against a caller-supplied collection name) must never be
// able to read a column no layout rule references.
function collectRecordConditionFields(layouts: Record<string, unknown>[]): string[] {
  const fields = new Set<string>()
  for (const row of layouts) {
    const rules = parseRecordConditions(row.record_conditions)
    if (!rules) continue
    for (const rule of rules) {
      if (typeof rule.field === 'string') fields.add(rule.field)
    }
  }
  return [...fields]
}

// Pick the best-matching layout given its DB-ordered candidates, the user's
// role, and (optionally) the record being edited. Precedence: record-condition
// layouts (ALL rules match; most rules wins; ties by is_active desc, sort asc)
// > role-condition layouts (conditions.role_ids includes userRoleId; most
// role_ids wins) > default (is_active=1) > first by sort. A layout carrying
// record_conditions is excluded from the role/default fallback pool entirely
// when it does not match (or no record is supplied) — it can never leak to
// non-matching records. Returns the raw DB row (JSON columns still strings)
// or null when no layout exists.
/**
 * Role allow-list. `conditions.role_ids` on a layout is a RESTRICTION, not a
 * preference: a non-admin whose role is not listed can never resolve, pin
 * (?layout=<slug>), list, or drill into that layout — record-condition
 * matches included (a CAR still resolves the admin-only PUB layout for an
 * admin, and the next allowed layout for everyone else). Empty/absent list =
 * open to all. Admins always pass.
 */
export function roleAllows(
  row: Record<string, unknown>,
  userRoleId: string | null | undefined,
  isAdmin: boolean
): boolean {
  if (isAdmin) return true
  const roleIds = parseConditions(row.conditions)?.role_ids
  if (!Array.isArray(roleIds) || roleIds.length === 0) return true
  if (!userRoleId) return false
  const want = String(userRoleId).toUpperCase()
  return roleIds.some((r) => String(r).toUpperCase() === want)
}

/** Why a layout won resolution — the overview's reason vocabulary. */
export type PickReason = {
  kind: 'record_rule' | 'role' | 'default' | 'fallback' | 'slug' | 'type_use'
  rules?: RecordConditionRule[]
  role_ids?: string[]
  role_names?: string[]
  type_use?: string
}
export type PickCheck = { layout_id: number; matched: boolean; why: string }
export type PickResult = {
  row: Record<string, unknown> | null
  reason: PickReason | null
  checked: PickCheck[]
}

export function pickBestLayout(
  allCandidates: Record<string, unknown>[],
  userRoleId: string | null | undefined,
  record: Record<string, unknown> | null,
  isAdmin = false
) {
  return pickBestLayoutTraced(allCandidates, userRoleId, record, isAdmin).row
}

/**
 * pickBestLayout with its working shown: the winner, the step that chose it
 * and one line per candidate (in candidate order) saying what its check found.
 * The one implementation — /active, /explain and preview-as-role all call it.
 */
export function pickBestLayoutTraced(
  allCandidates: Record<string, unknown>[],
  userRoleId: string | null | undefined,
  record: Record<string, unknown> | null,
  isAdmin = false
): PickResult {
  // Role-restricted layouts leave the candidate set entirely for non-listed
  // roles — before record conditions, before the default fallback.
  const layouts = allCandidates.filter((row) => roleAllows(row, userRoleId, isAdmin))

  const fallbackPool: typeof layouts = []
  const recordMatched = new Set<Record<string, unknown>>()
  const roleListed = new Set<Record<string, unknown>>()
  let bestRecordMatch: { row: (typeof layouts)[number]; matches: number } | null = null
  for (const row of layouts) {
    const rules = parseRecordConditions(row.record_conditions)
    if (rules) {
      if (record && matchesRecordConditions(rules, record)) {
        recordMatched.add(row)
        const matches = rules.length
        if (!bestRecordMatch || matches > bestRecordMatch.matches)
          bestRecordMatch = { row, matches }
      }
      continue // excluded from the role/default fallback pool regardless of match
    }
    fallbackPool.push(row)
  }

  let picked: Record<string, unknown> | null = null
  let reason: PickReason | null = null
  if (bestRecordMatch) {
    picked = bestRecordMatch.row
    reason = {
      kind: 'record_rule',
      rules: parseRecordConditions(picked.record_conditions) ?? []
    }
  }

  if (!picked && userRoleId) {
    let best: { row: (typeof layouts)[number]; matches: number } | null = null
    for (const row of fallbackPool) {
      const cond = parseConditions(row.conditions)
      const roleIds = cond?.role_ids
      if (Array.isArray(roleIds) && roleIds.includes(userRoleId)) {
        roleListed.add(row)
        const matches = roleIds.length
        if (!best || matches > best.matches) best = { row, matches }
      }
    }
    if (best) {
      picked = best.row
      reason = { kind: 'role', role_ids: parseConditions(picked.conditions)?.role_ids ?? [] }
    }
  }

  // Fall back to the active (default) layout, else the first by sort.
  if (!picked) {
    picked = fallbackPool.find((l) => l.is_active) ?? fallbackPool[0] ?? null
    if (picked) reason = { kind: picked.is_active ? 'default' : 'fallback' }
  }

  const winnerName = picked ? `“${String(picked.name ?? picked.id)}”` : ''
  const checked = allCandidates.map((row): PickCheck => {
    const layout_id = Number(row.id)
    if (row === picked) {
      const why =
        reason?.kind === 'record_rule'
          ? 'Its record rules match'
          : reason?.kind === 'role'
            ? 'Listed for this role'
            : reason?.kind === 'default'
              ? 'The default form'
              : allCandidates.some((c) => c.is_active)
                ? 'First in order among the forms this role can open'
                : 'First in order (no form is marked default)'
      return { layout_id, matched: true, why }
    }
    if (!layouts.includes(row))
      return { layout_id, matched: false, why: 'Restricted to other roles' }
    if (parseRecordConditions(row.record_conditions)) {
      if (!record)
        return { layout_id, matched: false, why: 'Has record rules; no saved record to test them' }
      if (recordMatched.has(row))
        return { layout_id, matched: true, why: `Its record rules match, but ${winnerName} wins` }
      return { layout_id, matched: false, why: 'Its record rules do not match' }
    }
    if (bestRecordMatch)
      return { layout_id, matched: false, why: 'A form with record rules matched first' }
    if (roleListed.has(row))
      return { layout_id, matched: true, why: `Listed for this role, but ${winnerName} wins` }
    return { layout_id, matched: false, why: `Not the default; ${winnerName} is used` }
  })

  return { row: picked, reason, checked }
}

/**
 * The /active resolution, step for step: slug pin → grouped candidates →
 * the record (only the columns rules name) → pickBestLayoutTraced. `role` is
 * the caller's role; admins (isAdmin) get no role preference, as on /active.
 */
export async function resolveLayout(opts: {
  collection: string
  slug?: string | null
  item?: string | null
  role: string | null
  isAdmin: boolean
}): Promise<PickResult> {
  const { collection, slug, item, role, isAdmin } = opts
  // Explicit slug pins a specific layout (any type — detail layouts use this
  // for drill-down rendering), bypassing role- and record-conditional resolution.
  let pinned: Record<string, unknown> | undefined | null
  const slugChecks: PickCheck[] = []
  if (slug) {
    pinned = await db('nivaro_collection_layouts').where({ collection, slug }).first()
    // A pinned slug the caller's role may not open (queue row_click,
    // ?layout= links, CBV) silently falls through to normal resolution.
    if (pinned && !roleAllows(pinned, role, isAdmin)) {
      slugChecks.push({
        layout_id: Number(pinned.id),
        matched: false,
        why: 'Its link name was asked for, but it is restricted to other roles'
      })
      pinned = null
    }
  }
  if (pinned) {
    return {
      row: pinned,
      reason: { kind: 'slug' },
      checked: [{ layout_id: Number(pinned.id), matched: true, why: 'Opened by its link name' }]
    }
  }

  // Admins always see the default layout (no conditional override).
  const userRoleId = isAdmin ? null : role
  const layouts = await fetchLayoutsForCollection(collection)

  // An unknown/missing item id, or a collection that isn't a registered
  // nivaro_collections entry, resolves to no record — falls through to
  // the role/default path exactly like the no-item case. The registry
  // gate stops `collection` (a caller-supplied query param) from ever
  // being used as an arbitrary table identifier, and the select below is
  // restricted to exactly the fields the candidate layouts' rules
  // reference, so this can't become a column-value probing oracle.
  let record: Record<string, unknown> | null = null
  if (item) {
    const registered = await db('nivaro_collections').where({ collection }).first()
    if (registered) {
      const columns = [...new Set(['id', ...collectRecordConditionFields(layouts)])]
      record =
        (await db(collection)
          .where({ id: item })
          .select(columns)
          .first()
          .catch(() => null)) ?? null
    }
  }
  const res = pickBestLayoutTraced(layouts, userRoleId, record, isAdmin)
  return { ...res, checked: [...slugChecks, ...res.checked] }
}

/**
 * A ?layout= pin the caller could legitimately be on for this record: a record
 * form (grouped, or legacy untyped) their role may open whose record rules,
 * when it has any, match the record. Null otherwise. /active honours any
 * role-allowed slug because there it only chooses presentation; where a pin
 * decides authorization (picker exclusions) it must pass this stricter check.
 */
export async function legitimatePinForRecord(opts: {
  collection: string
  slug: string
  item: string
  role: string | null
}): Promise<Record<string, unknown> | null> {
  const { collection, slug, item, role } = opts
  const row = (await db('nivaro_collection_layouts')
    .where({ collection, slug })
    .where((b) => b.where({ layout_type: 'grouped' }).orWhereNull('layout_type'))
    .first()) as Record<string, unknown> | undefined
  if (!row || !roleAllows(row, role, false)) return null
  const rules = parseRecordConditions(row.record_conditions)
  if (!rules) return row
  // Same guards as resolveLayout: a registered collection only, and only the
  // columns this layout's rules name.
  const registered = await db('nivaro_collections').where({ collection }).first()
  if (!registered) return null
  const columns = [
    ...new Set(['id', ...rules.map((r) => r.field).filter((f) => typeof f === 'string')])
  ]
  const record = (await db(collection)
    .where({ id: item })
    .select(columns)
    .first()
    .catch(() => null)) as Record<string, unknown> | null | undefined
  return record && matchesRecordConditions(rules, record) ? row : null
}

// Columns every record carries that a form never shows.
const SEED_SKIP_FIELDS = new Set([
  'id',
  'user_created',
  'user_updated',
  'date_created',
  'date_updated'
])

/**
 * Seed a new layout for "Create first form": one section "Main" holding every
 * non-hidden field of the collection in nivaro field order. System columns
 * and presentation/group pseudo fields (no value of their own) are left out;
 * relation alias fields stay — they render as grids and pickers.
 */
export async function seedLayoutFields(
  layout: { id: number; collection: string },
  trx: Knex | Knex.Transaction
) {
  const fields = (await trx('nivaro_fields')
    .where({ collection: layout.collection })
    .select('field', 'hidden', 'type', 'interface')
    .orderBy([
      { column: 'sort', order: 'asc' },
      { column: 'id', order: 'asc' }
    ])) as Array<{ field: string; hidden: unknown; type: string | null; interface: string | null }>
  const pseudo = (v: string | null) => /^(group-|presentation-)/.test(v ?? '')
  const keep = fields.filter(
    (f) => !f.hidden && !SEED_SKIP_FIELDS.has(f.field) && !pseudo(f.type) && !pseudo(f.interface)
  )
  await trx('nivaro_field_groups').insert({
    collection: layout.collection,
    key: 'main',
    label: 'Main',
    type: 'section',
    sort: 0,
    is_collapsed: 0,
    layout_id: Number(layout.id)
  })
  const rows = keep.map((f, i) => ({
    layout_id: Number(layout.id),
    field: f.field,
    group_key: 'main',
    sort: i,
    is_visible: 1
  }))
  // 5 bindings a row: stay well under the ~2100 parameter cap.
  for (let i = 0; i < rows.length; i += 200) {
    await trx('nivaro_layout_field_assignments').insert(rows.slice(i, i + 200))
  }
}

let driftCheckRegistered = false

export async function collectionLayoutsRoutes(app: FastifyInstance) {
  if (!driftCheckRegistered) {
    driftCheckRegistered = true
    registerReadinessCheck({
      id: 'layout-drift',
      label: 'No layout lost widths, flags or half its fields in its last save',
      group: 'Configuration',
      description:
        'Every layout mutation snapshots the state before it, so the newest version against the current rows is exactly what the last save changed. This names the shapes that meant damage before: column widths nulled wholesale, slot flags flipped off together, most assignments gone.',
      run: async () => {
        const hits = await layoutDriftSweep()
        if (hits.length === 0)
          return { status: 'pass', detail: "Every layout's last save looks like an ordinary edit." }
        return {
          status: 'warn',
          detail: `${hits.length} layout(s) changed in a data-losing shape on their last save — open Table Editor → Version history → "What the last save changed" to restore.`,
          blockers: hits
            .slice(0, 10)
            .map((h) => `${h.collection} · ${h.name} (#${h.layout_id}): ${h.warnings[0]}`)
        }
      }
    })
  }
  // Preview-as-role (#86): which layout a member of a role would resolve, and
  // which fields their permissions hide — answered with the SAME pickBestLayout
  // + getAllowedFields the live path uses (a parallel evaluator would drift).
  // Admin-only; record conditions can't be judged without a record and are
  // reported as such rather than guessed.
  app.get('/preview-as-role', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection, role_id } = req.query as { collection?: string; role_id?: string }
    if (!collection || !role_id) {
      return reply.code(400).send({ error: 'collection and role_id are required' })
    }
    const role = await db('nivaro_roles').where({ id: role_id }).first('id', 'name', 'admin_access')
    if (!role) return reply.code(404).send({ error: 'Role not found' })

    // The live path exactly: same candidates (grouped or legacy NULL, is_active
    // desc, sort asc) and an admin role gets no role preference, as on /active.
    const { row: picked } = await resolveLayout({
      collection,
      role: String(role_id),
      isAdmin: !!role.admin_access
    })
    const layouts = (await fetchLayoutsForCollection(collection)) as Record<string, unknown>[]
    const recordConditional = layouts.filter((l) => parseRecordConditions(l.record_conditions))

    // Field permissions via a synthetic user — the permission-simulator
    // precedent: real policy code, fabricated identity.
    const { getAllowedFields, can } = await import('../services/permissions.js')
    const syntheticUser = {
      id: '00000000-0000-0000-0000-000000000000',
      role: String(role_id)
    } as unknown as import('../types.js').User
    const [canRead, canUpdate, readFields, updateFields] = await Promise.all([
      can(syntheticUser, 'read', collection),
      can(syntheticUser, 'update', collection),
      getAllowedFields(syntheticUser, 'read', collection),
      getAllowedFields(syntheticUser, 'update', collection)
    ])

    const allFields = (await db('nivaro_fields').where({ collection }).pluck('field')) as string[]
    const readSet = readFields ? new Set(readFields) : null
    const updateSet = updateFields ? new Set(updateFields) : null
    return reply.send({
      data: {
        role: { id: role.id, name: role.name, admin_access: !!role.admin_access },
        can_read: !!canRead,
        can_update: !!canUpdate,
        // slug: the shared form pins the previewed layout by it.
        layout: picked
          ? {
              id: picked.id,
              name: picked.name,
              is_active: !!picked.is_active,
              slug: (picked.slug as string | null | undefined) ?? null
            }
          : null,
        // null field list = policy grants all fields
        hidden_fields: readSet ? allFields.filter((f) => !readSet.has(f)) : [],
        readonly_fields:
          canUpdate && updateSet
            ? allFields.filter((f) => !updateSet.has(f) && (!readSet || readSet.has(f)))
            : [],
        record_conditional_layouts: recordConditional.map((l) => String(l.name)),
        note:
          recordConditional.length > 0
            ? 'Record-conditional layouts depend on the record being opened and are not judged here.'
            : null
      }
    })
  })

  // ─── Overview + explain (layout editor) ──────────────────────────────────
  // "Which form does each kind of record get?" — every layout of the
  // collection, sectioned and ordered as /active checks them, with what
  // references each one. Admin-only, like the editor it opens.
  app.get('/overview', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    const layouts = (await db('nivaro_collection_layouts')
      .where({ collection })
      .orderByRaw('is_active desc, sort asc, id asc')
      .select(
        'id',
        'name',
        'layout_type',
        'slug',
        'is_active',
        'sort',
        'conditions',
        'record_conditions',
        'create_label',
        'create_hidden',
        'tab_mode'
      )) as OverviewLayoutInput[]
    const ids = layouts.map((l) => Number(l.id))
    const [groups, assignments, roles, refs] = await Promise.all([
      ids.length
        ? db('nivaro_field_groups')
            .whereIn('layout_id', ids)
            .select('id', 'key', 'type', 'container_id', 'tab_mode', 'layout_id')
        : [],
      ids.length
        ? db('nivaro_layout_field_assignments')
            .whereIn('layout_id', ids)
            .select('layout_id', 'field', 'group_key', 'is_visible')
        : [],
      db('nivaro_roles').select('id', 'name'),
      findLayoutReferences(collection)
    ])
    for (const l of layouts) {
      l.groups = groups.filter((g: { layout_id: number }) => Number(g.layout_id) === Number(l.id))
      l.assignments = assignments.filter(
        (a: { layout_id: number }) => Number(a.layout_id) === Number(l.id)
      )
    }
    return reply.send({
      data: {
        rows: buildLayoutOverview(layouts, refs, roles),
        warning: config.LAYOUT_EDIT_WARNING ?? null
      }
    })
  })

  // Which layout a saved record opens with, and why — the /active resolution
  // itself (resolveLayout), with each candidate's check. role_id tests as that
  // role (an admin role gets no role preference, as live); none = as an admin.
  app.get('/explain', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection, item, role_id, slug } = req.query as {
      collection?: string
      item?: string
      role_id?: string
      slug?: string
    }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    let role: string | null = req.user?.role ?? null
    let isAdmin = true
    if (role_id) {
      const r = await db('nivaro_roles').where({ id: role_id }).first('id', 'admin_access')
      if (!r) return reply.code(404).send({ error: 'Role not found' })
      role = String(r.id)
      isAdmin = !!r.admin_access
    }
    const res = await resolveLayout({ collection, slug, item, role, isAdmin })
    let reason = res.reason
    if (reason?.role_ids?.length) {
      const names = new Map(
        (
          (await db('nivaro_roles').whereIn('id', reason.role_ids).select('id', 'name')) as Array<{
            id: string
            name: string
          }>
        ).map((r) => [String(r.id).toUpperCase(), r.name])
      )
      reason = {
        ...reason,
        role_names: reason.role_ids.map((id) => names.get(id.toUpperCase()) ?? id)
      }
    }
    return reply.send({
      data: {
        layout_id: res.row ? Number(res.row.id) : null,
        reason,
        checked: res.checked
      }
    })
  })

  // GET /collection-layouts/active?collection=x — MUST be before /:id
  app.get('/active', { preHandler: authenticate }, async (req, reply) => {
    const { collection, slug, item } = req.query as {
      collection?: string
      slug?: string
      item?: string
    }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    const { row: layout } = await resolveLayout({
      collection,
      slug,
      item,
      role: req.user?.role ?? null,
      isAdmin: !!req.isAdmin
    })
    if (!layout) return reply.code(404).send({ error: 'No layout found' })

    layout.conditions = parseConditions(layout.conditions)
    layout.record_conditions = parseRecordConditions(layout.record_conditions)
    layout.default_values = parseDefaultValues(layout.default_values)
    layout.quick_picker = parseQuickPicker(layout.quick_picker)
    layout.changes_tray = !!layout.changes_tray

    let [groupsRaw, assignments] = await Promise.all([
      db('nivaro_field_groups').where({ layout_id: layout.id }).orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: layout.id })
        .select(
          'field',
          'group_key',
          'sort',
          'label_override',
          'is_visible',
          'default_expanded',
          'lock_conditions',
          'overrides',
          'show_row_revisions',
          'show_approval_chain',
          'widget_id',
          'input_bindings',
          'allow_revision_restore',
          // Slot cards (owners, PDF, widgets) size by col_span on the record page.
          'col_span'
        )
        .orderBy('sort', 'asc')
    ])

    // Layout inheritance (#424): a child layout EXTENDS its parent — parent
    // assignments fill in wherever the child has none for that field, parent
    // groups ride along unless the child defines the same key. One level
    // deep, deliberately (chains would make "where does this field come from"
    // unanswerable).
    if (layout.parent_layout_id) {
      try {
        const [pGroups, pAssignments] = await Promise.all([
          db('nivaro_field_groups')
            .where({ layout_id: Number(layout.parent_layout_id) })
            .orderBy('sort', 'asc'),
          db('nivaro_layout_field_assignments')
            .where({ layout_id: Number(layout.parent_layout_id) })
            .select(
              'field',
              'group_key',
              'sort',
              'label_override',
              'is_visible',
              'default_expanded',
              'lock_conditions',
              'overrides',
              'show_row_revisions',
              'show_approval_chain',
              'widget_id',
              'input_bindings',
              'allow_revision_restore',
              'col_span'
            )
            .orderBy('sort', 'asc')
        ])
        const childFields = new Set(assignments.map((a: { field: string }) => a.field))
        const childGroupKeys = new Set(groupsRaw.map((g: { key: string }) => g.key))
        assignments = [
          ...assignments,
          ...pAssignments.filter((a: { field: string }) => !childFields.has(a.field))
        ]
        groupsRaw = [
          ...groupsRaw,
          ...pGroups.filter((g: { key: string }) => !childGroupKeys.has(g.key))
        ]
      } catch {
        // broken parent reference — the child stands alone
      }
    }

    // Group-level role visibility (#390): groups listing this caller's role
    // in hidden_for_roles are dropped server-side. Admins see everything —
    // they configure the rule.
    const groups = req.isAdmin
      ? groupsRaw
      : groupsRaw.filter((g: { hidden_for_roles?: string | null }) => {
          try {
            const hidden = JSON.parse(g.hidden_for_roles ?? '[]') as string[]
            return !(
              Array.isArray(hidden) &&
              req.user?.role &&
              hidden
                .map((r) => String(r).toUpperCase())
                .includes(String(req.user.role).toUpperCase())
            )
          } catch {
            return true
          }
        })

    const ungroupedRow = assignments.find(
      (a: { field: string; sort: number }) => a.field === '__ungrouped_pos__'
    )
    const ungrouped_sort: number | null = ungroupedRow ? ungroupedRow.sort : null

    return reply.send({ data: { layout, groups, assignments, ungrouped_sort } })
  })

  // GET /collection-layouts/detail/:collection?layout_id= — resolve the detail
  // layout a drill-down sheet should render: explicit layout_id (must be a
  // detail layout of this collection) → active detail layout → null (caller
  // falls back to auto read-only rendering).
  app.get('/detail/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { layout_id } = req.query as { layout_id?: string }

    const roleId = req.user?.role ?? null
    const isAdmin = !!req.isAdmin
    let layout: Record<string, unknown> | undefined
    if (layout_id) {
      layout = await db('nivaro_collection_layouts')
        .where({ id: Number(layout_id), collection, layout_type: 'detail' })
        .first()
      if (layout && !roleAllows(layout, roleId, isAdmin)) layout = undefined
    }
    if (!layout) {
      const candidates = (await db('nivaro_collection_layouts')
        .where({ collection, layout_type: 'detail' })
        .orderByRaw('is_active desc, sort asc')) as Record<string, unknown>[]
      layout = candidates.find((l) => roleAllows(l, roleId, isAdmin))
    }
    if (!layout) return reply.send({ data: null })
    layout.header_fields = parseQuickPicker(layout.header_fields)
    layout.hide_empty = !!layout.hide_empty
    layout.changes_tray = !!layout.changes_tray

    const [groups, assignments] = await Promise.all([
      db('nivaro_field_groups').where({ layout_id: layout.id }).orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: layout.id })
        .select(
          'field',
          'group_key',
          'sort',
          'label_override',
          'is_visible',
          'default_expanded',
          'overrides',
          'widget_id',
          'input_bindings'
        )
        .orderBy('sort', 'asc')
    ])
    return reply.send({ data: { layout, groups, assignments } })
  })

  // GET /collection-layouts/summary/:collection — the layout Summary mode
  // renders (layout_type 'summary': the read-only presentation of the record
  // form, customisable like any other layout). Active-first, role-gated, null
  // when the collection has none — the form then falls back to rendering its
  // grouped layout read-only, which is what it did before summary layouts.
  app.get('/summary/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const roleId = req.user?.role ?? null
    const isAdmin = !!req.isAdmin
    const candidates = (await db('nivaro_collection_layouts')
      .where({ collection, layout_type: 'summary' })
      .orderByRaw('is_active desc, sort asc')) as Record<string, unknown>[]
    const layout = candidates.find((l) => roleAllows(l, roleId, isAdmin))
    if (!layout) return reply.send({ data: null })
    layout.header_fields = parseQuickPicker(layout.header_fields)
    layout.hide_empty = !!layout.hide_empty
    layout.changes_tray = !!layout.changes_tray
    const [groups, assignments] = await Promise.all([
      db('nivaro_field_groups').where({ layout_id: layout.id }).orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: layout.id })
        .select(
          'field',
          'group_key',
          'sort',
          'label_override',
          'is_visible',
          'default_expanded',
          'overrides',
          'widget_id',
          'input_bindings'
        )
        .orderBy('sort', 'asc')
    ])
    return reply.send({ data: { layout, groups, assignments } })
  })

  // GET /collection-layouts?collection=x[&active=true][&layout_type=grouped]
  app.get('/', { preHandler: authenticate }, async (req, reply) => {
    const { collection, active, layout_type } = req.query as {
      collection?: string
      active?: string
      layout_type?: string
    }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    if (layout_type !== undefined && !isLayoutType(layout_type)) {
      return reply
        .code(400)
        .send({ error: `layout_type must be one of ${LAYOUT_TYPES.join(', ')}` })
    }

    let q = db('nivaro_collection_layouts')
      .where({ collection })
      .orderBy('sort', 'asc')
      .select(
        'id',
        'collection',
        'name',
        'slug',
        'create_label',
        'create_hidden',
        'is_active',
        'sort',
        'created_at',
        'disable_comments',
        'disable_tasks',
        'disable_revisions',
        'disable_clone',
        'disable_delete',
        'accordion_mode',
        'tab_mode',
        'validate_before_next',
        'summary_enabled',
        'summary_hide_empty',
        'ai_enabled',
        'conditions',
        'allow_schedule',
        'allow_disable_pickers',
        'layout_type',
        'parent_layout_id',
        'row_order_field',
        'pdf_theme',
        'pdf_template_id',
        'pdf_cover_enabled',
        'pdf_cover_title_field',
        'pdf_cover_subtitle',
        'pdf_show_logo',
        'pdf_page_size',
        'pdf_orientation',
        'pdf_button_label',
        'addendum_layout_id',
        'workflow_template_id',
        'single_active_addendum',
        'addendum_default_view',
        'record_conditions',
        'default_values',
        'display_mode',
        'hide_integrity_banner',
        'hide_sla_banner',
        'changes_tray',
        'dossier_enabled',
        'dossier_label',
        'quick_picker',
        'sheet_width',
        'header_fields',
        'hide_empty'
      )
    if (active === 'true') q = q.where({ is_active: 1 })
    if (layout_type) q = whereLayoutType(q, layout_type)

    // Non-admins never see role-restricted layouts they cannot open (New-item
    // menus, queue builders, drill pickers all read this list).
    const rows = (await q).filter((row: Record<string, unknown>) =>
      roleAllows(row, req.user?.role ?? null, !!req.isAdmin)
    )
    for (const row of rows) {
      row.conditions = parseConditions(row.conditions)
      row.record_conditions = parseRecordConditions(row.record_conditions)
      row.default_values = parseDefaultValues(row.default_values)
      row.quick_picker = parseQuickPicker(row.quick_picker)
      row.header_fields = parseQuickPicker(row.header_fields)
      row.hide_empty = !!row.hide_empty
      row.changes_tray = !!row.changes_tray
    }
    return reply.send({ data: rows })
  })

  // POST /collection-layouts
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      collection: string
      name: string
      slug?: string | null
      layout_type?: string
      /** "Create first form": one "Main" section holding every visible field. */
      seed_fields?: boolean
    }
    if (!body.collection || !body.name)
      return reply.code(400).send({ error: 'collection and name are required' })
    if (body.layout_type !== undefined && !isLayoutType(body.layout_type)) {
      return reply
        .code(400)
        .send({ error: `layout_type must be one of ${LAYOUT_TYPES.join(', ')}` })
    }

    const maxSortRow = await db('nivaro_collection_layouts')
      .where({ collection: body.collection })
      .max('sort as m')
      .first()
    const maxSort = (maxSortRow?.m as number | null) ?? -1

    // Every layout gets a machine name: without one it can't be opened by
    // ?layout=, offered in New-item menus or named by queues and grids.
    const slug = await nextFreeSlug(body.collection, body.slug || slugBaseFromName(body.name))

    // Create and seed are one transaction: a failed seed leaves no empty
    // layout behind (and no name clash for the retry).
    let created: Record<string, unknown> & { id: number; collection: string }
    try {
      created = await db.transaction(async (trx) => {
        await trx('nivaro_collection_layouts').insert({
          collection: body.collection,
          name: body.name,
          slug,
          ...(body.layout_type ? { layout_type: body.layout_type } : {}),
          is_active: 0,
          sort: maxSort + 1
        })
        const row = await trx('nivaro_collection_layouts')
          .where({ collection: body.collection, name: body.name })
          .orderBy('id', 'desc')
          .first()
        if (body.seed_fields === true && row) await seedLayoutFields(row, trx)
        return row
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
        return reply.code(409).send({ error: 'A layout with that name already exists' })
      }
      throw err
    }

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: String(created.id),
      req
    })
    return reply.code(201).send({ data: created })
  })

  // GET /collection-layouts/:id
  app.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db('nivaro_collection_layouts').where({ id }).first()
    if (!row || !roleAllows(row, req.user?.role ?? null, !!req.isAdmin)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    row.conditions = parseConditions(row.conditions)
    row.record_conditions = parseRecordConditions(row.record_conditions)
    row.default_values = parseDefaultValues(row.default_values)
    row.quick_picker = parseQuickPicker(row.quick_picker)
    row.header_fields = parseQuickPicker(row.header_fields)
    row.hide_empty = !!row.hide_empty
    row.changes_tray = !!row.changes_tray
    return reply.send({ data: row })
  })

  // PATCH /collection-layouts/:id
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    const existing = await db('nivaro_collection_layouts').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    nameConfigCollection(req, existing.collection)

    await snapshotLayoutVersion(Number(id), 'before settings change', req.user?.id)

    const body = req.body as LayoutPatchBody
    const normalized = await normalizeLayoutPatch(db, id, existing, body)
    if (normalized.error !== undefined)
      return reply.code(normalized.status).send({ error: normalized.error })
    const patch = normalized.patch

    if (Object.keys(patch).length === 0 && body.is_active === undefined)
      return reply.code(400).send({ error: 'No fields to update' })

    try {
      await db.transaction(async (trx: Knex.Transaction) => {
        await lockLayout(trx, id)
        if (Object.keys(patch).length > 0)
          await trx('nivaro_collection_layouts').where({ id }).update(patch)
        // is_active only changes through the activate rule (one default per
        // type). An active layout moved to another type takes that type's
        // default with it, so the new type never ends up with two.
        const type = (patch.layout_type as string | undefined) ?? existing.layout_type
        const typeChanged =
          patch.layout_type !== undefined &&
          patch.layout_type !== (existing.layout_type ?? 'grouped')
        if (
          body.is_active === true ||
          (body.is_active === undefined && typeChanged && existing.is_active)
        )
          await activateLayout(trx, { id, collection: existing.collection, layout_type: type })
        else if (body.is_active === false)
          await trx('nivaro_collection_layouts').where({ id }).update({ is_active: 0 })
      })
    } catch (err: unknown) {
      // A rename that raced another into the same name (UNIQUE collection + name).
      if (isUniqueViolation(err)) return reply.code(409).send({ error: LAYOUT_NAME_TAKEN })
      throw err
    }
    const updated = parseLayoutRow(await db('nivaro_collection_layouts').where({ id }).first())

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: id,
      req
    })
    return reply.send({ data: updated })
  })

  // DELETE /collection-layouts/:id — blocked if it is the only layout for the
  // collection, or while another layout or an addendum still points at it.
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_collection_layouts').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    nameConfigCollection(req, existing.collection)

    const countRow = await db('nivaro_collection_layouts')
      .where({ collection: existing.collection })
      .count('id as c')
      .first()
    const count = Number(countRow?.c ?? 0)

    if (count <= 1)
      return reply.code(409).send({ error: 'Cannot delete the only layout for a collection' })

    // References first: the delete used to remove groups and assignments and
    // only then fail on the addendum FK, leaving an empty layout behind.
    const [addendumOf, childrenOf, addendums] = await Promise.all([
      db('nivaro_collection_layouts')
        .where({ addendum_layout_id: Number(id) })
        .whereNot({ id: Number(id) })
        .select('id', 'name'),
      db('nivaro_collection_layouts')
        .where({ parent_layout_id: Number(id) })
        .whereNot({ id: Number(id) })
        .select('id', 'name'),
      db('nivaro_addendums')
        .where({ addendum_layout_id: Number(id) })
        .select('id', 'title', 'parent_collection', 'parent_id')
        .limit(50)
    ])
    const references = [
      ...(addendumOf as Array<{ id: number; name: string }>).map((r) => ({
        kind: 'layout_addendum',
        id: r.id,
        label: r.name
      })),
      ...(childrenOf as Array<{ id: number; name: string }>).map((r) => ({
        kind: 'layout_parent',
        id: r.id,
        label: r.name
      })),
      ...(
        addendums as Array<{
          id: string
          title: string | null
          parent_collection: string
          parent_id: string
        }>
      ).map((r) => ({
        kind: 'addendum',
        id: r.id,
        label: r.title || `Addendum on ${r.parent_collection} ${r.parent_id}`
      }))
    ]
    if (references.length > 0) {
      return reply.code(409).send({
        error: 'This layout is still in use. Point these at another layout first.',
        references
      })
    }

    // One transaction: promote the next default, then assignments → groups →
    // layout. Version history is kept (migration 456 dropped the cascade).
    await db.transaction(async (trx: Knex.Transaction) => {
      // Deleting the active layout promotes the next one of the SAME type
      // (activation is type-scoped — grouped and detail defaults are independent).
      // File layouts are independent PDF buttons — nothing to promote.
      const layoutType = existing.layout_type ?? 'grouped'
      if (existing.is_active && layoutType !== 'file') {
        const next = await whereLayoutType(
          trx('nivaro_collection_layouts').where({ collection: existing.collection }),
          layoutType
        )
          .whereNot({ id: Number(id) })
          .orderBy('sort', 'asc')
          .first('id')
        if (next) {
          await activateLayout(trx, {
            id: next.id,
            collection: existing.collection,
            layout_type: layoutType
          })
        }
      }
      await trx('nivaro_layout_field_assignments')
        .where({ layout_id: Number(id) })
        .delete()
      await trx('nivaro_field_groups')
        .where({ layout_id: Number(id) })
        .delete()
      await trx('nivaro_collection_layouts').where({ id }).delete()
    })
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: id,
      req
    })
    return reply.code(204).send()
  })

  // POST /collection-layouts/:id/activate
  app.post('/:id/activate', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db('nivaro_collection_layouts').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    nameConfigCollection(req, existing.collection)

    // Activation is scoped to the layout's type: one active 'grouped' layout
    // (ItemEdit default) and one active 'detail' layout (drill-down default)
    // coexist per collection; file layouts may have several on.
    await db.transaction((trx: Knex.Transaction) => activateLayout(trx, existing))

    const updated = await db('nivaro_collection_layouts').where({ id }).first()
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: id,
      req
    })
    return reply.send({ data: updated })
  })

  app.get('/:id/preview-html', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout || layout.layout_type !== 'file')
      return reply.code(404).send({ error: 'Not found' })

    const [groups, assignments, fieldMeta] = await Promise.all([
      db('nivaro_field_groups')
        .where({ layout_id: Number(id) })
        .select('id', 'key', 'label', 'sort')
        .orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: Number(id) })
        .select(
          'field',
          'group_key',
          'sort',
          'label_override',
          'is_visible',
          'widget_id',
          'input_bindings'
        )
        .orderBy('sort', 'asc'),
      db('nivaro_fields').where({ collection: layout.collection }).select('field', 'label', 'type')
    ])

    const fieldMetaMap = new Map(
      (fieldMeta as Array<{ field: string; label: string | null; type: string }>).map((f) => [
        f.field,
        f
      ])
    )

    const realSections = groups
      .sort((a: { sort: number }, b: { sort: number }) => a.sort - b.sort)
      .map((group: { id: number; key: string; label: string; sort: number }) => {
        const groupFields = (
          assignments as Array<{
            field: string
            group_key: string | null
            sort: number
            label_override: string | null
            is_visible: number | boolean | null
          }>
        )
          .filter(
            (a) =>
              (group.key ? a.group_key === group.key : a.group_key === String(group.id)) &&
              a.is_visible !== 0 &&
              a.is_visible !== false &&
              !a.field.startsWith('__')
          )
          .sort((a, b) => a.sort - b.sort)
          .map((a) => {
            const meta = fieldMetaMap.get(a.field)
            return { label: a.label_override ?? meta?.label ?? a.field, value: `[${a.field}]` }
          })
        return { label: group.label, fields: groupFields }
      })
      .filter((s: { fields: unknown[] }) => s.fields.length > 0)

    const sections =
      realSections.length > 0
        ? realSections
        : [
            {
              label: 'No fields configured',
              fields: [
                { label: 'Groups in layout', value: String(groups.length) },
                {
                  label: 'Assignments in layout',
                  value: String((assignments as unknown[]).length)
                },
                {
                  label: 'Fix',
                  value: 'Drag fields into groups in the Layouts tab to populate this PDF.'
                }
              ]
            }
          ]

    const previewData = {
      coverTitle: layout.pdf_cover_title_field
        ? `[${layout.pdf_cover_title_field}]`
        : 'Document Title',
      coverSubtitle: layout.pdf_cover_subtitle ?? 'Preview · Real Layout',
      logoUrl: null as string | null,
      collectionLabel: layout.collection ?? 'Collection',
      generatedAt: new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }),
      generatedBy: 'Preview',
      coverEnabled: Boolean(layout.pdf_cover_enabled ?? true),
      sections
    }

    const theme = layout.pdf_theme ?? 'classic'
    let html: string
    if (theme === 'minimal') html = minimalTheme(previewData)
    else if (theme === 'executive') html = executiveTheme(previewData)
    else html = classicTheme(previewData)

    return reply.header('Content-Type', 'text/html; charset=utf-8').send(html)
  })

  // POST /collection-layouts/:id/generate-pdf
  app.post('/:id/generate-pdf', { preHandler: authenticate }, async (req, reply) => {
    // Renders a record through a layout: changes no configuration (any signed-in caller).
    markConfigRead(req)
    const { id } = req.params as { id: string }
    const { collection, item_id } = req.body as { collection: string; item_id: string | number }

    if (!collection || item_id == null) {
      return reply.code(400).send({ error: 'collection and item_id are required' })
    }

    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout) return reply.code(404).send({ error: 'Layout not found' })
    if (layout.layout_type !== 'file')
      return reply.code(400).send({ error: 'Layout is not a file layout' })

    let item: Record<string, unknown>
    try {
      item = (await readOne(
        req.user!,
        collection,
        String(item_id),
        req.workspaceId ?? undefined
      )) as Record<string, unknown>
    } catch (err) {
      if (err instanceof ForbiddenError) return reply.code(403).send({ error: 'Forbidden' })
      if (err instanceof ItemNotFoundError) return reply.code(404).send({ error: 'Item not found' })
      throw err
    }

    const [groups, assignments, fieldMeta, colMeta, settings, directRelations] = await Promise.all([
      db('nivaro_field_groups')
        .where({ layout_id: Number(id) })
        .select('id', 'key', 'label', 'sort')
        .orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: Number(id) })
        .select(
          'field',
          'group_key',
          'sort',
          'label_override',
          'is_visible',
          'col_span',
          'overrides'
        )
        .orderBy('sort', 'asc'),
      db('nivaro_fields')
        .where({ collection })
        .select('field', 'label', 'type', 'interface', 'options'),
      db('nivaro_collections').where({ collection }).first('display_name'),
      db('nivaro_settings')
        .where({ id: 1 })
        .first('logo_url')
        .catch(() => null),
      db('nivaro_relations')
        .where('many_collection', collection)
        .orWhere('one_collection', collection)
        .select('many_collection', 'many_field', 'one_collection', 'one_field', 'junction_field')
    ])

    // For M2M: also fetch the junction→other relations so we can resolve display values
    const m2mJunctions = (
      directRelations as Array<{
        many_collection: string
        junction_field: string | null
        one_collection: string | null
      }>
    )
      .filter((r) => r.one_collection === collection && r.junction_field != null)
      .map((r) => r.many_collection)
    const junctionRelations =
      m2mJunctions.length > 0
        ? await db('nivaro_relations')
            .whereIn('many_collection', m2mJunctions)
            .select(
              'many_collection',
              'many_field',
              'one_collection',
              'one_field',
              'junction_field'
            )
        : []
    const relations = [...directRelations, ...junctionRelations] as Array<{
      many_collection: string
      many_field: string
      one_collection: string | null
      one_field: string | null
      junction_field: string | null
    }>

    const collectionLabel = (colMeta?.display_name as string | null) ?? collection
    const logoUrl = (settings?.logo_url as string | null) ?? null
    const generatedBy = req.user?.first_name
      ? `${req.user.first_name} ${req.user.last_name ?? ''}`.trim()
      : (req.user?.email ?? 'System')

    const pdfBuffer = await generatePdfFromLayout({
      layout,
      collectionLabel,
      collection,
      item,
      groups,
      assignments,
      fieldMeta,
      relations,
      logoUrl,
      generatedBy
    })

    await logActivity({
      action: 'pdf-generate',
      user: req.user?.id,
      collection,
      item: String(item_id),
      req
    })

    const safeFilename = `${collection}-${item_id}`.replace(/[^a-zA-Z0-9_-]/g, '_')

    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`)
      .send(pdfBuffer)
  })

  // POST /collection-layouts/:id/generate-and-attach
  // Generates PDF for an item and attaches it to a file M2M/O2M field on the item.
  app.post('/:id/generate-and-attach', { preHandler: authenticate }, async (req, reply) => {
    // Writes a file onto the record, never the layout: no config flush or push.
    markConfigRead(req)
    const { id } = req.params as { id: string }
    const { collection, item_id, attach_field, filename_template, replace_generated, addendum_id } =
      req.body as {
        collection: string
        item_id: string | number
        attach_field: string
        filename_template?: string | null
        /** Detach (and delete) PDFs this layout generated before for the same
         *  record, so re-saving refreshes the document instead of stacking a new
         *  copy every time. Only ever removes files THIS endpoint created — a
         *  user-uploaded attachment is never touched. */
        replace_generated?: boolean
        /** Render the record AS AMENDED by this addendum (proposed scalars,
         *  proposed child rows, rollups recomputed from them) and also list
         *  the file on the addendum's attachments. */
        addendum_id?: string | null
      }

    if (!collection || item_id == null || !attach_field) {
      return reply.code(400).send({ error: 'collection, item_id, and attach_field are required' })
    }

    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout) return reply.code(404).send({ error: 'Layout not found' })

    // Check read AND update permission before generating/attaching
    if (!req.isAdmin) {
      const [canRead, canUpdate] = await Promise.all([
        can(req.user!, 'read', collection),
        can(req.user!, 'update', collection)
      ])
      if (!canRead || !canUpdate) return reply.code(403).send({ error: 'Forbidden' })
    }

    let item: Record<string, unknown>
    try {
      item = (await readOne(
        req.user!,
        collection,
        String(item_id),
        req.workspaceId ?? undefined
      )) as Record<string, unknown>
    } catch (err) {
      if (err instanceof ForbiddenError) return reply.code(403).send({ error: 'Forbidden' })
      if (err instanceof ItemNotFoundError) return reply.code(404).send({ error: 'Item not found' })
      throw err
    }

    let childRowsOverride: Record<string, Record<string, unknown>[]> | undefined
    let addendumTitle: string | null = null
    if (addendum_id) {
      const overlay = await buildAddendumRenderOverlay(collection, item, String(addendum_id))
      if (!overlay) return reply.code(404).send({ error: 'Addendum not found for this record' })
      item = overlay.item
      childRowsOverride = overlay.childRowsOverride
      addendumTitle = overlay.title
    }

    const [groups, assignments, fieldMeta, colMeta, settings, directRelations] = await Promise.all([
      db('nivaro_field_groups')
        .where({ layout_id: Number(id) })
        .select('id', 'key', 'label', 'sort')
        .orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: Number(id) })
        .select(
          'field',
          'group_key',
          'sort',
          'label_override',
          'is_visible',
          'col_span',
          'overrides',
          'widget_id',
          'input_bindings'
        )
        .orderBy('sort', 'asc'),
      db('nivaro_fields')
        .where({ collection })
        .select('field', 'label', 'type', 'interface', 'options'),
      db('nivaro_collections').where({ collection }).first('display_name'),
      db('nivaro_settings')
        .where({ id: 1 })
        .first('logo_url')
        .catch(() => null),
      db('nivaro_relations')
        .where('many_collection', collection)
        .orWhere('one_collection', collection)
        .select('many_collection', 'many_field', 'one_collection', 'one_field', 'junction_field')
    ])

    const m2mJunctions = (
      directRelations as Array<{
        many_collection: string
        junction_field: string | null
        one_collection: string | null
      }>
    )
      .filter((r) => r.one_collection === collection && r.junction_field != null)
      .map((r) => r.many_collection)
    const junctionRelations =
      m2mJunctions.length > 0
        ? await db('nivaro_relations')
            .whereIn('many_collection', m2mJunctions)
            .select(
              'many_collection',
              'many_field',
              'one_collection',
              'one_field',
              'junction_field'
            )
        : []
    const relations = [...directRelations, ...junctionRelations] as Array<{
      many_collection: string
      many_field: string
      one_collection: string | null
      one_field: string | null
      junction_field: string | null
    }>

    const collectionLabel = (colMeta?.display_name as string | null) ?? collection
    const logoUrl = (settings?.logo_url as string | null) ?? null
    const generatedBy = req.user?.first_name
      ? `${req.user.first_name} ${req.user.last_name ?? ''}`.trim()
      : (req.user?.email ?? 'System')

    const pdfBuffer = await generatePdfFromLayout({
      layout,
      collectionLabel,
      collection,
      item,
      groups,
      assignments,
      fieldMeta,
      relations,
      logoUrl,
      generatedBy,
      childRowsOverride
    })

    // Save PDF to file storage
    const fileId = randomUUID()
    const resolvedName = filename_template
      ? filename_template.replace(/\{\{(\w+)\}\}/g, (_: string, key: string) => {
          const v = item[key]
          return v != null && v !== '' ? String(v).replace(/[^a-zA-Z0-9_-]/g, '_') : key
        })
      : null
    const addendumSuffix = addendum_id
      ? `-addendum-${(addendumTitle ?? String(addendum_id).slice(0, 8)).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`
      : ''
    const safeBase =
      (resolvedName ?? `${collection}-${item_id}`).replace(/[^a-zA-Z0-9_-]/g, '_') + addendumSuffix
    const diskName = `${fileId}.pdf`
    const provider = getStorageProviderName()
    await getStorage().put(diskName, pdfBuffer, 'application/pdf')
    const fileRow = {
      id: fileId,
      storage: provider,
      storage_provider: provider,
      filename_disk: diskName,
      filename_download: `${safeBase}.pdf`,
      title: safeBase,
      type: 'application/pdf',
      folder: null,
      uploaded_by: req.user!.id,
      uploaded_on: new Date(),
      filesize: pdfBuffer.length,
      // Provenance, so a later replace_generated run can tell its own output
      // apart from a file a person uploaded.
      generated_by_layout: Number(id)
    }
    await db('nivaro_files').insert(fileRow)

    // Attach file to the item via the relation for attach_field
    // Require exact match using the same alias derivation as the config picker
    const junctionRels = (
      directRelations as Array<{
        many_collection: string
        many_field: string
        one_collection: string | null
        one_field: string | null
        junction_field: string | null
      }>
    ).filter((r) => r.one_collection === collection && r.junction_field != null)
    const getFieldAlias = (jr: { one_field: string | null; many_collection: string }) => {
      if (jr.one_field && jr.one_field !== 'id') return jr.one_field
      return (
        jr.many_collection
          .replace(new RegExp(`^${collection}_?|_?${collection}$`, 'i'), '')
          .replace(/^_|_$/g, '') || jr.many_collection
      )
    }
    let attached = false
    const targetJr = junctionRels.find((jr) => getFieldAlias(jr) === attach_field)
    if (!targetJr) {
      return reply.code(400).send({
        error: `No M2M relation found for field '${attach_field}' on collection '${collection}'`
      })
    }
    // targetJr encodes both FK columns:
    //   many_field      = junction column pointing to the parent (item_id side)
    //   junction_field  = junction column pointing to the related files record
    if (!targetJr.junction_field) {
      return reply
        .code(400)
        .send({ error: `Relation '${attach_field}' does not link to nivaro_files` })
    }
    if (replace_generated) {
      // Identify prior generations by the marker stamped on the file row, not
      // by filename — a user-uploaded file that happens to share a name must
      // survive.
      try {
        const priorJunctions = (await db(targetJr.many_collection)
          .where({ [targetJr.many_field]: item_id })
          .select('id', targetJr.junction_field)) as Array<Record<string, unknown>>
        const priorFileIds = priorJunctions
          .map((j) => j[targetJr.junction_field as string])
          .filter((v): v is string => typeof v === 'string' && v !== fileId)
        if (priorFileIds.length > 0) {
          const generated = (await db('nivaro_files')
            .whereIn('id', priorFileIds)
            .where({ generated_by_layout: Number(id) })
            .select('id')) as Array<{ id: string }>
          const generatedIds = new Set(generated.map((g) => String(g.id)))
          if (generatedIds.size > 0) {
            await db(targetJr.many_collection)
              .where({ [targetJr.many_field]: item_id })
              .whereIn(targetJr.junction_field as string, [...generatedIds])
              .del()
            await db('nivaro_files')
              .whereIn('id', [...generatedIds])
              .del()
          }
        }
      } catch {
        // Cleanup is best-effort — never block the new attachment over it.
      }
    }
    try {
      await db(targetJr.many_collection).insert({
        [targetJr.many_field]: item_id,
        [targetJr.junction_field]: fileId
      })
      attached = true
    } catch {
      /* duplicate/constraint — file already attached */
    }

    // The addendum keeps its own pointer to the document rendered for it, so
    // reviewers open the amended version from the addendum card.
    if (addendum_id) {
      try {
        const row = (await db('nivaro_addendums')
          .where({ id: String(addendum_id) })
          .first('attachments')) as { attachments: string | null } | undefined
        let list: string[] = []
        try {
          const parsed = row?.attachments ? JSON.parse(row.attachments) : []
          list = Array.isArray(parsed) ? parsed.map(String) : []
        } catch {
          list = []
        }
        if (replace_generated && list.length > 0) {
          const prior = (await db('nivaro_files')
            .whereIn('id', list)
            .where({ generated_by_layout: Number(id) })
            .select('id')) as Array<{ id: string }>
          const priorIds = new Set(prior.map((p) => String(p.id).toUpperCase()))
          list = list.filter((x) => !priorIds.has(String(x).toUpperCase()))
        }
        if (!list.some((x) => String(x).toUpperCase() === fileId.toUpperCase())) list.push(fileId)
        await db('nivaro_addendums')
          .where({ id: String(addendum_id) })
          .update({ attachments: JSON.stringify(list.slice(0, 50)) })
      } catch {
        /* best effort — the record attachment already landed */
      }
    }

    await logActivity({
      action: 'pdf-generate-attach',
      user: req.user?.id,
      collection,
      item: String(item_id),
      req
    })

    return reply.send({ data: { file_id: fileId, attached } })
  })

  // POST /collection-layouts/:id/clone
  app.post('/:id/clone', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const source = await db('nivaro_collection_layouts').where({ id }).first()
    if (!source) return reply.code(404).send({ error: 'Not found' })
    nameConfigCollection(req, source.collection)

    const body = req.body as { name: string; slug?: string | null; layout_type?: string }
    if (!body.name) return reply.code(400).send({ error: 'name is required' })
    // A clone may land as another TYPE (grouped → summary is how a Summary
    // layout starts life: the same groups and fields, rendered read-only).
    if (
      body.layout_type !== undefined &&
      !LAYOUT_TYPES.includes(body.layout_type as (typeof LAYOUT_TYPES)[number])
    ) {
      return reply
        .code(400)
        .send({ error: `layout_type must be one of ${LAYOUT_TYPES.join(', ')}` })
    }

    const maxSortRow = await db('nivaro_collection_layouts')
      .where({ collection: source.collection })
      .max('sort as m')
      .first()
    const maxSort = (maxSortRow?.m as number | null) ?? -1

    // Carry the source's settings — a clone used to land as a bare 'grouped'
    // layout with every presentation/behaviour column at its default, and
    // assignments lost their overrides (labels, interfaces, grid options).
    const carried: Record<string, unknown> = {}
    for (const col of CLONE_CARRIED_COLUMNS) {
      if (col in source && source[col] !== undefined) carried[col] = source[col]
    }
    const slug = await nextFreeSlug(source.collection, body.slug || slugBaseFromName(body.name))
    try {
      await db('nivaro_collection_layouts').insert({
        ...carried,
        collection: source.collection,
        name: body.name,
        layout_type: body.layout_type ?? source.layout_type ?? 'grouped',
        slug,
        // A copy never joins the collection's New menu on its own; the admin opts in.
        create_hidden: 1,
        is_active: 0,
        sort: maxSort + 1
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
        return reply.code(409).send({ error: 'A layout with that name already exists' })
      }
      throw err
    }
    const newLayout = await db('nivaro_collection_layouts')
      .where({ collection: source.collection, name: body.name })
      .orderBy('id', 'desc')
      .first()
    const newId = newLayout.id

    // Clone groups — every column except identity, with container_id remapped
    // to the cloned parent group (containers own their steps by id).
    const groups = (await db('nivaro_field_groups')
      .where({ layout_id: Number(id) })
      .orderBy('sort', 'asc')
      .select('*')) as Array<Record<string, unknown>>
    const groupIdMap = new Map<number, number>()
    for (const g of groups) {
      const { id: oldId, container_id, layout_id: _l, ...rest } = g
      const row = {
        ...rest,
        layout_id: newId,
        container_id: container_id != null ? (groupIdMap.get(Number(container_id)) ?? null) : null
      }
      await db('nivaro_field_groups').insert(row)
      const inserted = await db('nivaro_field_groups')
        .where({ layout_id: newId, key: g.key as string })
        .orderBy('id', 'desc')
        .first('id')
      if (inserted) groupIdMap.set(Number(oldId), Number(inserted.id))
    }

    // Clone field assignments WITH their overrides/visibility/widget wiring.
    const assignments = (await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id) })
      .select('*')) as Array<Record<string, unknown>>
    if (assignments.length > 0) {
      await db('nivaro_layout_field_assignments').insert(
        assignments.map((a) => {
          const { id: _id, layout_id: _lid, ...rest } = a
          return { ...rest, layout_id: newId }
        })
      )
    }

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: String(newId),
      req
    })
    return reply.code(201).send({ data: newLayout })
  })

  // GET /collection-layouts/:id/assignments
  app.get('/:id/assignments', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    const rows = await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id) })
      .select(
        'field',
        'group_key',
        'sort',
        'label_override',
        'is_visible',
        'default_expanded',
        'show_row_revisions',
        'allow_revision_restore',
        'lock_conditions',
        'overrides',
        'widget_id',
        'input_bindings'
      )
      .orderBy('sort', 'asc')
    return reply.send({ data: rows })
  })

  // PATCH /collection-layouts/:id/ungrouped-sort — update only the __ungrouped_pos__ row
  app.patch('/:id/ungrouped-sort', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { ungrouped_sort } = req.body as { ungrouped_sort: number }
    await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id), field: '__ungrouped_pos__' })
      .delete()
    await db('nivaro_layout_field_assignments').insert({
      layout_id: Number(id),
      field: '__ungrouped_pos__',
      group_key: null,
      sort: ungrouped_sort
    })
    return reply.send({ data: { ungrouped_sort } })
  })

  // GET /collection-layouts/:id/versions — snapshot history (see migration 211)
  app.get('/:id/versions', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rows = await db('nivaro_layout_versions as v')
      .leftJoin('nivaro_users as u', 'v.created_by', 'u.id')
      .where('v.layout_id', Number(id))
      .orderBy('v.version', 'desc')
      .select(
        'v.id',
        'v.version',
        'v.note',
        'v.created_at',
        db.raw(
          "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as created_by_name"
        )
      )
    return reply.send({ data: rows })
  })

  // GET /collection-layouts/:id/versions/:versionId — the snapshot itself
  // (the 09-16 col_span recovery had to read the row via SQL; never again).
  app.get('/:id/versions/:versionId', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, versionId } = req.params as { id: string; versionId: string }
    const v = await getLayoutVersion(Number(id), Number(versionId))
    if (!v) return reply.code(404).send({ error: 'Version not found' })
    return reply.send({ data: v })
  })

  // GET /collection-layouts/:id/versions/:versionId/diff?against=current|<versionId>
  // — what changed between a version and now (or another version); with
  // versionId 'newest' this is "what did the last save change" (#521).
  app.get('/:id/versions/:versionId/diff', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, versionId } = req.params as { id: string; versionId: string }
    const { against } = req.query as { against?: string }
    const from = versionId === 'newest' ? ('newest' as const) : Number(versionId)
    const to = !against || against === 'current' ? ('current' as const) : Number(against)
    const d = await diffLayoutVersions(Number(id), from, to)
    if (!d) return reply.code(404).send({ error: 'Version not found' })
    return reply.send({ data: d })
  })

  // GET /collection-layouts/drift — every layout whose last save shows a
  // data-losing shape (widths nulled wholesale, half the fields gone).
  app.get('/drift', { preHandler: requireAdmin }, async () => ({ data: await layoutDriftSweep() }))

  // POST /collection-layouts/:id/versions/:versionId/restore — id-preserving,
  // captures a 'before restore' version first so the restore is reversible.
  app.post('/:id/versions/:versionId/restore', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, versionId } = req.params as { id: string; versionId: string }
    const result = await restoreLayoutVersion(Number(id), Number(versionId), req.user?.id)
    if (!result) return reply.code(404).send({ error: 'Version not found' })
    if ('error' in result) return reply.code(result.status).send({ error: result.error })
    const restored = await db('nivaro_collection_layouts')
      .where({ id: Number(id) })
      .first('collection')
    nameConfigCollection(req, restored?.collection)
    await logActivity({
      action: 'layout-version-restore',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: String(id),
      comment: `restored ${result.restored_assignments} assignments, ${result.restored_groups} groups`,
      req
    })
    return reply.send({ data: result })
  })

  // PUT /collection-layouts/:id/assignments — bulk replace
  app.put('/:id/assignments', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const layout = await db('nivaro_collection_layouts').where({ id }).first()
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    nameConfigCollection(req, layout.collection)

    // The editor auto-saves this route on a 400ms debounce — snapshot the
    // CURRENT state first so a bad drag is one restore away. Deduped, so the
    // save stream doesn't mint a version per keystroke burst.
    await snapshotLayoutVersion(Number(id), 'before assignments save', req.user?.id)

    const body = req.body as {
      assignments: Array<{
        field: string
        group_key: string | null
        sort: number
        label_override?: string | null
        is_visible?: boolean
        default_expanded?: boolean
        col_span?: number | null
        overrides?: Record<string, unknown> | null
        show_row_revisions?: boolean
        allow_revision_restore?: boolean | null
        lock_conditions?: string | null
        input_bindings?: unknown
        widget_id?: number | null
        show_approval_chain?: boolean
      }>
    }
    if (!Array.isArray(body.assignments))
      return reply.code(400).send({ error: 'assignments array required' })

    // Upsert by (layout_id, field, group_key): a field may sit in two groups
    // (header strip + body) and both placements survive.
    // #774: a save used to DELETE every row and re-insert, so assignment ids
    // churned on each 400ms auto-save (version restores had to match by field,
    // and any column the insert map forgot was silently dropped). Rows keep
    // their id now; only what left the payload is deleted; every column is carried.
    const keyOf = (field: string, groupKey: string | null | undefined) =>
      `${field}\u0000${groupKey ?? ''}`
    const wanted = new Map<string, (typeof body.assignments)[number]>()
    for (const a of body.assignments) {
      if (!a || typeof a.field !== 'string' || !a.field) continue
      wanted.set(keyOf(a.field, a.group_key), a) // same pair named twice: the last entry wins
    }
    const rowOf = placementColumns
    await db.transaction(async (trx) => {
      await lockLayout(trx, id)
      const existing = (await trx('nivaro_layout_field_assignments')
        .where({ layout_id: Number(id) })
        .select('id', 'field', 'group_key')) as Array<{
        id: number
        field: string
        group_key: string | null
      }>
      const byKey = new Map<string, number>()
      const gone: number[] = []
      for (const r of existing) {
        const k = keyOf(r.field, r.group_key)
        // A leftover duplicate of the same pair goes; the first row keeps its id.
        if (wanted.has(k) && !byKey.has(k)) byKey.set(k, r.id)
        else gone.push(r.id)
      }
      if (gone.length > 0) {
        await trx('nivaro_layout_field_assignments').whereIn('id', gone).delete()
      }
      for (const [k, a] of wanted) {
        const field = a.field
        const rowId = byKey.get(k)
        if (rowId != null) {
          await trx('nivaro_layout_field_assignments').where({ id: rowId }).update(rowOf(a))
        } else {
          await trx('nivaro_layout_field_assignments').insert({
            layout_id: Number(id),
            field,
            ...rowOf(a)
          })
        }
      }
    })

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: id,
      comment: `assignments: ${body.assignments.length} field(s)`,
      req
    })

    const rows = await db('nivaro_layout_field_assignments')
      .where({ layout_id: Number(id) })
      .select(
        'id',
        'field',
        'group_key',
        'sort',
        'label_override',
        'is_visible',
        'default_expanded',
        'col_span',
        'overrides',
        'show_row_revisions',
        'allow_revision_restore',
        'lock_conditions',
        'input_bindings',
        'widget_id',
        'show_approval_chain'
      )
      .orderBy('sort', 'asc')
    return reply.send({ data: rows })
  })

  // ─── Layout editor save model: bundle + atomic ops ────────────────────────
  // GET /collection-layouts/:id/bundle — the layout, its groups and placements
  // as the editor edits them, with the rev its next ops batch must name.
  app.get('/:id/bundle', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    const bundle = await loadLayoutBundle(db, Number(id))
    if (!bundle) return reply.code(404).send({ error: 'Not found' })
    return reply.send(bundle)
  })

  // POST /collection-layouts/:id/ops — { ops, base_rev, note? } applied all or
  // nothing; 409 { error: 'stale', bundle } when the layout changed since
  // base_rev, 400 { error, op_index } when an op is refused.
  app.post('/:id/ops', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    const body = (req.body ?? {}) as { ops?: unknown; base_rev?: unknown; note?: unknown }
    if (!Array.isArray(body.ops)) return reply.code(400).send({ error: 'ops array required' })
    if (body.ops.length > 500) return reply.code(400).send({ error: 'At most 500 ops per batch' })
    if (typeof body.base_rev !== 'string')
      return reply.code(400).send({ error: 'base_rev required' })
    const result = await runLayoutOps(
      Number(id),
      {
        ops: body.ops,
        base_rev: body.base_rev,
        note: typeof body.note === 'string' ? body.note : null
      },
      req.user?.id
    )
    if (result.status === 404) return reply.code(404).send({ error: 'Not found' })
    // Open record pages of THIS collection hear the change (config:update names it).
    if ('bundle' in result) nameConfigCollection(req, result.bundle.layout.collection)
    if (result.status === 409)
      return reply.code(409).send({ error: 'stale', bundle: result.bundle })
    if (result.status === 400)
      return reply.code(400).send({ error: result.error, op_index: result.op_index })
    if (result.changed)
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_collection_layouts',
        item: id,
        comment: `layout editor: ${body.ops.length} change(s)`,
        req
      })
    return reply.send(result.bundle)
  })
}
