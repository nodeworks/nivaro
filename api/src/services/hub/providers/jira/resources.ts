import { asObj, mkOp, norm, str, strs } from '../entra/shared.js'
import { typedName } from '../plan-words.js'
import {
  type DesiredResource,
  type FieldChange,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderContext,
  ProviderError
} from '../types.js'
import {
  hasControl,
  idSeg,
  jiraCall,
  keySeg,
  modeOf,
  PROJECT_KEY_RE,
  projectAllowed,
  projectKeysOf,
  safe,
  siteUrl
} from './client.js'
import { COMPONENT, DEFAULT_WEBHOOK_EVENTS, PROJECT, VERSION, WEBHOOK } from './specs.js'

/**
 * Jira project, component, version and webhook: observe, list, plan, apply. External ids: project
 * = project key; component, version and webhook = Jira's numeric id. A project allow-list on the
 * connection (`project_keys`) is enforced on EVERY read and write by id: a component or version
 * is judged through its parent project, anything outside reads as gone (observe) or throws
 * JIRA_OUT_OF_ACCOUNT (apply). Webhooks are the Data Center admin webhook API only.
 */

const PAGE = 50
const PROJECTS_PER_LIST_PAGE = 20
const PROJECT_KEY_TTL_MS = 10 * 60 * 1000

const LABELS: Record<string, string> = {
  [PROJECT]: 'Jira project',
  [COMPONENT]: 'Jira component',
  [VERSION]: 'Jira version',
  [WEBHOOK]: 'Jira webhook'
}

export function outOfAccount(key: string): ProviderError {
  return new ProviderError(
    'JIRA_OUT_OF_ACCOUNT',
    `Project ${key} is outside the projects this Jira connection is limited to.`
  )
}

export function assertProject(ctx: ProviderContext, key: string): void {
  if (!projectAllowed(ctx.config, key)) throw outOfAccount(key)
}

const today = (ctx: ProviderContext) => ctx.now().toISOString().slice(0, 10)

export function refKey(desired: DesiredResource | null): string {
  const v = desired?.refs?.project
  const one = Array.isArray(v) ? v[0] : v
  if (typeof one === 'string' && one) return keySeg(one)
  throw new ProviderError(
    'INVALID_FIELDS',
    'The project this change belongs to is not created yet.'
  )
}

// ── Projects ──

export function projectObserved(ctx: ProviderContext, p: any): Observed {
  const key = String(p.key)
  const site = siteUrl(ctx.config)
  return {
    type: PROJECT,
    externalId: key,
    name: str(p.name) ?? key,
    fields: { key, name: str(p.name), project_type: str(p.projectTypeKey) },
    tags: {},
    version: null,
    status: p.archived ? 'archived' : 'active',
    url: site ? `${site}/browse/${key}` : null
  }
}

export async function readProject(ctx: ProviderContext, key: string): Promise<Observed | null> {
  const k = keySeg(key)
  if (!projectAllowed(ctx.config, k)) return null
  const r = await jiraCall(ctx, 'GET', `/project/${k}`, { allow: [404] })
  if (r.status === 404 || !r.body || !PROJECT_KEY_RE.test(String(r.body.key ?? ''))) return null
  if (!projectAllowed(ctx.config, String(r.body.key))) return null
  return projectObserved(ctx, r.body)
}

async function projectPage(
  ctx: ProviderContext,
  startAt: number,
  max: number
): Promise<{ projects: any[]; next: string | null }> {
  if (modeOf(ctx.config) === 'datacenter_pat') {
    const r = await jiraCall(ctx, 'GET', '/project')
    const all = Array.isArray(r.body) ? r.body : []
    return {
      projects: all.filter((p) => projectAllowed(ctx.config, String(p?.key ?? ''))),
      next: null
    }
  }
  const r = await jiraCall(ctx, 'GET', '/project/search', {
    query: { startAt, maxResults: max }
  })
  const values: any[] = Array.isArray(r.body?.values) ? r.body.values : []
  return {
    projects: values.filter((p) => projectAllowed(ctx.config, String(p?.key ?? ''))),
    next: r.body?.isLast === false && values.length ? String(startAt + values.length) : null
  }
}

