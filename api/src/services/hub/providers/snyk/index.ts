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
  issueSeg,
  isUuid,
  nextRestCursor,
  orgOf,
  repoPart,
  SNYK_HOSTS,
  snykCall,
  uuidSeg
} from './client.js'
import { type SnykFindings, snykFindingsFor } from './findings.js'

export { type SnykFindings, snykFindingsFor } from './findings.js'

/**
 * Snyk (`snyk`): an API token (a service account is preferred) + the organization id + the
 * regional host (`api.snyk.io`, `api.eu.snyk.io`, `api.au.snyk.io`). Every call is pinned to that
 * organization (its id is in every path). Types:
 *
 *  - `snyk.integration` (shared, read): the org's GitHub / GitLab integration (provider id = the
 *    integration uuid).
 *  - `snyk.target` (provider id = the target uuid): imports one repository that the GitHub or
 *    GitLab adapter manages, through a `ref`. Delete = stop monitoring (it removes the target and
 *    its projects at Snyk): `destructive` + `public_exposure` (admin).
 *  - `snyk.project` (read + the protection settings): one manifest / container. Switching
 *    monitoring off, switching pull request checks off or lowering the failing severity weakens
 *    protection: `public_exposure` (admin). Projects appear by importing a target, never created.
 *  - `snyk.ignore` (provider id = `<project uuid>/<issue id>`): an ignore with a reason and an
 *    expiry. An ignore with no expiry never lapses: `public_exposure` (admin).
 *
 * Nothing here is billed per resource (the plan is the organization's), so no type has a cost.
 * Findings (severity counts, fixable count) feed the Hub vulnerability tab as source `snyk`:
 * `snykFindingsFor` (findings.ts) and `readSnykFindings` below.
 */

const INTEGRATION = 'snyk.integration'
const TARGET = 'snyk.target'
const PROJECT = 'snyk.project'
const IGNORE = 'snyk.ignore'
const PAGES = 10
const PAGE = 100
const FIXABLE_PROJECT_CAP = 100
const IMPORT_POLLS = 8
const IMPORT_WAIT_MS = 1500

type Obj = Record<string, unknown>

const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const count = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>
): OpResult => ({ ok: true, externalId, observed, ...(answer ? { answer } : {}) })

function alreadyExists(what: string): ProviderError {
  return new ProviderError('ALREADY_EXISTS', `${what} at Snyk. Adopt it instead of creating it.`, {
    retryable: false
  })
}

function invalid(message: string): ProviderError {
  return new ProviderError('INVALID_FIELDS', message)
}

const orgPath = (ctx: ProviderContext) => uuidSeg(orgOf(ctx.config), 'organization')

function sleep(ctx: ProviderContext, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ctx.signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    ctx.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })
}

/** "2027-01-01" or any ISO time → one ISO form; empty = null (never expires). */
export function normExpires(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return null
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? t : d.toISOString()
}

// ── Observed mappers ──

function integrationObserved(type: string, id: string): Observed {
  return {
    type: INTEGRATION,
    externalId: id,
    name: type,
    fields: { type },
    tags: {},
    version: null,
    status: null,
    url: null
  }
}

function targetObserved(t: any): Observed {
  const a = asObj(t?.attributes)
  const rel = asObj(asObj(asObj(t?.relationships).integration).data)
  const integrationType = str(asObj(rel.attributes).integration_type) ?? ''
  const display = str(a.display_name)
  return {
    type: TARGET,
    externalId: String(t?.id),
    name: display,
    fields: {
      display_name: display,
      integration: str(rel.id),
      // A GitHub target's display name is the repository's full name, which is its provider id.
      github_repository: /^github/.test(integrationType) ? display : null,
      repository_path: display
    },
    tags: {},
    version: null,
    status: null,
    url: null
  }
}

function settingsOut(raw: unknown): { pr_checks: boolean | null; pr_fail_on: string | null } {
  const s = asObj(raw)
  if (!Object.keys(s).length) return { pr_checks: null, pr_fail_on: null }
  return {
    pr_checks: typeof s.pullRequestTestEnabled === 'boolean' ? s.pullRequestTestEnabled : null,
    pr_fail_on: s.pullRequestFailOnlyForHighSeverity === true ? 'high' : 'any'
  }
}

function projectObserved(p: any, settings: unknown, fixable: number | null): Observed {
  const c = asObj(p?.issueCountsBySeverity)
  const s = settingsOut(settings)
  const monitored = p?.isMonitored !== false
  return {
    type: PROJECT,
    externalId: String(p?.id),
    name: str(p?.name),
    fields: {
      name: str(p?.name),
      project_type: str(p?.type),
      monitored,
      pr_checks: s.pr_checks,
      pr_fail_on: s.pr_fail_on,
      critical: count(c.critical),
      high: count(c.high),
      medium: count(c.medium),
      low: count(c.low),
      fixable
    },
    tags: {},
    version: null,
    status: monitored ? 'monitored' : 'not monitored',
    url: null
  }
}

