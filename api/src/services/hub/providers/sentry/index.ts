import { fieldWords, typedName } from '../plan-words.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type FieldSpec,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag
} from '../types.js'
import {
  hostOf,
  hostProblem,
  keySeg,
  nextCursor,
  numSeg,
  orgOf,
  SENTRY_SAAS_HOSTS,
  type SentryAnswer,
  seg,
  sentryCall,
  slugProblem,
  slugSeg
} from './client.js'

/**
 * Sentry (`sentry`): an auth token (an organization-level internal integration is preferred) +
 * the organization slug + the host (`sentry.io`, `us.sentry.io`, `de.sentry.io`, or a self-hosted
 * name). Every call is pinned to that organization. Types: team (shared), project, client key
 * (its DSN is an OUTPUT, never part of observed or desired state), issue alert, metric alert.
 *
 * External ids: team = slug; project = slug; client key = `<project slug>/<key id>`; issue alert =
 * `<project slug>/<rule id>`; metric alert = rule id (organization-wide).
 *
 * Releases: a project may record a release + deploy for one environment (named op `release`,
 * triggered by `record_release`; a promotion does it). Both calls are read-before-write.
 */

const TEAM = 'sentry.team'
const PROJECT = 'sentry.project'
const KEY = 'sentry.client_key'
const ISSUE = 'sentry.issue_alert'
const METRIC = 'sentry.metric_alert'
const PAGE = 100
const TAG_PAGES = 5

type Obj = Record<string, unknown>

const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

// ── Comparison helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

/** Sorted-key JSON, so two equal objects compare equal whatever order Sentry answers in. */
function canon(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object')
      return Object.fromEntries(
        Object.entries(x as Obj)
          .filter(([, y]) => y !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, y]) => [k, walk(y)])
      )
    return x
  }
  return JSON.stringify(walk(v))
}

function sameValue(a: unknown, b: unknown): boolean {
  const x = norm(a)
  const y = norm(b)
  if (Array.isArray(x) || Array.isArray(y)) return canon(x ?? []) === canon(y ?? [])
  if (typeof x === 'number' || typeof y === 'number') return Number(x) === Number(y)
  return canon(x) === canon(y)
}

function diffFields(
  keys: string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (!sameValue(want[k], have[k])) out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
}

function split(externalId: string): [string, string] {
  const i = externalId.indexOf('/')
  if (i < 1 || i === externalId.length - 1)
    throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return [externalId.slice(0, i), externalId.slice(i + 1)]
}

function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} at Sentry. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

function refOne(desired: DesiredResource | null, field: string): string {
  const v = desired?.refs?.[field]
  const one = Array.isArray(v) ? v[0] : v
  if (typeof one === 'string' && one) return one
  throw new ProviderError(
    'INVALID_FIELDS',
    `The ${field} this change belongs to is not created yet.`
  )
}

function refMany(desired: DesiredResource | null, field: string): string[] {
  const v = desired?.refs?.[field]
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  if (!list.length || list.some((x) => typeof x !== 'string' || !x))
    throw new ProviderError(
      'INVALID_FIELDS',
      `The ${field} this change belongs to are not all created yet.`
    )
  return list as string[]
}

function consoleUrl(ctx: ProviderContext, path: string): string {
  const host = hostOf(ctx.config)
  const org = orgOf(ctx.config)
  return SENTRY_SAAS_HOSTS.includes(host)
    ? `https://${org}.sentry.io${path}`
    : `https://${host}/organizations/${org}${path}`
}

const orgPath = (ctx: ProviderContext) => slugSeg(orgOf(ctx.config), 'organization')

// ── Alert rule bodies (conditions, filters, actions are free-form per rule id) ──

/** Fields Sentry adds for display or bookkeeping; never part of what the Hub compares. */
const DISPLAY_KEYS = new Set(['name', 'uuid', 'label'])

function ruleItemOut(raw: unknown): Obj {
  const o = asObj(raw)
  const settings: Obj = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === 'id' || DISPLAY_KEYS.has(k) || v === null || v === undefined) continue
    settings[k] = v
  }
  return { id: String(o.id ?? ''), settings }
}

function ruleItemIn(item: unknown): Obj {
  const o = asObj(item)
  return { id: o.id, ...asObj(o.settings) }
}

const ACTION_KEYS = ['type', 'targetType', 'targetIdentifier', 'integrationId', 'sentryAppId']

function triggerOut(raw: unknown): Obj {
  const t = asObj(raw)
  const actions = arr(t.actions).map((a) => {
    const o = asObj(a)
    const out: Obj = {}
    for (const k of ACTION_KEYS) {
      const v = o[k]
      if (v === null || v === undefined || v === '') continue
      out[k] = k === 'targetIdentifier' ? String(v) : v
    }
    return out
  })
  return {
    label: t.label,
    alertThreshold: Number(t.alertThreshold),
    resolveThreshold: t.resolveThreshold == null ? null : Number(t.resolveThreshold),
    actions
  }
}

function triggerIn(item: unknown): Obj {
  const t = triggerOut(item)
  return t
}

const sortTriggers = (list: Obj[]): Obj[] =>
  [...list].sort((a, b) => String(a.label).localeCompare(String(b.label)))

// ── Observed mappers (never carry a DSN, a token or a secret key) ──

function teamObserved(t: any): Observed {
  return {
    type: TEAM,
    externalId: String(t.slug),
    name: t.slug ?? null,
    fields: { slug: t.slug ?? null, memberCount: t.memberCount ?? null },
    tags: {},
    version: null,
    status: null,
    url: null
  }
}

function projectObserved(ctx: ProviderContext, p: any): Observed {
  const teams = arr(p.teams).map((x) => String(asObj(x).slug ?? ''))
  const first = str(asObj(p.team).slug) ?? teams[0] ?? null
  return {
    type: PROJECT,
    externalId: String(p.slug),
    name: p.name ?? null,
    fields: {
      name: p.name ?? null,
      slug: p.slug ?? null,
      platform: p.platform ?? null,
      team: first
    },
    tags: {},
    version: null,
    status: typeof p.status === 'string' ? p.status : null,
    url: p.slug ? consoleUrl(ctx, `/settings/projects/${p.slug}/`) : null
  }
}