/** The key of the project an object belongs to (`project` key, else `projectId` looked up). */
async function projectKeyOf(ctx: ProviderContext, obj: any): Promise<string | null> {
  const direct = typeof obj?.project === 'string' ? obj.project.toUpperCase() : ''
  if (PROJECT_KEY_RE.test(direct)) return direct
  const id = obj?.projectId
  if (id === undefined || id === null) return null
  const sid = idSeg(id, 'project id')
  const cacheKey = `projkey:${sid}`
  const hit = ctx.tokens.get(cacheKey)
  if (hit) return hit
  const r = await jiraCall(ctx, 'GET', `/project/${sid}`, { allow: [404] })
  const key = r.status === 404 ? '' : String(r.body?.key ?? '').toUpperCase()
  if (!PROJECT_KEY_RE.test(key)) return null
  ctx.tokens.set(cacheKey, key, new Date(ctx.now().getTime() + PROJECT_KEY_TTL_MS))
  return key
}

// ── Components ──

function componentObserved(ctx: ProviderContext, c: any, project: string): Observed {
  const site = siteUrl(ctx.config)
  return {
    type: COMPONENT,
    externalId: String(c.id),
    name: str(c.name),
    fields: { project, name: str(c.name), description: str(c.description) },
    tags: {},
    version: null,
    status: null,
    url: site
      ? `${site}/projects/${project}?selectedItem=com.atlassian.jira.jira-projects-plugin:components-page`
      : null
  }
}

export async function readComponent(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const r = await jiraCall(ctx, 'GET', `/component/${idSeg(id, 'component id')}`, { allow: [404] })
  if (r.status === 404 || !r.body) return null
  const project = await projectKeyOf(ctx, r.body)
  if (!project || !projectAllowed(ctx.config, project)) return null
  return componentObserved(ctx, r.body, project)
}

// ── Versions ──

function versionObserved(ctx: ProviderContext, v: any, project: string): Observed {
  const site = siteUrl(ctx.config)
  return {
    type: VERSION,
    externalId: String(v.id),
    name: str(v.name),
    fields: {
      project,
      name: str(v.name),
      description: str(v.description),
      release_date: str(v.releaseDate),
      archived: v.archived === true,
      released: v.released === true
    },
    tags: {},
    version: null,
    status: v.archived ? 'archived' : v.released ? 'released' : 'unreleased',
    url: site
      ? `${site}/projects/${project}?selectedItem=com.atlassian.jira.jira-projects-plugin:release-page`
      : null
  }
}

export async function readVersion(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const r = await jiraCall(ctx, 'GET', `/version/${idSeg(id, 'version id')}`, { allow: [404] })
  if (r.status === 404 || !r.body) return null
  const project = await projectKeyOf(ctx, r.body)
  if (!project || !projectAllowed(ctx.config, project)) return null
  return versionObserved(ctx, r.body, project)
}

// ── Webhooks (Data Center admin API) ──

const FILTER_KEY = 'issue-related-events-section'

function webhookIdOf(w: any): string | null {
  if (w?.id !== undefined && /^\d{1,12}$/.test(String(w.id))) return String(w.id)
  const m = /\/webhook\/(\d{1,12})\/?$/.exec(String(w?.self ?? ''))
  return m ? (m[1] as string) : null
}

function webhookObserved(w: any, id: string): Observed {
  return {
    type: WEBHOOK,
    externalId: id,
    name: str(w.name),
    fields: {
      name: str(w.name),
      url: str(w.url),
      events: strs(w.events).sort(),
      jql: str(asObj(w.filters)[FILTER_KEY]),
      enabled: w.enabled !== false
    },
    tags: {},
    version: null,
    status: w.enabled === false ? 'disabled' : 'enabled',
    url: null
  }
}

