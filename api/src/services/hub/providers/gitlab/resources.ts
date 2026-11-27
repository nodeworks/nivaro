import {
  type DesiredResource,
  type FieldChange,
  type ListPage,
  type Observed,
  type ProviderContext,
  ProviderError,
  type SecretValue
} from '../types.js'
import {
  branchSeg,
  envNameSeg,
  type GlAnswer,
  glCall,
  idSeg,
  keySeg,
  outOfAccount,
  pathSeg,
  pinOf,
  withinPin
} from './client.js'
import { T, WEBHOOK_EVENTS } from './specs.js'

/**
 * One handler per GitLab resource type: read (by id, gated to the pinned group), list, create,
 * update, remove (and rotate for the once-only credentials). Plans are in plan.ts, the adapter
 * in index.ts. Nothing here puts a secret value in an Observed.
 *
 * Pinned group: every read by id checks the project / group / runner is inside the connection's
 * group (`strict` = throw GITLAB_OUT_OF_ACCOUNT, else answer null); children are judged through
 * their parent project or group.
 */

// ── Small helpers ──

export const norm = (v: unknown): unknown => (v === '' || v === undefined ? null : v)

export function sameValue(a: unknown, b: unknown): boolean {
  const x = norm(a)
  const y = norm(b)
  if (Array.isArray(x) || Array.isArray(y)) {
    const l = (Array.isArray(x) ? x : []).map(String).sort()
    const r = (Array.isArray(y) ? y : []).map(String).sort()
    return l.length === r.length && l.every((v, i) => v === r[i])
  }
  return x === y
}