function keyObserved(projectSlug: string, k: any): Observed {
  const limit = asObj(k.rateLimit)
  return {
    type: KEY,
    externalId: `${projectSlug}/${String(k.id)}`,
    name: k.name ?? null,
    // `dsn`, `public` and `secret` are never copied: the DSN is an output.
    fields: {
      project: projectSlug,
      name: k.name ?? null,
      isActive: k.isActive ?? null,
      rateLimitCount: limit.count != null ? Number(limit.count) : null,
      rateLimitWindow: limit.window != null ? Number(limit.window) : null
    },
    tags: {},
    version: null,
    status: k.isActive === false ? 'disabled' : 'active',
    url: null
  }
}

function issueObserved(projectSlug: string, r: any): Observed {
  return {
    type: ISSUE,
    externalId: `${projectSlug}/${String(r.id)}`,
    name: r.name ?? null,
    fields: {
      project: projectSlug,
      name: r.name ?? null,
      actionMatch: r.actionMatch ?? null,
      filterMatch: r.filterMatch ?? null,
      frequency: r.frequency != null ? Number(r.frequency) : null,
      environment: r.environment ?? null,
      conditions: arr(r.conditions).map(ruleItemOut),
      filters: arr(r.filters).map(ruleItemOut),
      actions: arr(r.actions).map(ruleItemOut)
    },
    tags: {},
    version: str(r.dateCreated),
    status: r.status ?? null,
    url: null
  }
}

function metricObserved(r: any): Observed {
  return {
    type: METRIC,
    externalId: String(r.id),
    name: r.name ?? null,
    fields: {
      name: r.name ?? null,
      projects: arr(r.projects).map(String),
      environment: r.environment ?? null,
      dataset: r.dataset ?? null,
      aggregate: r.aggregate ?? null,
      query: r.query ?? '',
      timeWindow: r.timeWindow != null ? Number(r.timeWindow) : null,
      thresholdType: r.thresholdType === 1 ? 'below' : 'above',
      triggers: sortTriggers(arr(r.triggers).map(triggerOut))
    },
    tags: {},
    version: str(r.dateModified),
    status: null,
    url: null
  }
}

// ── Reads ──

async function readTeam(ctx: ProviderContext, slug: string): Promise<Observed | null> {
  const r = await sentryCall(ctx, 'GET', `/teams/${orgPath(ctx)}/${slugSeg(slug, 'team')}/`, {
    allow: [404]
  })
  return r.status === 404 ? null : teamObserved(r.body)
}

async function readProject(ctx: ProviderContext, slug: string): Promise<Observed | null> {
  const r = await sentryCall(ctx, 'GET', `/projects/${orgPath(ctx)}/${slugSeg(slug, 'project')}/`, {
    allow: [404]
  })
  if (r.status === 404) return null
  // Pinned organization: a project that says it belongs to another one is not ours.
  const org = str(asObj(r.body?.organization).slug)
  if (org && org !== orgOf(ctx.config)) return null
  return projectObserved(ctx, r.body)
}

async function readKeys(ctx: ProviderContext, project: string): Promise<Observed[] | null> {
  const out: Observed[] = []
  let cursor: string | null = null
  for (let i = 0; i < TAG_PAGES; i++) {
    const r: SentryAnswer = await sentryCall(
      ctx,
      'GET',
      `/projects/${orgPath(ctx)}/${slugSeg(project, 'project')}/keys/`,
      { query: { cursor: cursor ?? undefined }, allow: [404] }
    )
    if (r.status === 404) return null
    for (const k of arr(r.body)) out.push(keyObserved(project, k))
    cursor = nextCursor(r.headers)
    if (!cursor) break
  }
  return out
}

async function readKeyRaw(ctx: ProviderContext, externalId: string): Promise<any | null> {
  const [project, id] = split(externalId)
  const r = await sentryCall(
    ctx,
    'GET',
    `/projects/${orgPath(ctx)}/${slugSeg(project, 'project')}/keys/${keySeg(id)}/`,
    { allow: [404] }
  )
  return r.status === 404 ? null : r.body
}

async function readKey(ctx: ProviderContext, externalId: string): Promise<Observed | null> {
  const raw = await readKeyRaw(ctx, externalId)
  return raw ? keyObserved(split(externalId)[0], raw) : null
}

async function readIssue(ctx: ProviderContext, externalId: string): Promise<Observed | null> {
  const [project, id] = split(externalId)
  const r = await sentryCall(
    ctx,
    'GET',
    `/projects/${orgPath(ctx)}/${slugSeg(project, 'project')}/rules/${numSeg(id, 'rule id')}/`,
    { allow: [404] }
  )
  return r.status === 404 ? null : issueObserved(project, r.body)
}

async function readIssues(ctx: ProviderContext, project: string): Promise<Observed[] | null> {
  const out: Observed[] = []
  let cursor: string | null = null
  for (let i = 0; i < TAG_PAGES; i++) {
    const r: SentryAnswer = await sentryCall(
      ctx,
      'GET',
      `/projects/${orgPath(ctx)}/${slugSeg(project, 'project')}/rules/`,
      { query: { cursor: cursor ?? undefined }, allow: [404] }
    )
    if (r.status === 404) return null
    for (const x of arr(r.body)) out.push(issueObserved(project, x))
    cursor = nextCursor(r.headers)
    if (!cursor) break
  }
  return out
}

async function readMetric(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const r = await sentryCall(
    ctx,
    'GET',
    `/organizations/${orgPath(ctx)}/alert-rules/${numSeg(id, 'alert rule id')}/`,
    { allow: [404] }
  )
  return r.status === 404 ? null : metricObserved(r.body)
}

async function listMetricsPage(
  ctx: ProviderContext,
  cursor?: string | null
): Promise<{ items: Observed[]; next: string | null }> {
  const r = await sentryCall(ctx, 'GET', `/organizations/${orgPath(ctx)}/alert-rules/`, {
    query: { cursor: cursor ?? undefined, per_page: PAGE }
  })
  return { items: arr(r.body).map(metricObserved), next: nextCursor(r.headers) }
}

async function listProjectsPage(
  ctx: ProviderContext,
  cursor?: string | null
): Promise<{ items: Observed[]; next: string | null }> {
  const r = await sentryCall(ctx, 'GET', `/organizations/${orgPath(ctx)}/projects/`, {
    query: { cursor: cursor ?? undefined, per_page: PAGE }
  })
  return { items: arr(r.body).map((p) => projectObserved(ctx, p)), next: nextCursor(r.headers) }
}