function needDataCenter(ctx: ProviderContext): void {
  if (modeOf(ctx.config) !== 'datacenter_pat')
    throw new ProviderError(
      'WEBHOOK_DC_ONLY',
      'The Hub manages webhooks on Jira Data Center only. Jira Cloud webhooks are made in Jira settings.'
    )
}

/**
 * Whether a person's JQL stays inside the group the Hub wraps it in (security review): quotes
 * closed, parentheses balanced and never closing below the top, no ORDER BY, no line breaks
 * (a stray `)` would let `x) OR (project = OTHER` escape the project limit). Pure.
 */
export function jqlIsContained(jql: string): boolean {
  if (/[\r\n]/.test(jql)) return false
  let depth = 0
  let quote: string | null = null
  let outside = ''
  for (let i = 0; i < jql.length; i++) {
    const c = jql[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth < 0) return false
    outside += c
  }
  if (quote || depth !== 0) return false
  return !/\border\s+by\b/i.test(outside)
}

/** The filter the Hub writes: limited to the allowed projects, the person's JQL wrapped inside. */
export function limitedJql(ctx: ProviderContext, userJql: string | null): string | null {
  const keys = [...projectKeysOf(ctx.config)].sort()
  if (!keys.length) return userJql
  if (keys.some((k) => !PROJECT_KEY_RE.test(k)))
    throw new ProviderError('INVALID_FIELDS', 'A project key of this connection is not valid.')
  const base = `project in (${keys.map((k) => `"${k}"`).join(', ')})`
  if (userJql && !jqlIsContained(userJql))
    throw new ProviderError(
      'INVALID_FIELDS',
      'The JQL filter must have balanced quotes and parentheses and no ORDER BY: the Hub wraps it inside the project limit.'
    )
  return userJql ? `${base} AND (${userJql})` : base
}

/** True when a stored webhook filter is limited to exactly the connection's projects. */
export function filterIsLimited(ctx: ProviderContext, jql: unknown): boolean {
  if (!projectKeysOf(ctx.config).length) return true
  const base = limitedJql(ctx, null) as string
  const s = typeof jql === 'string' ? jql : ''
  if (s === base) return true
  const head = `${base} AND (`
  if (!s.startsWith(head) || !s.endsWith(')')) return false
  return jqlIsContained(s.slice(head.length, -1))
}

async function readWebhookRaw(ctx: ProviderContext, id: string): Promise<Observed | null> {
  if (modeOf(ctx.config) !== 'datacenter_pat') return null
  const sid = idSeg(id, 'webhook id')
  const r = await jiraCall(ctx, 'GET', `/webhook/${sid}`, { allow: [404], root: 'webhooks' })
  if (r.status === 404 || !r.body) return null
  return webhookObserved(r.body, sid)
}

/** A webhook outside the connection's projects reads as gone (observe, adopt, list). */
export async function readWebhook(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const w = await readWebhookRaw(ctx, id)
  return w && filterIsLimited(ctx, w.fields.jql) ? w : null
}

async function ownWebhook(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const w = await readWebhookRaw(ctx, id)
  if (w && !filterIsLimited(ctx, w.fields.jql))
    throw new ProviderError(
      'PROJECT_MISMATCH',
      'This webhook is not limited to the projects of this connection. Nothing was changed.'
    )
  return w
}

// ── Observe / list / findExisting ──

export async function observeResource(
  ctx: ProviderContext,
  type: string,
  externalId: string
): Promise<Observed | null> {
  if (type === PROJECT) return readProject(ctx, externalId)
  if (type === COMPONENT) return readComponent(ctx, externalId)
  if (type === VERSION) return readVersion(ctx, externalId)
  if (type === WEBHOOK) return readWebhook(ctx, externalId)
  throw new ProviderError('UNKNOWN_TYPE', `Jira has no ${type}.`)
}

