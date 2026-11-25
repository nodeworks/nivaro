import type { Blueprint } from './blueprints.js'

/**
 * Hub enhancement 24 (review M3/L4): what a Hub template may carry into an app. A template is
 * installed into a new app with no review there, so — unlike an administrator's own install from
 * Promotion → Blueprints — its rows are cut down to known columns, every part must stay inside the
 * collections the template itself brings, and its size is capped. Run on upload (the Hub stores the
 * result and shows what was removed) and again on the app before it installs (defence in depth:
 * the same pure function, so a bundle that passed the Hub passes unchanged).
 *
 * Kept columns are the ones an export writes (services/blueprints.ts exportBlueprint) MINUS:
 *  - executable or audit-weakening config: a collection's `is_virtual`/`virtual_sql` (SQL run on
 *    Preview/Materialize), `accountability`, `read_logging`, `activity_retention_days`,
 *    `trash_retention_days`; a field's `remote_options_config` (outbound calls) and
 *    `cross_record_defaults` (reads other collections);
 *  - ids of rows on the source instance that mean nothing on the app (int ids, workspace, owner,
 *    layout/pdf/widget links) and timestamps (the installer sets them).
 * A column that is not listed is stripped (a newer export's new column is stripped until it is
 * listed here). Leaf module: no I/O.
 */

const T = (cols: string) => new Set(cols.split(/\s+/).filter(Boolean))

export const ALLOWED_COLUMNS = {
  collections: T(`collection display_name singular plural icon note color hidden singleton
    sort_field archive_field archive_value unarchive_value display_template group sort versioning
    draft_publish_enabled item_locking_enabled addendums_enabled picker_filter
    addendum_allowed_states addendum_allowed_roles addendum_start_states browser_config
    change_reason_config url_alias_fields integrity_badge export_watermark collision_detection
    delete_guard folder slug_field empty_state upsert_keys read_mode_toggle summary_mode_rules
    friendly_id_field`),
  fields: T(`collection field type db_column interface display display_options options note hidden
    readonly required sort group special validation validation_message computed_formula
    computed_type computed_store group_key visibility_rules dependency_config validation_rules
    lock_condition default_formula repeater_schema is_translatable is_encrypted is_inheritable
    label placeholder deprecated_at deprecation_note`),
  relations: T(`many_collection many_field one_collection one_field one_collection_field
    one_allowed_collections junction_field sort_field one_deselect_action`),
  workflow_templates: T('id name description color icon'),
  workflow_states: T(`id template key label color is_initial is_terminal lock_record sort
    skip_criteria skip_if_no_owners stage_visibility description owners_not_required
    external_label`),
  workflow_transitions: T(`id template from_state to_state label color required_roles actions sort
    conditions auto_trigger group_label condition_rules requirements comment_mode to_previous
    in_row_menu notify_text require_owner allow_creator open_when`),
  workflow_bindings: T(`template collection state_field auto_start auto_start_state state_field_map
    owner_fallback_field`),
  layouts: T(`collection name is_active sort disable_comments disable_tasks tab_mode
    validate_before_next summary_enabled summary_show_all ai_enabled conditions allow_clone
    allow_schedule allow_disable_pickers slug layout_type pdf_theme pdf_cover_enabled
    pdf_cover_title_field pdf_cover_subtitle pdf_show_logo pdf_page_size pdf_orientation
    row_order_field disable_revisions disable_clone accordion_mode disable_delete
    summary_hide_empty pdf_button_label workflow_template_id single_active_addendum
    addendum_default_view addendum_lock_fields record_conditions default_values create_label
    create_hidden display_mode hide_integrity_banner hide_sla_banner dossier_enabled dossier_label
    quick_picker sheet_width header_fields hide_empty changes_tray change_note entry_config
    email_summary_group`),
  field_groups: T(`collection key label type icon sort is_collapsed container_id tab_mode
    hide_when_empty visibility_mode summary_fields summary_hide_empty swap_config skip_if_filled
    content content_tone visible_when hidden_for_roles read_width locked_for_roles editor_note i18n
    form_width`),
  assignments: T(`field group_key sort label_override is_visible default_expanded col_span overrides
    show_row_revisions input_bindings show_approval_chain lock_conditions allow_revision_restore
    hide_actions_when_collapsed`),
  queues: T(`id name description icon color is_shared role_id is_active claims_enabled
    column_aliases display_config`),
  queue_sources: T(`type collection filters state_values sort sla_filter extra_fields state_mode
    label_template drilldown column_formats aggregates`),
  rules: T('name collection trigger conditions actions enabled sort'),
  // Hub enhancement 46 (app cloning: structure blueprints only).
  pipeline_dimensions: T('collection field label sort is_row_axis required'),
  roles: T('id name description admin_access app_access ui_permissions'),
  policies: T('role collection action fields permissions validation presets row_filter'),
  flows: T('id name description trigger trigger_options accountability'),
  flow_operations: T('id flow name key type position_x position_y options resolve reject')
} as const

