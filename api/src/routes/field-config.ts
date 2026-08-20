import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { bustRollupContributorCache } from '../services/rollups.js'

function parseJsonSafe(val: unknown): unknown {
  if (val === null || val === undefined) return val
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

interface FieldRow {
  display?: string | null
  display_options?: string | null
  field: string
  type: string | null
  label: string | null
  note: string | null
  placeholder: string | null
  hidden: number | boolean | null
  readonly: number | boolean | null
  required: number | boolean | null
  interface: string | null
  options: string | null
  group_key: string | null
  visibility_rules: string | null
  dependency_config: string | null
  validation_rules: string | null
  lock_condition: string | null
  default_formula: string | null
  computed_formula: string | null
  computed_type: string | null
  cross_record_defaults: string | null
  remote_options_config: string | null
  repeater_schema: string | null
  is_translatable: number | boolean | null
  sort?: number | null
}

function formatFieldConfig(row: FieldRow) {
  return {
    field: row.field,
    type: row.type ?? null,
    label: row.label ?? null,
    note: row.note ?? null,
    placeholder: row.placeholder ?? null,
    hidden: !!row.hidden,
    // A derived field is never editable: a rollup is recomputed from its
    // source rows and a write-computed field from its formula, so anything
    // typed in is silently discarded on save. Offering an input for it invites
    // a user to enter a number that quietly does not stick — the exact failure
    // that made "Close Out Lines" look like it had done nothing. An explicit
    // per-layout override can still force it editable.
    readonly: !!row.readonly || row.computed_type === 'rollup' || row.computed_type === 'write',
    required: !!row.required,
    interface: row.interface ?? null,
    display: row.display ?? null,
    display_options: parseJsonSafe(row.display_options),
    options: parseJsonSafe(row.options),
    group_key: row.group_key ?? null,
    visibility_rules: parseJsonSafe(row.visibility_rules),
    dependency_config: parseJsonSafe(row.dependency_config),
    validation_rules: parseJsonSafe(row.validation_rules),
    lock_condition: parseJsonSafe(row.lock_condition),
    default_formula: row.default_formula ?? null,
    computed_formula: row.computed_formula ?? null,
    computed_type: row.computed_type ?? null,
    cross_record_defaults: parseJsonSafe(row.cross_record_defaults),
    remote_options_config: parseJsonSafe(row.remote_options_config),
    repeater_schema: parseJsonSafe(row.repeater_schema),
    is_translatable: !!row.is_translatable
  }
}

// ─── Simple formula evaluator ─────────────────────────────────────────────────

function evaluateFormula(formula: string, values: Record<string, unknown>): unknown {
  const f = formula.trim()

  if (f === 'TODAY()') {
    return new Date().toISOString().slice(0, 10)
  }

  const upperMatch = f.match(/^UPPER\((\w+)\)$/)
  if (upperMatch) {
    const v = values[upperMatch[1]]
    return typeof v === 'string' ? v.toUpperCase() : v
  }

  const lowerMatch = f.match(/^LOWER\((\w+)\)$/)
  if (lowerMatch) {
    const v = values[lowerMatch[1]]
    return typeof v === 'string' ? v.toLowerCase() : v
  }

  const concatMatch = f.match(/^CONCAT\((.+)\)$/)
  if (concatMatch) {
    const parts = concatMatch[1].split(',').map((p) => p.trim())
    return parts
      .map((p) => {
        if (p.startsWith("'") && p.endsWith("'")) return p.slice(1, -1)
        if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1)
        return String(values[p] ?? '')
      })
      .join('')
  }

  return undefined
}

// ─── Visibility rule evaluator ────────────────────────────────────────────────

type Condition = { field: string; operator: string; value: unknown }
type VisibilityRules = { show_when?: Condition[]; hide_when?: Condition[] }

function evaluateCondition(cond: Condition, values: Record<string, unknown>): boolean {
  const actual = values[cond.field]
  switch (cond.operator) {
    case 'eq':
      return actual === cond.value
    case 'neq':
      return actual !== cond.value
    case 'null':
      return actual == null
    case 'nnull':
      return actual != null
    case 'in':
      return Array.isArray(cond.value) && cond.value.includes(actual)
    case 'nin':
      return Array.isArray(cond.value) && !cond.value.includes(actual)
    case 'gt':
      return Number(actual) > Number(cond.value)
    case 'lt':
      return Number(actual) < Number(cond.value)
    default:
      return false
  }
}

