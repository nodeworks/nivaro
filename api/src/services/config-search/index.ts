import { db } from '../../db/index.js'
import { tenantState } from '../ai-tenant-state.js'
import type { ExtraHit } from '../search-extra.js'
import {
  type ConfigRewrite,
  defaultRewriteDeps,
  type RewriteDeps,
  rewriteConfigQuery
} from './ai-rewrite.js'
import {
  buildConfigDocs,
  type ConfigSources,
  collectionNames,
  isSystemCollection,
  KIND_INFO,
  type Row
} from './builders.js'
import {
  type ConfigIndex,
  keywordAnswerIsGood,
  prepareIndex,
  queryTerms,
  type RankedConfig,
  rankConfig
} from './rank.js'

/**
 * Config search (search program item 24): loads the config tables into one
 * per-tenant index (60 s, single-flight), ranks it by keywords, and — on the
 * plain-words endpoint, for administrators, when the keywords found little —
 * asks the AI once to rewrite the question (ai-rewrite.ts).
 *
 * Columns are read by name from a fixed list per table and intersected with
 * the columns the table has (an older database simply has fewer). No secret
 * column is ever named: no auth_config/headers/secret/url/sql_text/body.
 */

/** table → [source key, wanted columns, row cap]. */
const TABLES: Array<[keyof ConfigSources, string, string[], number]> = [
  [
    'collections',
    'nivaro_collections',
    ['collection', 'display_name', 'singular', 'plural', 'note', 'group'],
    5000
  ],
  [
    'fields',
    'nivaro_fields',
    [
      'collection',
      'field',
      'label',
      'note',
      'interface',
      'placeholder',
      'required',
      'validation',
      'validation_rules',
      'validation_message',
      'dependency_config'
    ],
    40000
  ],
  [
    'layouts',
    'nivaro_collection_layouts',
    ['id', 'collection', 'name', 'is_active', 'description'],
    5000
  ],
  [
    'assignments',
    'nivaro_layout_field_assignments',
    ['layout_id', 'field', 'label_override', 'overrides', 'is_visible'],
    60000
  ],
  ['groups', 'nivaro_field_groups', ['layout_id', 'label'], 20000],
  ['templates', 'nivaro_workflow_templates', ['id', 'name', 'description'], 2000],
  ['states', 'nivaro_workflow_states', ['id', 'template', 'key', 'label'], 20000],
  ['transitions', 'nivaro_workflow_transitions', ['template', 'to_state', 'label'], 20000],
  ['bindings', 'nivaro_workflow_bindings', ['template', 'collection'], 5000],
  [
    'flows',
    'nivaro_flows',
    ['id', 'name', 'description', 'status', 'trigger', 'trigger_options'],
    5000
  ],
  ['operations', 'nivaro_flow_operations', ['flow', 'name', 'type', 'options'], 40000],
  ['externalApis', 'nivaro_external_apis', ['id', 'name', 'description', 'integration_type'], 2000],
  ['endpoints', 'nivaro_external_api_endpoints', ['id', 'api_id', 'name', 'slug'], 20000],
  [
    'fieldRules',
    'nivaro_field_rules',
    ['id', 'collection', 'trigger_field', 'trigger_op', 'target_field', 'target_type', 'is_active'],
    20000
  ],
  ['alerts', 'nivaro_alert_definitions', ['id', 'name', 'category', 'collection', 'field'], 5000],
  ['rules', 'nivaro_rules', ['id', 'name', 'collection', 'trigger', 'conditions', 'actions'], 5000],
  ['queues', 'nivaro_queues', ['id', 'name', 'description'], 5000],
  ['queueSources', 'nivaro_queue_sources', ['queue_id', 'collection'], 20000],
  ['dashboards', 'nivaro_dashboards', ['id', 'name'], 5000],
  ['widgets', 'nivaro_dashboard_widgets', ['dashboard', 'title', 'collection'], 40000],
  ['reports', 'nivaro_report_defs', ['id', 'name', 'description'], 5000],
  ['customQueries', 'nivaro_custom_queries', ['id', 'name', 'slug', 'description'], 5000],
  [
    'payloadTemplates',
    'nivaro_payload_templates',
    ['key', 'label', 'description', 'external_api', 'collection'],
    5000
  ],
  [
    'importDefinitions',
    'nivaro_import_definitions',
    ['key', 'label', 'description', 'procedure', 'staging_table'],
    5000
  ],
  ['webhooks', 'nivaro_webhooks', ['id', 'name', 'events', 'collections'], 5000],
  ['roles', 'nivaro_roles', ['id', 'name', 'description', 'admin_access'], 2000],
  ['policies', 'nivaro_policies', ['role', 'collection', 'action'], 40000]
]