function ignoreObserved(projectId: string, issueId: string, entry: unknown): Observed | null {
  const first = asObj(arr(entry)[0])
  const path = Object.keys(first)[0]
  if (path === undefined) return null
  const d = asObj(first[path])
  return {
    type: IGNORE,
    externalId: `${projectId}/${issueId}`,
    name: issueId,
    fields: {
      project: projectId,
      issue_id: issueId,
      reason: str(d.reason) ?? '',
      reason_type: str(d.reasonType),
      expires: normExpires(d.expires),
      path,
      disregard_if_fixable: d.disregardIfFixable === true
    },
    tags: {},
    version: null,
    status: null,
    url: null
  }
}

// ── Reads ──

async function readIntegrations(ctx: ProviderContext): Promise<Array<[string, string]>> {
  const r = await snykCall(ctx, 'v1', 'GET', `/org/${orgPath(ctx)}/integrations`)
  return Object.entries(asObj(r.body))
    .filter(([, id]) => typeof id === 'string' && isUuid(id))
    .map(([type, id]) => [type, id as string])
}

async function readTargetsPage(
  ctx: ProviderContext,
  cursor: string | null
): Promise<{ items: Observed[]; next: string | null }> {
  const r = await snykCall(ctx, 'rest', 'GET', `/orgs/${orgPath(ctx)}/targets`, {
    query: { limit: PAGE, starting_after: cursor ?? undefined }
  })
  return { items: arr(r.body?.data).map(targetObserved), next: nextRestCursor(r.body) }
}

async function readTarget(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const r = await snykCall(ctx, 'rest', 'GET', `/orgs/${orgPath(ctx)}/targets/${uuidSeg(id)}`, {
    allow: [404]
  })
  return r.status === 404 ? null : targetObserved(r.body?.data)
}

async function findTargetByPath(ctx: ProviderContext, path: string): Promise<Observed | null> {
  let cursor: string | null = null
  for (let i = 0; i < PAGES; i++) {
    const page = await readTargetsPage(ctx, cursor)
    const hit = page.items.find((t) => (t.name ?? '').toLowerCase() === path.toLowerCase())
    if (hit) return hit
    cursor = page.next
    if (!cursor) break
  }
  return null
}

/** Fixable = open issues Snyk can fix by an upgrade, a patch or a pin; null = not readable. */
export async function readSnykFixable(
  ctx: ProviderContext,
  projectId: string
): Promise<number | null> {
  const r = await snykCall(
    ctx,
    'v1',
    'POST',
    `/org/${orgPath(ctx)}/project/${uuidSeg(projectId, 'project id')}/aggregated-issues`,
    {
      body: {
        includeDescription: false,
        includeIntroducedThrough: false,
        filters: { ignored: false }
      },
      allow: [403, 404]
    }
  )
  if (r.status !== 200) return null
  let n = 0
  for (const raw of arr(asObj(r.body).issues)) {
    const i = asObj(raw)
    const fix = asObj(i.fixInfo)
    if (i.isIgnored === true || i.isPatched === true) continue
    if (fix.isUpgradable === true || fix.isPatchable === true || fix.isPinnable === true) n += 1
  }
  return n
}

async function readProject(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const pid = uuidSeg(id, 'project id')
  const r = await snykCall(ctx, 'v1', 'GET', `/org/${orgPath(ctx)}/project/${pid}`, {
    allow: [404]
  })
  if (r.status === 404) return null
  const settings = await snykCall(
    ctx,
    'v1',
    'GET',
    `/org/${orgPath(ctx)}/project/${pid}/settings`,
    {
      allow: [403, 404]
    }
  )
  const fixable = await readSnykFixable(ctx, pid)
  return projectObserved(r.body, settings.status === 200 ? settings.body : null, fixable)
}

async function listProjects(ctx: ProviderContext): Promise<Observed[]> {
  const r = await snykCall(ctx, 'v1', 'POST', `/org/${orgPath(ctx)}/projects`, { body: {} })
  return arr(asObj(r.body).projects).map((p) => projectObserved(p, null, null))
}

function splitIgnoreId(externalId: string): [string, string] {
  const i = externalId.indexOf('/')
  if (i < 1 || i === externalId.length - 1)
    throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return [uuidSeg(externalId.slice(0, i), 'project id'), externalId.slice(i + 1)]
}

async function readIgnoreMap(ctx: ProviderContext, projectId: string): Promise<Obj | null> {
  const r = await snykCall(
    ctx,
    'v1',
    'GET',
    `/org/${orgPath(ctx)}/project/${uuidSeg(projectId, 'project id')}/ignores`,
    { allow: [404] }
  )
  return r.status === 404 ? null : asObj(r.body)
}

async function readIgnore(ctx: ProviderContext, externalId: string): Promise<Observed | null> {
  const [projectId, issueId] = splitIgnoreId(externalId)
  issueSeg(issueId)
  const map = await readIgnoreMap(ctx, projectId)
  return map && map[issueId] !== undefined ? ignoreObserved(projectId, issueId, map[issueId]) : null
}