/** The most a template may bring (review L4): each field is a DDL statement plus an insert. */
export const TEMPLATE_CAPS = {
  collections: 100,
  fields: 3000,
  relations: 500,
  workflows: 50,
  states_per_workflow: 100,
  transitions_per_workflow: 300,
  layouts: 300,
  groups_per_layout: 200,
  assignments_per_layout: 1000,
  queues: 100,
  rules: 300,
  payload_templates: 100,
  roles: 100,
  policies: 5000,
  flows: 200,
  operations_per_flow: 200
} as const

const NAME_RE = /^[a-zA-Z0-9_]+$/
export const isSystemCollection = (name: string) => /^(nivaro_|directus_)/i.test(name)

export interface SanitizeReview {
  /** Columns removed, by part ("collections.virtual_sql" → rows it was on). */
  stripped: Record<string, number>
  /** Parts left out because they reach outside the template (plain sentences, ≤ 50). */
  refused: string[]
  /** Collections whose virtual SQL was removed (they install as ordinary tables). */
  virtual_removed: string[]
  /** Transition actions and rules the template carries (run on the app once installed). */
  transition_actions: number
  rules: number
}

export interface SanitizeResult {
  blueprint: Blueprint
  review: SanitizeReview
}

export class TemplateShapeError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'TemplateShapeError'
    this.code = code
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function arr(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new TemplateShapeError('BAD_SHAPE', `${what} must be a list.`)
  return v
}

function rows(v: unknown, what: string): Record<string, unknown>[] {
  const list = arr(v, what)
  if (!list.every(isObj))
    throw new TemplateShapeError('BAD_SHAPE', `Every entry of ${what} must be an object.`)
  return list as Record<string, unknown>[]
}

function cap(n: number, max: number, what: string) {
  if (n > max)
    throw new TemplateShapeError(
      'TOO_MANY_PARTS',
      `The template has ${n} ${what}; a template may bring at most ${max}.`
    )
}