export async function listResources(
  ctx: ProviderContext,
  type: string,
  cursor: string | null
): Promise<ListPage> {
  if (type === WEBHOOK) {
    if (modeOf(ctx.config) !== 'datacenter_pat') return { items: [], cursor: null }
    const r = await jiraCall(ctx, 'GET', '/webhook', { root: 'webhooks' })
    const items: Observed[] = []
    for (const w of Array.isArray(r.body) ? r.body : []) {
      const id = webhookIdOf(w)
      const o = id ? webhookObserved(w, id) : null
      if (o && filterIsLimited(ctx, o.fields.jql)) items.push(o)
    }
    return { items, cursor: null }
  }
  const startAt = Number(cursor ?? 0)
  const at = Number.isInteger(startAt) && startAt >= 0 ? startAt : 0
  const { projects, next } = await projectPage(
    ctx,
    at,
    type === PROJECT ? PAGE : PROJECTS_PER_LIST_PAGE
  )
  if (type === PROJECT) return { items: projects.map((p) => projectObserved(ctx, p)), cursor: next }
  const items: Observed[] = []
  for (const p of projects) {
    const key = keySeg(p.key)
    const r = await jiraCall(
      ctx,
      'GET',
      `/project/${key}/${type === COMPONENT ? 'components' : 'versions'}`
    )
    for (const x of Array.isArray(r.body) ? r.body : [])
      items.push(type === COMPONENT ? componentObserved(ctx, x, key) : versionObserved(ctx, x, key))
  }
  return { items, cursor: next }
}

export async function findExistingResource(
  ctx: ProviderContext,
  type: string,
  desired: DesiredResource
): Promise<Observed | null> {
  const name = String(desired.fields.name ?? '')
    .trim()
    .toLowerCase()
  if (!name) return null
  if (type === WEBHOOK) {
    const page = await listResources(ctx, WEBHOOK, null)
    return page.items.find((o) => String(o.name ?? '').toLowerCase() === name) ?? null
  }
  if (type !== COMPONENT && type !== VERSION) return null
  const v = desired.refs?.project
  const one = Array.isArray(v) ? v[0] : v
  if (typeof one !== 'string' || !one) return null
  const key = keySeg(one)
  if (!projectAllowed(ctx.config, key)) return null
  const r = await jiraCall(
    ctx,
    'GET',
    `/project/${key}/${type === COMPONENT ? 'components' : 'versions'}`,
    {
      allow: [404]
    }
  )
  const hit = (Array.isArray(r.body) ? r.body : []).find(
    (x: any) => String(x?.name ?? '').toLowerCase() === name
  )
  if (!hit) return null
  return type === COMPONENT ? componentObserved(ctx, hit, key) : versionObserved(ctx, hit, key)
}

// ── Plans ──

const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}

interface StdKeys {
  /** field keys compared with `norm` (empty text = null). */
  fields: string[]
  /** boolean fields (absent = false). */
  bools?: string[]
}

function wantOf(desired: DesiredResource, k: StdKeys): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of k.fields) {
    const v = desired.fields[f]
    out[f] = Array.isArray(v) ? v : text(v)
  }
  for (const f of k.bools ?? []) out[f] = desired.fields[f] === true
  return out
}