/** Never read, whatever a future table list says. */
const SECRET_COLUMN =
  /(secret|password|pass$|token|auth_config|headers|api_key|^url$|base_url|sql_text|body|credential)/i

export async function loadConfigSources(): Promise<ConfigSources> {
  const tables = TABLES.map((t) => t[1])
  const cols = (await db('information_schema.columns')
    .whereIn('table_name', tables)
    .select('table_name', 'column_name')) as Array<{ table_name: string; column_name: string }>
  const have = new Map<string, Set<string>>()
  for (const c of cols) {
    const t = c.table_name.toLowerCase()
    const set = have.get(t) ?? new Set<string>()
    set.add(c.column_name.toLowerCase())
    have.set(t, set)
  }
  const out: ConfigSources = {}
  // A few at a time: these are small config tables, but there are many.
  const queue = [...TABLES]
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const [key, table, wanted, cap] = t
      const present = have.get(table.toLowerCase())
      if (!present) continue
      const select = wanted.filter((c) => present.has(c.toLowerCase()) && !SECRET_COLUMN.test(c))
      if (select.length === 0) continue
      try {
        out[key] = (await db(table).select(select).limit(cap)) as Row[]
      } catch {
        /* unreadable table — no docs of that kind */
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  return out
}

export const CONFIG_INDEX_TTL_MS = 60_000
const REWRITE_TTL_MS = 10 * 60_000
const REWRITE_MAX = 500

const state = tenantState(() => ({
  index: null as {
    at: number
    index: ConfigIndex
    collections: Array<{ collection: string; display: string }>
  } | null,
  flight: null as Promise<{
    index: ConfigIndex
    collections: Array<{ collection: string; display: string }>
  }> | null,
  rewrites: new Map<string, { at: number; value: ConfigRewrite | null }>()
}))

/** The tenant's index: rebuilt at most once a minute, one build at a time. */
export async function configIndex(
  load: () => Promise<ConfigSources> = loadConfigSources
): Promise<{ index: ConfigIndex; collections: Array<{ collection: string; display: string }> }> {
  const s = state()
  if (s.index && Date.now() - s.index.at < CONFIG_INDEX_TTL_MS) return s.index
  if (s.flight) return s.flight
  const flight = (async () => {
    const src = await load()
    const names = collectionNames(src)
    const collections = (src.collections ?? [])
      .map((r) => String(r.collection ?? ''))
      .filter((c) => c && !isSystemCollection(c))
      .map((c) => ({ collection: c, display: names.display(c) }))
    const built = { index: prepareIndex(buildConfigDocs(src)), collections }
    s.index = { at: Date.now(), ...built }
    return built
  })()
  s.flight = flight
  try {
    return await flight
  } finally {
    s.flight = null
  }
}

/** Drop the tenant's index (tests; a config import may call it too). */
export function forgetConfigIndex(): void {
  const s = state()
  s.index = null
  s.rewrites.clear()
}

export function toExtraHit(r: RankedConfig): ExtraHit {
  const d = r.doc
  const where = d.snippet ?? KIND_INFO[d.kind].label
  const matched = r.matched.length ? ` · ${r.matched.join(', ')}` : ''
  return {
    kind: d.kind,
    id: `${d.kind}:${d.id}`,
    label: d.label.slice(0, 120),
    snippet: `${where}${matched}`.slice(0, 200),
    href: d.href,
    admin_href: d.href,
    ...(d.collection ? { collection: d.collection } : {})
  }
}

/** What a non-admin can find: the personal screens only. No tenant data, so
 *  one static index — a non-admin search never loads the config tables. */
let personal: ConfigIndex | null = null
function personalIndex(): ConfigIndex {
  personal ??= prepareIndex(buildConfigDocs({}).filter((d) => !d.adminOnly))
  return personal
}

/** Keyword-only config hits (global search's `extra.config`, Cmd+K). */
export async function configKeywordHits(
  q: string,
  opts: { isAdmin: boolean; limit: number }
): Promise<ExtraHit[]> {
  const index = opts.isAdmin ? (await configIndex()).index : personalIndex()
  return rankConfig(index, q, { isAdmin: opts.isAdmin, limit: opts.limit }).map(toExtraHit)
}

export type AiStatus = 'used' | 'not_needed' | 'off' | 'failed' | 'admin_only'

export interface ConfigSearchAnswer {
  hits: ExtraHit[]
  rewrite: ConfigRewrite | null
  ai: AiStatus
}

/** Plain-words config search. `ai` asks for the rewrite step; it runs only
 *  for administrators, only when the keyword answer is thin, and is cached per
 *  tenant + question for 10 minutes. AI off (or failing) = keyword answer. */
export async function searchConfig(
  q: string,
  opts: {
    isAdmin: boolean
    ai: boolean
    limit?: number
    deps?: RewriteDeps
    load?: () => Promise<ConfigSources>
  }
): Promise<ConfigSearchAnswer> {
  const limit = opts.limit ?? 20
  const asHits = (list: RankedConfig[]) => list.map(toExtraHit)
  if (!opts.isAdmin) {
    const mine = rankConfig(personalIndex(), q, { isAdmin: false, limit })
    return { hits: asHits(mine), rewrite: null, ai: opts.ai ? 'admin_only' : 'not_needed' }
  }
  const { index, collections } = await configIndex(opts.load)
  const keyword = rankConfig(index, q, { isAdmin: true, limit })
  if (!opts.ai) return { hits: asHits(keyword), rewrite: null, ai: 'not_needed' }
  if (keywordAnswerIsGood(keyword) || queryTerms(q).length === 0)
    return { hits: asHits(keyword), rewrite: null, ai: 'not_needed' }

  const s = state()
  const key = q.trim().toLowerCase().replace(/\s+/g, ' ')
  const cached = s.rewrites.get(key)
  let rewrite: ConfigRewrite | null
  if (cached && Date.now() - cached.at < REWRITE_TTL_MS) {
    rewrite = cached.value
  } else {
    const outcome = await rewriteConfigQuery(q, collections, opts.deps ?? defaultRewriteDeps)
    // AI off is not remembered: switching it on works at once.
    if (outcome.status === 'off') return { hits: asHits(keyword), rewrite: null, ai: 'off' }
    rewrite = outcome.status === 'ok' ? outcome.rewrite : null
    if (s.rewrites.size >= REWRITE_MAX) {
      const oldest = s.rewrites.keys().next().value
      if (oldest !== undefined) s.rewrites.delete(oldest)
    }
    s.rewrites.set(key, { at: Date.now(), value: rewrite })
  }
  if (!rewrite) return { hits: asHits(keyword), rewrite: null, ai: 'failed' }
  const rewritten = rankConfig(index, rewrite.keywords.join(' '), {
    isAdmin: true,
    kinds: rewrite.kinds,
    collection: rewrite.collection,
    limit
  })
  const seen = new Set<string>()
  const merged: RankedConfig[] = []
  for (const r of [...rewritten, ...keyword]) {
    if (seen.has(r.doc.href)) continue
    seen.add(r.doc.href)
    merged.push(r)
    if (merged.length >= limit) break
  }
  return { hits: asHits(merged), rewrite, ai: 'used' }
}