/** Everything of Snyk's answer the vulnerability tab needs, per connection (see findings.ts). */
export async function readSnykFindings(ctx: ProviderContext): Promise<SnykFindings> {
  return (await readSnykProjectFindings(ctx)).totals
}

/** One project's row of the Hub vulnerability tab (Task 43): counts only, never issue text. */
export interface SnykProjectFindings {
  id: string
  name: string | null
  project_type: string | null
  monitored: boolean
  critical: number
  high: number
  medium: number
  low: number
  fixable: number | null
}

/** The totals (readSnykFindings) and the per-project rows they are made of, in one read. */
export async function readSnykProjectFindings(
  ctx: ProviderContext
): Promise<{ totals: SnykFindings; projects: SnykProjectFindings[] }> {
  const projects = await listProjects(ctx)
  let read = 0
  for (const p of projects) {
    const hasIssues = ['critical', 'high', 'medium', 'low'].some((k) => count(p.fields[k]) > 0)
    if (p.fields.monitored === false || !hasIssues) {
      p.fields.fixable = hasIssues ? null : 0
      continue
    }
    if (read >= FIXABLE_PROJECT_CAP) continue
    read += 1
    p.fields.fixable = await readSnykFixable(ctx, p.externalId)
  }
  return {
    totals: snykFindingsFor(projects),
    projects: projects.map((p) => ({
      id: p.externalId,
      name: str(p.fields.name),
      project_type: str(p.fields.project_type),
      monitored: p.fields.monitored !== false,
      critical: count(p.fields.critical),
      high: count(p.fields.high),
      medium: count(p.fields.medium),
      low: count(p.fields.low),
      fixable:
        p.fields.fixable === null || p.fields.fixable === undefined ? null : count(p.fields.fixable)
    }))
  }
}

// ── Plan ──

const TARGET_CREATE_KEYS = ['integration', 'github_repository', 'gitlab_project', 'branch']
const PROJECT_KEYS = ['monitored', 'pr_checks', 'pr_fail_on']
const IGNORE_KEYS = ['reason', 'reason_type', 'expires', 'disregard_if_fixable']

function same(a: unknown, b: unknown): boolean {
  const x = a === '' || a === undefined ? null : a
  const y = b === '' || b === undefined ? null : b
  return x === y
}

function diff(keys: string[], want: Obj, have: Obj): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    // A setting Snyk would not show (no access to the project's settings) is not compared.
    if (have[k] === null && (k === 'pr_checks' || k === 'pr_fail_on')) continue
    if (!same(want[k], have[k]))
      out.push({ field: k, from: have[k] ?? null, to: want[k] === '' ? null : want[k] })
  }
  return out
}

function wantOf(desired: DesiredResource): Obj {
  const f = { ...desired.fields }
  if (f.expires !== undefined) f.expires = normExpires(f.expires)
  return f
}

function op(
  kind: PlannedOp['kind'],
  type: string,
  resourceId: number | null,
  externalId: string | null,
  reason: string,
  changes: FieldChange[],
  preconditions: Record<string, unknown> = {}
): PlannedOp {
  return { kind, type, resourceId, externalId, reason, changes, preconditions, risk: [] }
}

function repoSide(fields: Obj): 'github' | 'gitlab' | null {
  const gh = fields.github_repository != null && fields.github_repository !== ''
  const gl = fields.gitlab_project != null && fields.gitlab_project !== ''
  if (gh === gl) return null
  return gh ? 'github' : 'gitlab'
}

function planTarget(
  desired: DesiredResource | null,
  observed: Observed | null,
  spec: ResourceTypeSpec
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      op(
        'delete',
        TARGET,
        null,
        observed.externalId,
        `Stop monitoring ${typedName(spec.label, observed.name)}: Snyk removes the target and its projects`,
        [],
        { display_name: observed.name }
      )
    ]
  }
  if (observed) return []
  const side = repoSide(desired.fields)
  if (!side) throw invalid('Name exactly one repository: a GitHub repository or a GitLab project.')
  if (side === 'gitlab' && !String(desired.fields.repository_path ?? '').trim())
    throw invalid('A GitLab project needs its path (group/project) too: Snyk lists it by path.')
  return [
    op(
      'create',
      TARGET,
      desired.resourceId,
      null,
      `Import ${side === 'github' ? 'the GitHub repository' : 'the GitLab project'} into Snyk (${fieldWords(
        spec.fields,
        TARGET_CREATE_KEYS.filter((k) => desired.fields[k] != null && desired.fields[k] !== '')
      )})`,
      TARGET_CREATE_KEYS.filter((k) => desired.fields[k] != null && desired.fields[k] !== '').map(
        (k) => ({ field: k, to: desired.fields[k] })
      )
    )
  ]
}