function planStd(
  type: string,
  k: StdKeys,
  desired: DesiredResource | null,
  observed: Observed | null,
  gone: string
): PlannedOp[] {
  const label = LABELS[type] ?? type
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        type,
        null,
        'delete',
        observed.externalId,
        `Delete ${typedName(label, observed.name)}. ${gone}`,
        {
          preconditions: { name: observed.name }
        }
      )
    ]
  }
  const want = wantOf(desired, k)
  const name = typedName(label, String(want.name ?? observed?.name ?? ''))
  if (!observed) {
    return [
      mkOp(type, desired, 'create', null, `Create ${name}.`, {
        changes: [...k.fields, ...(k.bools ?? [])]
          .filter(
            (f) =>
              want[f] !== null &&
              want[f] !== false &&
              !(Array.isArray(want[f]) && !(want[f] as unknown[]).length)
          )
          .map((f) => ({ field: f, to: want[f] }))
      })
    ]
  }
  const proj = desired.refs?.project
  const wantProject = Array.isArray(proj) ? proj[0] : proj
  if (
    typeof wantProject === 'string' &&
    wantProject &&
    observed.fields.project !== undefined &&
    observed.fields.project !== wantProject
  )
    return [
      mkOp(
        type,
        desired,
        'replace',
        observed.externalId,
        `Replace ${name}: it cannot move to another project, so it is deleted from ${String(observed.fields.project)} and made in ${wantProject}. ${gone}`,
        { changes: [{ field: 'project', from: observed.fields.project, to: wantProject }] }
      )
    ]
  const changes: FieldChange[] = []
  for (const f of k.fields) {
    if (norm(want[f]) !== norm(observed.fields[f]))
      changes.push({ field: f, from: observed.fields[f] ?? null, to: want[f] })
  }
  for (const f of k.bools ?? [])
    if (want[f] !== (observed.fields[f] === true))
      changes.push({ field: f, from: observed.fields[f] === true, to: want[f] })
  if (!changes.length) return []
  return [
    mkOp(type, desired, 'update', observed.externalId, `Update ${name}.`, {
      changes,
      preconditions: Object.fromEntries(changes.map((c) => [c.field, c.from ?? null]))
    })
  ]
}

export function planComponent(d: DesiredResource | null, o: Observed | null): PlannedOp[] {
  return planStd(
    COMPONENT,
    { fields: ['name', 'description'] },
    d,
    o,
    'Issues in it lose their component.'
  )
}

export function planVersion(d: DesiredResource | null, o: Observed | null): PlannedOp[] {
  const ops = planStd(
    VERSION,
    { fields: ['name', 'description', 'release_date'], bools: ['archived'] },
    d,
    o,
    'Issues lose this fix version.'
  )
  if (!d) return ops
  const releasing = d.fields.release === true
  if (!releasing || (o && o.fields.released === true)) return ops
  const name = typedName(LABELS[VERSION] ?? VERSION, String(d.fields.name ?? o?.name ?? ''))
  if (!o) return ops // a create releases in the same call (see createVersion)
  const hasPlain = ops.find((op) => op.kind === 'update' || op.kind === 'replace')
  if (hasPlain?.kind === 'replace') return ops
  const merged: FieldChange[] = [
    ...(hasPlain?.changes ?? []),
    { field: 'released', from: false, to: true }
  ]
  return [
    mkOp(VERSION, d, 'update', o.externalId, `Release ${name}.`, {
      action: 'release',
      changes: merged,
      preconditions: { released: false, ...(hasPlain?.preconditions ?? {}) },
      data: { releaseDate: text(d.fields.release_date) }
    })
  ]
}

function webhookUrlProblem(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return 'Enter the webhook address as an https URL.'
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
    return 'The webhook address must be https, with no login, query string or fragment.'
  return null
}

function webhookFields(ctx: ProviderContext | null, desired: DesiredResource) {
  const url = text(desired.fields.url)
  const problem = webhookUrlProblem(url)
  if (problem) throw new ProviderError('INVALID_FIELDS', problem)
  const events = strs(desired.fields.events)
    .map((e) => e.trim())
    .filter(Boolean)
  const userJql = text(desired.fields.jql)
  const jql = ctx ? limitedJql(ctx, userJql) : userJql
  return {
    name: String(desired.fields.name ?? '').trim(),
    url: url as string,
    events: events.length ? events : DEFAULT_WEBHOOK_EVENTS,
    jql,
    enabled: desired.fields.enabled !== false
  }
}