/** Pure: the template as it may be installed, and what was removed or refused. */
export function sanitizeBlueprint(bp: Blueprint): SanitizeResult {
  const review: SanitizeReview = {
    stripped: {},
    refused: [],
    virtual_removed: [],
    transition_actions: 0,
    rules: 0
  }
  const refuse = (why: string) => {
    if (review.refused.length < 50) review.refused.push(why)
  }
  const keep = (part: keyof typeof ALLOWED_COLUMNS, row: Record<string, unknown>) => {
    const allowed = ALLOWED_COLUMNS[part]
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (allowed.has(k)) out[k] = v
      else review.stripped[`${part}.${k}`] = (review.stripped[`${part}.${k}`] ?? 0) + 1
    }
    return out
  }

  const cols = rows(bp.collections, 'collections')
  cap(cols.length, TEMPLATE_CAPS.collections, 'collections')
  const brought = new Set<string>()
  const collections: Blueprint['collections'] = []
  let fieldCount = 0
  for (const c of cols) {
    if (!isObj(c.meta)) throw new TemplateShapeError('BAD_SHAPE', 'A collection has no meta.')
    const name = String(c.meta.collection ?? '')
    if (!NAME_RE.test(name) || isSystemCollection(name)) {
      refuse(`Collection "${name.slice(0, 64)}" (not a business collection name)`)
      continue
    }
    if (brought.has(name.toLowerCase())) {
      refuse(`Collection "${name}" is listed twice`)
      continue
    }
    brought.add(name.toLowerCase())
    if (c.meta.is_virtual === true || c.meta.is_virtual === 1 || c.meta.virtual_sql)
      review.virtual_removed.push(name)
    const fields = rows(c.fields, `the fields of ${name}`)
    fieldCount += fields.length
    collections.push({
      meta: keep('collections', c.meta),
      fields: fields
        .filter((f) => NAME_RE.test(String(f.field ?? '')))
        .map((f) => ({ ...keep('fields', f), collection: name }))
    })
  }
  cap(fieldCount, TEMPLATE_CAPS.fields, 'fields')
  const inside = (c: unknown) => typeof c === 'string' && brought.has(c.toLowerCase())

  const relations: Blueprint['relations'] = []
  const rels = rows(bp.relations, 'relations')
  cap(rels.length, TEMPLATE_CAPS.relations, 'relations')
  for (const r of rels) {
    const one = r.one_collection
    const oneOk = one == null || inside(one) || one === 'nivaro_files'
    if (!inside(r.many_collection) || !oneOk) {
      refuse(`Relation ${String(r.many_collection)}.${String(r.many_field)} → ${String(one)}`)
      continue
    }
    relations.push(keep('relations', r))
  }

  const workflows: Blueprint['workflows'] = []
  const wfs = rows(bp.workflows, 'workflows')
  cap(wfs.length, TEMPLATE_CAPS.workflows, 'workflows')
  for (const w of wfs) {
    if (!isObj(w.template) || typeof w.template.id !== 'string' || !w.template.id) {
      refuse('A workflow without a template id')
      continue
    }
    const tpl = w.template as Record<string, unknown>
    const label = String(tpl.name ?? tpl.id)
    const states = rows(w.states, 'workflow states')
    const transitions = rows(w.transitions, 'workflow transitions')
    cap(states.length, TEMPLATE_CAPS.states_per_workflow, 'states in one workflow')
    cap(transitions.length, TEMPLATE_CAPS.transitions_per_workflow, 'transitions in one workflow')
    const bindings = rows(w.bindings, 'workflow bindings').filter((b) => {
      if (inside(b.collection)) return true
      refuse(`Workflow ${label} bound to ${String(b.collection)}`)
      return false
    })
    if (!bindings.length) {
      refuse(`Workflow ${label} (bound to none of its collections)`)
      continue
    }
    const tid = String(tpl.id)
    for (const t of transitions) review.transition_actions += countActions(t.actions)
    const dims = w.dimensions === undefined ? null : rows(w.dimensions, 'pipeline dimensions')
    workflows.push({
      template: keep('workflow_templates', tpl),
      states: states.map((s) => ({ ...keep('workflow_states', s), template: tid })),
      transitions: transitions.map((t) => ({ ...keep('workflow_transitions', t), template: tid })),
      bindings: bindings.map((b) => ({ ...keep('workflow_bindings', b), template: tid })),
      ...(dims
        ? {
            dimensions: dims
              .filter((d) => inside(d.collection))
              .map((d) => keep('pipeline_dimensions', d))
          }
        : {})
    })
  }

  const layouts: Blueprint['layouts'] = []
  const ls = rows(bp.layouts, 'layouts')
  cap(ls.length, TEMPLATE_CAPS.layouts, 'layouts')
  for (const l of ls) {
    if (!isObj(l.layout) || !inside(l.layout.collection)) {
      refuse(
        `Layout ${String((l.layout as Record<string, unknown> | undefined)?.name ?? '')} on another collection`
      )
      continue
    }
    const groups = rows(l.groups, 'layout groups')
    const assignments = rows(l.assignments, 'layout fields')
    cap(groups.length, TEMPLATE_CAPS.groups_per_layout, 'sections in one layout')
    cap(assignments.length, TEMPLATE_CAPS.assignments_per_layout, 'fields in one layout')
    layouts.push({
      layout: keep('layouts', l.layout),
      groups: groups
        .filter((g) => g.collection == null || inside(g.collection))
        .map((g) => keep('field_groups', g)),
      assignments: assignments.map((a) => keep('assignments', a))
    })
  }

  const queues: Blueprint['queues'] = []
  const qs = rows(bp.queues, 'queues')
  cap(qs.length, TEMPLATE_CAPS.queues, 'queues')
  for (const q of qs) {
    const sources = rows(q.sources, 'queue sources')
    if (!isObj(q.queue) || typeof q.queue.id !== 'string' || !sources.length) {
      refuse('A queue without an id or sources')
      continue
    }
    if (!sources.every((s) => s.type !== 'collection' || inside(s.collection))) {
      refuse(`Queue ${String(q.queue.name ?? q.queue.id)} reads another collection`)
      continue
    }
    queues.push({
      queue: keep('queues', q.queue),
      sources: sources.map((s) => keep('queue_sources', s))
    })
  }

  const rules: Blueprint['rules'] = []
  const rs = rows(bp.rules, 'rules')
  cap(rs.length, TEMPLATE_CAPS.rules, 'rules')
  for (const r of rs) {
    if (!inside(r.collection)) {
      refuse(`Rule ${String(r.name ?? '')} on ${String(r.collection)}`)
      continue
    }
    rules.push(keep('rules', r))
  }
  review.rules = rules.length

  // Hub enhancement 46: roles (with policies on the blueprint's own collections, plus reads of
  // the system directory tables a working app needs) and flows (always inactive).
  const roles = sanitizeRoles(bp.roles, keep, refuse, inside)
  const flows = sanitizeFlows(bp.flows, keep, refuse)

  const pts = arr(bp.payload_templates, 'payload templates')
  cap(pts.length, TEMPLATE_CAPS.payload_templates, 'payload templates')

  return {
    blueprint: {
      type: 'nivaro-blueprint',
      version: 1,
      name: String(bp.name ?? '').slice(0, 200),
      exported_at: String(bp.exported_at ?? ''),
      collections,
      relations,
      workflows,
      layouts,
      queues,
      rules,
      ...(pts.length ? { payload_templates: pts as Blueprint['payload_templates'] } : {}),
      ...(roles ? { roles } : {}),
      ...(flows ? { flows } : {})
    },
    review
  }
}