// ── Resource types ──

const FULL = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: false }

const PLATFORMS = [
  'node',
  'javascript',
  'javascript-react',
  'javascript-nextjs',
  'javascript-vue',
  'python',
  'python-django',
  'php',
  'ruby',
  'go',
  'java',
  'dotnet',
  'other'
]

const ruleItem = (label: string): FieldSpec => ({
  key: 'item',
  label,
  kind: 'object',
  fields: [
    { key: 'id', label: 'Rule id', kind: 'string', required: true },
    {
      key: 'settings',
      label: 'Settings',
      kind: 'object',
      help: 'The rest of the rule (for example value, interval, targetType).'
    }
  ]
})

const triggerItem: FieldSpec = {
  key: 'item',
  label: 'Trigger',
  kind: 'object',
  fields: [
    {
      key: 'label',
      label: 'Level',
      kind: 'enum',
      required: true,
      options: [
        { value: 'critical', label: 'Critical' },
        { value: 'warning', label: 'Warning' }
      ]
    },
    { key: 'alertThreshold', label: 'Alert above/below', kind: 'number', required: true },
    { key: 'resolveThreshold', label: 'Resolve at', kind: 'number' },
    {
      key: 'actions',
      label: 'Notify',
      kind: 'list',
      items: {
        key: 'item',
        label: 'Action',
        kind: 'object',
        fields: [
          { key: 'type', label: 'Channel', kind: 'string', required: true },
          { key: 'targetType', label: 'Target type', kind: 'string' },
          { key: 'targetIdentifier', label: 'Target', kind: 'string' },
          { key: 'integrationId', label: 'Integration id', kind: 'number' },
          { key: 'sentryAppId', label: 'Sentry app id', kind: 'number' }
        ]
      }
    }
  ]
}

const TYPES: ResourceTypeSpec[] = [
  {
    key: TEAM,
    label: 'Sentry team',
    scope: 'shared',
    nameField: 'slug',
    fields: [
      {
        key: 'slug',
        label: 'Slug',
        kind: 'string',
        required: true,
        replaceOnChange: true,
        pattern: '^[a-z0-9_-]{1,50}$',
        help: 'Lower-case letters, digits, dashes and underscores.'
      },
      { key: 'memberCount', label: 'Members', kind: 'number', readOnly: true }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [],
    risk(op) {
      return op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : []
    }
  },
  {
    key: PROJECT,
    label: 'Sentry project',
    scope: 'app',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 200 },
      {
        key: 'slug',
        label: 'Slug',
        kind: 'string',
        required: true,
        createOnly: true,
        pattern: '^[a-z0-9_-]{1,50}$'
      },
      {
        key: 'platform',
        label: 'Platform',
        kind: 'enum',
        default: 'node',
        options: PLATFORMS.map((p) => ({ value: p, label: p }))
      },
      {
        key: 'team',
        label: 'Team',
        kind: 'ref',
        refType: TEAM,
        required: true,
        createOnly: true,
        help: 'The team that owns the project (set at create).'
      },
      { key: 'release_version', label: 'Release version', kind: 'string' },
      { key: 'release_environment', label: 'Release environment', kind: 'string' },
      { key: 'release_url', label: 'Release link', kind: 'string' },
      {
        key: 'record_release',
        label: 'Record release now',
        kind: 'boolean',
        help: 'Creates the release and one deploy record on the next apply.',
        trigger: true
      }
    ],
    capabilities: FULL,
    reversible: (field) => field === 'name' || field === 'platform',
    refs: [{ field: 'team', type: TEAM, required: true }],
    risk(op) {
      return op.kind === 'delete' || op.kind === 'replace' ? ['destructive', 'data_loss'] : []
    }
  },
  {
    key: KEY,
    label: 'Sentry client key',
    scope: 'app',
    nameField: 'name',
    fields: [
      {
        key: 'project',
        label: 'Project',
        kind: 'ref',
        refType: PROJECT,
        required: true,
        replaceOnChange: true
      },
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 64 },
      { key: 'isActive', label: 'Active', kind: 'boolean', default: true },
      { key: 'rateLimitCount', label: 'Rate limit: events', kind: 'number', min: 0 },
      { key: 'rateLimitWindow', label: 'Rate limit: seconds', kind: 'number', min: 0 }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [{ field: 'project', type: PROJECT, required: true }],
    outputs: [{ key: 'dsn', label: 'DSN', secret: false }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive', 'downtime')
      else if (op.changes.some((c) => c.field === 'isActive' && c.to === false))
        out.push('downtime')
      return out
    }
  },
  {
    key: ISSUE,
    label: 'Sentry issue alert',
    scope: 'app',
    nameField: 'name',
    fields: [
      {
        key: 'project',
        label: 'Project',
        kind: 'ref',
        refType: PROJECT,
        required: true,
        replaceOnChange: true
      },
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 256 },
      {
        key: 'actionMatch',
        label: 'Conditions match',
        kind: 'enum',
        default: 'any',
        options: [
          { value: 'all', label: 'All' },
          { value: 'any', label: 'Any' },
          { value: 'none', label: 'None' }
        ]
      },
      {
        key: 'filterMatch',
        label: 'Filters match',
        kind: 'enum',
        default: 'all',
        options: [
          { value: 'all', label: 'All' },
          { value: 'any', label: 'Any' },
          { value: 'none', label: 'None' }
        ]
      },
      {
        key: 'frequency',
        label: 'Act at most every (minutes)',
        kind: 'number',
        default: 30,
        min: 5,
        max: 43200
      },
      { key: 'environment', label: 'Environment', kind: 'string' },
      {
        key: 'conditions',
        label: 'Conditions',
        kind: 'list',
        items: ruleItem('Condition')
      },
      { key: 'filters', label: 'Filters', kind: 'list', items: ruleItem('Filter') },
      {
        key: 'actions',
        label: 'Actions',
        kind: 'list',
        required: true,
        min: 1,
        items: ruleItem('Action')
      }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [{ field: 'project', type: PROJECT, required: true }],
    risk(op) {
      return op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : []
    }
  },
  {
    key: METRIC,
    label: 'Sentry metric alert',
    scope: 'app',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true, max: 256 },
      {
        key: 'projects',
        label: 'Projects',
        kind: 'list',
        required: true,
        min: 1,
        items: { key: 'item', label: 'Project', kind: 'ref', refType: PROJECT }
      },
      { key: 'environment', label: 'Environment', kind: 'string' },
      {
        key: 'dataset',
        label: 'Data',
        kind: 'enum',
        default: 'events',
        options: [
          { value: 'events', label: 'Errors' },
          { value: 'transactions', label: 'Transactions' },
          { value: 'generic_metrics', label: 'Metrics' },
          { value: 'sessions', label: 'Sessions' }
        ]
      },
      {
        key: 'aggregate',
        label: 'Measure',
        kind: 'string',
        required: true,
        help: 'For example count() or p95(transaction.duration).'
      },
      { key: 'query', label: 'Filter query', kind: 'string' },
      {
        key: 'timeWindow',
        label: 'Time window (minutes)',
        kind: 'enum',
        default: '10',
        options: ['1', '5', '10', '15', '30', '60', '120', '240', '1440'].map((m) => ({
          value: m,
          label: `${m}`
        }))
      },
      {
        key: 'thresholdType',
        label: 'Alert when',
        kind: 'enum',
        default: 'above',
        options: [
          { value: 'above', label: 'Above the threshold' },
          { value: 'below', label: 'Below the threshold' }
        ]
      },
      {
        key: 'triggers',
        label: 'Triggers',
        kind: 'list',
        required: true,
        min: 1,
        max: 2,
        items: triggerItem
      }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [{ field: 'projects', type: PROJECT, required: true }],
    risk(op) {
      return op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : []
    }
  }
]

