import { db } from '../db/index.js'

/**
 * Field impact analysis — "what references this field?"
 *
 * Scans every metadata surface that can hold a field reference: layout
 * assignments (including dotted relation paths), queue source configs,
 * display templates, computed formulas, field rules, visibility/lock/
 * dependency configs, at-risk rules, alert definitions, field watches,
 * automation rules, and workflow transition conditions.
 *
 * Matching against JSON text columns is substring-based on purpose — impact
 * analysis errs toward recall. Every hit says where it came from so a human
 * can judge before deleting/renaming.
 */

export interface FieldImpact {
  source: string // machine key, e.g. 'layout', 'queue-source'
  label: string // human summary, e.g. "Layout 'Default'"
  detail: string // what kind of reference
  link: string | null // admin route to the config
}

async function safeQuery<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn()
  } catch {
    return []
  }
}

export async function analyzeFieldImpact(
  collection: string,
  field: string
): Promise<FieldImpact[]> {
  const impacts: FieldImpact[] = []
  const fieldToken = `%${field}%`
  const quoted = `%"${field}"%`

  // 1. Layout assignments — exact field, or a dotted path containing it
  const layoutHits = await safeQuery(() =>
    db('nivaro_layout_field_assignments as a')
      .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
      .where('l.collection', collection)
      .where((qb) =>
        qb
          .where('a.field', field)
          .orWhere('a.field', 'like', `${field}.%`)
          .orWhere('a.field', 'like', `%.${field}`)
          .orWhere('a.field', 'like', `%.${field}.%`)
      )
      .select('l.name as layout_name', 'l.id as layout_id', 'a.field as assigned_field')
  )
  for (const h of layoutHits as Array<{ layout_name: string; layout_id: number; assigned_field: string }>) {
    impacts.push({
      source: 'layout',
      label: `Layout '${h.layout_name}'`,
      detail:
        h.assigned_field === field
          ? 'field assignment'
          : `relation-path assignment (${h.assigned_field})`,
      link: `/data-model/${collection}`
    })
  }

  // 2. Queue sources for this collection — extra fields, filters, label
  //    template, aggregates, drilldown, column formats
  const queueSources = await safeQuery(() =>
    db('nivaro_queue_sources as s')
      .join('nivaro_queues as q', 'q.id', 's.queue_id')
      .where('s.collection', collection)
      .select('q.name as queue_name', 'q.id as queue_id', 's.extra_fields', 's.filters', 's.label_template', 's.aggregates', 's.drilldown', 's.column_formats', 's.state_values')
  )
  for (const s of queueSources as Array<Record<string, unknown>>) {
    const uses: string[] = []
    const has = (v: unknown) => typeof v === 'string' && v.includes(field)
    if (has(s.extra_fields)) uses.push('extra column')
    if (has(s.filters)) uses.push('source filter')
    if (has(s.label_template)) uses.push('label template')
    if (has(s.aggregates)) uses.push('aggregate')
    if (has(s.drilldown)) uses.push('drill-down config')
    if (has(s.column_formats)) uses.push('column format')
    if (uses.length > 0) {
      impacts.push({
        source: 'queue-source',
        label: `Queue '${String(s.queue_name)}'`,
        detail: uses.join(', '),
        link: `/queues/${String(s.queue_id)}`
      })
    }
  }

  // 3. Collection display template + picker filter
  const colMeta = await safeQuery(() =>
    db('nivaro_collections').where({ collection }).select('display_template', 'picker_filter')
  )
  if (colMeta[0]) {
    const m = colMeta[0] as { display_template?: string | null; picker_filter?: string | null }
    if (m.display_template?.includes(`{{${field}`)) {
      impacts.push({
        source: 'display-template',
        label: 'Collection display template',
        detail: m.display_template,
        link: `/data-model/${collection}`
      })
    }
    if (m.picker_filter?.includes(`"${field}"`)) {
      impacts.push({
        source: 'picker-filter',
        label: 'Relation picker filter',
        detail: 'field used in picker_filter',
        link: `/data-model/${collection}`
      })
    }
  }

  // 4. Sibling field configs — computed formulas, visibility/lock/dependency/
  //    default rules referencing this field
  const siblingFields = await safeQuery(() =>
    db('nivaro_fields')
      .where({ collection })
      .whereNot({ field })
      .select('field', 'computed_formula', 'visibility_rules', 'lock_condition', 'dependency_config', 'default_formula', 'cross_record_defaults', 'validation_rules')
  )
  for (const f of siblingFields as Array<Record<string, unknown>>) {
    const uses: string[] = []
    const checks: Array<[string, unknown]> = [
      ['computed formula', f.computed_formula],
      ['visibility rules', f.visibility_rules],
      ['lock condition', f.lock_condition],
      ['cascade/dependency config', f.dependency_config],
      ['default formula', f.default_formula],
      ['cross-record defaults', f.cross_record_defaults],
      ['validation rules', f.validation_rules]
    ]
    for (const [what, v] of checks) {
      if (typeof v === 'string' && (v.includes(`"${field}"`) || v.includes(`{{${field}`))) {
        uses.push(what)
      }
    }
    if (uses.length > 0) {
      impacts.push({
        source: 'field-config',
        label: `Field '${String(f.field)}'`,
        detail: uses.join(', '),
        link: `/data-model/${collection}`
      })
    }
  }

  // 5. Field rules (inline defaults)
  const fieldRules = await safeQuery(() =>
    db('nivaro_field_rules')
      .where({ collection })
      .where((qb) => qb.where('trigger_field', field).orWhere('target_field', field))
      .select('id', 'trigger_field', 'target_field')
  )
  for (const r of fieldRules as Array<{ id: number; trigger_field: string; target_field: string }>) {
    impacts.push({
      source: 'field-rule',
      label: `Field rule #${r.id}`,
      detail: r.trigger_field === field ? 'trigger field' : 'target field',
      link: `/data-model/${collection}`
    })
  }

  // 6. At-risk rules
  const atRisk = await safeQuery(() =>
    db('nivaro_at_risk_rules')
      .where({ collection })
      .where('conditions', 'like', quoted)
      .select('id', 'name')
  )
  for (const r of atRisk as Array<{ id: number; name: string }>) {
    impacts.push({
      source: 'at-risk-rule',
      label: `At-risk rule '${r.name}'`,
      detail: 'condition references field',
      link: '/at-risk'
    })
  }

  // 7. Alert definitions
  const alerts = await safeQuery(() =>
    db('nivaro_alert_definitions')
      .where({ collection })
      .where((qb) => qb.where('field', field).orWhere('filters', 'like', quoted))
      .select('id', 'name')
  )
  for (const a of alerts as Array<{ id: number; name: string }>) {
    impacts.push({
      source: 'alert',
      label: `Alert '${a.name}'`,
      detail: 'monitored field or filter',
      link: `/alerts/${a.id}`
    })
  }

  // 8. Field watches
  const watches = await safeQuery(() =>
    db('nivaro_field_watches').where({ collection, field }).select('id', 'name')
  )
  for (const w of watches as Array<{ id: number; name: string }>) {
    impacts.push({
      source: 'field-watch',
      label: `Field watch '${w.name}'`,
      detail: 'watched field',
      link: '/field-watches'
    })
  }

  // 9. Automation rules (conditions/actions JSON)
  const rules = await safeQuery(() =>
    db('nivaro_rules')
      .where('collection', collection)
      .where((qb) => qb.where('conditions', 'like', quoted).orWhere('actions', 'like', quoted))
      .select('id', 'name')
  )
  for (const r of rules as Array<{ id: number | string; name: string }>) {
    impacts.push({
      source: 'rule',
      label: `Rule '${r.name}'`,
      detail: 'condition or action references field',
      link: `/rules/${String(r.id)}`
    })
  }

  // 10. Workflow transition conditions on templates bound to this collection
  const transitions = await safeQuery(() =>
    db('nivaro_workflow_transitions as t')
      .join('nivaro_workflow_bindings as b', 'b.template', 't.template')
      .where('b.collection', collection)
      .where('t.condition_rules', 'like', quoted)
      .select('t.id', 't.label', 't.template')
  )
  for (const t of transitions as Array<{ id: string; label: string; template: string }>) {
    impacts.push({
      source: 'workflow-transition',
      label: `Transition '${t.label}'`,
      detail: 'condition rule references field',
      link: `/pipelines/${t.template}`
    })
  }

  // 11. Saved views (filters/columns snapshots)
  const savedViews = await safeQuery(() =>
    db('nivaro_saved_views')
      .where({ collection })
      .where((qb) =>
        qb
          .where('filters', 'like', fieldToken)
          .orWhere('columns', 'like', fieldToken)
          .orWhere('sort', 'like', fieldToken)
      )
      .select('id', 'name')
  )
  for (const v of savedViews as Array<{ id: number; name: string }>) {
    impacts.push({
      source: 'saved-view',
      label: `Saved view '${v.name}'`,
      detail: 'filter/column snapshot may reference field',
      link: `/collections/${collection}`
    })
  }

  return impacts
}