export function diffFields(
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

export function isSecret(v: unknown): v is SecretValue {
  return !!v && typeof v === 'object' && 'fingerprint' in (v as object)
}

/** The plain value of a secret field (apply only), or undefined. */
export function plainOf(v: unknown): string | undefined {
  if (isSecret(v)) return v.plain
  return typeof v === 'string' && v ? v : undefined
}

export function plainsOf(desired: DesiredResource | null): string[] {
  const out: string[] = []
  for (const v of Object.values(desired?.fields ?? {})) {
    const p = isSecret(v) ? v.plain : undefined
    if (p) out.push(p)
  }
  return out
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt)
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

const ROLE_LEVEL: Record<string, number> = { no_one: 0, developers: 30, maintainers: 40 }
function levelOf(role: unknown, dflt: string): number {
  const r = typeof role === 'string' && role in ROLE_LEVEL ? role : dflt
  return ROLE_LEVEL[r] as number
}
function roleOf(level: unknown): string | null {
  if (level === 0) return 'no_one'
  if (level === 30) return 'developers'
  if (level === 40) return 'maintainers'
  return level == null ? null : `level_${String(level)}`
}

const refName = (v: unknown): string | null =>
  typeof v === 'string' && v ? v.replace(/^refs\/(heads|tags)\//, '') : null

const normKey = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const parts = v.trim().split(/\s+/)
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : (parts[0] ?? null)
}

export function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} at GitLab and was not created by the Hub. Adopt it instead of creating it.`
  )
}

export function refId(desired: DesiredResource | null, field: string): string {
  const v = desired?.refs?.[field]
  if (typeof v === 'string' && v) return v
  throw new ProviderError(
    'INVALID_FIELDS',
    `The ${field} this change belongs to is not created yet.`
  )
}

/** The ref a project-or-group resource is made on: exactly one of the two. */
export function scopeRef(desired: DesiredResource): { field: 'project' | 'group'; id: string } {
  const p = desired.refs?.project
  const g = desired.refs?.group
  const hasP = typeof p === 'string' && p !== ''
  const hasG = typeof g === 'string' && g !== ''
  if (hasP === hasG)
    throw new ProviderError('INVALID_FIELDS', 'Set a project or a group, not both and not neither.')
  return hasP ? { field: 'project', id: p as string } : { field: 'group', id: g as string }
}

function splitSlash(ext: string): [string, string] {
  const i = ext.indexOf('/')
  if (i < 1) throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return [idSeg(ext.slice(0, i), 'project id'), ext.slice(i + 1)]
}

function splitScoped(ext: string): { kind: 'project' | 'group'; id: string; rest: string } {
  const m = /^(project|group):(\d{1,18}):(.*)$/s.exec(ext)
  if (!m) throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return { kind: m[1] as 'project' | 'group', id: m[2] as string, rest: m[3] as string }
}

// ── Handler contract ──

export interface Created {
  externalId: string
  /** Output values (token…) — sealed by the engine, never stored by the adapter. */
  outputs?: Record<string, string>
}

export interface Handler {
  type: string
  /** The project / group an external id lives in (named ops check it against `desired.refs`). */
  target?(ext: string): { field: 'project' | 'group'; id: string } | null
  observe(ctx: ProviderContext, ext: string, strict?: boolean): Promise<Observed | null>
  list(ctx: ProviderContext, cursor: string | null): Promise<ListPage>
  /** The resource a create would collide with. */
  existing?(ctx: ProviderContext, desired: DesiredResource): Promise<Observed | null>
  create(ctx: ProviderContext, desired: DesiredResource): Promise<Created>
  update(ctx: ProviderContext, ext: string, desired: DesiredResource, have: Observed): Promise<void>
  remove(ctx: ProviderContext, ext: string): Promise<void>
  rotate?(
    ctx: ProviderContext,
    ext: string,
    desired: DesiredResource,
    have: Observed
  ): Promise<Created>
  /** A replace makes the new one first and removes the old one after (credentials). */
  replaceCreateFirst?: boolean
  /** Refuses a replace that cannot be completed, before anything is removed. */
  checkReplace?(desired: DesiredResource): void
  readOutputs?(ctx: ProviderContext, ext: string): Promise<Record<string, string>>
}

// ── Gates ──

async function projectGate(
  ctx: ProviderContext,
  pid: string,
  strict: boolean
): Promise<any | null> {
  const r = await glCall(ctx, 'GET', `/projects/${idSeg(pid, 'project id')}`, { allow: [404] })
  if (r.status === 404) return null
  if (!withinPin(ctx, r.body?.path_with_namespace, false)) {
    if (strict) throw outOfAccount('project')
    return null
  }
  return r.body
}

async function groupGate(ctx: ProviderContext, gid: string, strict: boolean): Promise<any | null> {
  const r = await glCall(ctx, 'GET', `/groups/${idSeg(gid, 'group id')}`, {
    query: { with_projects: false },
    allow: [404]
  })
  if (r.status === 404) return null
  if (!withinPin(ctx, r.body?.full_path, true)) {
    if (strict) throw outOfAccount('group')
    return null
  }
  return r.body
}

/** The pinned group itself (null when it does not exist or the token cannot see it). */
export async function pinnedGroup(ctx: ProviderContext): Promise<any | null> {
  const r = await glCall(ctx, 'GET', `/groups/${pathSeg(pinOf(ctx), 'group path')}`, {
    query: { with_projects: false },
    allow: [403, 404]
  })
  return r.status === 200 ? r.body : null
}

/** One page of the pinned group's projects (with subgroups). */
async function projectsPage(
  ctx: ProviderContext,
  cursor: string | null,
  activeOnly: boolean
): Promise<{ rows: any[]; next: string | null }> {
  const group = await pinnedGroup(ctx)
  if (!group) return { rows: [], next: null }
  const r = await glCall(ctx, 'GET', `/groups/${idSeg(group.id, 'group id')}/projects`, {
    query: {
      include_subgroups: true,
      per_page: 20,
      page: cursor ?? 1,
      archived: activeOnly ? false : undefined
    }
  })
  const rows = (Array.isArray(r.body) ? r.body : []).filter((p: any) =>
    withinPin(ctx, p?.path_with_namespace, false)
  )
  return { rows, next: r.next }
}

/** Lists a child type project by project: the cursor pages the projects. */
async function listPerProject(
  ctx: ProviderContext,
  cursor: string | null,
  each: (pid: string) => Promise<Observed[]>
): Promise<ListPage> {
  const { rows, next } = await projectsPage(ctx, cursor, true)
  const items: Observed[] = []
  for (const p of rows) items.push(...(await each(String(p.id))))
  return { items, cursor: next }
}

// ── group ──

function groupObserved(g: any): Observed {
  return {
    type: T.group,
    externalId: String(g.id),
    name: g.full_path ?? g.name ?? null,
    fields: {
      name: g.name ?? null,
      path: g.path ?? null,
      fullPath: g.full_path ?? null,
      visibility: g.visibility ?? null,
      description: g.description ?? null
    },
    tags: {},
    version: null,
    status: null,
    url: g.web_url ?? null
  }
}

const groupHandler: Handler = {
  type: T.group,
  async observe(ctx, ext, strict = false) {
    const g = await groupGate(ctx, ext, strict)
    return g ? groupObserved(g) : null
  },
  async list(ctx, cursor) {
    const pin = await pinnedGroup(ctx)
    if (!pin) return { items: [], cursor: null }
    const r = await glCall(ctx, 'GET', `/groups/${idSeg(pin.id, 'group id')}/descendant_groups`, {
      query: { per_page: 20, page: cursor ?? 1 }
    })
    const items = (Array.isArray(r.body) ? r.body : [])
      .filter((g: any) => withinPin(ctx, g?.full_path, true))
      .map(groupObserved)
    return { items: cursor ? items : [groupObserved(pin), ...items], cursor: r.next }
  },
  async create() {
    throw new ProviderError(
      'CAPABILITY_MISSING',
      'Groups are shared: the Hub adopts them, it never creates one.'
    )
  },
  async update() {
    throw new ProviderError(
      'CAPABILITY_MISSING',
      'Groups are shared: the Hub reads them, it never changes one.'
    )
  },
  async remove() {
    throw new ProviderError('CAPABILITY_MISSING', 'Groups are shared: the Hub never removes one.')
  }
}

// ── project ──

export const PROJECT_FIELDS = ['name', 'description', 'visibility', 'defaultBranch']

export function projectObserved(p: any): Observed {
  const importStatus = typeof p.import_status === 'string' ? p.import_status : null
  return {
    type: T.project,
    externalId: String(p.id),
    name: p.name ?? null,
    fields: {
      namespace: p.namespace?.id != null ? String(p.namespace.id) : null,
      name: p.name ?? null,
      path: p.path ?? null,
      description: p.description ?? null,
      visibility: p.visibility ?? null,
      defaultBranch: p.default_branch ?? null,
      fullPath: p.path_with_namespace ?? null,
      archived: !!p.archived,
      importStatus
    },
    tags: {},
    version: null,
    status: p.archived
      ? 'archived'
      : importStatus && importStatus !== 'none' && importStatus !== 'finished'
        ? importStatus
        : 'active',
    url: p.web_url ?? null
  }
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')

async function namespaceOf(ctx: ProviderContext, desired: DesiredResource): Promise<any> {
  const ref = desired.refs?.namespace
  if (typeof ref === 'string' && ref) {
    const g = await groupGate(ctx, ref, true)
    if (!g) throw new ProviderError('NOT_FOUND', 'The group no longer exists.', { status: 404 })
    return g
  }
  const pin = await pinnedGroup(ctx)
  if (!pin)
    throw new ProviderError('NOT_FOUND', 'The pinned group cannot be read with this token.', {
      status: 404
    })
  return pin
}

export async function archiveProject(ctx: ProviderContext, ext: string): Promise<void> {
  await glCall(ctx, 'POST', `/projects/${idSeg(ext, 'project id')}/archive`)
}

const projectHandler: Handler = {
  type: T.project,
  async observe(ctx, ext, strict = false) {
    const p = await projectGate(ctx, ext, strict)
    return p ? projectObserved(p) : null
  },
  async list(ctx, cursor) {
    const { rows, next } = await projectsPage(ctx, cursor, false)
    return { items: rows.map(projectObserved), cursor: next }
  },
  async existing(ctx, desired) {
    const ns = await namespaceOf(ctx, desired)
    const path = str(desired.fields.path) ?? slug(String(desired.fields.name ?? ''))
    if (!path) return null
    const full = `${String(ns.full_path)}/${path}`
    if (!withinPin(ctx, full, false)) throw outOfAccount('group')
    const r = await glCall(ctx, 'GET', `/projects/${pathSeg(full, 'project path')}`, {
      allow: [404]
    })
    return r.status === 404 ? null : projectObserved(r.body)
  },
  async create(ctx, desired) {
    const ns = await namespaceOf(ctx, desired)
    const name = String(desired.fields.name)
    const body: Record<string, unknown> = {
      name,
      path: str(desired.fields.path) ?? slug(name),
      namespace_id: ns.id,
      visibility: str(desired.fields.visibility) ?? 'private'
    }
    if (str(desired.fields.description)) body.description = desired.fields.description
    if (str(desired.fields.defaultBranch)) body.default_branch = desired.fields.defaultBranch
    if (str(desired.fields.templateName)) body.template_name = desired.fields.templateName
    const tpl = str(desired.fields.templateProject)
    if (tpl) {
      // A template project is read by GitLab for the copy: it must be inside the pinned group too.
      if (!(await projectGate(ctx, tpl, false))) throw outOfAccount('template project')
      body.template_project_id = Number(idSeg(tpl, 'template project id'))
      body.use_custom_template = true
    }
    const r = await glCall(ctx, 'POST', '/projects', { body })
    return { externalId: String(r.body?.id) }
  },
  async update(ctx, ext, desired, have) {
    const id = idSeg(ext, 'project id')
    const wantArchived =
      typeof desired.fields.archived === 'boolean' ? desired.fields.archived : undefined
    // An archived project refuses every other edit: lift it first, apply it last.
    if (have.fields.archived === true && wantArchived === false)
      await glCall(ctx, 'POST', `/projects/${id}/unarchive`)
    const changes = diffFields(PROJECT_FIELDS, desired.fields, have.fields)
    if (changes.length && !(have.fields.archived === true && wantArchived !== false)) {
      const body: Record<string, unknown> = {}
      for (const c of changes) {
        const key = c.field === 'defaultBranch' ? 'default_branch' : c.field
        body[key] = c.to ?? ''
      }
      await glCall(ctx, 'PUT', `/projects/${id}`, { body })
    }
    if (wantArchived === true && have.fields.archived !== true)
      await glCall(ctx, 'POST', `/projects/${id}/archive`)
  },
  async remove(ctx, ext) {
    await glCall(ctx, 'DELETE', `/projects/${idSeg(ext, 'project id')}`, { allow: [404] })
  }
}

// ── protected branch ──

function pbObserved(pid: string, b: any): Observed {
  return {
    type: T.protectedBranch,
    externalId: `${pid}/${b.name}`,
    name: b.name ?? null,
    fields: {
      project: pid,
      name: b.name ?? null,
      pushAccess: roleOf(b.push_access_levels?.[0]?.access_level),
      mergeAccess: roleOf(b.merge_access_levels?.[0]?.access_level),
      allowForcePush: !!b.allow_force_push,
      codeOwnerApprovalRequired: !!b.code_owner_approval_required
    },
    tags: {},
    version: null,
    status: null,
    url: null
  }
}

async function rawBranch(ctx: ProviderContext, pid: string, name: string): Promise<any | null> {
  const r = await glCall(ctx, 'GET', `/projects/${pid}/protected_branches/${branchSeg(name)}`, {
    allow: [404]
  })
  return r.status === 404 ? null : r.body
}

const protectedBranchHandler: Handler = {
  type: T.protectedBranch,
  target: (ext) => ({ field: 'project', id: splitSlash(ext)[0] }),
  async observe(ctx, ext, strict = false) {
    const [pid, name] = splitSlash(ext)
    if (!(await projectGate(ctx, pid, strict))) return null
    const b = await rawBranch(ctx, pid, name)
    return b ? pbObserved(pid, b) : null
  },
  list: (ctx, cursor) =>
    listPerProject(ctx, cursor, async (pid) => {
      const r = await glCall(ctx, 'GET', `/projects/${pid}/protected_branches`, {
        query: { per_page: 100 },
        allow: [403, 404]
      })
      return (Array.isArray(r.body) ? r.body : []).map((b: any) => pbObserved(pid, b))
    }),
  async existing(ctx, desired) {
    const pid = refId(desired, 'project')
    const b = await rawBranch(ctx, pid, String(desired.fields.name))
    return b ? pbObserved(pid, b) : null
  },
  async create(ctx, desired) {
    const pid = refId(desired, 'project')
    const body: Record<string, unknown> = {
      name: desired.fields.name,
      push_access_level: levelOf(desired.fields.pushAccess, 'maintainers'),
      merge_access_level: levelOf(desired.fields.mergeAccess, 'maintainers'),
      allow_force_push: bool(desired.fields.allowForcePush, false)
    }
    if (desired.fields.codeOwnerApprovalRequired === true) body.code_owner_approval_required = true
    const r = await glCall(ctx, 'POST', `/projects/${pid}/protected_branches`, { body })
    return { externalId: `${pid}/${String(r.body?.name ?? desired.fields.name)}` }
  },
  async update(ctx, ext, desired, have) {
    const [pid, name] = splitSlash(ext)
    const raw = await rawBranch(ctx, pid, name)
    if (!raw)
      throw new ProviderError('NOT_FOUND', 'The protected branch no longer exists.', {
        status: 404
      })
    const body: Record<string, unknown> = {}
    const changes = diffFields(
      ['pushAccess', 'mergeAccess', 'allowForcePush', 'codeOwnerApprovalRequired'],
      desired.fields,
      have.fields
    )
    for (const c of changes) {
      if (c.field === 'allowForcePush') body.allow_force_push = bool(c.to, false)
      else if (c.field === 'codeOwnerApprovalRequired')
        body.code_owner_approval_required = bool(c.to, false)
      else if (c.field === 'pushAccess' || c.field === 'mergeAccess') {
        const rows =
          (c.field === 'pushAccess' ? raw.push_access_levels : raw.merge_access_levels) ?? []
        body[c.field === 'pushAccess' ? 'allowed_to_push' : 'allowed_to_merge'] = [
          ...rows.filter((x: any) => x?.id != null).map((x: any) => ({ id: x.id, _destroy: true })),
          { access_level: levelOf(c.to, 'maintainers') }
        ]
      }
    }
    if (Object.keys(body).length)
      await glCall(ctx, 'PATCH', `/projects/${pid}/protected_branches/${branchSeg(name)}`, { body })
  },
  async remove(ctx, ext) {
    const [pid, name] = splitSlash(ext)
    await glCall(ctx, 'DELETE', `/projects/${pid}/protected_branches/${branchSeg(name)}`, {
      allow: [404]
    })
  }
}

// ── environment ──

function envObserved(pid: string, e: any): Observed {
  return {
    type: T.environment,
    externalId: `${pid}/${e.id}`,
    name: e.name ?? null,
    fields: {
      project: pid,
      name: e.name ?? null,
      externalUrl: e.external_url ?? null,
      tier: e.tier ?? null,
      state: e.state ?? null
    },
    tags: {},
    version: null,
    status: e.state ?? null,
    url: null
  }
}

async function rawEnvironment(ctx: ProviderContext, pid: string, eid: string): Promise<any | null> {
  const r = await glCall(
    ctx,
    'GET',
    `/projects/${pid}/environments/${idSeg(eid, 'environment id')}`,
    {
      allow: [404]
    }
  )
  return r.status === 404 ? null : r.body
}

const environmentHandler: Handler = {
  type: T.environment,
  target: (ext) => ({ field: 'project', id: splitSlash(ext)[0] }),
  async observe(ctx, ext, strict = false) {
    const [pid, eid] = splitSlash(ext)
    if (!(await projectGate(ctx, pid, strict))) return null
    const e = await rawEnvironment(ctx, pid, eid)
    return e ? envObserved(pid, e) : null
  },
  list: (ctx, cursor) =>
    listPerProject(ctx, cursor, async (pid) => {
      const r = await glCall(ctx, 'GET', `/projects/${pid}/environments`, {
        query: { per_page: 100 },
        allow: [403, 404]
      })
      return (Array.isArray(r.body) ? r.body : []).map((e: any) => envObserved(pid, e))
    }),
  async existing(ctx, desired) {
    const pid = refId(desired, 'project')
    envNameSeg(desired.fields.name)
    const r = await glCall(ctx, 'GET', `/projects/${pid}/environments`, {
      query: { name: String(desired.fields.name) },
      allow: [404]
    })
    const hit = (Array.isArray(r.body) ? r.body : []).find(
      (e: any) => e.name === desired.fields.name
    )
    return hit ? envObserved(pid, hit) : null
  },
  async create(ctx, desired) {
    const pid = refId(desired, 'project')
    envNameSeg(desired.fields.name)
    const body: Record<string, unknown> = { name: desired.fields.name }
    if (str(desired.fields.externalUrl)) body.external_url = desired.fields.externalUrl
    if (str(desired.fields.tier)) body.tier = desired.fields.tier
    const r = await glCall(ctx, 'POST', `/projects/${pid}/environments`, { body })
    return { externalId: `${pid}/${String(r.body?.id)}` }
  },
  async update(ctx, ext, desired, have) {
    const [pid, eid] = splitSlash(ext)
    const body: Record<string, unknown> = {}
    for (const c of diffFields(['externalUrl', 'tier'], desired.fields, have.fields))
      body[c.field === 'externalUrl' ? 'external_url' : 'tier'] = c.to ?? ''
    if (Object.keys(body).length)
      await glCall(ctx, 'PUT', `/projects/${pid}/environments/${idSeg(eid, 'environment id')}`, {
        body
      })
  },
  async remove(ctx, ext) {
    const [pid, eid] = splitSlash(ext)
    const id = idSeg(eid, 'environment id')
    const e = await rawEnvironment(ctx, pid, id)
    if (!e) return
    // GitLab removes only a stopped environment: stop it first (the stop is asynchronous).
    if (e.state === 'available')
      await glCall(ctx, 'POST', `/projects/${pid}/environments/${id}/stop`)
    try {
      await glCall(ctx, 'DELETE', `/projects/${pid}/environments/${id}`, { allow: [404] })
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 400 || err.status === 403))
        throw new ProviderError(
          'ENVIRONMENT_STOPPING',
          'GitLab is still stopping the environment (its stop job may be running). Apply again in a minute.',
          { retryable: true, status: err.status }
        )
      throw err
    }
  }
}

// ── protected environment ──

function peObserved(pid: string, e: any): Observed {
  const rule = e.approval_rules?.[0]
  return {
    type: T.protectedEnvironment,
    externalId: `${pid}/${e.name}`,
    name: e.name ?? null,
    fields: {
      project: pid,
      environment: e.name ?? null,
      deployAccess: roleOf(e.deploy_access_levels?.[0]?.access_level),
      approverRole: rule ? roleOf(rule.access_level) : 'maintainers',
      requiredApprovals: typeof rule?.required_approvals === 'number' ? rule.required_approvals : 0
    },
    tags: {},
    version: null,
    status: null,
    url: null
  }
}

async function rawProtectedEnv(
  ctx: ProviderContext,
  pid: string,
  name: string
): Promise<any | null> {
  const r = await glCall(
    ctx,
    'GET',
    `/projects/${pid}/protected_environments/${envNameSeg(name)}`,
    {
      allow: [404]
    }
  )
  return r.status === 404 ? null : r.body
}

const protectedEnvironmentHandler: Handler = {
  type: T.protectedEnvironment,
  target: (ext) => ({ field: 'project', id: splitSlash(ext)[0] }),
  async observe(ctx, ext, strict = false) {
    const [pid, name] = splitSlash(ext)
    if (!(await projectGate(ctx, pid, strict))) return null
    const e = await rawProtectedEnv(ctx, pid, name)
    return e ? peObserved(pid, e) : null
  },
  list: (ctx, cursor) =>
    listPerProject(ctx, cursor, async (pid) => {
      const r = await glCall(ctx, 'GET', `/projects/${pid}/protected_environments`, {
        query: { per_page: 100 },
        allow: [403, 404]
      })
      return (Array.isArray(r.body) ? r.body : []).map((e: any) => peObserved(pid, e))
    }),
  async existing(ctx, desired) {
    const pid = refId(desired, 'project')
    const e = await rawProtectedEnv(ctx, pid, String(desired.fields.environment))
    return e ? peObserved(pid, e) : null
  },
  async create(ctx, desired) {
    const pid = refId(desired, 'project')
    const name = String(desired.fields.environment)
    envNameSeg(name)
    const approvals = Number(desired.fields.requiredApprovals ?? 0)
    const body: Record<string, unknown> = {
      name,
      deploy_access_levels: [{ access_level: levelOf(desired.fields.deployAccess, 'maintainers') }]
    }
    if (approvals > 0)
      body.approval_rules = [
        {
          access_level: levelOf(desired.fields.approverRole, 'maintainers'),
          required_approvals: approvals
        }
      ]
    await glCall(ctx, 'POST', `/projects/${pid}/protected_environments`, { body })
    return { externalId: `${pid}/${name}` }
  },
  async update(ctx, ext, desired, have) {
    const [pid, name] = splitSlash(ext)
    const raw = await rawProtectedEnv(ctx, pid, name)
    if (!raw)
      throw new ProviderError('NOT_FOUND', 'The protected environment no longer exists.', {
        status: 404
      })
    const body: Record<string, unknown> = {}
    const accessChanged = !sameValue(desired.fields.deployAccess, have.fields.deployAccess)
    if (accessChanged)
      body.deploy_access_levels = [
        ...(raw.deploy_access_levels ?? [])
          .filter((x: any) => x?.id != null)
          .map((x: any) => ({ id: x.id, _destroy: true })),
        { access_level: levelOf(desired.fields.deployAccess, 'maintainers') }
      ]
    const approvalsChanged =
      !sameValue(desired.fields.requiredApprovals ?? 0, have.fields.requiredApprovals) ||
      (Number(desired.fields.requiredApprovals ?? 0) > 0 &&
        !sameValue(desired.fields.approverRole, have.fields.approverRole))
    if (approvalsChanged) {
      const approvals = Number(desired.fields.requiredApprovals ?? 0)
      body.approval_rules = [
        ...(raw.approval_rules ?? [])
          .filter((x: any) => x?.id != null)
          .map((x: any) => ({ id: x.id, _destroy: true })),
        ...(approvals > 0
          ? [
              {
                access_level: levelOf(desired.fields.approverRole, 'maintainers'),
                required_approvals: approvals
              }
            ]
          : [])
      ]
    }
    if (Object.keys(body).length)
      await glCall(ctx, 'PUT', `/projects/${pid}/protected_environments/${envNameSeg(name)}`, {
        body
      })
  },
  async remove(ctx, ext) {
    const [pid, name] = splitSlash(ext)
    await glCall(ctx, 'DELETE', `/projects/${pid}/protected_environments/${envNameSeg(name)}`, {
      allow: [404]
    })
  }
}

// ── CI/CD variable ──

const VAR_KEYS = ['variableType', 'masked', 'protected', 'raw']

function varBase(kind: 'project' | 'group', id: string): string {
  return `/${kind}s/${idSeg(id, `${kind} id`)}/variables`
}

/** Group variables take a scope filter only when it is not the default (Free groups have none). */
function scopeQuery(kind: 'project' | 'group', scope: string) {
  return kind === 'project' || scope !== '*' ? { 'filter[environment_scope]': scope } : {}
}

function varObserved(kind: 'project' | 'group', id: string, v: any): Observed {
  const scope =
    typeof v.environment_scope === 'string' && v.environment_scope ? v.environment_scope : '*'
  // `value` is write-only here: never copied, even for a plain variable.
  return {
    type: T.ciVariable,
    externalId: `${kind}:${id}:${v.key}:${scope}`,
    name: v.key ?? null,
    fields: {
      project: kind === 'project' ? id : null,
      group: kind === 'group' ? id : null,
      key: v.key ?? null,
      variableType: v.variable_type ?? 'env_var',
      masked: !!v.masked,
      protected: !!v.protected,
      raw: !!v.raw,
      environmentScope: scope
    },
    tags: {},
    version: null,
    status: null,
    url: null
  }
}

async function gateScope(
  ctx: ProviderContext,
  kind: 'project' | 'group',
  id: string,
  strict: boolean
): Promise<boolean> {
  return kind === 'project'
    ? !!(await projectGate(ctx, id, strict))
    : !!(await groupGate(ctx, id, strict))
}

async function rawVariable(
  ctx: ProviderContext,
  kind: 'project' | 'group',
  id: string,
  key: string,
  scope: string
): Promise<any | null> {
  const r = await glCall(ctx, 'GET', `${varBase(kind, id)}/${keySeg(key)}`, {
    query: scopeQuery(kind, scope),
    allow: [404]
  })
  return r.status === 404 ? null : r.body
}

function varBody(desired: DesiredResource, withKey: boolean, kind: 'project' | 'group') {
  const body: Record<string, unknown> = {
    variable_type: str(desired.fields.variableType) ?? 'env_var',
    masked: bool(desired.fields.masked, true),
    protected: bool(desired.fields.protected, false),
    raw: bool(desired.fields.raw, false)
  }
  if (withKey) {
    body.key = desired.fields.key
    const scope = str(desired.fields.environmentScope) ?? '*'
    if (kind === 'project' || scope !== '*') body.environment_scope = scope
  }
  return body
}

const ciVariableHandler: Handler = {
  type: T.ciVariable,
  target(ext) {
    const s = splitScoped(ext)
    return { field: s.kind, id: s.id }
  },
  async observe(ctx, ext, strict = false) {
    const s = splitScoped(ext)
    const m = /^([A-Za-z0-9_]{1,255}):(.*)$/s.exec(s.rest)
    if (!m) throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
    if (!(await gateScope(ctx, s.kind, s.id, strict))) return null
    const v = await rawVariable(ctx, s.kind, s.id, m[1] as string, m[2] || '*')
    return v ? varObserved(s.kind, s.id, v) : null
  },
  async list(ctx, cursor) {
    const out = await listPerProject(ctx, cursor, async (pid) => {
      const r = await glCall(ctx, 'GET', varBase('project', pid), {
        query: { per_page: 100 },
        allow: [403, 404]
      })
      return (Array.isArray(r.body) ? r.body : []).map((v: any) => varObserved('project', pid, v))
    })
    if (!cursor) {
      const pin = await pinnedGroup(ctx)
      if (pin) {
        const r = await glCall(ctx, 'GET', varBase('group', String(pin.id)), {
          query: { per_page: 100 },
          allow: [403, 404]
        })
        for (const v of Array.isArray(r.body) ? r.body : [])
          out.items.push(varObserved('group', String(pin.id), v))
      }
    }
    return out
  },
  async existing(ctx, desired) {
    const s = scopeRef(desired)
    const scope = str(desired.fields.environmentScope) ?? '*'
    const v = await rawVariable(ctx, s.field, s.id, String(desired.fields.key), scope)
    return v ? varObserved(s.field, s.id, v) : null
  },
  checkReplace(desired) {
    // The new variable needs its value before the old one goes away.
    if (plainOf(desired.fields.value) === undefined)
      throw new ProviderError('INVALID_FIELDS', 'A value is needed to add this variable.')
  },
  async create(ctx, desired) {
    const s = scopeRef(desired)
    if (!(await gateScope(ctx, s.field, s.id, true)))
      throw new ProviderError('NOT_FOUND', `The ${s.field} no longer exists.`, { status: 404 })
    const value = plainOf(desired.fields.value)
    if (value === undefined)
      throw new ProviderError('INVALID_FIELDS', 'A value is needed to add this variable.')
    const body = { ...varBody(desired, true, s.field), value }
    await glCall(ctx, 'POST', varBase(s.field, s.id), { body, extraScrub: [value] })
    const scope = str(desired.fields.environmentScope) ?? '*'
    return { externalId: `${s.field}:${s.id}:${String(desired.fields.key)}:${scope}` }
  },
  async update(ctx, ext, desired, have) {
    const s = splitScoped(ext)
    const m = /^([A-Za-z0-9_]{1,255}):(.*)$/s.exec(s.rest)
    if (!m) throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
    const diff = diffFields(VAR_KEYS, desired.fields, have.fields)
    const v = desired.fields.value
    const newValue = isSecret(v) && v.changed ? v.plain : undefined
    if (!diff.length && newValue === undefined) return
    const body: Record<string, unknown> = {}
    for (const c of diff) {
      if (c.field === 'variableType') body.variable_type = c.to
      else body[c.field] = c.to
    }
    if (newValue !== undefined) body.value = newValue
    await glCall(ctx, 'PUT', `${varBase(s.kind, s.id)}/${keySeg(m[1])}`, {
      query: scopeQuery(s.kind, m[2] || '*'),
      body,
      extraScrub: newValue !== undefined ? [newValue] : []
    })
  },
  async remove(ctx, ext) {
    const s = splitScoped(ext)
    const m = /^([A-Za-z0-9_]{1,255}):(.*)$/s.exec(s.rest)
    if (!m) throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
    await glCall(ctx, 'DELETE', `${varBase(s.kind, s.id)}/${keySeg(m[1])}`, {
      query: scopeQuery(s.kind, m[2] || '*'),
      allow: [404]
    })
  }
}

// ── deploy token ──

function tokenObserved(kind: 'project' | 'group', id: string, t: any): Observed {
  const state = t.expired ? 'expired' : t.revoked ? 'revoked' : 'active'
  return {
    type: T.deployToken,
    externalId: `${kind}:${id}:${t.id}`,
    name: t.name ?? null,
    // The token value is never part of a read: GitLab shows it once, at create.
    fields: {
      project: kind === 'project' ? id : null,
      group: kind === 'group' ? id : null,
      name: t.name ?? null,
      scopes: Array.isArray(t.scopes) ? t.scopes : [],
      expiresAt: t.expires_at ?? null,
      username: t.username ?? null
    },
    tags: {},
    version: null,
    status: state,
    url: null
  }
}

function tokenBase(kind: 'project' | 'group', id: string): string {
  return `/${kind}s/${idSeg(id, `${kind} id`)}/deploy_tokens`
}

async function tokensOf(
  ctx: ProviderContext,
  kind: 'project' | 'group',
  id: string
): Promise<any[]> {
  const out: any[] = []
  let page: string | null = '1'
  for (let i = 0; i < 5 && page; i++) {
    const r: GlAnswer = await glCall(ctx, 'GET', tokenBase(kind, id), {
      query: { per_page: 100, page },
      allow: [403, 404]
    })
    if (r.status !== 200) break
    out.push(...(Array.isArray(r.body) ? r.body : []))
    page = r.next
  }
  return out
}

async function makeToken(
  ctx: ProviderContext,
  desired: DesiredResource
): Promise<{ created: Created; id: string }> {
  const s = scopeRef(desired)
  if (!(await gateScope(ctx, s.field, s.id, true)))
    throw new ProviderError('NOT_FOUND', `The ${s.field} no longer exists.`, { status: 404 })
  const body: Record<string, unknown> = {
    name: desired.fields.name,
    scopes: list(desired.fields.scopes)
  }
  if (str(desired.fields.expiresAt)) body.expires_at = desired.fields.expiresAt
  if (str(desired.fields.username)) body.username = desired.fields.username
  const r = await glCall(ctx, 'POST', tokenBase(s.field, s.id), { body })
  const token = typeof r.body?.token === 'string' ? r.body.token : ''
  if (!token)
    throw new ProviderError('PROVIDER_REJECTED', 'GitLab made the token but did not return it.')
  const outputs: Record<string, string> = { token }
  if (typeof r.body?.username === 'string' && r.body.username) outputs.username = r.body.username
  return { created: { externalId: `${s.field}:${s.id}:${String(r.body?.id)}`, outputs }, id: s.id }
}

const deployTokenHandler: Handler = {
  type: T.deployToken,
  replaceCreateFirst: true,
  target(ext) {
    const s = splitScoped(ext)
    return { field: s.kind, id: s.id }
  },
  async observe(ctx, ext, strict = false) {
    const s = splitScoped(ext)
    if (!(await gateScope(ctx, s.kind, s.id, strict))) return null
    const t = (await tokensOf(ctx, s.kind, s.id)).find(
      (x) => String(x?.id) === idSeg(s.rest, 'token id')
    )
    return t ? tokenObserved(s.kind, s.id, t) : null
  },
  async list(ctx, cursor) {
    const out = await listPerProject(ctx, cursor, async (pid) =>
      (await tokensOf(ctx, 'project', pid)).map((t) => tokenObserved('project', pid, t))
    )
    if (!cursor) {
      const pin = await pinnedGroup(ctx)
      if (pin)
        for (const t of await tokensOf(ctx, 'group', String(pin.id)))
          out.items.push(tokenObserved('group', String(pin.id), t))
    }
    return out
  },
  // Token names are not unique at GitLab: there is nothing to collide with.
  async create(ctx, desired) {
    return (await makeToken(ctx, desired)).created
  },
  async update() {
    // No field of a deploy token changes in place (they replace); rotating is `rotate`.
  },
  async rotate(ctx, _ext, desired) {
    // New first, old after: a failure to remove the old one never loses the new value.
    const { created } = await makeToken(ctx, desired)
    return created
  },
  async remove(ctx, ext) {
    const s = splitScoped(ext)
    await glCall(ctx, 'DELETE', `${tokenBase(s.kind, s.id)}/${idSeg(s.rest, 'token id')}`, {
      allow: [404]
    })
  },
  async readOutputs(ctx, ext) {
    const have = await this.observe(ctx, ext, true)
    const username = have?.fields.username
    const out: Record<string, string> = {}
    if (typeof username === 'string' && username) out.username = username
    return out
  }
}

// ── deploy key ──

function keyObserved(pid: string, k: any): Observed {
  return {
    type: T.deployKey,
    externalId: `${pid}/${k.id}`,
    name: k.title ?? null,
    fields: {
      project: pid,
      title: k.title ?? null,
      key: normKey(k.key),
      canPush: !!k.can_push
    },
    tags: {},
    version: null,
    status: null,
    url: null
  }
}

async function keysOf(ctx: ProviderContext, pid: string): Promise<any[]> {
  const r = await glCall(ctx, 'GET', `/projects/${pid}/deploy_keys`, {
    query: { per_page: 100 },
    allow: [403, 404]
  })
  return Array.isArray(r.body) ? r.body : []
}

const deployKeyHandler: Handler = {
  type: T.deployKey,
  target: (ext) => ({ field: 'project', id: splitSlash(ext)[0] }),
  async observe(ctx, ext, strict = false) {
    const [pid, kid] = splitSlash(ext)
    if (!(await projectGate(ctx, pid, strict))) return null
    const r = await glCall(ctx, 'GET', `/projects/${pid}/deploy_keys/${idSeg(kid, 'key id')}`, {
      allow: [404]
    })
    return r.status === 404 ? null : keyObserved(pid, r.body)
  },
  list: (ctx, cursor) =>
    listPerProject(ctx, cursor, async (pid) =>
      (await keysOf(ctx, pid)).map((k) => keyObserved(pid, k))
    ),
  async existing(ctx, desired) {
    const pid = refId(desired, 'project')
    const want = normKey(desired.fields.key)
    const hit = (await keysOf(ctx, pid)).find((k) => normKey(k.key) === want)
    return hit ? keyObserved(pid, hit) : null
  },
  async create(ctx, desired) {
    const pid = refId(desired, 'project')
    const r = await glCall(ctx, 'POST', `/projects/${pid}/deploy_keys`, {
      body: {
        title: desired.fields.title,
        key: String(desired.fields.key).trim(),
        can_push: bool(desired.fields.canPush, false)
      }
    })
    return { externalId: `${pid}/${String(r.body?.id)}` }
  },
  async update(ctx, ext, desired, have) {
    const [pid, kid] = splitSlash(ext)
    const body: Record<string, unknown> = {}
    for (const c of diffFields(['title', 'canPush'], desired.fields, have.fields))
      body[c.field === 'canPush' ? 'can_push' : 'title'] = c.to
    if (Object.keys(body).length)
      await glCall(ctx, 'PUT', `/projects/${pid}/deploy_keys/${idSeg(kid, 'key id')}`, { body })
  },
  async remove(ctx, ext) {
    const [pid, kid] = splitSlash(ext)
    await glCall(ctx, 'DELETE', `/projects/${pid}/deploy_keys/${idSeg(kid, 'key id')}`, {
      allow: [404]
    })
  }
}

// ── webhook ──

function hookObserved(pid: string, h: any): Observed {
  return {
    type: T.webhook,
    externalId: `${pid}/${h.id}`,
    name: h.url ?? null,
    // The secret token is write-only: GitLab never gives it back.
    fields: {
      project: pid,
      url: h.url ?? null,
      events: WEBHOOK_EVENTS.filter((e) => h[e] === true),
      enableSslVerification: h.enable_ssl_verification !== false,
      alertStatus: h.alert_status ?? null
    },
    tags: {},
    version: null,
    status: h.alert_status && h.alert_status !== 'executable' ? String(h.alert_status) : null,
    url: null
  }
}

async function hooksOf(ctx: ProviderContext, pid: string): Promise<any[]> {
  const r = await glCall(ctx, 'GET', `/projects/${pid}/hooks`, {
    query: { per_page: 100 },
    allow: [403, 404]
  })
  return Array.isArray(r.body) ? r.body : []
}

function hookBody(desired: DesiredResource): Record<string, unknown> {
  const events = new Set(list(desired.fields.events))
  const body: Record<string, unknown> = {
    url: desired.fields.url,
    enable_ssl_verification: bool(desired.fields.enableSslVerification, true)
  }
  // Every event is stated, so removing one from the list turns it off.
  for (const e of WEBHOOK_EVENTS) body[e] = events.has(e)
  return body
}

const webhookHandler: Handler = {
  type: T.webhook,
  target: (ext) => ({ field: 'project', id: splitSlash(ext)[0] }),
  async observe(ctx, ext, strict = false) {
    const [pid, hid] = splitSlash(ext)
    if (!(await projectGate(ctx, pid, strict))) return null
    const r = await glCall(ctx, 'GET', `/projects/${pid}/hooks/${idSeg(hid, 'hook id')}`, {
      allow: [404]
    })
    return r.status === 404 ? null : hookObserved(pid, r.body)
  },
  list: (ctx, cursor) =>
    listPerProject(ctx, cursor, async (pid) =>
      (await hooksOf(ctx, pid)).map((h) => hookObserved(pid, h))
    ),
  async existing(ctx, desired) {
    const pid = refId(desired, 'project')
    const hit = (await hooksOf(ctx, pid)).find((h) => h.url === desired.fields.url)
    return hit ? hookObserved(pid, hit) : null
  },
  async create(ctx, desired) {
    const pid = refId(desired, 'project')
    const body = hookBody(desired)
    const token = plainOf(desired.fields.token)
    if (token) body.token = token
    const r = await glCall(ctx, 'POST', `/projects/${pid}/hooks`, {
      body,
      extraScrub: token ? [token] : []
    })
    return { externalId: `${pid}/${String(r.body?.id)}` }
  },
  async update(ctx, ext, desired, have) {
    const [pid, hid] = splitSlash(ext)
    const changed = diffFields(
      ['url', 'events', 'enableSslVerification'],
      desired.fields,
      have.fields
    )
    const v = desired.fields.token
    const newToken = isSecret(v) && v.changed ? v.plain : undefined
    if (!changed.length && newToken === undefined) return
    const body = hookBody({ ...desired, fields: { ...have.fields, ...desired.fields } })
    if (newToken !== undefined) body.token = newToken
    await glCall(ctx, 'PUT', `/projects/${pid}/hooks/${idSeg(hid, 'hook id')}`, {
      body,
      extraScrub: newToken !== undefined ? [newToken] : []
    })
  },
  async remove(ctx, ext) {
    const [pid, hid] = splitSlash(ext)
    await glCall(ctx, 'DELETE', `/projects/${pid}/hooks/${idSeg(hid, 'hook id')}`, { allow: [404] })
  }
}

// ── pipeline schedule ──

function scheduleObserved(pid: string, s: any): Observed {
  return {
    type: T.pipelineSchedule,
    externalId: `${pid}/${s.id}`,
    name: s.description ?? null,
    fields: {
      project: pid,
      description: s.description ?? null,
      ref: refName(s.ref),
      cron: s.cron ?? null,
      cronTimezone: s.cron_timezone ?? null,
      active: s.active !== false
    },
    tags: {},
    version: null,
    status: s.active === false ? 'paused' : null,
    url: null
  }
}

async function schedulesOf(ctx: ProviderContext, pid: string): Promise<any[]> {
  const r = await glCall(ctx, 'GET', `/projects/${pid}/pipeline_schedules`, {
    query: { per_page: 100 },
    allow: [403, 404]
  })
  return Array.isArray(r.body) ? r.body : []
}

const scheduleHandler: Handler = {
  type: T.pipelineSchedule,
  target: (ext) => ({ field: 'project', id: splitSlash(ext)[0] }),
  async observe(ctx, ext, strict = false) {
    const [pid, sid] = splitSlash(ext)
    if (!(await projectGate(ctx, pid, strict))) return null
    const r = await glCall(
      ctx,
      'GET',
      `/projects/${pid}/pipeline_schedules/${idSeg(sid, 'schedule id')}`,
      {
        allow: [404]
      }
    )
    return r.status === 404 ? null : scheduleObserved(pid, r.body)
  },
  list: (ctx, cursor) =>
    listPerProject(ctx, cursor, async (pid) =>
      (await schedulesOf(ctx, pid)).map((s) => scheduleObserved(pid, s))
    ),
  async existing(ctx, desired) {
    const pid = refId(desired, 'project')
    const hit = (await schedulesOf(ctx, pid)).find(
      (s) =>
        s.description === desired.fields.description &&
        refName(s.ref) === refName(desired.fields.ref)
    )
    return hit ? scheduleObserved(pid, hit) : null
  },
  async create(ctx, desired) {
    const pid = refId(desired, 'project')
    const r = await glCall(ctx, 'POST', `/projects/${pid}/pipeline_schedules`, {
      body: {
        description: desired.fields.description,
        ref: desired.fields.ref,
        cron: desired.fields.cron,
        cron_timezone: str(desired.fields.cronTimezone) ?? 'UTC',
        active: bool(desired.fields.active, true)
      }
    })
    return { externalId: `${pid}/${String(r.body?.id)}` }
  },
  async update(ctx, ext, desired, have) {
    const [pid, sid] = splitSlash(ext)
    const body: Record<string, unknown> = {}
    for (const c of diffFields(
      ['description', 'ref', 'cron', 'cronTimezone', 'active'],
      desired.fields,
      have.fields
    )) {
      if (c.field === 'cronTimezone') body.cron_timezone = c.to
      else body[c.field] = c.to
    }
    if (Object.keys(body).length)
      await glCall(ctx, 'PUT', `/projects/${pid}/pipeline_schedules/${idSeg(sid, 'schedule id')}`, {
        body
      })
  },
  async remove(ctx, ext) {
    const [pid, sid] = splitSlash(ext)
    await glCall(
      ctx,
      'DELETE',
      `/projects/${pid}/pipeline_schedules/${idSeg(sid, 'schedule id')}`,
      {
        allow: [404]
      }
    )
  }
}

// ── runner ──

/** True when every project / group the runner belongs to is inside the pinned group. */
function runnerWithin(ctx: ProviderContext, r: any): boolean {
  if (r?.runner_type === 'project_type') {
    const projects = Array.isArray(r.projects) ? r.projects : []
    return (
      projects.length > 0 &&
      projects.every((p: any) => withinPin(ctx, p?.path_with_namespace, false))
    )
  }
  if (r?.runner_type === 'group_type') {
    const groups = Array.isArray(r.groups) ? r.groups : []
    return (
      groups.length > 0 &&
      groups.every((g: any) => {
        try {
          const path = decodeURIComponent(new URL(String(g?.web_url ?? '')).pathname)
          return withinPin(ctx, path.replace(/^\/groups\//, '').replace(/^\//, ''), true)
        } catch {
          return false
        }
      })
    )
  }
  return false // an instance runner is never inside one group
}

function runnerObserved(r: any): Observed {
  const projects = Array.isArray(r.projects) ? r.projects : []
  const groups = Array.isArray(r.groups) ? r.groups : []
  const online = r.online === true || r.status === 'online'
  return {
    type: T.runner,
    externalId: String(r.id),
    name: r.description ?? null,
    fields: {
      project: projects.length === 1 ? String(projects[0].id) : null,
      group: groups.length === 1 && groups[0]?.id != null ? String(groups[0].id) : null,
      description: r.description ?? null,
      tagList: Array.isArray(r.tag_list) ? r.tag_list : [],
      runUntagged: r.run_untagged !== false,
      locked: !!r.locked,
      accessLevel: r.access_level ?? 'not_protected',
      paused: r.paused === true || r.active === false,
      maximumTimeout: typeof r.maximum_timeout === 'number' ? r.maximum_timeout : null,
      runnerType: r.runner_type ?? null,
      online
    },
    tags: {},
    version: null,
    status: r.paused === true || r.active === false ? 'paused' : online ? 'online' : 'offline',
    url: null
  }
}

async function rawRunner(ctx: ProviderContext, ext: string, strict: boolean): Promise<any | null> {
  const r = await glCall(ctx, 'GET', `/runners/${idSeg(ext, 'runner id')}`, { allow: [404] })
  if (r.status === 404) return null
  if (!runnerWithin(ctx, r.body)) {
    if (strict) throw outOfAccount('runner')
    return null
  }
  return r.body
}

const RUNNER_KEYS = [
  'description',
  'tagList',
  'runUntagged',
  'locked',
  'accessLevel',
  'paused',
  'maximumTimeout'
]

const runnerHandler: Handler = {
  type: T.runner,
  async observe(ctx, ext, strict = false) {
    const r = await rawRunner(ctx, ext, strict)
    return r ? runnerObserved(r) : null
  },
  async list(ctx, cursor) {
    const pin = await pinnedGroup(ctx)
    if (!pin) return { items: [], cursor: null }
    const r = await glCall(ctx, 'GET', `/groups/${idSeg(pin.id, 'group id')}/runners`, {
      query: { per_page: 20, page: cursor ?? 1 },
      allow: [403, 404]
    })
    const items: Observed[] = []
    // The group list is a summary (no tags, no owners): read each runner for the full shape.
    for (const row of Array.isArray(r.body) ? r.body : []) {
      const full = await rawRunner(ctx, String(row?.id), false)
      if (full) items.push(runnerObserved(full))
    }
    return { items, cursor: r.next }
  },
  // Runner descriptions are not unique at GitLab: there is nothing to collide with.
  async create(ctx, desired) {
    const s = scopeRef(desired)
    if (!(await gateScope(ctx, s.field, s.id, true)))
      throw new ProviderError('NOT_FOUND', `The ${s.field} no longer exists.`, { status: 404 })
    const body: Record<string, unknown> = {
      runner_type: s.field === 'project' ? 'project_type' : 'group_type',
      [s.field === 'project' ? 'project_id' : 'group_id']: Number(idSeg(s.id, `${s.field} id`)),
      description: desired.fields.description,
      run_untagged: bool(desired.fields.runUntagged, true),
      locked: bool(desired.fields.locked, false),
      access_level: str(desired.fields.accessLevel) ?? 'not_protected',
      paused: bool(desired.fields.paused, false)
    }
    const tags = list(desired.fields.tagList)
    if (tags.length) body.tag_list = tags
    if (typeof desired.fields.maximumTimeout === 'number')
      body.maximum_timeout = desired.fields.maximumTimeout
    const r = await glCall(ctx, 'POST', '/user/runners', { body })
    const token = typeof r.body?.token === 'string' ? r.body.token : ''
    if (!token || r.body?.id == null)
      throw new ProviderError(
        'PROVIDER_REJECTED',
        'GitLab made the runner but did not return its token.'
      )
    return { externalId: String(r.body.id), outputs: { token } }
  },
  async update(ctx, ext, desired, have) {
    const changes = diffFields(RUNNER_KEYS, desired.fields, have.fields)
    if (!changes.length) return
    const body: Record<string, unknown> = {}
    for (const c of changes) {
      if (c.field === 'tagList') body.tag_list = list(c.to)
      else if (c.field === 'runUntagged') body.run_untagged = bool(c.to, true)
      else if (c.field === 'accessLevel') body.access_level = c.to
      else if (c.field === 'maximumTimeout') body.maximum_timeout = c.to
      else body[c.field] = c.to
    }
    await glCall(ctx, 'PUT', `/runners/${idSeg(ext, 'runner id')}`, { body })
  },
  async rotate(ctx, ext) {
    const r = await glCall(
      ctx,
      'POST',
      `/runners/${idSeg(ext, 'runner id')}/reset_authentication_token`
    )
    const token = typeof r.body?.token === 'string' ? r.body.token : ''
    if (!token)
      throw new ProviderError(
        'PROVIDER_REJECTED',
        'GitLab reset the runner token but did not return it.'
      )
    return { externalId: ext, outputs: { token } }
  },
  async remove(ctx, ext) {
    await glCall(ctx, 'DELETE', `/runners/${idSeg(ext, 'runner id')}`, { allow: [404] })
  }
}

export const RUNNER_UPDATE_KEYS = RUNNER_KEYS
export const VARIABLE_UPDATE_KEYS = VAR_KEYS

const HANDLERS: Handler[] = [
  groupHandler,
  projectHandler,
  protectedBranchHandler,
  environmentHandler,
  protectedEnvironmentHandler,
  ciVariableHandler,
  deployTokenHandler,
  deployKeyHandler,
  webhookHandler,
  scheduleHandler,
  runnerHandler
]

export function handlerFor(type: string): Handler {
  const h = HANDLERS.find((x) => x.type === type)
  if (!h) throw new ProviderError('UNKNOWN_TYPE', `GitLab has no ${type}.`)
  return h
}