export function planWebhook(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const label = LABELS[WEBHOOK] as string
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        WEBHOOK,
        null,
        'delete',
        observed.externalId,
        `Delete ${typedName(label, observed.name)}: Jira stops sending its events.`,
        {
          preconditions: { name: observed.name }
        }
      )
    ]
  }
  needDataCenter(ctx)
  const want = webhookFields(ctx, desired)
  const secret = asObj(desired.fields.secret)
  const name = typedName(label, want.name)
  if (!observed)
    return [
      mkOp(
        WEBHOOK,
        desired,
        'create',
        null,
        `Create ${name}: Jira sends ${want.events.length} event type(s) to ${new URL(want.url).host}.`,
        {
          changes: [
            { field: 'name', to: want.name },
            { field: 'url', to: want.url },
            { field: 'events', to: want.events },
            ...(want.jql ? [{ field: 'jql', to: want.jql }] : []),
            ...(secret.changed === true ? [{ field: 'secret', secret: true }] : [])
          ]
        }
      )
    ]
  const changes: FieldChange[] = []
  const have = observed.fields
  if (want.name !== have.name) changes.push({ field: 'name', from: have.name, to: want.name })
  if (want.url !== have.url) changes.push({ field: 'url', from: have.url, to: want.url })
  if (norm(want.events) !== norm(have.events))
    changes.push({ field: 'events', from: have.events, to: want.events })
  if (norm(want.jql) !== norm(have.jql))
    changes.push({ field: 'jql', from: have.jql ?? null, to: want.jql })
  if (want.enabled !== (have.enabled === true))
    changes.push({ field: 'enabled', from: have.enabled === true, to: want.enabled })
  if (secret.changed === true) changes.push({ field: 'secret', secret: true })
  if (!changes.length) return []
  return [
    mkOp(WEBHOOK, desired, 'update', observed.externalId, `Update ${name}.`, {
      changes,
      preconditions: Object.fromEntries(
        changes.filter((c) => !c.secret).map((c) => [c.field, c.from ?? null])
      )
    })
  ]
}

// ── Apply ──

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>
): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer } : {})
})

function alreadyExists(what: string): ProviderError {
  return new ProviderError('ALREADY_EXISTS', `${what} at Jira. Adopt it instead of creating it.`)
}

function cleanName(v: unknown, what: string): string {
  const s = String(v ?? '').trim()
  if (!s || s.length > 255 || hasControl(s))
    throw new ProviderError('INVALID_FIELDS', `The ${what} name is 1 to 255 characters.`)
  return s
}

function cleanDate(v: unknown): string | null {
  const s = text(v)
  if (s === null) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)))
    throw new ProviderError('INVALID_FIELDS', 'The release date is YYYY-MM-DD.')
  return s
}

async function guardProject(
  ctx: ProviderContext,
  seen: Observed | null,
  desired: DesiredResource | null
): Promise<void> {
  if (!seen) return
  const want = desired?.refs?.project
  const one = Array.isArray(want) ? want[0] : want
  const have = String(seen.fields.project ?? '')
  assertProject(ctx, have)
  if (typeof one === 'string' && one && one.toUpperCase() !== have.toUpperCase())
    throw new ProviderError(
      'PROJECT_MISMATCH',
      `${seen.name ?? 'This item'} belongs to project ${have}, not the one this change names. Nothing was changed.`
    )
}

async function createComponent(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const project = refKey(desired)
  assertProject(ctx, project)
  if (desired.externalId) {
    const again = await readComponent(ctx, desired.externalId)
    if (again) return ok(desired.externalId, again)
  }
  const name = cleanName(desired.fields.name, 'component')
  const dup = await findExistingResource(ctx, COMPONENT, desired)
  if (dup) throw alreadyExists(`A component named ${name} already exists in ${project}`)
  const r = await jiraCall(ctx, 'POST', '/component', {
    body: {
      project,
      name,
      ...(text(desired.fields.description) ? { description: text(desired.fields.description) } : {})
    }
  })
  const id = idSeg(r.body?.id, 'component id')
  return ok(id, await readComponent(ctx, id))
}

