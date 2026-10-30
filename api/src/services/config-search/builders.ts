/**
 * Config search index (search program item 24): one document per piece of
 * configuration an administrator may look for — "where is the Fusion push for
 * IRs set up", "which rule makes Zone required on POs" — each with a deep link
 * to the exact screen that edits it (tab + item).
 *
 * Pure: the loader (index.ts) reads the config tables and hands the rows here.
 * Only NAMES and LABELS go into a document (names, labels, notes, trigger
 * kinds, step names, endpoint names). Never a secret, header, URL, SQL text,
 * body template or stored value — the index is safe to rank, show and (as a
 * list of kinds/collection names only) describe to the AI rewrite.
 */

export type ConfigKind =
  | 'collection'
  | 'field'
  | 'validation'
  | 'cascade'
  | 'layout'
  | 'pipeline'
  | 'flow'
  | 'field_rule'
  | 'alert'
  | 'rule'
  | 'queue'
  | 'dashboard'
  | 'report'
  | 'custom_query'
  | 'external_api'
  | 'payload_template'
  | 'import_definition'
  | 'webhook'
  | 'role'
  | 'setting'
  | 'screen'

export interface ConfigDoc {
  kind: ConfigKind
  /** Unique within the kind. */
  id: string
  label: string
  /** The collection this config belongs to (machine name), when it has one. */
  collection?: string
  /** A short line under the label (kind + where). */
  snippet?: string
  /** Words around the label: collection names + acronyms, notes, triggers. */
  context: string[]
  /** Named parts — placed fields, states, transitions, steps, endpoints. The
   *  ones a query matched are named in the hit's snippet. */
  details: string[]
  /** Admin app path to the exact screen (tab + item). */
  href: string
  /** Administrators only (every stored config); personal screens are not. */
  adminOnly: boolean
}

export const KIND_INFO: Record<ConfigKind, { label: string; words: string[] }> = {
  collection: { label: 'Collection', words: ['collection', 'table', 'schema', 'data', 'model'] },
  field: { label: 'Field', words: ['field', 'column', 'attribute'] },
  validation: {
    label: 'Validation',
    words: ['validation', 'validate', 'required', 'mandatory', 'rule', 'check']
  },
  cascade: {
    label: 'Cascade filter',
    words: ['cascade', 'cascading', 'filter', 'picker', 'dropdown', 'depend', 'dependent', 'rule']
  },
  layout: { label: 'Layout', words: ['layout', 'form', 'section', 'tab', 'screen', 'placement'] },
  pipeline: {
    label: 'Pipeline',
    words: ['pipeline', 'workflow', 'state', 'status', 'transition', 'stage', 'step', 'approval']
  },
  flow: {
    label: 'Flow',
    words: ['flow', 'automation', 'trigger', 'operation', 'step', 'push', 'send', 'job']
  },
  field_rule: {
    label: 'Field rule',
    words: ['rule', 'default', 'defaults', 'autofill', 'prefill', 'set', 'field']
  },
  alert: { label: 'Alert', words: ['alert', 'threshold', 'notify', 'notification', 'warning'] },
  rule: { label: 'Rule', words: ['rule', 'automation', 'condition', 'action'] },
  queue: { label: 'Queue', words: ['queue', 'worklist', 'inbox', 'list'] },
  dashboard: { label: 'Dashboard', words: ['dashboard', 'widget', 'kpi', 'chart'] },
  report: { label: 'Report', words: ['report', 'studio', 'widget', 'chart'] },
  custom_query: { label: 'Custom query', words: ['query', 'sql', 'custom', 'report'] },
  external_api: {
    label: 'External API',
    words: ['api', 'integration', 'endpoint', 'external', 'partner', 'push', 'connection']
  },
  payload_template: {
    label: 'Payload template',
    words: ['payload', 'template', 'body', 'push', 'submission', 'send', 'integration', 'mapping']
  },
  import_definition: {
    label: 'Import',
    words: ['import', 'upload', 'staging', 'load', 'procedure', 'file']
  },
  webhook: { label: 'Webhook', words: ['webhook', 'hook', 'callback', 'event', 'push'] },
  role: {
    label: 'Role',
    words: ['role', 'permission', 'permissions', 'access', 'policy', 'policies', 'rbac', 'who']
  },
  setting: { label: 'Settings', words: ['setting', 'settings', 'configuration', 'option'] },
  screen: { label: 'Screen', words: ['profile', 'my', 'personal', 'preference'] }
}