export async function fieldConfigRoutes(app: FastifyInstance) {
  // GET /field-config/:collection — get all field configs, overlaid with active layout assignments
  app.get('/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { layout_id } = req.query as { layout_id?: string }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .select(
        'field',
        'type',
        'label',
        'note',
        'display',
        'display_options',
        'hidden',
        'readonly',
        'required',
        'interface',
        'options',
        'group_key',
        'visibility_rules',
        'dependency_config',
        'validation_rules',
        'lock_condition',
        'default_formula',
        'computed_formula',
        'computed_type',
        'cross_record_defaults',
        'remote_options_config',
        'repeater_schema',
        'is_translatable',
        'sort',
        'placeholder'
      )
      .orderBy('sort', 'asc')) as FieldRow[]

    // Resolve layout assignments — use explicit layout_id or fall back to active layout
    let targetLayoutId: number | null = null
    if (layout_id) {
      const parsed = parseInt(layout_id, 10)
      if (!Number.isFinite(parsed)) return reply.code(400).send({ error: 'Invalid layout_id' })
      targetLayoutId = parsed
    } else {
      const active = await db('nivaro_collection_layouts')
        .where({ collection, is_active: 1 })
        .first('id')
      targetLayoutId = active?.id ?? null
    }

    // Multi-group: a field may have multiple assignments (different group_keys)
    type Assignment = {
      group_key: string | null
      sort: number
      label_override: string | null
      is_visible: number | null
      default_expanded: number | null
      show_row_revisions: number | null
      show_approval_chain: number | null
      col_span: number | null
      overrides: Record<string, unknown> | null
      widget_id: number | null
      input_bindings: string | null
      lock_conditions: string | null
      allow_revision_restore: number | null
    }
    const assignmentsByField = new Map<string, Assignment[]>()
    let ungrouped_sort: number | null = null
    if (targetLayoutId !== null) {
      const assignments = await db('nivaro_layout_field_assignments')
        .where({ layout_id: targetLayoutId })
        .select(
          'field',
          'group_key',
          'sort',
          'label_override',
          'is_visible',
          'default_expanded',
          'show_row_revisions',
          'show_approval_chain',
          'col_span',
          'overrides',
          'widget_id',
          'input_bindings',
          'lock_conditions',
          'allow_revision_restore'
        )
      for (const a of assignments) {
        if (a.field === '__ungrouped_pos__') {
          ungrouped_sort = a.sort
          continue
        }
        let overrides: Record<string, unknown> | null = null
        try {
          overrides = a.overrides
            ? typeof a.overrides === 'string'
              ? JSON.parse(a.overrides)
              : a.overrides
            : null
        } catch {
          /* noop */
        }
        const entry: Assignment = {
          group_key: a.group_key,
          sort: a.sort,
          label_override: a.label_override ?? null,
          is_visible: a.is_visible ?? null,
          default_expanded: a.default_expanded ?? null,
          show_row_revisions: a.show_row_revisions ?? null,
          show_approval_chain: a.show_approval_chain ?? null,
          col_span: a.col_span ?? null,
          overrides,
          widget_id: a.widget_id ?? null,
          input_bindings: a.input_bindings ?? null,
          lock_conditions: a.lock_conditions ?? null,
          allow_revision_restore: a.allow_revision_restore ?? null
        }
        const existing = assignmentsByField.get(a.field)
        if (existing) existing.push(entry)
        else assignmentsByField.set(a.field, [entry])
      }
    }

    // Dotted relation-path fields may have a nivaro_fields alias row (created by
    // the rename PATCH) — capture its label but keep them OUT of the normal
    // emission so they always render via the relation-path virtual branch.
    const dottedLabels = new Map<string, string | null>()
    for (const r of rows) {
      if (r.field.includes('.') && !r.field.startsWith('__'))
        dottedLabels.set(r.field, r.label ?? null)
    }
    const plainRows = rows.filter((r) => !dottedLabels.has(r.field))
    const knownFields = new Set(plainRows.map((r) => r.field))

    // Emit one formatted row per (field, group_key) assignment — multi-group fields appear multiple times
    const formatted: unknown[] = []
    for (const [rowIdx, row] of plainRows.entries()) {
      const fieldAssignments = assignmentsByField.get(row.field)
      const base = formatFieldConfig(row)

      if (!fieldAssignments || fieldAssignments.length === 0) {
        // Strip layout-specific options so unassigned fields don't inherit from global field metadata
        const unassignedOpts = base.options
          ? { ...(base.options as Record<string, unknown>) }
          : null
        if (unassignedOpts) {
          delete unassignedOpts.col_span
          delete unassignedOpts.show_row_revisions
        }
        formatted.push({
          ...base,
          options: unassignedOpts,
          sort: row.sort ?? rowIdx,
          layout_assigned: false,
          _overrides: null
        })
        continue
      }

      for (const assignment of fieldAssignments) {
        const ov = assignment.overrides ?? null
        // Start from base.options but strip layout-specific keys so the assignment is authoritative
        let options: Record<string, unknown> | null = base.options
          ? { ...(base.options as Record<string, unknown>) }
          : null
        if (options) {
          delete options.col_span
          delete options.show_row_revisions
        }
        if (assignment.col_span != null)
          options = { ...(options ?? {}), col_span: assignment.col_span }
        if (assignment.show_row_revisions)
          options = { ...(options ?? {}), show_row_revisions: true }
        if (assignment.lock_conditions)
          options = { ...(options ?? {}), lock_conditions: assignment.lock_conditions }
        if (assignment.allow_revision_restore != null)
          options = {
            ...(options ?? {}),
            allow_revision_restore: !!assignment.allow_revision_restore
          }
        if (ov?.options && typeof ov.options === 'object')
          options = { ...(options ?? {}), ...(ov.options as Record<string, unknown>) }
        formatted.push({
          ...base,
          options,
          label: ov?.label !== undefined ? (ov.label as string | null) : base.label,
          note: ov?.note !== undefined ? (ov.note as string | null) : base.note,
          hidden: ov?.hidden !== undefined ? !!ov.hidden : base.hidden,
          // base.readonly already carries the derived-field rule. A layout
          // override cannot switch it back on for a computed field via the
          // wholesale `readonly` key (the layout editor writes it with its
          // defaults — a `false` there is serialization, not a decision).
          // `editable_computed` is the EXPLICIT opt-in: it lifts only the
          // derived-field rule, letting a layout accept manual entry for a
          // rollup (a PUB workflow's Total REQ Amount, entered by hand
          // because no lines exist to sum). The next contributor write still
          // recalculates a stored rollup — the flag is per-layout curation,
          // not a change to what the field IS.
          readonly:
            ov?.editable_computed === true &&
            (base.computed_type === 'rollup' || base.computed_type === 'write')
              ? // Only the FIELD's own explicit readonly still binds — the
                // override's readonly is the derived state serialized back by
                // the settings sheet, which is exactly what this flag lifts.
                !!row.readonly
              : base.readonly || (ov?.readonly !== undefined ? !!ov.readonly : base.readonly),
          required: ov?.required !== undefined ? !!ov.required : base.required,
          interface: ov?.interface !== undefined ? (ov.interface as string | null) : base.interface,
          placeholder:
            ov?.placeholder !== undefined
              ? (ov.placeholder as string | null)
              : ((base as Record<string, unknown>).placeholder ?? null),
          dependency_config:
            ov?.dependency_config !== undefined
              ? ov.dependency_config
              : ((base as Record<string, unknown>).dependency_config ?? null),
          group_key: assignment.group_key,
          sort: assignment.sort,
          layout_assigned: true,
          // Inline-rename label (distinct from overrides.label) — the layouts
          // editor round-trips it; header field chips read it back on load.
          label_override: assignment.label_override ?? null,
          lock_conditions: assignment.lock_conditions ?? null,
          allow_revision_restore:
            assignment.allow_revision_restore == null ? true : !!assignment.allow_revision_restore,
          widget_id: assignment.widget_id ?? null,
          input_bindings: assignment.input_bindings ?? null,
          _overrides: ov
        })
      }
    }

    // Virtual fields (O2M/M2M alias with no nivaro_fields row) that are in assignments
    for (const [field, fieldAssignments] of assignmentsByField.entries()) {
      if (knownFields.has(field)) continue
      // Relation-path field ('purchase_order.workflow.workflow_id'): read-only
      // display of a value reached through M2O hops. Rendered via the shared
      // form's relation-path handling; value resolved by /items/:col/:id/resolve-paths.
      if (field.includes('.') && !field.startsWith('__')) {
        // Final entity collection of the chain — lets the layout settings popover
        // list the target's detail layouts for drill-down config.
        let pathTarget: string | null = null
        try {
          const { classifyRelationSegment } = await import('../services/queues.js')
          const { getRelations } = await import('../services/collections.js')
          let cur = collection
          for (const seg of field.split('.')) {
            const info = classifyRelationSegment(cur, seg, await getRelations(cur))
            if (!info?.relatedCollection) break
            cur = info.relatedCollection
            pathTarget = cur
          }
        } catch {
          /* leave null */
        }
        for (const a of fieldAssignments) {
          const autoLabel = field
            .split('.')
            .map((seg) => seg.replace(/_/g, ' ').replace(/(^|\s)\S/g, (c) => c.toUpperCase()))
            .join(' → ')
          const aliasLabel = dottedLabels.get(field) ?? null
          const ov = a.overrides ?? null
          formatted.push({
            field,
            // Alias precedence: chip settings (overrides.label) -> inline rename
            // (label_override) -> nivaro_fields alias row -> auto from the path.
            label: (ov?.label as string | null) ?? a.label_override ?? aliasLabel ?? autoLabel,
            note: (ov?.note as string | null) ?? null,
            hidden: false,
            readonly: true,
            required: false,
            interface: 'relation-path',
            display: null,
            display_options: null,
            options: {
              ...(ov?.options && typeof ov.options === 'object'
                ? (ov.options as Record<string, unknown>)
                : {}),
              ...(pathTarget ? { path_target_collection: pathTarget } : {})
            },
            group_key: a.group_key,
            sort: a.sort,
            label_override: a.label_override,
            is_visible: a.is_visible,
            default_expanded: a.default_expanded,
            show_row_revisions: false,
            show_approval_chain: null,
            lock_conditions: null,
            allow_revision_restore: false,
            // Header display bindings (link template, color, format) save per
            // assignment for dotted fields too — hardcoding null here made the
            // editor seed empty on reload and the next auto-save WIPE the
            // stored value.
            widget_id: null,
            input_bindings: a.input_bindings ?? null,
            layout_assigned: true,
            is_virtual: true as unknown,
            dependency_config: null,
            type: 'string',
            _overrides: a.overrides ?? null
          })
        }
        continue
      }
      for (const a of fieldAssignments) {
        const ov = a.overrides ?? null
        let virtualOpts: Record<string, unknown> | null = a.show_row_revisions
          ? { show_row_revisions: true }
          : null
        if (a.lock_conditions)
          virtualOpts = { ...(virtualOpts ?? {}), lock_conditions: a.lock_conditions }
        if (a.allow_revision_restore != null)
          virtualOpts = {
            ...(virtualOpts ?? {}),
            allow_revision_restore: !!a.allow_revision_restore
          }
        if (ov?.options && typeof ov.options === 'object') {
          virtualOpts = { ...(virtualOpts ?? {}), ...(ov.options as Record<string, unknown>) }
        }
        formatted.push({
          field,
          label: (ov?.label as string | null) ?? null,
          note: null,
          hidden: false,
          readonly: false,
          required: false,
          interface: ov?.interface !== undefined ? (ov.interface as string | null) : 'o2m',
          options: virtualOpts,
          group_key: a.group_key,
          sort: a.sort,
          label_override: a.label_override,
          is_visible: a.is_visible,
          default_expanded: a.default_expanded,
          show_row_revisions: a.show_row_revisions,
          show_approval_chain: a.show_approval_chain,
          lock_conditions: a.lock_conditions ?? null,
          allow_revision_restore:
            a.allow_revision_restore == null ? true : !!a.allow_revision_restore,
          widget_id: a.widget_id ?? null,
          input_bindings: a.input_bindings ?? null,
          layout_assigned: true,
          is_virtual: true as unknown,
          dependency_config: null,
          _overrides: ov
        })
      }
    }

    ;(formatted as Array<{ sort?: number }>).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))

    return reply.send({ data: formatted, ungrouped_sort })
  })

  // PATCH /field-config/:collection/:field — update field config
  app.patch('/:collection/:field', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection, field } = req.params as { collection: string; field: string }

    app.log.info({ collection, field }, 'field-config PATCH')

    let existing = await db('nivaro_fields').where({ collection, field }).first()
    app.log.info({ existing: !!existing }, 'field-config PATCH existing check')
    if (!existing) {
      // Auto-create an alias row for virtual fields (M2M/O2M) that have no nivaro_fields row.
      try {
        await db('nivaro_fields').insert({
          collection,
          field,
          type: 'alias',
          interface: null,
          hidden: false,
          readonly: false,
          required: false,
          sort: null,
          label: null,
          note: null,
          options: null,
          group_key: null,
          visibility_rules: null,
          dependency_config: null,
          validation_rules: null,
          lock_condition: null,
          default_formula: null,
          cross_record_defaults: null,
          remote_options_config: null,
          repeater_schema: null,
          is_translatable: false
        })
        existing = await db('nivaro_fields').where({ collection, field }).first()
      } catch (insertErr) {
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr)
        return reply.code(500).send({ error: `Failed to create field row: ${msg}` })
      }
    }

    const body = req.body as Partial<{
      label: string | null
      note: string | null
      hidden: boolean
      readonly: boolean
      required: boolean
      interface: string | null
      group_key: string | null
      sort: number | null
      col_span: number | null
      options: string | null
      inline_relation: boolean | null
      max_values: number | null
      visibility_rules: unknown
      dependency_config: unknown
      validation_rules: unknown
      lock_condition: unknown
      default_formula: string | null
      cross_record_defaults: unknown
      remote_options_config: unknown
      repeater_schema: unknown
      is_translatable: boolean
    }>

    const patch: Record<string, unknown> = { updated_at: new Date() }

    if ('label' in body) patch.label = body.label ?? null
    if ('note' in body) patch.note = body.note ?? null
    if ('placeholder' in body)
      patch.placeholder = (body as Record<string, unknown>).placeholder ?? null
    if ('hidden' in body) patch.hidden = body.hidden ? 1 : 0
    if ('readonly' in body) patch.readonly = body.readonly ? 1 : 0
    if ('required' in body) patch.required = body.required ? 1 : 0
    if ('interface' in body) patch.interface = body.interface ?? null
    if ('group_key' in body) patch.group_key = body.group_key ?? null
    if ('sort' in body) patch.sort = body.sort ?? null
    if (
      'options' in body &&
      !('col_span' in body) &&
      !('inline_relation' in body) &&
      !('max_values' in body)
    ) {
      patch.options = body.options ?? null
    }
    if ('col_span' in body || 'inline_relation' in body || 'max_values' in body) {
      let opts: Record<string, unknown> = {}
      try {
        opts = JSON.parse(String(existing.options ?? '{}'))
      } catch {
        /* noop */
      }
      if ('col_span' in body) {
        if (body.col_span == null) delete opts.col_span
        else opts.col_span = body.col_span
      }
      if ('inline_relation' in body) {
        if ((body as Record<string, unknown>).inline_relation == null) delete opts.inline_relation
        else opts.inline_relation = (body as Record<string, unknown>).inline_relation
      }
      if ('max_values' in body) {
        const mv = (body as Record<string, unknown>).max_values
        if (mv == null) delete opts.max_values
        else opts.max_values = mv
      }
      patch.options = JSON.stringify(opts)
    }
    if ('visibility_rules' in body)
      patch.visibility_rules =
        body.visibility_rules != null ? JSON.stringify(body.visibility_rules) : null
    if ('dependency_config' in body)
      patch.dependency_config =
        body.dependency_config != null ? JSON.stringify(body.dependency_config) : null
    if ('validation_rules' in body)
      patch.validation_rules =
        body.validation_rules != null ? JSON.stringify(body.validation_rules) : null
    if ('lock_condition' in body)
      patch.lock_condition =
        body.lock_condition != null ? JSON.stringify(body.lock_condition) : null
    if ('default_formula' in body) patch.default_formula = body.default_formula ?? null
    if ('cross_record_defaults' in body)
      patch.cross_record_defaults =
        body.cross_record_defaults != null ? JSON.stringify(body.cross_record_defaults) : null
    if ('remote_options_config' in body)
      patch.remote_options_config =
        body.remote_options_config != null ? JSON.stringify(body.remote_options_config) : null
    if ('repeater_schema' in body)
      patch.repeater_schema =
        body.repeater_schema != null ? JSON.stringify(body.repeater_schema) : null
    if ('is_translatable' in body) patch.is_translatable = body.is_translatable ? 1 : 0

    await db('nivaro_fields').where({ collection, field }).update(patch)
    bustRollupContributorCache()

    const updated = (await db('nivaro_fields')
      .where({ collection, field })
      .select(
        'field',
        'label',
        'note',
        'hidden',
        'readonly',
        'required',
        'interface',
        'options',
        'group_key',
        'visibility_rules',
        'dependency_config',
        'validation_rules',
        'lock_condition',
        'default_formula',
        'cross_record_defaults',
        'remote_options_config',
        'repeater_schema',
        'is_translatable'
      )
      .first()) as FieldRow

    await logActivity({
      action: 'schema-field-update',
      user: req.user?.id,
      collection,
      item: field,
      comment: 'field-config',
      req
    })

    return reply.send({ data: formatFieldConfig(updated) })
  })

  // POST /field-config/:collection/evaluate-visibility
  app.post('/:collection/evaluate-visibility', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { values } = req.body as { values: Record<string, unknown> }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .select('field', 'visibility_rules')) as Array<{
      field: string
      visibility_rules: string | null
    }>

    const hidden_fields: string[] = []

    for (const row of rows) {
      if (!row.visibility_rules) continue
      const rules = parseJsonSafe(row.visibility_rules) as VisibilityRules | null
      if (!rules) continue

      let isVisible = true

      // hide_when: if any condition matches, hide the field
      if (rules.hide_when && rules.hide_when.length > 0) {
        const shouldHide = rules.hide_when.some((c) => evaluateCondition(c, values))
        if (shouldHide) isVisible = false
      }

      // show_when: field is only shown if at least one condition matches
      if (isVisible && rules.show_when && rules.show_when.length > 0) {
        const shouldShow = rules.show_when.some((c) => evaluateCondition(c, values))
        if (!shouldShow) isVisible = false
      }

      if (!isVisible) hidden_fields.push(row.field)
    }

    return reply.send({ hidden_fields })
  })

  // POST /field-config/:collection/evaluate-defaults
  app.post('/:collection/evaluate-defaults', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { trigger_field, values } = req.body as {
      trigger_field: string
      values: Record<string, unknown>
    }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .whereNotNull('default_formula')
      .select('field', 'default_formula')) as Array<{
      field: string
      default_formula: string
    }>

    const updates: Record<string, unknown> = {}

    for (const row of rows) {
      const formula = row.default_formula
      // Only evaluate if the formula references the trigger field
      if (!formula.includes(trigger_field) && formula !== 'TODAY()') continue
      const result = evaluateFormula(formula, values)
      if (result !== undefined) {
        updates[row.field] = result
      }
    }

    return reply.send({ updates })
  })

  // POST /field-config/:collection/evaluate-lock
  app.post('/:collection/evaluate-lock', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { values } = req.body as { values: Record<string, unknown> }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .whereNotNull('lock_condition')
      .select('field', 'lock_condition')) as Array<{
      field: string
      lock_condition: string
    }>

    const locked_fields: string[] = []

    for (const row of rows) {
      const condition = parseJsonSafe(row.lock_condition) as Condition | null
      if (!condition) continue
      if (evaluateCondition(condition, values)) {
        locked_fields.push(row.field)
      }
    }

    return reply.send({ locked_fields })
  })

  // POST /field-config/:collection/cascade
  app.post('/:collection/cascade', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { changed_field, values } = req.body as {
      changed_field: string
      values: Record<string, unknown>
    }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .whereNotNull('dependency_config')
      .select('field', 'dependency_config')) as Array<{
      field: string
      dependency_config: string
    }>

    const updates: Record<string, unknown> = {}
    const option_filters: Record<string, unknown> = {}

    for (const row of rows) {
      const config = parseJsonSafe(row.dependency_config) as {
        depends_on?: string
        filter_by?: string
        clear_on_change?: boolean
        option_filter?: Record<string, unknown>
      } | null
      if (!config) continue
      if (config.depends_on !== changed_field && config.filter_by !== changed_field) continue

      if (config.clear_on_change) {
        updates[row.field] = null
      }

      if (config.option_filter) {
        const filterValue = values[changed_field]
        option_filters[row.field] = {
          ...config.option_filter,
          _parent_value: filterValue
        }
      }
    }

    return reply.send({ updates, option_filters })
  })
}