function planProject(
  desired: DesiredResource | null,
  observed: Observed | null,
  spec: ResourceTypeSpec
): PlannedOp[] {
  if (!desired)
    throw new ProviderError('CANNOT_DELETE', 'A Snyk project goes away when its target is deleted.')
  if (!observed)
    throw new ProviderError('CANNOT_CREATE', 'A Snyk project appears when its target is imported.')
  const changes = diff(PROJECT_KEYS, wantOf(desired), observed.fields)
  if (!changes.length) return []
  return [
    op(
      'update',
      PROJECT,
      desired.resourceId,
      observed.externalId,
      `Change ${fieldWords(spec.fields, changes)} of ${typedName(spec.label, observed.name)}`,
      changes,
      Object.fromEntries(changes.map((c) => [c.field, c.from]))
    )
  ]
}

function planIgnore(
  desired: DesiredResource | null,
  observed: Observed | null,
  spec: ResourceTypeSpec
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      op(
        'delete',
        IGNORE,
        null,
        observed.externalId,
        `Remove ${typedName(spec.label, String(observed.fields.issue_id ?? ''))}: the issue counts again`,
        [],
        { reason: observed.fields.reason, expires: observed.fields.expires }
      )
    ]
  }
  const want = wantOf(desired)
  if (!observed) {
    const keys = [
      'project',
      'issue_id',
      'reason',
      'reason_type',
      'expires',
      'path',
      'disregard_if_fixable'
    ]
    return [
      op(
        'create',
        IGNORE,
        desired.resourceId,
        null,
        `Ignore ${String(desired.fields.issue_id ?? 'an issue')} in Snyk${want.expires ? ` until ${String(want.expires).slice(0, 10)}` : ' with no expiry'}`,
        keys
          .filter((k) => want[k] !== undefined)
          .map((k) => ({ field: k, to: want[k] === '' ? null : want[k] }))
      )
    ]
  }
  const changes = diff(IGNORE_KEYS, want, observed.fields)
  if (!changes.length) return []
  return [
    op(
      'update',
      IGNORE,
      desired.resourceId,
      observed.externalId,
      `Change ${fieldWords(spec.fields, changes)} of the ignore for ${String(observed.fields.issue_id ?? '')}`,
      changes,
      Object.fromEntries(changes.map((c) => [c.field, c.from]))
    )
  ]
}

// ── Apply ──

function importBody(
  side: 'github' | 'gitlab',
  repo: string,
  gitlabId: string | null,
  branch: string | null
) {
  if (side === 'github') {
    const [owner, name] = repo.split('/')
    return {
      target: {
        owner: repoPart(owner, 'repository owner'),
        name: repoPart(name, 'repository name'),
        ...(branch ? { branch } : {})
      }
    }
  }
  return { target: { id: Number(gitlabId), ...(branch ? { branch } : {}) } }
}

const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/

