import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'

/**
 * Config-wide search (#37): one query across every configuration surface —
 * "who references update_workflow.php" without opening seven editors. Each
 * surface declares which text/JSON columns it scans and how a hit links back
 * to its editor; a missing table degrades to zero hits, never a 500.
 */

interface Surface {
  table: string
  label: string
  nameCol: string
  cols: string[]
  link: (row: Record<string, unknown>) => string
}

const SURFACES: Surface[] = [
  {
    table: 'nivaro_flows',
    label: 'Flows',
    nameCol: 'name',
    cols: ['name', 'description', 'trigger_options'],
    link: (r) => `/flows/${r.id}`
  },
  {
    table: 'nivaro_flow_operations',
    label: 'Flow operations',
    nameCol: 'name',
    cols: ['name', 'options'],
    link: (r) => `/flows/${r.flow}`
  },
  {
    table: 'nivaro_rules',
    label: 'Automation rules',
    nameCol: 'name',
    cols: ['name', 'conditions', 'actions'],
    link: (r) => `/rules/${r.id}`
  },
  {
    table: 'nivaro_workflow_transitions',
    label: 'Workflow transitions',
    nameCol: 'label',
    cols: ['label', 'actions', 'condition_rules', 'requirements'],
    link: (r) => `/pipelines/${r.template}`
  },
  {
    table: 'nivaro_workflow_states',
    label: 'Workflow states',
    nameCol: 'label',
    cols: ['label', 'key', 'skip_criteria'],
    link: (r) => `/pipelines/${r.template}`
  },
  {
    table: 'nivaro_layout_field_assignments',
    label: 'Layout assignments',
    nameCol: 'field',
    cols: ['field', 'overrides', 'input_bindings'],
    link: () => '/data-model'
  },
  {
    table: 'nivaro_queue_sources',
    label: 'Queue sources',
    nameCol: 'collection',
    cols: ['collection', 'filters', 'extra_fields', 'label_template'],
    link: (r) => `/queues/${r.queue_id}`
  },
  {
    table: 'nivaro_external_apis',
    label: 'External APIs',
    nameCol: 'name',
    cols: ['name', 'base_url'],
    link: (r) => `/external-apis/${r.id}`
  },
  {
    table: 'nivaro_external_api_endpoints',
    label: 'API endpoints',
    nameCol: 'name',
    cols: ['name', 'path', 'body_template'],
    link: (r) => `/external-apis/${r.external_api}`
  },
  {
    table: 'nivaro_webhooks',
    label: 'Webhooks',
    nameCol: 'name',
    cols: ['name', 'url'],
    link: (r) => `/webhooks/${r.id}`
  },
  {
    table: 'nivaro_custom_queries',
    label: 'Custom queries',
    nameCol: 'name',
    cols: ['name', 'slug', 'sql_text'],
    link: (r) => `/custom-queries/${r.id}`
  },
  {
    table: 'nivaro_import_templates',
    label: 'Import templates',
    nameCol: 'name',
    cols: ['name', 'header_map', 'line_map'],
    link: () => '/data-model'
  },
  {
    table: 'nivaro_report_widgets',
    label: 'Report widgets',
    nameCol: 'type',
    cols: ['config'],
    link: (r) => `/report-studio/${r.report}`
  },
  {
    table: 'nivaro_custom_actions',
    label: 'Custom actions',
    nameCol: 'label',
    cols: ['label', 'config', 'guard'],
    link: () => '/data-model'
  },
  {
    table: 'nivaro_fields',
    label: 'Field config',
    nameCol: 'field',
    cols: ['field', 'options', 'computed_formula', 'dependency_config', 'validation_rules'],
    link: (r) => `/data-model/${r.collection}`
  },
  {
    table: 'nivaro_alert_definitions',
    label: 'Alert definitions',
    nameCol: 'name',
    cols: ['name', 'filters'],
    link: (r) => `/alerts/${r.id}`
  },
  {
    table: 'nivaro_saved_views',
    label: 'Saved views',
    nameCol: 'name',
    cols: ['name', 'filters'],
    link: (r) => `/collections/${r.collection}`
  }
]

function snippet(row: Record<string, unknown>, cols: string[], q: string): string {
  for (const c of cols) {
    const v = row[c]
    if (v == null) continue
    const s = String(v)
    const i = s.toLowerCase().indexOf(q.toLowerCase())
    if (i >= 0) {
      const start = Math.max(0, i - 40)
      return `${start > 0 ? '…' : ''}${s.slice(start, i + q.length + 60)}${i + q.length + 60 < s.length ? '…' : ''}`
    }
  }
  return ''
}

export async function searchConfigSurfaces(q: string): Promise<
  Array<{ surface: string; hits: Array<{ id: unknown; name: string; snippet: string; link: string }> }>
> {
  const like = `%${q.replace(/[%_[]/g, (c) => `[${c}]`)}%`
  const groups: Array<{
    surface: string
    hits: Array<{ id: unknown; name: string; snippet: string; link: string }>
  }> = []
  for (const s of SURFACES) {
    try {
      const rows = (await db(s.table)
        .where((qb) => {
          for (const c of s.cols) void qb.orWhere(c, 'like', like)
        })
        .limit(25)
        .select('*')) as Array<Record<string, unknown>>
      if (rows.length === 0) continue
      groups.push({
        surface: s.label,
        hits: rows.map((r) => ({
          id: r.id,
          name: String(r[s.nameCol] ?? r.id),
          snippet: snippet(r, s.cols, q),
          link: s.link(r)
        }))
      })
    } catch {
      // Table or column absent on this deployment — surface contributes
      // nothing rather than killing the whole search.
    }
  }
  return groups
}

export async function configSearchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get<{ Querystring: { q?: string } }>('/', async (req, reply) => {
    const q = String(req.query.q ?? '').trim()
    if (q.length < 2) return reply.code(400).send({ error: 'q must be at least 2 characters' })
    const groups = await searchConfigSurfaces(q)
    return { data: { query: q, groups, total: groups.reduce((a, g) => a + g.hits.length, 0) } }
  })
}
