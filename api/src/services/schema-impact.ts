import { db } from '../db/index.js'

/**
 * Reverse index: everything that references a field, computed on demand.
 *
 * Deleting or renaming a field silently breaks a long tail of configuration —
 * layouts, formulas, field rules, grid row rules, queue columns and filters,
 * owner-group filters, display templates, report widgets, import templates,
 * at-risk rules, saved views, transition conditions — and none of it fails
 * loudly. A formula reads the missing field as 0, a queue column renders
 * blank, an owner filter stops matching: each one surfaces weeks later as a
 * data question, never as "someone deleted the column".
 *
 * This scan answers "what would break" BEFORE the delete. It is advisory and
 * deliberately errs toward showing a hit: most config stores field names
 * inside JSON text, so matching is by quoted/token forms (`"field"`,
 * `{{field}}`, `item.field`) with a context snippet so a human can judge.
 * A generic name like `name` will over-match — a reviewable false positive
 * beats an invisible true one.
 */

export interface ImpactHit {
  /** Which config surface holds the reference. */
  surface: string
  /** Identifier of the referencing thing (layout name, queue name, …). */
  ref: string
  /** Where to fix it, when the surface has an obvious page. */
  detail?: string
}

export interface ImpactReport {
  collection: string
  field: string
  total: number
  surfaces: Array<{ surface: string; hits: ImpactHit[] }>
}