async function applyTargetCreate(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<OpResult> {
  const side = repoSide(desired.fields)
  if (!side) throw invalid('Name exactly one repository: a GitHub repository or a GitLab project.')
  const integrationId = desired.refs?.integration
  if (typeof integrationId !== 'string' || !isUuid(integrationId))
    throw invalid('The Snyk integration this target uses is not created yet.')
  const found = (await readIntegrations(ctx)).find(([, id]) => id === integrationId.toLowerCase())
  if (!found) throw invalid('That integration is not in this Snyk organization.')
  const integrationType = found[0]
  const ref = desired.refs?.[side === 'github' ? 'github_repository' : 'gitlab_project']
  if (typeof ref !== 'string' || !ref)
    throw invalid('The repository this target imports is not created yet.')
  let path: string
  let gitlabId: string | null = null
  if (side === 'github') {
    if (!/^github/.test(integrationType))
      throw invalid('A GitHub repository needs a GitHub integration.')
    path = ref
    if (!PATH_RE.test(path) || path.split('/').length !== 2)
      throw invalid('The GitHub repository name is not owner/name.')
  } else {
    if (integrationType !== 'gitlab') throw invalid('A GitLab project needs a GitLab integration.')
    if (!/^\d{1,18}$/.test(ref)) throw invalid('The GitLab project id is not a number.')
    gitlabId = ref
    path = String(desired.fields.repository_path ?? '').trim()
    if (!PATH_RE.test(path)) throw invalid('The GitLab project path is not group/project.')
  }
  const existing = await findTargetByPath(ctx, path)
  if (existing) {
    if (desired.externalId === existing.externalId)
      return ok(existing.externalId, existing, { already: 'exists' })
    throw alreadyExists(`${path} is already imported`)
  }
  const branch = str(desired.fields.branch)
  if (branch && !/^[A-Za-z0-9._/-]{1,200}$/.test(branch))
    throw invalid('That branch name is not valid.')
  const started = await snykCall(
    ctx,
    'v1',
    'POST',
    `/org/${orgPath(ctx)}/integrations/${uuidSeg(integrationId, 'integration id')}/import`,
    { body: importBody(side, path, gitlabId, branch) }
  )
  const loc = started.headers.get('location') ?? ''
  const jobId = isUuid(asObj(started.body).id)
    ? String(asObj(started.body).id)
    : (loc.split('/').filter(Boolean).pop() ?? '')
  uuidSeg(jobId, 'import job id')
  for (let i = 0; i < IMPORT_POLLS; i++) {
    const job = await snykCall(
      ctx,
      'v1',
      'GET',
      `/org/${orgPath(ctx)}/integrations/${uuidSeg(integrationId)}/import/${uuidSeg(jobId)}`
    )
    const status = String(asObj(job.body).status ?? '')
    if (status === 'failed' || status === 'aborted')
      throw new ProviderError('IMPORT_FAILED', `Snyk could not import ${path} (${status}).`)
    if (status === 'complete') {
      const made = await findTargetByPath(ctx, path)
      if (made) return ok(made.externalId, made, { import_job: jobId })
      break
    }
    await sleep(ctx, IMPORT_WAIT_MS)
  }
  throw new ProviderError(
    'IMPORT_PENDING',
    `Snyk is still importing ${path}. Check the target in a minute; adopt it if it appears.`,
    { retryable: true }
  )
}

async function applyProject(ctx: ProviderContext, o: PlannedOp, desired: DesiredResource | null) {
  if (!desired) throw invalid('Nothing to write.')
  const id = uuidSeg(o.externalId, 'project id')
  const have = await readProject(ctx, id)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The Snyk project no longer exists.', { status: 404 })
  const want = wantOf(desired)
  const changes = diff(PROJECT_KEYS, want, have.fields)
  if (!changes.length) return ok(id, have, { already: 'matches' })
  const base = `/org/${orgPath(ctx)}/project/${id}`
  if (want.monitored !== undefined && want.monitored !== have.fields.monitored)
    await snykCall(ctx, 'v1', 'POST', `${base}/${want.monitored ? 'activate' : 'deactivate'}`, {
      body: {}
    })
  const settings: Obj = {}
  if (want.pr_checks !== undefined && want.pr_checks !== have.fields.pr_checks)
    settings.pullRequestTestEnabled = want.pr_checks === true
  if (want.pr_fail_on !== undefined && want.pr_fail_on !== have.fields.pr_fail_on) {
    settings.pullRequestFailOnAnyVulns = want.pr_fail_on === 'any'
    settings.pullRequestFailOnlyForHighSeverity = want.pr_fail_on === 'high'
  }
  if (Object.keys(settings).length)
    await snykCall(ctx, 'v1', 'PUT', `${base}/settings`, { body: settings })
  return ok(id, await readProject(ctx, id))
}

function ignoreBody(f: Obj) {
  const expires = normExpires(f.expires)
  return {
    ignorePath: str(f.path) ?? '*',
    reasonType: str(f.reason_type) ?? 'temporary-ignore',
    disregardIfFixable: f.disregard_if_fixable === true,
    reason: String(f.reason ?? ''),
    ...(expires ? { expires } : {})
  }
}

async function applyIgnore(ctx: ProviderContext, o: PlannedOp, desired: DesiredResource | null) {
  if (o.kind === 'delete') {
    const [pid, issue] = splitIgnoreId(String(o.externalId))
    const have = await readIgnore(ctx, String(o.externalId))
    if (!have) return ok(o.externalId, null, { already: 'gone' })
    await snykCall(
      ctx,
      'v1',
      'DELETE',
      `/org/${orgPath(ctx)}/project/${pid}/ignore/${issueSeg(issue)}`,
      { allow: [404] }
    )
    return ok(o.externalId, null)
  }
  if (!desired) throw invalid('Nothing to write.')
  const want = wantOf(desired)
  const expires = normExpires(want.expires)
  if (expires && new Date(expires).getTime() <= ctx.now().getTime())
    throw invalid('The expiry of an ignore must be in the future.')
  if (o.kind === 'create') {
    const pid = desired.refs?.project
    if (typeof pid !== 'string' || !pid)
      throw invalid('The project this ignore belongs to is not created yet.')
    const issue = String(want.issue_id ?? '')
    const id = `${uuidSeg(pid, 'project id')}/${issue}`
    const found = await readIgnore(ctx, id)
    if (found) {
      if (desired.externalId === id) return ok(id, found, { already: 'exists' })
      throw alreadyExists(`An ignore for ${issue} already exists`)
    }
    await snykCall(
      ctx,
      'v1',
      'POST',
      `/org/${orgPath(ctx)}/project/${uuidSeg(pid)}/ignore/${issueSeg(issue)}`,
      { body: ignoreBody(want) }
    )
    return ok(id, await readIgnore(ctx, id))
  }
  const externalId = String(o.externalId)
  const [pid, issue] = splitIgnoreId(externalId)
  const have = await readIgnore(ctx, externalId)
  if (!have) throw new ProviderError('NOT_FOUND', 'The ignore no longer exists.', { status: 404 })
  if (!diff(IGNORE_KEYS, want, have.fields).length)
    return ok(externalId, have, { already: 'matches' })
  await snykCall(
    ctx,
    'v1',
    'PUT',
    `/org/${orgPath(ctx)}/project/${pid}/ignore/${issueSeg(issue)}`,
    {
      body: [ignoreBody({ ...have.fields, ...want })]
    }
  )
  return ok(externalId, await readIgnore(ctx, externalId))
}

// ── Specs ──

const READ_ONLY = { readOnly: true } as const

const INTEGRATION_FIELDS: FieldSpec[] = [
  { key: 'type', label: 'Integration', kind: 'string', ...READ_ONLY }
]

const TARGET_FIELDS: FieldSpec[] = [
  {
    key: 'integration',
    label: 'Snyk integration',
    kind: 'ref',
    refType: INTEGRATION,
    required: true,
    createOnly: true
  },
  {
    key: 'github_repository',
    label: 'GitHub repository',
    kind: 'ref',
    refType: 'github.repository',
    createOnly: true,
    help: 'Name this or a GitLab project, not both.'
  },
  {
    key: 'gitlab_project',
    label: 'GitLab project',
    kind: 'ref',
    refType: 'gitlab.project',
    createOnly: true
  },
  {
    key: 'repository_path',
    label: 'Repository path',
    kind: 'string',
    createOnly: true,
    help: 'group/project: required for a GitLab project (Snyk lists it by path).'
  },
  {
    key: 'branch',
    label: 'Branch',
    kind: 'string',
    createOnly: true,
    help: 'Empty = the default branch.'
  },
  { key: 'display_name', label: 'Name at Snyk', kind: 'string', ...READ_ONLY }
]

const PROJECT_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'string', ...READ_ONLY },
  { key: 'project_type', label: 'Kind', kind: 'string', ...READ_ONLY },
  {
    key: 'monitored',
    label: 'Monitoring',
    kind: 'boolean',
    default: true,
    help: 'Off = Snyk stops testing the project (weakens protection).'
  },
  {
    key: 'pr_checks',
    label: 'Pull request checks',
    kind: 'boolean',
    help: 'Off = pull requests are no longer tested.'
  },
  {
    key: 'pr_fail_on',
    label: 'Fail pull requests on',
    kind: 'enum',
    options: [
      { value: 'any', label: 'Any vulnerability' },
      { value: 'high', label: 'High severity only' }
    ],
    help: 'High severity only lowers the threshold.'
  },
  { key: 'critical', label: 'Critical issues', kind: 'number', ...READ_ONLY },
  { key: 'high', label: 'High issues', kind: 'number', ...READ_ONLY },
  { key: 'medium', label: 'Medium issues', kind: 'number', ...READ_ONLY },
  { key: 'low', label: 'Low issues', kind: 'number', ...READ_ONLY },
  { key: 'fixable', label: 'Fixable issues', kind: 'number', ...READ_ONLY }
]