const specOf = (type: string) => TYPES.find((t) => t.key === type)
const labelOf = (type: string) => specOf(type)?.label ?? type
const wordsOf = (type: string, changes: Array<{ field: string }>) =>
  fieldWords(specOf(type)?.fields, changes)

// ── Plan ──

interface Handler {
  type: string
  /** Fields changed in place. */
  compare: string[]
  /** Fields all shown on a create. */
  create: string[]
  /** `ref` fields (single) whose change forces a replace. */
  replaceRefs: string[]
  /** Plain fields whose change forces a replace. */
  replaceFields: string[]
  nameOf(f: Record<string, unknown>): string
  /** The field in the observed state holding the ref's provider id. */
  refField?: string
}

const HANDLERS: Record<string, Handler> = {
  [TEAM]: {
    type: TEAM,
    compare: [],
    create: ['slug'],
    replaceRefs: [],
    replaceFields: ['slug'],
    nameOf: (f) => String(f.slug ?? '')
  },
  [PROJECT]: {
    type: PROJECT,
    compare: ['name', 'platform'],
    create: ['name', 'slug', 'platform'],
    replaceRefs: [],
    replaceFields: [],
    nameOf: (f) => String(f.name ?? '')
  },
  [KEY]: {
    type: KEY,
    compare: ['name', 'isActive', 'rateLimitCount', 'rateLimitWindow'],
    create: ['name', 'isActive', 'rateLimitCount', 'rateLimitWindow'],
    replaceRefs: ['project'],
    replaceFields: [],
    nameOf: (f) => String(f.name ?? '')
  },
  [ISSUE]: {
    type: ISSUE,
    compare: [
      'name',
      'actionMatch',
      'filterMatch',
      'frequency',
      'environment',
      'conditions',
      'filters',
      'actions'
    ],
    create: [
      'name',
      'actionMatch',
      'filterMatch',
      'frequency',
      'environment',
      'conditions',
      'filters',
      'actions'
    ],
    replaceRefs: ['project'],
    replaceFields: [],
    nameOf: (f) => String(f.name ?? '')
  },
  [METRIC]: {
    type: METRIC,
    compare: [
      'name',
      'environment',
      'dataset',
      'aggregate',
      'query',
      'timeWindow',
      'thresholdType',
      'triggers'
    ],
    create: [
      'name',
      'dataset',
      'aggregate',
      'query',
      'environment',
      'timeWindow',
      'thresholdType',
      'triggers'
    ],
    replaceRefs: [],
    replaceFields: [],
    nameOf: (f) => String(f.name ?? '')
  }
}

/** Desired values in the shape observed values come in (trigger lists sorted, numbers as numbers). */
function wantOf(type: string, fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields }
  if (type === METRIC) {
    if (Array.isArray(fields.triggers)) out.triggers = sortTriggers(fields.triggers.map(triggerIn))
    if (fields.timeWindow !== undefined) out.timeWindow = Number(fields.timeWindow)
  }
  if (type === ISSUE) {
    for (const k of ['conditions', 'filters', 'actions'])
      if (Array.isArray(fields[k]))
        out[k] = (fields[k] as unknown[]).map((x) => {
          const o = asObj(x)
          return { id: String(o.id ?? ''), settings: asObj(o.settings) }
        })
  }
  return out
}

function planGeneric(
  h: Handler,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const type = h.type
  const label = labelOf(type)
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(label, observed.name)} at Sentry.`,
        changes: [],
        preconditions: { name: observed.name },
        risk: []
      }
    ]
  }
  const want = wantOf(type, desired.fields)
  if (!observed) {
    return [
      {
        kind: 'create',
        type,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(label, h.nameOf(desired.fields))}.`,
        changes: h.create
          .filter((k) => norm(want[k]) !== null)
          .map((k) => ({ field: k, to: want[k] })),
        preconditions: {},
        risk: []
      }
    ]
  }
  const replaceChanges = diffFields(h.replaceFields, want, observed.fields)
  const refChanged = h.replaceRefs.filter((r) => {
    const v = desired.refs?.[r]
    return typeof v === 'string' && v !== observed.fields[r]
  })
  if (replaceChanges.length || refChanged.length) {
    return [
      {
        kind: 'replace',
        type,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(label, observed.name)}: ${
          refChanged.length ? 'the project it belongs to' : wordsOf(type, replaceChanges)
        } cannot change in place.`,
        changes: [
          ...replaceChanges,
          ...refChanged.map((r) => ({
            field: r,
            from: observed.fields[r],
            to: desired.refs?.[r]
          }))
        ],
        preconditions: { name: observed.name },
        risk: []
      }
    ]
  }
  const changes = diffFields(h.compare, want, observed.fields)
  if (!changes.length) return []
  const pre: Record<string, unknown> = { version: observed.version ?? null }
  for (const c of changes) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${wordsOf(type, changes)} on ${typedName(label, observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

function planMetric(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const ops = planGeneric(HANDLERS[METRIC] as Handler, desired, observed)
  if (!desired || !observed) return ops
  // The projects are a list of refs (provider ids on both sides): a different set is an update.
  const want = Array.isArray(desired.refs?.projects) ? (desired.refs.projects as string[]) : null
  if (!want) return ops
  const have = arr(observed.fields.projects).map(String)
  if (canon([...want].sort()) === canon([...have].sort())) return ops
  const change: FieldChange = { field: 'projects', from: have, to: want }
  const first = ops[0]
  if (first && first.kind === 'update') {
    first.changes.push(change)
    first.preconditions.projects = have
    first.reason = `Change ${wordsOf(METRIC, first.changes)} on ${typedName(labelOf(METRIC), observed.name)}.`
    return ops
  }
  return [
    ...ops,
    {
      kind: 'update',
      type: METRIC,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${wordsOf(METRIC, [change])} on ${typedName(labelOf(METRIC), observed.name)}.`,
      changes: [change],
      preconditions: { version: observed.version ?? null, projects: have },
      risk: []
    }
  ]
}