type Keep = (
  part: keyof typeof ALLOWED_COLUMNS,
  row: Record<string, unknown>
) => Record<string, unknown>

/** System tables a cloned role may READ (a working app shows people and files). */
const SYSTEM_READS = new Set(['nivaro_users', 'nivaro_files'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sanitizeRoles(
  v: unknown,
  keep: Keep,
  refuse: (why: string) => void,
  inside: (c: unknown) => boolean
): Blueprint['roles'] | undefined {
  if (v === undefined || v === null) return undefined
  const list = rows(v, 'roles')
  cap(list.length, TEMPLATE_CAPS.roles, 'roles')
  const out: NonNullable<Blueprint['roles']> = []
  let policyCount = 0
  for (const r of list) {
    const role = isObj(r.role) ? r.role : null
    const id = String(role?.id ?? '')
    const name = String(role?.name ?? '').slice(0, 255)
    if (!role || !UUID_RE.test(id) || !name) {
      refuse('A role without an id or a name')
      continue
    }
    const policies = rows(r.policies, `the policies of ${name}`)
    policyCount += policies.length
    const kept = policies
      .filter((p) => {
        const c = String(p.collection ?? '')
        if (inside(c)) return true
        if (SYSTEM_READS.has(c) && p.action === 'read') return true
        refuse(`Policy of ${name} on ${c.slice(0, 64)}`)
        return false
      })
      .map((p) => ({ ...keep('policies', p), role: id }))
    out.push({ role: keep('roles', role), policies: kept })
  }
  cap(policyCount, TEMPLATE_CAPS.policies, 'policies')
  return out
}

function sanitizeFlows(
  v: unknown,
  keep: Keep,
  refuse: (why: string) => void
): Blueprint['flows'] | undefined {
  if (v === undefined || v === null) return undefined
  const list = rows(v, 'flows')
  cap(list.length, TEMPLATE_CAPS.flows, 'flows')
  const out: NonNullable<Blueprint['flows']> = []
  for (const f of list) {
    const flow = isObj(f.flow) ? f.flow : null
    const id = String(flow?.id ?? '')
    if (!flow || !UUID_RE.test(id)) {
      refuse('A flow without an id')
      continue
    }
    const ops = rows(f.operations, `the steps of flow ${String(flow.name ?? id).slice(0, 64)}`)
    cap(ops.length, TEMPLATE_CAPS.operations_per_flow, 'steps in one flow')
    out.push({
      // Always inactive: an administrator turns a flow on after reading it.
      flow: { ...keep('flows', flow), status: 'inactive' },
      operations: ops.map((o) => ({ ...keep('flow_operations', o), flow: id }))
    })
  }
  return out
}

function countActions(v: unknown): number {
  let a = v
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a)
    } catch {
      return 0
    }
  }
  return Array.isArray(a) ? a.length : 0
}

/** Whether a review found anything a person should know about before installing. */
export function reviewNotes(r: SanitizeReview | null | undefined): string[] {
  if (!r) return []
  const out: string[] = []
  if (r.virtual_removed.length)
    out.push(
      `Virtual SQL removed: ${r.virtual_removed.slice(0, 5).join(', ')} install as ordinary collections.`
    )
  const stripped = Object.keys(r.stripped)
  if (stripped.length)
    out.push(`Settings removed (not allowed in a template): ${stripped.slice(0, 8).join(', ')}.`)
  if (r.refused.length)
    out.push(
      `Left out (outside the template's own collections): ${r.refused.slice(0, 5).join('; ')}.`
    )
  return out
}