const IGNORE_FIELDS: FieldSpec[] = [
  {
    key: 'project',
    label: 'Snyk project',
    kind: 'ref',
    refType: PROJECT,
    required: true,
    createOnly: true
  },
  {
    key: 'issue_id',
    label: 'Issue id',
    kind: 'string',
    required: true,
    createOnly: true,
    pattern: '^[A-Za-z0-9:._-]{1,200}$',
    help: 'For example SNYK-JS-LODASH-1234.'
  },
  { key: 'reason', label: 'Reason', kind: 'string', required: true, max: 200 },
  {
    key: 'reason_type',
    label: 'Reason kind',
    kind: 'enum',
    default: 'temporary-ignore',
    options: [
      { value: 'temporary-ignore', label: 'Temporary ignore' },
      { value: 'wont-fix', label: 'Will not fix' },
      { value: 'not-vulnerable', label: 'Not vulnerable' }
    ]
  },
  {
    key: 'expires',
    label: 'Expires on',
    kind: 'string',
    help: 'A date (2027-01-31). Empty = never: that needs an administrator.'
  },
  {
    key: 'path',
    label: 'Path',
    kind: 'string',
    default: '*',
    createOnly: true,
    help: '* = every path.'
  },
  {
    key: 'disregard_if_fixable',
    label: 'Stop ignoring when a fix exists',
    kind: 'boolean',
    default: false
  }
]

const WEAKENING: Array<{ field: string; weak: (to: unknown) => boolean }> = [
  { field: 'monitored', weak: (to) => to === false },
  { field: 'pr_checks', weak: (to) => to === false },
  { field: 'pr_fail_on', weak: (to) => to === 'high' }
]

const noRisk = (): RiskFlag[] => []

const caps = (c: Partial<ResourceTypeSpec['capabilities']>): ResourceTypeSpec['capabilities'] => ({
  create: false,
  update: false,
  delete: false,
  adopt: false,
  snapshot: false,
  tag: false,
  ...c
})