function planProject(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const ops = planGeneric(HANDLERS[PROJECT] as Handler, desired, observed)
  if (!desired || !observed || desired.fields.record_release !== true) return ops
  const version = str(desired.fields.release_version)
  const environment = str(desired.fields.release_environment)
  if (!version || !environment)
    throw new ProviderError(
      'INVALID_FIELDS',
      'Recording a release needs a release version and an environment.'
    )
  return [
    ...ops,
    {
      kind: 'update',
      type: PROJECT,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      action: 'release',
      reason: `Record release ${version} deployed to ${environment} on ${typedName(labelOf(PROJECT), observed.name)}.`,
      changes: [{ field: 'record_release', from: false, to: true }],
      preconditions: { slug: observed.fields.slug },
      risk: [],
      data: { version, environment }
    }
  ]
}

// ── Apply ──

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>,
  outputs?: Record<string, string>
): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer } : {}),
  ...(outputs ? { outputs } : {})
})

const numOrUndef = (v: unknown): number | undefined =>
  v === null || v === undefined || v === '' ? undefined : Number(v)

function dsnOf(raw: any): string | null {
  const dsn = asObj(raw?.dsn)
  return str(dsn.public) ?? (typeof raw?.dsn === 'string' ? raw.dsn : null)
}

async function applyTeam(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const remove = async (slug: string) => {
    await sentryCall(ctx, 'DELETE', `/teams/${orgPath(ctx)}/${slugSeg(slug, 'team')}/`, {
      allow: [404]
    })
  }
  const add = async (): Promise<OpResult> => {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
    const slug = String(desired.fields.slug)
    const existing = await readTeam(ctx, slug)
    if (existing) {
      if (desired.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists(`A team named ${slug} already exists`)
    }
    const r = await sentryCall(ctx, 'POST', `/organizations/${orgPath(ctx)}/teams/`, {
      body: { slug }
    })
    const made = teamObserved(r.body)
    return ok(made.externalId, made)
  }
  if (op.kind === 'delete') {
    await remove(op.externalId as string)
    return ok(op.externalId, null)
  }
  if (op.kind === 'replace') {
    await remove(op.externalId as string)
    return add()
  }
  if (op.kind === 'create') return add()
  const have = await readTeam(ctx, op.externalId as string)
  if (!have) throw new ProviderError('NOT_FOUND', 'The team no longer exists.', { status: 404 })
  return ok(have.externalId, have, { already: 'matches' })
}

async function applyProject(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.action === 'release') return applyRelease(ctx, op, desired)
  if (op.kind === 'delete') {
    const slug = op.externalId as string
    if (!(await readProject(ctx, slug))) return ok(slug, null, { already: 'gone' })
    await sentryCall(ctx, 'DELETE', `/projects/${orgPath(ctx)}/${slugSeg(slug, 'project')}/`, {
      allow: [404]
    })
    return ok(slug, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'create') {
    const slug = String(desired.fields.slug)
    const existing = await readProject(ctx, slug)
    if (existing) {
      if (desired.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists(`A project with the slug ${slug} already exists`)
    }
    const team = refOne(desired, 'team')
    const r = await sentryCall(
      ctx,
      'POST',
      `/teams/${orgPath(ctx)}/${slugSeg(team, 'team')}/projects/`,
      {
        body: {
          name: desired.fields.name,
          slug,
          platform: norm(desired.fields.platform) ?? undefined,
          // The Hub manages alerts itself: no default rule behind its back.
          default_rules: false
        }
      }
    )
    return ok(String(r.body?.slug ?? slug), projectObserved(ctx, r.body))
  }
  const slug = op.externalId as string
  const have = await readProject(ctx, slug)
  if (!have) throw new ProviderError('NOT_FOUND', 'The project no longer exists.', { status: 404 })
  const diff = diffFields(['name', 'platform'], desired.fields, have.fields)
  if (!diff.length) return ok(slug, have, { already: 'matches' })
  const body: Obj = {}
  for (const c of diff) body[c.field] = c.to
  const r = await sentryCall(ctx, 'PUT', `/projects/${orgPath(ctx)}/${slugSeg(slug, 'project')}/`, {
    body
  })
  return ok(slug, projectObserved(ctx, r.body))
}

/** Release + deploy record. Both read-before-write; the values come from desired only. */
async function applyRelease(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const slug = op.externalId as string
  if (!desired || desired.externalId !== slug || String(desired.fields.slug ?? '') !== slug)
    throw new ProviderError(
      'TARGET_MISMATCH',
      'The project this release is for is not the one the resource points at.'
    )
  const version = str(desired.fields.release_version)
  const environment = str(desired.fields.release_environment)
  if (!version || !environment)
    throw new ProviderError(
      'INVALID_FIELDS',
      'Recording a release needs a release version and an environment.'
    )
  const planned = asObj(op.data)
  if (planned.version !== version || planned.environment !== environment)
    throw new ProviderError(
      'TARGET_MISMATCH',
      'The release changed after the plan was made. Plan it again.'
    )
  const org = orgPath(ctx)
  const rel = await sentryCall(
    ctx,
    'GET',
    `/organizations/${org}/releases/${seg(version, 'release version')}/`,
    {
      allow: [404]
    }
  )
  const attached = arr(rel.body?.projects).some((p) => asObj(p).slug === slug)
  if (rel.status === 404 || !attached)
    await sentryCall(ctx, 'POST', `/organizations/${org}/releases/`, {
      body: { version, projects: [slug] },
      // 208 = Sentry already has the release; the project is added to it.
      allow: [208]
    })
  const deploys = await sentryCall(
    ctx,
    'GET',
    `/organizations/${org}/releases/${seg(version, 'release version')}/deploys/`,
    { allow: [404] }
  )
  const seen = arr(deploys.body).some((d) => asObj(d).environment === environment)
  if (!seen) {
    const now = ctx.now().toISOString()
    const body: Obj = { environment, dateStarted: now, dateFinished: now }
    const url = str(desired.fields.release_url)
    if (url) body.url = url
    await sentryCall(
      ctx,
      'POST',
      `/organizations/${org}/releases/${seg(version, 'release version')}/deploys/`,
      { body }
    )
  }
  return ok(slug, await readProject(ctx, slug), {
    release: version,
    environment,
    deploy: seen ? 'already' : 'created'
  })
}

function keyBody(desired: DesiredResource): Obj {
  const body: Obj = { name: desired.fields.name }
  if (desired.fields.isActive === false) body.isActive = false
  const count = numOrUndef(desired.fields.rateLimitCount)
  const window = numOrUndef(desired.fields.rateLimitWindow)
  if (count !== undefined && window !== undefined) body.rateLimit = { count, window }
  return body
}

async function applyKey(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const remove = async (externalId: string) => {
    const [project, id] = split(externalId)
    await sentryCall(
      ctx,
      'DELETE',
      `/projects/${orgPath(ctx)}/${slugSeg(project, 'project')}/keys/${keySeg(id)}/`,
      { allow: [404] }
    )
  }
  const add = async (): Promise<OpResult> => {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
    const project = refOne(desired, 'project')
    const keys = (await readKeys(ctx, project)) ?? []
    const existing = keys.find((k) => k.fields.name === desired.fields.name)
    if (existing) {
      if (desired.externalId !== existing.externalId)
        throw alreadyExists(`A client key named ${String(desired.fields.name)} already exists`)
      const raw = await readKeyRaw(ctx, existing.externalId)
      const dsn = dsnOf(raw)
      return ok(existing.externalId, existing, { already: 'exists' }, dsn ? { dsn } : undefined)
    }
    const r = await sentryCall(
      ctx,
      'POST',
      `/projects/${orgPath(ctx)}/${slugSeg(project, 'project')}/keys/`,
      { body: keyBody(desired) }
    )
    const made = keyObserved(project, r.body)
    const dsn = dsnOf(r.body)
    return ok(made.externalId, made, undefined, dsn ? { dsn } : undefined)
  }
  if (op.kind === 'delete') {
    await remove(op.externalId as string)
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'create') return add()
  if (op.kind === 'replace') {
    await remove(op.externalId as string)
    return add()
  }
  const externalId = op.externalId as string
  const [project, id] = split(externalId)
  const raw = await readKeyRaw(ctx, externalId)
  if (!raw)
    throw new ProviderError('NOT_FOUND', 'The client key no longer exists.', { status: 404 })
  const have = keyObserved(project, raw)
  const diff = diffFields(
    ['name', 'isActive', 'rateLimitCount', 'rateLimitWindow'],
    desired.fields,
    have.fields
  )
  const dsn = dsnOf(raw)
  if (!diff.length) return ok(externalId, have, { already: 'matches' }, dsn ? { dsn } : undefined)
  const body: Obj = {}
  for (const c of diff) if (c.field === 'name' || c.field === 'isActive') body[c.field] = c.to
  if (diff.some((c) => c.field.startsWith('rateLimit'))) {
    const count = numOrUndef(desired.fields.rateLimitCount)
    const window = numOrUndef(desired.fields.rateLimitWindow)
    body.rateLimit = count !== undefined && window !== undefined ? { count, window } : null
  }
  const r = await sentryCall(
    ctx,
    'PUT',
    `/projects/${orgPath(ctx)}/${slugSeg(project, 'project')}/keys/${keySeg(id)}/`,
    { body }
  )
  const after = dsnOf(r.body) ?? dsn
  return ok(externalId, keyObserved(project, r.body), undefined, after ? { dsn: after } : undefined)
}

function issueBody(desired: DesiredResource): Obj {
  const list = (k: string) => arr(desired.fields[k]).map(ruleItemIn)
  return {
    name: desired.fields.name,
    actionMatch: desired.fields.actionMatch ?? 'any',
    filterMatch: desired.fields.filterMatch ?? 'all',
    frequency: Number(desired.fields.frequency ?? 30),
    environment: norm(desired.fields.environment),
    conditions: list('conditions'),
    filters: list('filters'),
    actions: list('actions')
  }
}

async function applyIssue(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const remove = async (externalId: string) => {
    const [project, id] = split(externalId)
    await sentryCall(
      ctx,
      'DELETE',
      `/projects/${orgPath(ctx)}/${slugSeg(project, 'project')}/rules/${numSeg(id, 'rule id')}/`,
      { allow: [404] }
    )
  }
  const add = async (): Promise<OpResult> => {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
    const project = refOne(desired, 'project')
    const rules = (await readIssues(ctx, project)) ?? []
    const existing = rules.find((r) => r.fields.name === desired.fields.name)
    if (existing) {
      if (desired.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists(`An issue alert named ${String(desired.fields.name)} already exists`)
    }
    const r = await sentryCall(
      ctx,
      'POST',
      `/projects/${orgPath(ctx)}/${slugSeg(project, 'project')}/rules/`,
      { body: issueBody(desired) }
    )
    const made = issueObserved(project, r.body)
    return ok(made.externalId, made)
  }
  if (op.kind === 'delete') {
    await remove(op.externalId as string)
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'create') return add()
  if (op.kind === 'replace') {
    await remove(op.externalId as string)
    return add()
  }
  const externalId = op.externalId as string
  const [project, id] = split(externalId)
  const have = await readIssue(ctx, externalId)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The issue alert no longer exists.', { status: 404 })
  const want = wantOf(ISSUE, desired.fields)
  if (!diffFields((HANDLERS[ISSUE] as Handler).compare, want, have.fields).length)
    return ok(externalId, have, { already: 'matches' })
  const r = await sentryCall(
    ctx,
    'PUT',
    `/projects/${orgPath(ctx)}/${slugSeg(project, 'project')}/rules/${numSeg(id, 'rule id')}/`,
    { body: issueBody(desired) }
  )
  return ok(externalId, issueObserved(project, r.body))
}

function metricBody(desired: DesiredResource): Obj {
  const projects = refMany(desired, 'projects')
  return {
    name: desired.fields.name,
    projects,
    environment: norm(desired.fields.environment),
    dataset: desired.fields.dataset ?? 'events',
    aggregate: desired.fields.aggregate,
    query: desired.fields.query ?? '',
    timeWindow: Number(desired.fields.timeWindow ?? 10),
    thresholdType: desired.fields.thresholdType === 'below' ? 1 : 0,
    triggers: arr(desired.fields.triggers).map(triggerIn)
  }
}

async function applyMetric(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const org = orgPath(ctx)
  if (op.kind === 'delete') {
    const id = numSeg(op.externalId, 'alert rule id')
    await sentryCall(ctx, 'DELETE', `/organizations/${org}/alert-rules/${id}/`, { allow: [404] })
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'create') {
    const found = await findMetricByName(ctx, String(desired.fields.name))
    if (found) {
      if (desired.externalId === found.externalId)
        return ok(found.externalId, found, { already: 'exists' })
      throw alreadyExists(`A metric alert named ${String(desired.fields.name)} already exists`)
    }
    const r = await sentryCall(ctx, 'POST', `/organizations/${org}/alert-rules/`, {
      body: metricBody(desired)
    })
    const made = metricObserved(r.body)
    return ok(made.externalId, made)
  }
  const externalId = op.externalId as string
  const have = await readMetric(ctx, externalId)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The metric alert no longer exists.', { status: 404 })
  const want = wantOf(METRIC, desired.fields)
  const projectsSame =
    canon([...refMany(desired, 'projects')].sort()) ===
    canon(arr(have.fields.projects).map(String).sort())
  if (projectsSame && !diffFields((HANDLERS[METRIC] as Handler).compare, want, have.fields).length)
    return ok(externalId, have, { already: 'matches' })
  const r = await sentryCall(
    ctx,
    'PUT',
    `/organizations/${org}/alert-rules/${numSeg(externalId, 'alert rule id')}/`,
    { body: metricBody(desired) }
  )
  return ok(externalId, metricObserved(r.body))
}

async function findMetricByName(ctx: ProviderContext, name: string): Promise<Observed | null> {
  let cursor: string | null = null
  for (let i = 0; i < TAG_PAGES; i++) {
    const page = await listMetricsPage(ctx, cursor)
    const hit = page.items.find((m) => m.fields.name === name)
    if (hit) return hit
    cursor = page.next
    if (!cursor) break
  }
  return null
}

// ── Permissions ──

const SCOPE_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 }

function hasScope(scopes: string[], resource: string, level: 'read' | 'write' | 'admin'): boolean {
  return scopes.some((s) => {
    const [res, lvl] = s.split(':')
    return res === resource && (SCOPE_RANK[lvl ?? ''] ?? 0) >= SCOPE_RANK[level]
  })
}

interface Need {
  type: string
  need: string
  resource: string
  level: 'read' | 'write' | 'admin'
}

const NEEDS: Need[] = [
  { type: TEAM, need: 'read sentry.team (scope team:read)', resource: 'team', level: 'read' },
  { type: TEAM, need: 'write sentry.team (scope team:write)', resource: 'team', level: 'write' },
  { type: TEAM, need: 'delete sentry.team (scope team:admin)', resource: 'team', level: 'admin' },
  {
    type: PROJECT,
    need: 'read sentry.project (scope project:read)',
    resource: 'project',
    level: 'read'
  },
  {
    type: PROJECT,
    need: 'write sentry.project (scope project:write)',
    resource: 'project',
    level: 'write'
  },
  {
    type: PROJECT,
    need: 'delete sentry.project (scope project:admin)',
    resource: 'project',
    level: 'admin'
  },
  {
    type: KEY,
    need: 'write sentry.client_key (scope project:write)',
    resource: 'project',
    level: 'write'
  },
  {
    type: ISSUE,
    need: 'write sentry.issue_alert (scope project:write)',
    resource: 'project',
    level: 'write'
  },
  {
    type: METRIC,
    need: 'read sentry.metric_alert (scope alerts:read)',
    resource: 'alerts',
    level: 'read'
  },
  {
    type: METRIC,
    need: 'write sentry.metric_alert (scope alerts:write)',
    resource: 'alerts',
    level: 'write'
  },
  {
    type: '*',
    need: 'record releases (scope project:releases)',
    resource: 'project',
    level: 'write'
  }
]

// ── The adapter ──

export const sentryAdapter: ProviderAdapter = {
  key: 'sentry',
  label: 'Sentry',
  connection: {
    fields: [
      {
        key: 'host',
        label: 'Host',
        kind: 'string',
        default: 'sentry.io',
        required: true,
        placeholder: 'sentry.io',
        help: 'sentry.io, us.sentry.io, de.sentry.io, or the name of a self-hosted Sentry (https only).'
      },
      {
        key: 'organization',
        label: 'Organization slug',
        kind: 'string',
        required: true,
        help: 'Pinned: every call is scoped to this organization.'
      },
      {
        key: 'token',
        label: 'Auth token',
        kind: 'string',
        secret: true,
        required: true,
        help: 'An organization-level internal integration token (Settings → Developer settings) is preferred.'
      }
    ],
    hosts: (config) => [hostOf(config)],
    describe: (config) => `Sentry ${orgOf(config)} on ${hostOf(config)}`,
    validate(config, secrets) {
      const problems: string[] = []
      const h = hostProblem(config.host)
      if (h) problems.push(h)
      if (slugProblem(orgOf(config)))
        problems.push(
          'The organization slug is lower-case letters, digits, dashes and underscores.'
        )
      if (secrets.token !== undefined && !secrets.token.trim())
        problems.push('The auth token is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const permissions = (has: (n: Need) => boolean) =>
      NEEDS.map((n) => ({ type: n.type, need: n.need, has: has(n) }))
    const fail = (message: string): ConnectionTest => {
      const p = permissions(() => false)
      return { ok: false, identity: null, permissions: p, missing: p.map((x) => x.need), message }
    }
    let org: any
    try {
      const r = await sentryCall(ctx, 'GET', `/organizations/${orgPath(ctx)}/`, {
        allow: [403, 404]
      })
      if (r.status !== 200)
        return fail('The token cannot see this organization (check the slug and the token scope).')
      org = r.body
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    let scopes: string[] = arr(org?.access).filter((s): s is string => typeof s === 'string')
    if (!scopes.length) {
      // The token does not list its scopes: probe the reads, report every write as missing.
      let canRead = false
      try {
        const t = await sentryCall(ctx, 'GET', `/organizations/${orgPath(ctx)}/teams/`, {
          query: { per_page: 1 },
          allow: [403]
        })
        canRead = t.status === 200
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err
      }
      scopes = canRead ? ['team:read', 'project:read', 'alerts:read'] : []
    }
    const p = permissions((n) => hasScope(scopes, n.resource, n.level))
    const missing = p.filter((x) => !x.has).map((x) => x.need)
    return {
      ok: p.some((x) => x.has),
      identity: `organization ${org?.slug ?? orgOf(ctx.config)}${org?.name ? ` (${org.name})` : ''}`,
      permissions: p,
      missing
    }
  },

  async observe(ctx, type, externalId) {
    if (type === TEAM) return readTeam(ctx, externalId)
    if (type === PROJECT) return readProject(ctx, externalId)
    if (type === KEY) return readKey(ctx, externalId)
    if (type === ISSUE) return readIssue(ctx, externalId)
    if (type === METRIC) return readMetric(ctx, externalId)
    throw new ProviderError('UNKNOWN_TYPE', `Sentry has no ${type}.`)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    if (type === TEAM) {
      const r = await sentryCall(ctx, 'GET', `/organizations/${orgPath(ctx)}/teams/`, {
        query: { cursor: cursor ?? undefined, per_page: PAGE }
      })
      return { items: arr(r.body).map(teamObserved), cursor: nextCursor(r.headers) }
    }
    if (type === METRIC) {
      const { items, next } = await listMetricsPage(ctx, cursor)
      return { items, cursor: next }
    }
    if (type !== PROJECT && type !== KEY && type !== ISSUE)
      throw new ProviderError('UNKNOWN_TYPE', `Sentry has no ${type}.`)
    const { items: projects, next } = await listProjectsPage(ctx, cursor)
    if (type === PROJECT) return { items: projects, cursor: next }
    const items: Observed[] = []
    for (const p of projects)
      items.push(
        ...((type === KEY
          ? await readKeys(ctx, p.externalId)
          : await readIssues(ctx, p.externalId)) ?? [])
      )
    return { items, cursor: next }
  },

  /** Plan time: a team or project with that slug, a key or alert with that name. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    if (type === TEAM) return readTeam(ctx, String(desired.fields.slug ?? ''))
    if (type === PROJECT) return readProject(ctx, String(desired.fields.slug ?? ''))
    if (type === METRIC) return findMetricByName(ctx, String(desired.fields.name ?? ''))
    if (type !== KEY && type !== ISSUE) return null
    const project = desired.refs?.project
    // A project made in the same change has no id yet, so nothing can collide yet.
    if (typeof project !== 'string' || !project) return null
    const list = type === KEY ? await readKeys(ctx, project) : await readIssues(ctx, project)
    return (list ?? []).find((x) => x.fields.name === desired.fields.name) ?? null
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === PROJECT) return planProject(desired, observed)
    if (type === METRIC) return planMetric(desired, observed)
    const h = type ? HANDLERS[type] : undefined
    if (!h) throw new ProviderError('UNKNOWN_TYPE', `Sentry has no ${String(type)}.`)
    return planGeneric(h, desired, observed)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    if (op.type === TEAM) return applyTeam(ctx, op, desired)
    if (op.type === PROJECT) return applyProject(ctx, op, desired)
    if (op.type === KEY) return applyKey(ctx, op, desired)
    if (op.type === ISSUE) return applyIssue(ctx, op, desired)
    if (op.type === METRIC) return applyMetric(ctx, op, desired)
    throw new ProviderError('UNKNOWN_TYPE', `Sentry has no ${op.type}.`)
  },

  /** The DSN is public and shown again by Sentry, so it can be re-read (never once-only). */
  async readOutputs(ctx, type, externalId): Promise<Record<string, string>> {
    if (type !== KEY) return {}
    const raw = await readKeyRaw(ctx, externalId)
    const dsn = raw ? dsnOf(raw) : null
    return dsn ? { dsn } : {}
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Sentry.', checkedAt }
    if (type === KEY && seen.fields.isActive === false)
      return { status: 'warn', message: 'The client key is disabled.', checkedAt }
    if (type !== PROJECT) return { status: 'ok', checkedAt }
    // Unresolved issues seen in the last 24 hours: the project, then each of its environments.
    const slug = slugSeg(externalId, 'project')
    const count = async (environment?: string): Promise<number | null> => {
      const r = await sentryCall(ctx, 'GET', `/projects/${orgPath(ctx)}/${slug}/issues/`, {
        query: { query: 'is:unresolved', statsPeriod: '24h', limit: 1, environment },
        allow: [403, 404]
      })
      if (r.status !== 200) return null
      const hits = Number(r.headers.get('x-hits'))
      return Number.isFinite(hits) && r.headers.get('x-hits') !== null ? hits : arr(r.body).length
    }
    const total = await count()
    if (total === null)
      return { status: 'unknown', message: 'The token cannot read issues.', checkedAt }
    const details: Record<string, string | number | boolean> = { unresolved_24h: total }
    const envs = await sentryCall(ctx, 'GET', `/projects/${orgPath(ctx)}/${slug}/environments/`, {
      allow: [403, 404]
    })
    for (const e of arr(envs.body).slice(0, 5)) {
      const name = str(asObj(e).name) ?? (typeof e === 'string' ? e : null)
      if (!name) continue
      const n = await count(name)
      if (n !== null) details[`unresolved_24h_${name}`] = n
    }
    return {
      status: total >= 50 ? 'warn' : 'ok',
      message: `${total} unresolved issue${total === 1 ? '' : 's'} in the last 24 hours.`,
      checkedAt,
      details
    }
  }
}