export const CONFIG_KINDS = Object.keys(KIND_INFO) as ConfigKind[]

export type Row = Record<string, unknown>

/** Every source is optional: a tenant without a table simply has no docs of
 *  that kind. */
export interface ConfigSources {
  collections?: Row[]
  fields?: Row[]
  layouts?: Row[]
  assignments?: Row[]
  groups?: Row[]
  templates?: Row[]
  states?: Row[]
  transitions?: Row[]
  bindings?: Row[]
  flows?: Row[]
  operations?: Row[]
  externalApis?: Row[]
  endpoints?: Row[]
  fieldRules?: Row[]
  alerts?: Row[]
  rules?: Row[]
  queues?: Row[]
  queueSources?: Row[]
  dashboards?: Row[]
  widgets?: Row[]
  reports?: Row[]
  customQueries?: Row[]
  payloadTemplates?: Row[]
  importDefinitions?: Row[]
  webhooks?: Row[]
  roles?: Row[]
  policies?: Row[]
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const enc = encodeURIComponent
const str = (v: unknown): string => (v == null ? '' : String(v).trim())
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
export const isSystemCollection = (c: string) => /^(nivaro_|directus_)/i.test(c)

export function parseJsonLoose(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  const t = raw.trim()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

function asArray(raw: unknown): unknown[] {
  const v = parseJsonLoose(raw)
  return Array.isArray(v) ? v : []
}

function asObject(raw: unknown): Record<string, unknown> {
  const v = parseJsonLoose(raw)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** `purchase_orders` → `Purchase orders`. */
export function humanize(name: string): string {
  const s = name.replace(/[_-]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/** First letters of a multi-word name: `Inventory Request` → `ir`,
 *  `purchase_orders` → `po`. Null for one word. */
export function acronym(name: string): string | null {
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  if (parts.length < 2) return null
  return parts.map((p) => p[0].toLowerCase()).join('')
}

const uniq = (list: string[]) => [...new Set(list.map((s) => s.trim()).filter(Boolean))]

// ─── Hrefs (the admin screens) ───────────────────────────────────────────────

export const configHref = {
  collection: (c: string) => `/data-model/${enc(c)}?tab=settings`,
  field: (c: string, f: string) => `/data-model/${enc(c)}?tab=fields&field=${enc(f)}`,
  layout: (c: string, id: string) => `/data-model/${enc(c)}?tab=groups&layout=${enc(id)}`,
  fieldRules: (c: string) => `/data-model/${enc(c)}?tab=rules`,
  pipeline: (id: string) => `/pipelines/${enc(id)}`,
  flow: (id: string) => `/flows/${enc(id)}`,
  alert: (id: string) => `/alerts/${enc(id)}`,
  rule: (id: string) => `/rules/${enc(id)}`,
  queue: (id: string) => `/queues/${enc(id)}`,
  dashboard: (id: string) => `/dashboards/${enc(id)}`,
  report: (id: string) => `/report-studio/${enc(id)}`,
  customQuery: (id: string) => `/custom-queries/${enc(id)}`,
  externalApi: (id: string) => `/external-apis/${enc(id)}`,
  payloadTemplate: (key: string, apiId: string | null) =>
    apiId ? `/external-apis/${enc(apiId)}/payloads/${enc(key)}` : `/payload-templates/${enc(key)}`,
  importDefinition: (key: string) => `/imports?definition=${enc(key)}`,
  webhook: (id: string) => `/webhooks/${enc(id)}`,
  role: (id: string) => `/roles?role=${enc(id)}`,
  setting: (section: string) => `/settings?section=${enc(section)}`
}

// ─── Collection names ────────────────────────────────────────────────────────

export interface CollectionNames {
  /** The name people see. */
  display(c: string): string
  /** Words that name a collection: display name, singular/plural, machine
   *  name, acronyms ("IR", "PO"). */
  words(c: string): string[]
  /** A field's label as people see it. */
  fieldLabel(c: string, f: string): string
}

export function collectionNames(src: ConfigSources): CollectionNames {
  const byName = new Map<string, Row>()
  for (const r of src.collections ?? []) byName.set(str(r.collection).toLowerCase(), r)
  const labels = new Map<string, string>()
  for (const f of src.fields ?? []) {
    const label = str(f.label)
    if (label) labels.set(`${str(f.collection).toLowerCase()}.${str(f.field).toLowerCase()}`, label)
  }
  const display = (c: string) => {
    const r = byName.get(c.toLowerCase())
    return str(r?.display_name) || humanize(c)
  }
  const words = (c: string) => {
    const r = byName.get(c.toLowerCase())
    const names = uniq([display(c), str(r?.singular), str(r?.plural), c])
    const acr = names.map((n) => acronym(n)).filter((a): a is string => !!a)
    return uniq([...names, ...acr])
  }
  return {
    display,
    words,
    fieldLabel: (c, f) => labels.get(`${c.toLowerCase()}.${f.toLowerCase()}`) || humanize(f)
  }
}

// ─── Builders, one per kind ──────────────────────────────────────────────────

type Builder = (src: ConfigSources, names: CollectionNames) => ConfigDoc[]

const where = (names: CollectionNames, c: string | undefined, kind: ConfigKind, extra = '') =>
  [KIND_INFO[kind].label, c ? names.display(c) : '', extra].filter(Boolean).join(' · ')

export const buildCollectionDocs: Builder = (src, names) =>
  (src.collections ?? [])
    .filter((r) => str(r.collection) && !isSystemCollection(str(r.collection)))
    .map((r) => {
      const c = str(r.collection)
      return {
        kind: 'collection' as const,
        id: c,
        label: names.display(c),
        collection: c,
        snippet: where(names, undefined, 'collection', c),
        context: uniq([...names.words(c), str(r.note), str(r.group)]),
        details: [],
        href: configHref.collection(c),
        adminOnly: true
      }
    })

interface CascadeRule {
  parent_field?: string
  filter_column?: string
}

/** Fields + their validation (required / validation rules) and cascade
 *  filters. A field with either also gets its own validation / cascade doc —
 *  same screen, so search answers collapse them by href. */
export const buildFieldDocs: Builder = (src, names) => {
  const out: ConfigDoc[] = []
  for (const r of src.fields ?? []) {
    const c = str(r.collection)
    const f = str(r.field)
    if (!c || !f || isSystemCollection(c)) continue
    const label = names.fieldLabel(c, f)
    const href = configHref.field(c, f)
    const colWords = names.words(c)
    const base = uniq([f, str(r.note), str(r.interface), str(r.placeholder), ...colWords])
    out.push({
      kind: 'field',
      id: `${c}.${f}`,
      label,
      collection: c,
      snippet: where(names, c, 'field', f),
      context: base,
      details: [],
      href,
      adminOnly: true
    })
    const rules = asArray(r.validation_rules)
      .map((v) => (v && typeof v === 'object' ? str((v as Row).type) : ''))
      .filter(Boolean)
    const required = truthy(r.required)
    const legacyValidation = Object.keys(asObject(r.validation)).length > 0
    if (required || rules.length || legacyValidation || str(r.validation_message)) {
      const parts = [
        required ? 'required' : '',
        ...rules.map((t) => t.replace(/_/g, ' ')),
        str(r.validation_message)
      ].filter(Boolean)
      out.push({
        kind: 'validation',
        id: `${c}.${f}`,
        label: `${label}${required ? ' is required' : ' validation'}`,
        collection: c,
        snippet: where(names, c, 'validation', parts.slice(0, 3).join(', ')),
        context: uniq([...base, label, ...(required ? ['required', 'mandatory'] : [])]),
        details: parts,
        href,
        adminOnly: true
      })
    }
    const dep = asObject(r.dependency_config)
    const cascades = (Array.isArray(dep.cascade_filters) ? dep.cascade_filters : []).filter(
      (x): x is CascadeRule => !!x && typeof x === 'object'
    )
    if (cascades.length) {
      const parents = uniq(cascades.map((x) => str(x.parent_field))).map((p) =>
        names.fieldLabel(c, p)
      )
      out.push({
        kind: 'cascade',
        id: `${c}.${f}`,
        label: `${label} filtered by ${parents.join(', ') || 'another field'}`,
        collection: c,
        snippet: where(names, c, 'cascade', f),
        context: uniq([...base, label]),
        details: uniq([...parents, ...cascades.map((x) => str(x.filter_column))]),
        href,
        adminOnly: true
      })
    }
  }
  return out
}

export const buildLayoutDocs: Builder = (src, names) => {
  const layoutCollection = new Map<string, string>()
  for (const l of src.layouts ?? []) layoutCollection.set(str(l.id), str(l.collection))
  const byLayout = new Map<string, string[]>()
  for (const a of src.assignments ?? []) {
    const id = str(a.layout_id)
    if (!id) continue
    if (a.is_visible != null && !truthy(a.is_visible)) continue
    const c = layoutCollection.get(id) ?? ''
    const ov = asObject(a.overrides)
    const label =
      str(a.label_override) || str(ov.label) || (c ? names.fieldLabel(c, str(a.field)) : '')
    if (!label) continue
    const list = byLayout.get(id) ?? []
    list.push(truthy(ov.required) ? `${label} (required on this form)` : label)
    byLayout.set(id, list)
  }
  const sections = new Map<string, string[]>()
  for (const g of src.groups ?? []) {
    const id = str(g.layout_id)
    if (!id || !str(g.label)) continue
    const list = sections.get(id) ?? []
    list.push(str(g.label))
    sections.set(id, list)
  }
  return (src.layouts ?? [])
    .filter((l) => str(l.collection) && !isSystemCollection(str(l.collection)))
    .map((l) => {
      const c = str(l.collection)
      const id = str(l.id)
      return {
        kind: 'layout' as const,
        id,
        label: str(l.name) || `Layout ${id}`,
        collection: c,
        snippet: where(names, c, 'layout', truthy(l.is_active) ? 'active' : ''),
        context: uniq([...names.words(c), str(l.description)]),
        details: uniq([...(sections.get(id) ?? []), ...(byLayout.get(id) ?? [])]).slice(0, 400),
        href: configHref.layout(c, id),
        adminOnly: true
      }
    })
}

export const buildPipelineDocs: Builder = (src, names) => {
  const stateLabel = new Map<string, string>()
  const states = new Map<string, string[]>()
  for (const s of src.states ?? []) {
    const t = str(s.template).toLowerCase()
    const label = str(s.label) || str(s.key)
    stateLabel.set(str(s.id).toLowerCase(), label)
    const list = states.get(t) ?? []
    list.push(label)
    states.set(t, list)
  }
  const transitions = new Map<string, string[]>()
  for (const tr of src.transitions ?? []) {
    const t = str(tr.template).toLowerCase()
    const to = stateLabel.get(str(tr.to_state).toLowerCase())
    const label = str(tr.label)
    if (!label) continue
    const list = transitions.get(t) ?? []
    list.push(to ? `${label} → ${to}` : label)
    transitions.set(t, list)
  }
  const bound = new Map<string, string[]>()
  for (const b of src.bindings ?? []) {
    const t = str(b.template).toLowerCase()
    const list = bound.get(t) ?? []
    if (str(b.collection)) list.push(str(b.collection))
    bound.set(t, list)
  }
  return (src.templates ?? []).map((t) => {
    const id = str(t.id)
    const cols = bound.get(id.toLowerCase()) ?? []
    return {
      kind: 'pipeline' as const,
      id,
      label: str(t.name) || 'Pipeline',
      ...(cols[0] ? { collection: cols[0] } : {}),
      snippet: [KIND_INFO.pipeline.label, ...cols.map((c) => names.display(c))].join(' · '),
      context: uniq([...cols.flatMap((c) => names.words(c)), str(t.description)]),
      details: uniq([
        ...(states.get(id.toLowerCase()) ?? []),
        ...(transitions.get(id.toLowerCase()) ?? [])
      ]),
      href: configHref.pipeline(id),
      adminOnly: true
    }
  })
}

/** API id → name and endpoint id/slug → name, for flow steps and payloads. */
function apiNames(src: ConfigSources) {
  const api = new Map<string, string>()
  const apiByName = new Map<string, string>()
  for (const a of src.externalApis ?? []) {
    api.set(str(a.id), str(a.name))
    if (str(a.name)) apiByName.set(str(a.name).toLowerCase(), str(a.id))
  }
  const endpoint = new Map<string, string>()
  for (const e of src.endpoints ?? []) {
    const name = str(e.name)
    endpoint.set(`${str(e.api_id)}:${str(e.id)}`, name)
    if (str(e.slug)) endpoint.set(`${str(e.api_id)}:${str(e.slug).toLowerCase()}`, name)
  }
  return { api, apiByName, endpoint }
}

export const buildFlowDocs: Builder = (src, names) => {
  const { api, endpoint } = apiNames(src)
  const steps = new Map<string, string[]>()
  const stepCollections = new Map<string, string[]>()
  for (const op of src.operations ?? []) {
    const flow = str(op.flow).toLowerCase()
    const opts = asObject(op.options)
    const list = steps.get(flow) ?? []
    const type = str(op.type)
    const name = str(op.name)
    list.push(name || type.replace(/-/g, ' '))
    if (type === 'external-api') {
      const apiId = str(opts.api_id)
      const apiName = api.get(apiId)
      const ep = str(opts.endpoint)
      const epName =
        endpoint.get(`${apiId}:${ep}`) ?? endpoint.get(`${apiId}:${ep.toLowerCase()}`) ?? ''
      if (apiName) list.push(epName ? `${apiName}: ${epName}` : apiName)
    }
    if (str(opts.collection)) {
      const cl = stepCollections.get(flow) ?? []
      cl.push(str(opts.collection))
      stepCollections.set(flow, cl)
    }
    steps.set(flow, list)
  }
  return (src.flows ?? []).map((f) => {
    const id = str(f.id)
    const trigger = str(f.trigger)
    const opts = asObject(f.trigger_options)
    const triggerCols = (Array.isArray(opts.collections) ? opts.collections : [])
      .map(str)
      .filter(Boolean)
    const cols = uniq([...triggerCols, ...(stepCollections.get(id.toLowerCase()) ?? [])])
    const triggerText = trigger
      ? `${trigger} trigger${triggerCols.length ? ` on ${triggerCols.map((c) => names.display(c)).join(', ')}` : ''}`
      : ''
    return {
      kind: 'flow' as const,
      id,
      label: str(f.name) || 'Flow',
      ...(cols[0] ? { collection: cols[0] } : {}),
      snippet: [KIND_INFO.flow.label, triggerText, str(f.status)].filter(Boolean).join(' · '),
      context: uniq([...cols.flatMap((c) => names.words(c)), str(f.description), trigger]),
      details: uniq(steps.get(id.toLowerCase()) ?? []),
      href: configHref.flow(id),
      adminOnly: true
    }
  })
}

const OP_WORDS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  null: 'is empty',
  nnull: 'is not empty',
  changed: 'changes',
  contains: 'contains',
  in: 'is one of'
}

export const buildFieldRuleDocs: Builder = (src, names) =>
  (src.fieldRules ?? [])
    .filter((r) => str(r.collection) && !isSystemCollection(str(r.collection)))
    .map((r) => {
      const c = str(r.collection)
      const target = names.fieldLabel(c, str(r.target_field))
      const trigger = names.fieldLabel(c, str(r.trigger_field))
      const op = OP_WORDS[str(r.trigger_op)] ?? str(r.trigger_op)
      const action = str(r.target_type) === 'clear' ? 'Clears' : 'Sets'
      return {
        kind: 'field_rule' as const,
        id: str(r.id),
        // Values are left out: a rule's trigger/target value is data.
        label: `${action} ${target} when ${trigger} ${op}`.trim(),
        collection: c,
        snippet: where(
          names,
          c,
          'field_rule',
          truthy(r.is_active) || r.is_active == null ? '' : 'off'
        ),
        context: uniq([
          ...names.words(c),
          str(r.target_field),
          str(r.trigger_field),
          target,
          trigger
        ]),
        details: [],
        href: configHref.fieldRules(c),
        adminOnly: true
      }
    })

export const buildAlertDocs: Builder = (src, names) =>
  (src.alerts ?? []).map((r) => {
    const c = str(r.collection)
    const field = c && str(r.field) ? names.fieldLabel(c, str(r.field)) : str(r.field)
    return {
      kind: 'alert' as const,
      id: str(r.id),
      label: str(r.name) || 'Alert',
      ...(c ? { collection: c } : {}),
      snippet: where(names, c || undefined, 'alert', str(r.category)),
      context: uniq([...(c ? names.words(c) : []), field, str(r.field), str(r.category)]),
      details: [],
      href: configHref.alert(str(r.id)),
      adminOnly: true
    }
  })

export const buildRuleDocs: Builder = (src, names) =>
  (src.rules ?? []).map((r) => {
    const c = str(r.collection)
    const actions = asArray(r.actions)
      .map((a) => (a && typeof a === 'object' ? str((a as Row).type) : ''))
      .filter(Boolean)
      .map((t) => t.replace(/_/g, ' '))
    const condFields = asArray(r.conditions)
      .map((x) => (x && typeof x === 'object' ? str((x as Row).field) : ''))
      .filter(Boolean)
      .map((f) => (c ? names.fieldLabel(c, f) : f))
    return {
      kind: 'rule' as const,
      id: str(r.id),
      label: str(r.name) || 'Rule',
      ...(c ? { collection: c } : {}),
      snippet: where(names, c || undefined, 'rule', str(r.trigger)),
      context: uniq([...(c ? names.words(c) : []), str(r.trigger)]),
      details: uniq([...condFields, ...actions]),
      href: configHref.rule(str(r.id)),
      adminOnly: true
    }
  })

export const buildQueueDocs: Builder = (src, names) => {
  const sources = new Map<string, string[]>()
  for (const s of src.queueSources ?? []) {
    const q = str(s.queue_id).toLowerCase()
    const list = sources.get(q) ?? []
    if (str(s.collection)) list.push(str(s.collection))
    sources.set(q, list)
  }
  return (src.queues ?? []).map((q) => {
    const id = str(q.id)
    const cols = uniq(sources.get(id.toLowerCase()) ?? [])
    return {
      kind: 'queue' as const,
      id,
      label: str(q.name) || 'Queue',
      ...(cols[0] ? { collection: cols[0] } : {}),
      snippet: [KIND_INFO.queue.label, ...cols.map((c) => names.display(c))].join(' · '),
      context: uniq([...cols.flatMap((c) => names.words(c)), str(q.description)]),
      details: [],
      href: configHref.queue(id),
      adminOnly: true
    }
  })
}

export const buildDashboardDocs: Builder = (src, names) => {
  const widgets = new Map<string, string[]>()
  for (const w of src.widgets ?? []) {
    const d = str(w.dashboard).toLowerCase()
    const list = widgets.get(d) ?? []
    if (str(w.title)) list.push(str(w.title))
    if (str(w.collection)) list.push(names.display(str(w.collection)))
    widgets.set(d, list)
  }
  const dashboards = (src.dashboards ?? []).map((d) => ({
    kind: 'dashboard' as const,
    id: str(d.id),
    label: str(d.name) || 'Dashboard',
    snippet: KIND_INFO.dashboard.label,
    context: [],
    details: uniq(widgets.get(str(d.id).toLowerCase()) ?? []),
    href: configHref.dashboard(str(d.id)),
    adminOnly: true
  }))
  const reports = (src.reports ?? []).map((r) => ({
    kind: 'report' as const,
    id: str(r.id),
    label: str(r.name) || 'Report',
    snippet: KIND_INFO.report.label,
    context: uniq([str(r.description)]),
    details: [],
    href: configHref.report(str(r.id)),
    adminOnly: true
  }))
  return [...dashboards, ...reports]
}

export const buildCustomQueryDocs: Builder = (src) =>
  (src.customQueries ?? []).map((q) => ({
    kind: 'custom_query' as const,
    id: str(q.id),
    label: str(q.name) || str(q.slug) || 'Query',
    snippet: [KIND_INFO.custom_query.label, str(q.slug)].filter(Boolean).join(' · '),
    // Never the SQL text: names and the description only.
    context: uniq([str(q.slug), str(q.description)]),
    details: [],
    href: configHref.customQuery(str(q.id)),
    adminOnly: true
  }))

export const buildExternalApiDocs: Builder = (src, names) => {
  const { apiByName } = apiNames(src)
  const endpoints = new Map<string, string[]>()
  for (const e of src.endpoints ?? []) {
    const a = str(e.api_id)
    const list = endpoints.get(a) ?? []
    // Name + slug only: an endpoint path can carry a key in its query string.
    list.push(str(e.name), str(e.slug))
    endpoints.set(a, list)
  }
  const apis = (src.externalApis ?? []).map((a) => ({
    kind: 'external_api' as const,
    id: str(a.id),
    label: str(a.name) || 'External API',
    snippet: [KIND_INFO.external_api.label, str(a.integration_type)].filter(Boolean).join(' · '),
    context: uniq([str(a.description), str(a.integration_type)]),
    details: uniq(endpoints.get(str(a.id)) ?? []),
    href: configHref.externalApi(str(a.id)),
    adminOnly: true
  }))
  const payloads = (src.payloadTemplates ?? []).map((p) => {
    const c = str(p.collection)
    const apiName = str(p.external_api)
    const apiId = apiName ? (apiByName.get(apiName.toLowerCase()) ?? null) : null
    return {
      kind: 'payload_template' as const,
      id: str(p.key),
      label: str(p.label) || str(p.key),
      ...(c ? { collection: c } : {}),
      snippet: where(names, c || undefined, 'payload_template', apiName),
      context: uniq([...(c ? names.words(c) : []), str(p.key), str(p.description), apiName]),
      details: [],
      href: configHref.payloadTemplate(str(p.key), apiId),
      adminOnly: true
    }
  })
  return [...apis, ...payloads]
}

export const buildImportDocs: Builder = (src) =>
  (src.importDefinitions ?? []).map((d) => ({
    kind: 'import_definition' as const,
    id: str(d.key),
    label: str(d.label) || humanize(str(d.key)),
    snippet: [KIND_INFO.import_definition.label, str(d.key)].join(' · '),
    context: uniq([str(d.key), str(d.description), str(d.procedure), str(d.staging_table)]),
    details: [],
    href: configHref.importDefinition(str(d.key)),
    adminOnly: true
  }))

export const buildWebhookDocs: Builder = (src, names) =>
  (src.webhooks ?? []).map((w) => {
    const cols = asArray(w.collections).map(str).filter(Boolean)
    const events = asArray(w.events).map(str).filter(Boolean)
    return {
      kind: 'webhook' as const,
      id: str(w.id),
      label: str(w.name) || 'Webhook',
      ...(cols[0] ? { collection: cols[0] } : {}),
      // Never the URL, headers or secret.
      snippet: [KIND_INFO.webhook.label, ...cols.map((c) => names.display(c))].join(' · '),
      context: uniq([...cols.flatMap((c) => names.words(c)), ...events]),
      details: [],
      href: configHref.webhook(str(w.id)),
      adminOnly: true
    }
  })

export const buildRoleDocs: Builder = (src, names) => {
  const policies = new Map<string, Map<string, string[]>>()
  for (const p of src.policies ?? []) {
    const role = str(p.role).toLowerCase()
    const c = str(p.collection)
    if (!role || !c) continue
    const byCol = policies.get(role) ?? new Map<string, string[]>()
    const list = byCol.get(c) ?? []
    list.push(str(p.action))
    byCol.set(c, list)
    policies.set(role, byCol)
  }
  return (src.roles ?? []).map((r) => {
    const id = str(r.id)
    const byCol = policies.get(id.toLowerCase()) ?? new Map<string, string[]>()
    const details = [...byCol].map(
      ([c, actions]) =>
        `${c === '*' ? 'Every collection' : names.display(c)}: ${uniq(actions).join(', ')}`
    )
    return {
      kind: 'role' as const,
      id,
      label: str(r.name) || 'Role',
      snippet: [KIND_INFO.role.label, truthy(r.admin_access) ? 'admin access' : '']
        .filter(Boolean)
        .join(' · '),
      context: uniq([str(r.description)]),
      details: details.slice(0, 300),
      href: configHref.role(id),
      adminOnly: true
    }
  })
}

/** Settings sections (admin) — ids match admin Settings' NAV. */
export const SETTINGS_SECTIONS: Array<{ id: string; label: string; words: string }> = [
  { id: 'project', label: 'Project', words: 'name description url instance title' },
  { id: 'appearance', label: 'Appearance', words: 'theme colour color logo brand white label' },
  { id: 'localization', label: 'Localization', words: 'language locale translation time zone' },
  { id: 'microsoft', label: 'Microsoft', words: 'teams entra azure ad groups bot graph directory' },
  { id: 'ai', label: 'AI Features', words: 'ai anthropic claude model gateway key prompt caching' },
  { id: 'presence', label: 'Presence', words: 'online who is here ping session' },
  { id: 'sla', label: 'SLA', words: 'business hours days deadline' },
  { id: 'content', label: 'Content', words: 'page size retention revisions activity files' },
  { id: 'integrations', label: 'Integrations', words: 'erp submission retention push' },
  { id: 'email', label: 'Email', words: 'smtp mail sender from server' },
  { id: 'sms', label: 'SMS', words: 'text message twilio sns vonage phone' },
  { id: 'sso', label: 'Sign-in providers', words: 'sso saml oidc login sign in microsoft' },
  { id: 'profile-fields', label: 'Profile fields', words: 'people profile custom fields' },
  { id: 'storage', label: 'File storage', words: 'uploads s3 azure blob disk files' },
  { id: 'session-replay', label: 'Session replay', words: 'recording replay rrweb' },
  { id: 'huddles', label: 'Huddles', words: 'calls video livekit turn stun' },
  { id: 'backups', label: 'Backups', words: 'export backup download' },
  { id: 'instance', label: 'This Instance', words: 'environment overrides instance' }
]

/** Personal screens everyone has — the only config docs non-admins see. */
export const PERSONAL_SCREENS: Array<{ id: string; label: string; href: string; words: string }> = [
  {
    id: 'profile-notifications',
    label: 'Notification rules (your profile)',
    href: '/profile',
    words: 'notifications email push mute digest rules alerts'
  },
  {
    id: 'profile-delegate',
    label: 'Out of office and delegate (your profile)',
    href: '/profile',
    words: 'out of office ooo delegate cover vacation'
  },
  {
    id: 'profile-field-defaults',
    label: 'Personal field defaults (your profile)',
    href: '/profile',
    words: 'defaults prefill my values field'
  },
  {
    id: 'notification-subscriptions',
    label: 'Notification subscriptions',
    href: '/alerts/subscriptions',
    words: 'subscribe subscription notify follow'
  }
]

export const buildSettingDocs: Builder = () => [
  ...SETTINGS_SECTIONS.map((s) => ({
    kind: 'setting' as const,
    id: s.id,
    label: `Settings → ${s.label}`,
    snippet: KIND_INFO.setting.label,
    context: s.words.split(' '),
    details: [],
    href: configHref.setting(s.id),
    adminOnly: true
  })),
  ...PERSONAL_SCREENS.map((s) => ({
    kind: 'screen' as const,
    id: s.id,
    label: s.label,
    snippet: KIND_INFO.screen.label,
    context: s.words.split(' '),
    details: [],
    href: s.href,
    adminOnly: false
  }))
]

export const CONFIG_BUILDERS: Builder[] = [
  buildCollectionDocs,
  buildFieldDocs,
  buildLayoutDocs,
  buildPipelineDocs,
  buildFlowDocs,
  buildFieldRuleDocs,
  buildAlertDocs,
  buildRuleDocs,
  buildQueueDocs,
  buildDashboardDocs,
  buildCustomQueryDocs,
  buildExternalApiDocs,
  buildImportDocs,
  buildWebhookDocs,
  buildRoleDocs,
  buildSettingDocs
]

/** Every doc for these sources; a builder that throws is left out. */
export function buildConfigDocs(src: ConfigSources): ConfigDoc[] {
  const names = collectionNames(src)
  const out: ConfigDoc[] = []
  for (const b of CONFIG_BUILDERS) {
    try {
      out.push(...b(src, names))
    } catch {
      /* a malformed source — skip that kind */
    }
  }
  return out
}