const TYPES: ResourceTypeSpec[] = [
  {
    key: INTEGRATION,
    label: 'Snyk integration',
    scope: 'shared',
    fields: INTEGRATION_FIELDS,
    capabilities: caps({ adopt: true }),
    reversible: false,
    refs: [],
    risk: noRisk
  },
  {
    key: TARGET,
    label: 'Snyk target',
    scope: 'app',
    fields: TARGET_FIELDS,
    capabilities: caps({ create: true, delete: true, adopt: true }),
    reversible: false,
    refs: [
      { field: 'integration', type: INTEGRATION },
      { field: 'github_repository', type: 'github.repository', required: false },
      { field: 'gitlab_project', type: 'gitlab.project', required: false }
    ],
    nameField: 'display_name',
    // Deleting a target stops monitoring and removes its projects: admin only.
    risk: (o) => (o.kind === 'delete' ? ['destructive', 'public_exposure'] : [])
  },
  {
    key: PROJECT,
    label: 'Snyk project',
    scope: 'app',
    fields: PROJECT_FIELDS,
    capabilities: caps({ update: true, adopt: true }),
    reversible: true,
    refs: [],
    nameField: 'name',
    // Judged on what is SENT: monitoring off, pull request checks off, a lower failing severity.
    risk: (o) =>
      o.kind !== 'noop' &&
      o.changes.some((c) => WEAKENING.some((w) => w.field === c.field && w.weak(c.to)))
        ? ['public_exposure']
        : []
  },
  {
    key: IGNORE,
    label: 'Snyk ignore',
    scope: 'app',
    fields: IGNORE_FIELDS,
    capabilities: caps({ create: true, update: true, delete: true, adopt: true }),
    reversible: true,
    refs: [{ field: 'project', type: PROJECT }],
    nameField: 'issue_id',
    // An ignore with no expiry never lapses: an administrator decides.
    risk: (o, desired) =>
      o.kind === 'delete' || o.kind === 'noop' || !desired || normExpires(desired.fields.expires)
        ? []
        : ['public_exposure']
  }
]

const BY_KEY = new Map(TYPES.map((t) => [t.key, t]))
const specOf = (type: string): ResourceTypeSpec => {
  const s = BY_KEY.get(type)
  if (!s) throw new ProviderError('UNKNOWN_TYPE', `Snyk has no ${type}.`)
  return s
}

// ── Permissions ──

const NEEDS = [
  { type: INTEGRATION, need: 'read snyk.integration (view the organization’s integrations)' },
  { type: PROJECT, need: 'read snyk.project (view projects)' },
  { type: TARGET, need: 'read snyk.target (view targets)' },
  { type: TARGET, need: 'write snyk.target (import and remove repositories)', write: true },
  { type: PROJECT, need: 'write snyk.project (edit project settings)', write: true },
  { type: IGNORE, need: 'write snyk.ignore (create and remove ignores)', write: true }
]

// ── The adapter ──