/** Escape a value for a LIKE pattern (MSSQL bracket escaping). */
function likeEscape(v: string): string {
  return v.replace(/[%_[]/g, (c) => `[${c}]`)
}

/**
 * The token forms a field name appears in across config JSON/templates. A
 * bare substring match on `name` would flag half the database; these anchor
 * the match to how config actually encodes a field reference.
 */
function tokenPatterns(field: string): string[] {
  const f = likeEscape(field)
  return [
    `%"${f}"%`, // JSON: "field" as key or value
    `%{{${f}}}%`, // template token
    `%{{${f}.%`, // dotted template token head
    `%item.${f}%`, // expr-eval form
    `%{{%.${f}}}%` // dotted token tail (parent.field)
  ]
}

function whereAnyLike(q: ReturnType<typeof db>, column: string, patterns: string[]) {
  void q.where((b) => {
    for (const p of patterns) b.orWhere(column, 'like', p)
  })
  return q
}

async function scan(
  surface: string,
  fn: () => Promise<ImpactHit[]>
): Promise<{ surface: string; hits: ImpactHit[] }> {
  try {
    return { surface, hits: await fn() }
  } catch {
    // One unreadable surface must not kill the report — an empty section for
    // it is wrong, but a 500 that blocks the delete dialog entirely is worse.
    return { surface, hits: [] }
  }
}

export async function buildImpactReport(
  collection: string,
  field: string
): Promise<ImpactReport> {
  const pats = tokenPatterns(field)
  const fieldEq = field

  const sections = await Promise.all([
    // Layout assignments — the field itself, and dotted paths through it.
    scan('layouts', async () => {
      const rows = (await db('nivaro_layout_field_assignments as a')
        .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
        .where('l.collection', collection)
        .where((b) => {
          void b
            .where('a.field', fieldEq)
            .orWhere('a.field', 'like', `${likeEscape(field)}.%`)
            .orWhere('a.field', 'like', `%.${likeEscape(field)}`)
            .orWhere('a.field', 'like', `%.${likeEscape(field)}.%`)
        })
        .select('l.name as layout', 'a.field')) as Array<{ layout: string; field: string }>
      return rows.map((r) => ({
        surface: 'layouts',
        ref: r.layout,
        detail: r.field === fieldEq ? 'assigned field' : `relation path ${r.field}`
      }))
    }),

    // Assignment overrides (row_rules, option_filter, drilldown, formulas …)
    scan('layout-overrides', async () => {
      const q = db('nivaro_layout_field_assignments as a')
        .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
        .select('l.name as layout', 'l.collection as col', 'a.field')
      whereAnyLike(q, 'a.overrides', pats)
      const rows = (await q) as Array<{ layout: string; col: string; field: string }>
      return rows.map((r) => ({
        surface: 'layout-overrides',
        ref: `${r.col} · ${r.layout}`,
        detail: `options on "${r.field}" mention it (row rules / filters / formulas)`
      }))
    }),

    // Other fields' config on the same collection — formulas, visibility,
    // locks, cascades, defaults, auto-ids.
    scan('field-config', async () => {
      const cols = [
        'computed_formula',
        'visibility_rules',
        'lock_condition',
        'dependency_config',
        'default_formula',
        'cross_record_defaults',
        'options'
      ]
      const hits: ImpactHit[] = []
      for (const col of cols) {
        const q = db('nivaro_fields')
          .where({ collection })
          .whereNot('field', fieldEq)
          .select('field')
        whereAnyLike(q, col, pats)
        const rows = (await q) as Array<{ field: string }>
        for (const r of rows) {
          hits.push({ surface: 'field-config', ref: `${collection}.${r.field}`, detail: col })
        }
      }
      return hits
    }),

    // Rollups on OTHER collections that aggregate this one.
    scan('rollups-elsewhere', async () => {
      const q = db('nivaro_fields')
        .where({ computed_type: 'rollup' })
        .whereRaw('computed_formula LIKE ?', [`%"${likeEscape(collection)}"%`])
        .select('collection', 'field', 'computed_formula')
      const rows = (await q) as Array<{
        collection: string
        field: string
        computed_formula: string
      }>
      return rows
        .filter((r) => new RegExp(`"${field}"`).test(r.computed_formula ?? ''))
        .map((r) => ({
          surface: 'rollups-elsewhere',
          ref: `${r.collection}.${r.field}`,
          detail: 'rollup source references it'
        }))
    }),

    scan('field-rules', async () => {
      const rows = (await db('nivaro_field_rules')
        .where({ collection })
        .where((b) => {
          void b.where('trigger_field', fieldEq).orWhere('target_field', fieldEq)
        })
        .select('id', 'trigger_field', 'target_field')) as Array<{
        id: number
        trigger_field: string
        target_field: string
      }>
      return rows.map((r) => ({
        surface: 'field-rules',
        ref: `rule #${r.id}`,
        detail: r.trigger_field === fieldEq ? 'trigger field' : 'target field'
      }))
    }),

    scan('queues', async () => {
      const q = db('nivaro_queue_sources as s')
        .join('nivaro_queues as qq', 'qq.id', 's.queue_id')
        .where('s.collection', collection)
        .select('qq.name')
      void q.where((b) => {
        for (const col of ['s.filters', 's.extra_fields', 's.label_template', 's.aggregates']) {
          for (const p of pats) b.orWhere(col, 'like', p)
        }
      })
      const rows = (await q) as Array<{ name: string }>
      return [...new Set(rows.map((r) => r.name))].map((name) => ({
        surface: 'queues',
        ref: name,
        detail: 'source filters / columns / label template'
      }))
    }),

    // Owner-group filters + dimensions on templates bound to the collection.
    scan('pipeline-owners', async () => {
      const templates = (await db('nivaro_workflow_bindings')
        .where({ collection })
        .pluck('template')) as string[]
      if (templates.length === 0) return []
      const hits: ImpactHit[] = []
      const bindingIds = (await db('nivaro_workflow_bindings')
        .where({ collection })
        .pluck('id')) as Array<string | number>
      const dims = (await db('nivaro_pipeline_owner_dimensions')
        .whereIn('binding', bindingIds)
        .where((b) => {
          void b
            .where('field', fieldEq)
            .orWhere('field', 'like', `${likeEscape(field)}.%`)
        })
        .select('label', 'field')) as Array<{ label: string; field: string }>
      for (const d of dims) {
        hits.push({ surface: 'pipeline-owners', ref: `dimension "${d.label}"`, detail: d.field })
      }
      const groupQ = db('nivaro_pipeline_owner_groups as g')
        .join('nivaro_workflow_states as st', 'st.id', 'g.state')
        .whereIn('st.template', templates)
        .count('* as c')
        .first()
      whereAnyLike(groupQ as unknown as ReturnType<typeof db>, 'g.filters', pats)
      const c = Number(((await groupQ) as { c?: number | string } | undefined)?.c ?? 0)
      if (c > 0) {
        hits.push({
          surface: 'pipeline-owners',
          ref: `${c} owner group(s)`,
          detail: 'filters reference it'
        })
      }
      return hits
    }),

    scan('workflow-conditions', async () => {
      const templates = (await db('nivaro_workflow_bindings')
        .where({ collection })
        .pluck('template')) as string[]
      if (templates.length === 0) return []
      const tq = db('nivaro_workflow_transitions as t')
        .join('nivaro_workflow_templates as tpl', 'tpl.id', 't.template')
        .whereIn('t.template', templates)
        .select('tpl.name as template', 't.label')
      whereAnyLike(tq, 't.condition_rules', pats)
      const trans = (await tq) as Array<{ template: string; label: string }>
      const sq = db('nivaro_workflow_states as s')
        .join('nivaro_workflow_templates as tpl', 'tpl.id', 's.template')
        .whereIn('s.template', templates)
        .select('tpl.name as template', 's.label')
      whereAnyLike(sq, 's.skip_criteria', pats)
      const states = (await sq) as Array<{ template: string; label: string }>
      return [
        ...trans.map((t) => ({
          surface: 'workflow-conditions',
          ref: `${t.template} → ${t.label}`,
          detail: 'transition conditions'
        })),
        ...states.map((s) => ({
          surface: 'workflow-conditions',
          ref: `${s.template} · ${s.label}`,
          detail: 'skip criteria'
        }))
      ]
    }),

    scan('display-template', async () => {
      const row = (await db('nivaro_collections')
        .where({ collection })
        .first('display_template')) as { display_template?: string | null } | undefined
      const t = row?.display_template ?? ''
      return new RegExp(`\\{\\{\\s*${field}(\\.|\\s*\\}\\})`).test(t)
        ? [{ surface: 'display-template', ref: collection, detail: t }]
        : []
    }),

    scan('report-widgets', async () => {
      const q = db('nivaro_report_widgets as w')
        .join('nivaro_report_defs as r', 'r.id', 'w.report')
        .where('w.collection', collection)
        .select('r.name')
      whereAnyLike(q, 'w.config', pats)
      const rows = (await q) as Array<{ name: string }>
      return [...new Set(rows.map((r) => r.name))].map((name) => ({
        surface: 'report-widgets',
        ref: name
      }))
    }),

    scan('import-templates', async () => {
      const q = db('nivaro_import_templates').where({ collection }).select('name')
      void q.where((b) => {
        for (const col of ['header_map', 'line_map']) {
          for (const p of pats) b.orWhere(col, 'like', p)
        }
      })
      const rows = (await q) as Array<{ name: string }>
      return rows.map((r) => ({ surface: 'import-templates', ref: r.name }))
    }),

    scan('at-risk-rules', async () => {
      const q = db('nivaro_at_risk_rules').where({ collection }).select('name')
      whereAnyLike(q, 'conditions', pats)
      const rows = (await q) as Array<{ name: string }>
      return rows.map((r) => ({ surface: 'at-risk-rules', ref: r.name }))
    }),

    scan('automation-rules', async () => {
      const q = db('nivaro_rules').where({ collection }).select('id', 'name')
      void q.where((b) => {
        for (const col of ['conditions', 'actions']) {
          for (const p of pats) b.orWhere(col, 'like', p)
        }
      })
      const rows = (await q) as Array<{ id: number; name: string }>
      return rows.map((r) => ({
        surface: 'automation-rules',
        ref: r.name ?? `rule #${r.id}`,
        detail: 'conditions or actions'
      }))
    }),

    scan('saved-views', async () => {
      const q = db('nivaro_saved_views').where({ collection }).select('name')
      void q.where((b) => {
        for (const col of ['filters', 'columns']) {
          for (const p of pats) b.orWhere(col, 'like', p)
        }
      })
      const rows = (await q) as Array<{ name: string }>
      return rows.map((r) => ({ surface: 'saved-views', ref: r.name }))
    }),

    scan('alert-definitions', async () => {
      const rows = (await db('nivaro_alert_definitions')
        .where({ collection })
        .where((b) => {
          void b.where('field', fieldEq)
          for (const p of pats) b.orWhere('filters', 'like', p)
        })
        .select('name')) as Array<{ name: string }>
      return rows.map((r) => ({ surface: 'alert-definitions', ref: r.name }))
    })
  ])

  const surfaces = sections.filter((s) => s.hits.length > 0)
  return {
    collection,
    field,
    total: surfaces.reduce((sum, s) => sum + s.hits.length, 0),
    surfaces
  }
}