async function updateComponent(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource
): Promise<OpResult> {
  const id = idSeg(op.externalId, 'component id')
  const seen = await readComponent(ctx, id)
  if (!seen) throw new ProviderError('NOT_FOUND', 'The component is gone at Jira.', { status: 404 })
  await guardProject(ctx, seen, desired)
  const fields = new Set(op.changes.map((c) => c.field))
  const body: Record<string, unknown> = {}
  if (fields.has('name')) body.name = cleanName(desired.fields.name, 'component')
  if (fields.has('description')) body.description = text(desired.fields.description) ?? ''
  if (Object.keys(body).length) await jiraCall(ctx, 'PUT', `/component/${id}`, { body })
  return ok(id, await readComponent(ctx, id))
}

async function deleteComponent(ctx: ProviderContext, externalId: string | null): Promise<OpResult> {
  const id = idSeg(externalId, 'component id')
  const seen = await readComponent(ctx, id)
  if (!seen) return ok(id, null)
  assertProject(ctx, String(seen.fields.project))
  await jiraCall(ctx, 'DELETE', `/component/${id}`, { allow: [404] })
  return ok(id, null)
}

async function createVersion(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const project = refKey(desired)
  assertProject(ctx, project)
  if (desired.externalId) {
    const again = await readVersion(ctx, desired.externalId)
    if (again) return ok(desired.externalId, again)
  }
  const name = cleanName(desired.fields.name, 'version')
  const dup = await findExistingResource(ctx, VERSION, desired)
  if (dup) throw alreadyExists(`A version named ${name} already exists in ${project}`)
  const releaseDate = cleanDate(desired.fields.release_date)
  const release = desired.fields.release === true
  const r = await jiraCall(ctx, 'POST', '/version', {
    body: {
      project,
      name,
      ...(text(desired.fields.description)
        ? { description: text(desired.fields.description) }
        : {}),
      ...(releaseDate || release ? { releaseDate: releaseDate ?? today(ctx) } : {}),
      archived: desired.fields.archived === true,
      released: release
    }
  })
  const id = idSeg(r.body?.id, 'version id')
  return ok(id, await readVersion(ctx, id))
}

async function updateVersion(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource
): Promise<OpResult> {
  const id = idSeg(op.externalId, 'version id')
  const seen = await readVersion(ctx, id)
  if (!seen) throw new ProviderError('NOT_FOUND', 'The version is gone at Jira.', { status: 404 })
  await guardProject(ctx, seen, desired)
  const fields = new Set(op.changes.map((c) => c.field))
  const body: Record<string, unknown> = {}
  if (fields.has('name')) body.name = cleanName(desired.fields.name, 'version')
  if (fields.has('description')) body.description = text(desired.fields.description) ?? ''
  if (fields.has('archived')) body.archived = desired.fields.archived === true
  if (fields.has('release_date')) body.releaseDate = cleanDate(desired.fields.release_date) ?? ''
  if (op.action === 'release') {
    if (seen.fields.released !== true) {
      body.released = true
      if (!('releaseDate' in body))
        body.releaseDate =
          cleanDate(op.data?.releaseDate) ?? cleanDate(desired.fields.release_date) ?? today(ctx)
    }
  } else if (op.action) {
    throw new ProviderError(
      'CAPABILITY_MISSING',
      'A version can only be released as a named change.'
    )
  }
  if (Object.keys(body).length) await jiraCall(ctx, 'PUT', `/version/${id}`, { body })
  return ok(
    id,
    await readVersion(ctx, id),
    op.action === 'release' ? { released: true } : undefined
  )
}

async function deleteVersion(ctx: ProviderContext, externalId: string | null): Promise<OpResult> {
  const id = idSeg(externalId, 'version id')
  const seen = await readVersion(ctx, id)
  if (!seen) return ok(id, null)
  assertProject(ctx, String(seen.fields.project))
  await jiraCall(ctx, 'DELETE', `/version/${id}`, { allow: [404] })
  return ok(id, null)
}

function scrubbing(ctx: ProviderContext, plain: string | undefined, err: unknown): never {
  if (err instanceof ProviderError && plain && plain.length >= 4)
    err.message = safe(ctx, err.message.split(plain).join('••••••'))
  throw err
}