export const snykAdapter: ProviderAdapter = {
  key: 'snyk',
  label: 'Snyk',
  connection: {
    fields: [
      {
        key: 'host',
        label: 'Region',
        kind: 'enum',
        default: 'api.snyk.io',
        required: true,
        options: [
          { value: 'api.snyk.io', label: 'US (api.snyk.io)' },
          { value: 'api.eu.snyk.io', label: 'EU (api.eu.snyk.io)' },
          { value: 'api.au.snyk.io', label: 'Australia (api.au.snyk.io)' }
        ]
      },
      {
        key: 'organization',
        label: 'Organization id',
        kind: 'string',
        required: true,
        help: 'The uuid from Snyk → Settings → General. Pinned: every call is scoped to it.'
      },
      {
        key: 'token',
        label: 'API token',
        kind: 'string',
        secret: true,
        required: true,
        help: 'A service account token is preferred over a personal one.'
      }
    ],
    hosts: (config) => [hostOf(config)],
    describe: (config) => `Snyk ${orgOf(config)} on ${hostOf(config)}`,
    validate(config, secrets) {
      const problems: string[] = []
      const h = String(config.host ?? '')
        .trim()
        .toLowerCase()
      if (h && !SNYK_HOSTS.includes(h))
        problems.push('The region is api.snyk.io, api.eu.snyk.io or api.au.snyk.io.')
      if (!isUuid(orgOf(config))) problems.push('The organization id is a uuid.')
      if (secrets.token !== undefined && !secrets.token.trim())
        problems.push('The API token is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const all = (has: (n: (typeof NEEDS)[number]) => boolean) =>
      NEEDS.map((n) => ({ type: n.type, need: n.need, has: has(n) }))
    const fail = (message: string): ConnectionTest => {
      const p = all(() => false)
      return { ok: false, identity: null, permissions: p, missing: p.map((x) => x.need), message }
    }
    let name: string | null = null
    try {
      const r = await snykCall(ctx, 'rest', 'GET', `/orgs/${orgPath(ctx)}`, { allow: [403, 404] })
      if (r.status !== 200)
        return fail('The token cannot see this organization (check the id and the token).')
      name = str(asObj(asObj(r.body?.data).attributes).name)
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    const probe = async (run: () => Promise<unknown>): Promise<boolean> => {
      try {
        await run()
        return true
      } catch (err) {
        if (err instanceof ProviderError) return false
        throw err
      }
    }
    const canIntegrations = await probe(() => readIntegrations(ctx))
    const canProjects = await probe(() => listProjects(ctx))
    const canTargets = await probe(() => readTargetsPage(ctx, null))
    const reads: Record<string, boolean> = {
      [INTEGRATION]: canIntegrations,
      [PROJECT]: canProjects,
      [IGNORE]: canProjects,
      [TARGET]: canTargets
    }
    // Snyk lists no rights for a token and a write cannot be tried without changing something:
    // a token that reads is assumed able to write (a read-only role fails at its first change).
    const p = all((n) => reads[n.type] === true)
    return {
      ok: p.some((x) => x.has),
      identity: `Snyk organization ${name ?? orgOf(ctx.config)}`,
      permissions: p,
      missing: p.filter((x) => !x.has).map((x) => x.need),
      message: 'Write rights cannot be checked without changing something at Snyk.'
    }
  },

  async observe(ctx, type, externalId) {
    specOf(type)
    if (type === INTEGRATION) {
      const hit = (await readIntegrations(ctx)).find(([, id]) => id === externalId.toLowerCase())
      return hit ? integrationObserved(hit[0], hit[1]) : null
    }
    if (type === TARGET) return readTarget(ctx, externalId)
    if (type === PROJECT) return readProject(ctx, externalId)
    return readIgnore(ctx, externalId)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    specOf(type)
    if (type === INTEGRATION)
      return {
        items: (await readIntegrations(ctx)).map(([t, id]) => integrationObserved(t, id)),
        cursor: null
      }
    if (type === TARGET) {
      const page = await readTargetsPage(ctx, cursor ?? null)
      return { items: page.items, cursor: page.next }
    }
    const projects = await listProjects(ctx)
    if (type === PROJECT) return { items: projects, cursor: null }
    const items: Observed[] = []
    for (const p of projects.slice(0, 200)) {
      const map = await readIgnoreMap(ctx, p.externalId)
      for (const [issue, entry] of Object.entries(map ?? {})) {
        if (!/^[A-Za-z0-9:._-]{1,200}$/.test(issue)) continue
        const o = ignoreObserved(p.externalId, issue, entry)
        if (o) items.push(o)
      }
    }
    return { items, cursor: null }
  },

  /** Plan time: a target already imported for that repository, an ignore already on that issue. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    if (type === TARGET) {
      const side = repoSide(desired.fields)
      const ref = desired.refs?.[side === 'github' ? 'github_repository' : 'gitlab_project']
      const path = side === 'github' ? ref : String(desired.fields.repository_path ?? '').trim()
      if (typeof path !== 'string' || !PATH_RE.test(path)) return null
      return findTargetByPath(ctx, path)
    }
    if (type === IGNORE) {
      const pid = desired.refs?.project
      const issue = String(desired.fields.issue_id ?? '')
      if (typeof pid !== 'string' || !isUuid(pid) || !/^[A-Za-z0-9:._-]{1,200}$/.test(issue))
        return null
      return readIgnore(ctx, `${pid}/${issue}`)
    }
    return null
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (!type) return []
    const spec = specOf(type)
    if (type === TARGET) return planTarget(desired, observed, spec)
    if (type === PROJECT) return planProject(desired, observed, spec)
    if (type === IGNORE) return planIgnore(desired, observed, spec)
    if (desired && !observed)
      throw new ProviderError('CANNOT_CREATE', 'Snyk integrations are made in Snyk; adopt one.')
    if (!desired)
      throw new ProviderError('CANNOT_DELETE', 'The Hub never removes a Snyk integration.')
    return []
  },

  async apply(ctx, o, desired) {
    if (o.kind === 'noop') return ok(o.externalId, null)
    if (o.type === TARGET) {
      if (o.kind === 'delete') {
        const id = uuidSeg(o.externalId, 'target id')
        const have = await readTarget(ctx, id)
        if (!have) return ok(id, null, { already: 'gone' })
        await snykCall(ctx, 'rest', 'DELETE', `/orgs/${orgPath(ctx)}/targets/${id}`, {
          allow: [404]
        })
        return ok(id, null)
      }
      if (o.kind !== 'create' || !desired)
        throw invalid('A Snyk target is imported or deleted, never changed.')
      return applyTargetCreate(ctx, desired)
    }
    if (o.type === PROJECT) return applyProject(ctx, o, desired)
    if (o.type === IGNORE) return applyIgnore(ctx, o, desired)
    throw new ProviderError('UNKNOWN_TYPE', `Snyk has no ${o.type} to change.`)
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Snyk.', checkedAt }
    if (type === PROJECT) {
      const f = seen.fields
      const details = {
        critical: count(f.critical),
        high: count(f.high),
        medium: count(f.medium),
        low: count(f.low),
        ...(f.fixable === null || f.fixable === undefined ? {} : { fixable: count(f.fixable) })
      }
      if (f.monitored === false)
        return {
          status: 'warn',
          message: 'Snyk is not monitoring this project.',
          checkedAt,
          details
        }
      const bad = details.critical + details.high
      return {
        status: bad > 0 ? 'warn' : 'ok',
        message:
          bad > 0
            ? `${details.critical} critical and ${details.high} high issues.`
            : 'No critical or high issues.',
        checkedAt,
        details
      }
    }
    if (type === IGNORE && !seen.fields.expires)
      return { status: 'warn', message: 'This ignore never expires.', checkedAt }
    return { status: 'ok', checkedAt }
  }
}