function webhookBody(ctx: ProviderContext, desired: DesiredResource, withSecret: boolean) {
  const w = webhookFields(ctx, desired)
  const secret = asObj(desired.fields.secret)
  return {
    plain: typeof secret.plain === 'string' && secret.plain ? secret.plain : undefined,
    body: {
      name: w.name,
      url: w.url,
      events: w.events,
      enabled: w.enabled,
      excludeBody: false,
      ...(w.jql ? { filters: { [FILTER_KEY]: w.jql } } : {}),
      ...(withSecret && typeof secret.plain === 'string' && secret.plain
        ? { secret: secret.plain }
        : {})
    }
  }
}

async function createWebhook(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  needDataCenter(ctx)
  if (desired.externalId) {
    const again = await readWebhook(ctx, desired.externalId)
    if (again) return ok(desired.externalId, again)
  }
  const dup = await findExistingResource(ctx, WEBHOOK, desired)
  if (dup) throw alreadyExists(`A webhook named ${String(desired.fields.name)} already exists`)
  const { body, plain } = webhookBody(ctx, desired, true)
  try {
    const r = await jiraCall(ctx, 'POST', '/webhook', { body, root: 'webhooks' })
    const id = webhookIdOf(r.body)
    if (!id) throw new ProviderError('PROVIDER_REJECTED', 'Jira did not say which webhook it made.')
    return ok(id, await readWebhook(ctx, id))
  } catch (err) {
    return scrubbing(ctx, plain, err)
  }
}

async function updateWebhook(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource
): Promise<OpResult> {
  needDataCenter(ctx)
  const id = idSeg(op.externalId, 'webhook id')
  const seen = await ownWebhook(ctx, id)
  if (!seen) throw new ProviderError('NOT_FOUND', 'The webhook is gone at Jira.', { status: 404 })
  const changed = asObj(desired.fields.secret).changed === true
  const { body, plain } = webhookBody(ctx, desired, changed)
  try {
    await jiraCall(ctx, 'PUT', `/webhook/${id}`, { body, root: 'webhooks' })
  } catch (err) {
    return scrubbing(ctx, plain, err)
  }
  return ok(id, await readWebhook(ctx, id))
}

async function deleteWebhook(ctx: ProviderContext, externalId: string | null): Promise<OpResult> {
  const id = idSeg(externalId, 'webhook id')
  if (modeOf(ctx.config) !== 'datacenter_pat') return ok(id, null)
  const seen = await ownWebhook(ctx, id)
  if (!seen) return ok(id, null)
  await jiraCall(ctx, 'DELETE', `/webhook/${id}`, { allow: [404], root: 'webhooks' })
  return ok(id, null)
}

export async function applyResource(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const t = op.type
  const make =
    t === COMPONENT
      ? createComponent
      : t === VERSION
        ? createVersion
        : t === WEBHOOK
          ? createWebhook
          : null
  const change =
    t === COMPONENT
      ? updateComponent
      : t === VERSION
        ? updateVersion
        : t === WEBHOOK
          ? updateWebhook
          : null
  const remove =
    t === COMPONENT
      ? deleteComponent
      : t === VERSION
        ? deleteVersion
        : t === WEBHOOK
          ? deleteWebhook
          : null
  if (!make || !change || !remove) throw new ProviderError('UNKNOWN_TYPE', `Jira has no ${t}.`)
  if (op.kind === 'noop') return ok(op.externalId, null)
  if (op.kind === 'delete') return remove(ctx, op.externalId)
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'This change has no desired state.')
  if (op.kind === 'create') return make(ctx, desired)
  if (op.kind === 'replace') {
    await remove(ctx, op.externalId)
    return make(ctx, { ...desired, externalId: null })
  }
  if (desired.externalId && op.externalId && desired.externalId !== op.externalId)
    throw new ProviderError('TARGET_MISMATCH', 'This change is for a different item.')
  return change(ctx, op, desired)
}
