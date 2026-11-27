import { fieldWords, typedName } from '../plan-words.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type OutputSpec,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag
} from '../types.js'
import { neonCall, orgIdOf, seg, waitOperations } from './client.js'
import { NEON_BUNDLED, neonEstimate } from './pricing.js'

/**
 * Neon (`neon`): an organisation API key + the pinned organisation id. Types: project, branch
 * (one per environment; "reset from parent" is a named op), endpoint (compute size and
 * autosuspend), database and role. Host `console.neon.tech`.
 *
 * External ids: project = project id; branch and endpoint = `<projectId>/<id>`; database and role
 * = `<projectId>/<branchId>/<name>`. The organisation is enforced on EVERY read by id: a project
 * whose `org_id` is not the connection's is "not there" (observe/list) or `NEON_OUT_OF_ACCOUNT`
 * (any write), and every child is judged through its parent project.
 *
 * Outputs (values only in `OpResult.outputs`, sealed by the engine): `database_url` (pooled),
 * `host`, `database`, `user`, `password` on a branch (its first database and that database's
 * owner) and on a database (its owner); `user` and `password` on a role. Neon shows a role's
 * password again on request, so none of them is once-only and `readOutputs` re-reads them.
 */

const T_PROJECT = 'neon.project'
const T_BRANCH = 'neon.branch'
const T_ENDPOINT = 'neon.endpoint'
const T_DATABASE = 'neon.database'
const T_ROLE = 'neon.role'
const PAGE = 50
const CONSOLE = 'https://console.neon.tech/app/projects'
const RESET_ACTION = 'reset_from_parent'

// ── Small helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function sameValue(a: unknown, b: unknown): boolean {
  const x = norm(a)
  const y = norm(b)
  if (typeof x === 'number' || typeof y === 'number') return Number(x) === Number(y)
  return x === y
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

/** `a/b/c` → its parts, each one a valid path segment. */
function parts(externalId: string | null | undefined, n: number): string[] {
  const p = String(externalId ?? '').split('/')
  if (p.length !== n)
    throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  for (const s of p) seg(s)
  return p
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function alreadyExists(what: string): ProviderError {
  return new ProviderError('ALREADY_EXISTS', `${what} at Neon. Adopt it instead of creating it.`)
}

/** A create that meets something the Hub did not make is refused unless this row recorded it. */
function refuseUnlessResumed(d: DesiredResource, existingId: string, what: string): void {
  if (d.externalId && d.externalId === existingId) return
  throw alreadyExists(what)
}

function refString(desired: DesiredResource | null, field: string): string {
  const v = desired?.refs?.[field]
  if (typeof v === 'string' && v) return v
  throw new ProviderError(
    'INVALID_FIELDS',
    `The ${field} this change belongs to is not created yet.`
  )
}

/** The project and branch a child's refs name; the branch must live in that project. */
function childRefs(desired: DesiredResource | null): { project: string; branch: string } {
  const project = refString(desired, 'project')
  const [bp, branch] = parts(refString(desired, 'branch'), 2)
  seg(project)
  if (bp !== project)
    throw new ProviderError('PROJECT_MISMATCH', 'The branch belongs to a different project.')
  return { project, branch }
}

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
  ...(outputs && Object.keys(outputs).length ? { outputs } : {})
})

// ── Organisation pin ──

async function readProjectRaw(ctx: ProviderContext, id: string): Promise<any | null> {
  const r = await neonCall(ctx, 'GET', `/projects/${seg(id)}`, { allow: [404] })
  return r.status === 404 ? null : (r.body?.project ?? null)
}

const inOrg = (ctx: ProviderContext, p: any): boolean =>
  !!p && typeof p.org_id === 'string' && p.org_id === orgIdOf(ctx)

const outOfAccount = () =>
  new ProviderError(
    'NEON_OUT_OF_ACCOUNT',
    'That project is not in the organisation this connection is pinned to.'
  )

/** The project when it is in the pinned organisation; null when gone or outside it. */
async function projectInOrg(ctx: ProviderContext, id: string): Promise<any | null> {
  const p = await readProjectRaw(ctx, id)
  return inOrg(ctx, p) ? p : null
}

/** For writes: gone → null, outside the organisation → NEON_OUT_OF_ACCOUNT. */
async function projectForWrite(ctx: ProviderContext, id: string): Promise<any | null> {
  const p = await readProjectRaw(ctx, id)
  if (p && !inOrg(ctx, p)) throw outOfAccount()
  return p
}

async function mustProject(ctx: ProviderContext, id: string): Promise<any> {
  const p = await projectForWrite(ctx, id)
  if (!p) throw new ProviderError('NOT_FOUND', 'The project no longer exists.', { status: 404 })
  return p
}

// ── Observed mappers (never carry a secret value) ──

const GIB = 1024 ** 3

function projectObserved(p: any): Observed {
  const bytes = num(p.synthetic_storage_size)
  return {
    type: T_PROJECT,
    externalId: String(p.id),
    name: p.name ?? null,
    fields: {
      name: p.name ?? null,
      region: p.region_id ?? null,
      pgVersion: p.pg_version != null ? String(p.pg_version) : null,
      historyRetentionSeconds: num(p.history_retention_seconds),
      plan: p.owner?.subscription_type ?? null,
      storageGb: bytes != null ? Math.round((bytes / GIB) * 1000) / 1000 : null
    },
    tags: {},
    version: p.updated_at ?? null,
    status: null,
    url: `${CONSOLE}/${p.id}`
  }
}

function branchObserved(projectId: string, b: any, children: number | null = null): Observed {
  return {
    type: T_BRANCH,
    externalId: `${projectId}/${b.id}`,
    name: b.name ?? null,
    fields: {
      project: projectId,
      name: b.name ?? null,
      parent: b.parent_id ?? null,
      protected: !!b.protected,
      default: !!(b.default ?? b.primary),
      children
    },
    tags: {},
    version: b.updated_at ?? null,
    status: b.current_state ?? null,
    url: `${CONSOLE}/${projectId}/branches/${b.id}`
  }
}

function endpointObserved(projectId: string, e: any): Observed {
  return {
    type: T_ENDPOINT,
    externalId: `${projectId}/${e.id}`,
    name: e.id ?? null,
    fields: {
      project: projectId,
      branch: `${projectId}/${e.branch_id}`,
      type: e.type ?? null,
      minCu: num(e.autoscaling_limit_min_cu),
      maxCu: num(e.autoscaling_limit_max_cu),
      suspendTimeoutSeconds: num(e.suspend_timeout_seconds),
      poolerEnabled: e.pooler_enabled != null ? !!e.pooler_enabled : null,
      host: e.host ?? null
    },
    tags: {},
    version: e.updated_at ?? null,
    status: e.current_state ?? null,
    url: `${CONSOLE}/${projectId}/branches/${e.branch_id}`
  }
}

function databaseObserved(projectId: string, branchId: string, d: any): Observed {
  return {
    type: T_DATABASE,
    externalId: `${projectId}/${branchId}/${d.name}`,
    name: d.name ?? null,
    fields: {
      project: projectId,
      branch: `${projectId}/${branchId}`,
      name: d.name ?? null,
      owner: d.owner_name ?? null
    },
    tags: {},
    version: d.updated_at ?? null,
    status: null,
    url: `${CONSOLE}/${projectId}/branches/${branchId}`
  }
}

function roleObserved(projectId: string, branchId: string, r: any): Observed {
  return {
    type: T_ROLE,
    externalId: `${projectId}/${branchId}/${r.name}`,
    name: r.name ?? null,
    // The password is an output, never a field.
    fields: {
      project: projectId,
      branch: `${projectId}/${branchId}`,
      name: r.name ?? null,
      protected: !!r.protected
    },
    tags: {},
    version: r.updated_at ?? null,
    status: null,
    url: `${CONSOLE}/${projectId}/branches/${branchId}`
  }
}

// ── Reads ──

async function readBranchRaw(ctx: ProviderContext, p: string, b: string): Promise<any | null> {
  const r = await neonCall(ctx, 'GET', `/projects/${seg(p)}/branches/${seg(b)}`, { allow: [404] })
  return r.status === 404 ? null : (r.body?.branch ?? null)
}

async function readBranch(ctx: ProviderContext, p: string, b: string): Promise<Observed | null> {
  if (!(await projectInOrg(ctx, p))) return null
  const raw = await readBranchRaw(ctx, p, b)
  if (!raw) return null
  const kids = (await listBranchesRaw(ctx, p)).filter((x) => x.parent_id === b).length
  return branchObserved(p, raw, kids)
}

async function listBranchesRaw(ctx: ProviderContext, p: string): Promise<any[]> {
  const r = await neonCall(ctx, 'GET', `/projects/${seg(p)}/branches`, { allow: [404] })
  return r.body?.branches ?? []
}

async function listEndpointsRaw(ctx: ProviderContext, p: string): Promise<any[]> {
  const r = await neonCall(ctx, 'GET', `/projects/${seg(p)}/endpoints`, { allow: [404] })
  return r.body?.endpoints ?? []
}

async function readEndpoint(ctx: ProviderContext, p: string, e: string): Promise<Observed | null> {
  if (!(await projectInOrg(ctx, p))) return null
  const r = await neonCall(ctx, 'GET', `/projects/${seg(p)}/endpoints/${seg(e)}`, { allow: [404] })
  return r.status === 404 ? null : endpointObserved(p, r.body?.endpoint ?? {})
}

async function listDatabasesRaw(ctx: ProviderContext, p: string, b: string): Promise<any[]> {
  const r = await neonCall(ctx, 'GET', `/projects/${seg(p)}/branches/${seg(b)}/databases`, {
    allow: [404]
  })
  return r.body?.databases ?? []
}

async function listRolesRaw(ctx: ProviderContext, p: string, b: string): Promise<any[]> {
  const r = await neonCall(ctx, 'GET', `/projects/${seg(p)}/branches/${seg(b)}/roles`, {
    allow: [404]
  })
  return r.body?.roles ?? []
}

async function readDatabase(
  ctx: ProviderContext,
  p: string,
  b: string,
  name: string
): Promise<Observed | null> {
  if (!(await projectInOrg(ctx, p))) return null
  const r = await neonCall(
    ctx,
    'GET',
    `/projects/${seg(p)}/branches/${seg(b)}/databases/${seg(name)}`,
    { allow: [404] }
  )
  return r.status === 404 ? null : databaseObserved(p, b, r.body?.database ?? {})
}

async function readRole(
  ctx: ProviderContext,
  p: string,
  b: string,
  name: string
): Promise<Observed | null> {
  if (!(await projectInOrg(ctx, p))) return null
  const r = await neonCall(
    ctx,
    'GET',
    `/projects/${seg(p)}/branches/${seg(b)}/roles/${seg(name)}`,
    {
      allow: [404]
    }
  )
  return r.status === 404 ? null : roleObserved(p, b, r.body?.role ?? {})
}

async function listProjects(ctx: ProviderContext, cursor?: string | null, search?: string) {
  const r = await neonCall(ctx, 'GET', '/projects', {
    query: { org_id: orgIdOf(ctx), limit: PAGE, cursor: cursor ?? undefined, search }
  })
  const next = r.body?.pagination?.cursor
  return {
    // The server filters by org; a row of another organisation is dropped here as well.
    projects: ((r.body?.projects ?? []) as any[]).filter((p) => inOrg(ctx, p)),
    next: typeof next === 'string' && next ? next : null
  }
}

// ── Outputs ──

async function connectionOutputs(
  ctx: ProviderContext,
  p: string,
  b: string,
  database: string,
  role: string
): Promise<Record<string, string>> {
  const r = await neonCall(ctx, 'GET', `/projects/${seg(p)}/connection_uri`, {
    query: { branch_id: b, database_name: database, role_name: role, pooled: 'true' }
  })
  const uri = typeof r.body?.uri === 'string' ? r.body.uri : ''
  if (!uri) throw new ProviderError('NO_CONNECTION', 'Neon gave no connection address yet.')
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    throw new ProviderError('NO_CONNECTION', 'Neon gave a connection address the Hub cannot read.')
  }
  return {
    database_url: uri,
    host: u.hostname,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || database,
    user: decodeURIComponent(u.username) || role,
    password: decodeURIComponent(u.password)
  }
}

/** A branch's outputs come from its first database and that database's owner. */
async function branchOutputs(
  ctx: ProviderContext,
  p: string,
  b: string
): Promise<Record<string, string>> {
  const dbs = await listDatabasesRaw(ctx, p, b)
  const first = dbs.find((d) => d?.name && d?.owner_name)
  if (!first) return {}
  return connectionOutputs(ctx, p, b, String(first.name), String(first.owner_name))
}

async function outputsFor(
  ctx: ProviderContext,
  type: string,
  externalId: string
): Promise<Record<string, string>> {
  if (type === T_BRANCH) {
    const [p, b] = parts(externalId, 2)
    if (!(await projectInOrg(ctx, p))) throw outOfAccount()
    return branchOutputs(ctx, p, b)
  }
  const [p, b, name] = parts(externalId, 3)
  if (!(await projectInOrg(ctx, p))) throw outOfAccount()
  if (type === T_DATABASE) {
    const d = await readDatabase(ctx, p, b, name)
    if (!d?.fields.owner) throw new ProviderError('NOT_FOUND', 'The database is gone.')
    return connectionOutputs(ctx, p, b, name, String(d.fields.owner))
  }
  if (type === T_ROLE) {
    const r = await neonCall(
      ctx,
      'GET',
      `/projects/${seg(p)}/branches/${seg(b)}/roles/${seg(name)}/reveal_password`
    )
    const password = typeof r.body?.password === 'string' ? r.body.password : ''
    if (!password) throw new ProviderError('NO_PASSWORD', 'Neon gave no password for the role.')
    return { user: name, password }
  }
  return {}
}

/** Best effort after a write: a failed read leaves the outputs for the engine's later re-read. */
async function tryOutputs(
  ctx: ProviderContext,
  type: string,
  externalId: string
): Promise<Record<string, string>> {
  try {
    return await outputsFor(ctx, type, externalId)
  } catch (err) {
    if (err instanceof ProviderError) return {}
    throw err
  }
}

// ── Resource types ──

const FULL = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: false }

const REGIONS = [
  'aws-us-east-1',
  'aws-us-east-2',
  'aws-us-west-2',
  'aws-eu-central-1',
  'aws-eu-west-2',
  'aws-ap-southeast-1',
  'aws-ap-southeast-2',
  'aws-sa-east-1',
  'azure-eastus2',
  'azure-westus3',
  'azure-gwc'
]

const CONNECTION_OUTPUTS: OutputSpec[] = [
  { key: 'database_url', label: 'Database URL (pooled)', secret: true },
  { key: 'host', label: 'Host (pooled)', secret: false },
  { key: 'database', label: 'Database name', secret: false },
  { key: 'user', label: 'User', secret: false },
  { key: 'password', label: 'Password', secret: true }
]

const NAME_PATTERN = '^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,62}$'

const PROJECT_REF = {
  key: 'project',
  label: 'Project',
  kind: 'ref' as const,
  refType: T_PROJECT,
  required: true,
  replaceOnChange: true
}
const BRANCH_REF = {
  key: 'branch',
  label: 'Branch',
  kind: 'ref' as const,
  refType: T_BRANCH,
  required: true,
  replaceOnChange: true
}

const ENDPOINT_SIZE_KEYS = ['minCu', 'maxCu']

const TYPES: ResourceTypeSpec[] = [
  {
    key: T_PROJECT,
    label: 'Neon project',
    scope: 'app',
    nameField: 'name',
    fields: [
      { key: 'name', label: 'Name', kind: 'string', required: true, pattern: '^.{1,64}$' },
      {
        key: 'region',
        label: 'Region',
        kind: 'enum',
        required: true,
        createOnly: true,
        options: REGIONS.map((r) => ({ value: r, label: r }))
      },
      {
        key: 'pgVersion',
        label: 'Postgres version',
        kind: 'enum',
        createOnly: true,
        options: ['14', '15', '16', '17'].map((v) => ({ value: v, label: v }))
      },
      {
        key: 'historyRetentionSeconds',
        label: 'History retention (seconds)',
        kind: 'number',
        min: 0,
        max: 2592000,
        help: 'How long point-in-time history is kept; the longest depends on the plan.'
      },
      { key: 'plan', label: 'Plan', kind: 'string', readOnly: true },
      { key: 'storageGb', label: 'Storage (GB)', kind: 'number', readOnly: true }
    ],
    capabilities: FULL,
    reversible: false,
    refs: [],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive', 'data_loss')
      return out
    },
    costClass: () => 'monthly',
    estimate: neonEstimate('project')
  },
  {
    key: T_BRANCH,
    label: 'Neon branch',
    scope: 'app',
    nameField: 'name',
    fields: [
      PROJECT_REF,
      { key: 'name', label: 'Name', kind: 'string', required: true, pattern: '^.{1,256}$' },
      {
        key: 'parent',
        label: 'Parent branch',
        kind: 'string',
        createOnly: true,
        help: 'A branch id (br-…) or name. Empty = the project’s primary branch.'
      },
      { key: 'protected', label: 'Protected', kind: 'boolean', default: false },
      {
        key: 'resetFromParent',
        label: 'Reset from parent',
        kind: 'boolean',
        trigger: true,
        help: 'One-shot: replaces this branch’s data with its parent’s current data. Everything written to this branch since it was made is lost.'
      },
      { key: 'default', label: 'Primary branch', kind: 'boolean', readOnly: true },
      { key: 'children', label: 'Child branches', kind: 'number', readOnly: true }
    ],
    // No snapshot: a child branch would block its own parent's delete. A delete is final.
    capabilities: FULL,
    reversible: false,
    refs: [{ field: 'project', type: T_PROJECT, required: true }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive', 'data_loss')
      if (op.action === RESET_ACTION) out.push('data_loss')
      return out
    },
    outputs: CONNECTION_OUTPUTS
  },
  {
    key: T_ENDPOINT,
    label: 'Neon compute endpoint',
    scope: 'app',
    nameField: 'type',
    fields: [
      PROJECT_REF,
      BRANCH_REF,
      {
        key: 'type',
        label: 'Type',
        kind: 'enum',
        createOnly: true,
        default: 'read_write',
        options: [
          { value: 'read_write', label: 'Read / write' },
          { value: 'read_only', label: 'Read only (replica)' }
        ]
      },
      {
        key: 'minCu',
        label: 'Minimum compute (CU)',
        kind: 'number',
        min: 0.25,
        max: 56,
        default: 0.25
      },
      {
        key: 'maxCu',
        label: 'Maximum compute (CU)',
        kind: 'number',
        min: 0.25,
        max: 56,
        default: 0.25
      },
      {
        key: 'suspendTimeoutSeconds',
        label: 'Autosuspend after (seconds)',
        kind: 'number',
        min: -1,
        max: 604800,
        help: '0 = Neon’s default (5 minutes), -1 = never suspend.'
      },
      { key: 'poolerEnabled', label: 'Connection pooling', kind: 'boolean', default: true },
      { key: 'host', label: 'Host', kind: 'string', readOnly: true }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [
      { field: 'project', type: T_PROJECT, required: true },
      { field: 'branch', type: T_BRANCH, required: true }
    ],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive', 'downtime')
      // A compute size change restarts the compute: connections drop for a moment.
      if (
        (op.kind === 'update' || op.kind === 'replace') &&
        op.changes.some((c) => ENDPOINT_SIZE_KEYS.includes(c.field))
      )
        out.push('downtime')
      if (op.kind === 'replace') out.push('downtime')
      return out
    },
    costClass: () => 'monthly',
    estimate: neonEstimate('endpoint')
  },
  {
    key: T_DATABASE,
    label: 'Neon database',
    scope: 'app',
    nameField: 'name',
    fields: [
      PROJECT_REF,
      BRANCH_REF,
      { key: 'name', label: 'Name', kind: 'string', required: true, pattern: NAME_PATTERN },
      {
        key: 'owner',
        label: 'Owner role',
        kind: 'string',
        required: true,
        pattern: NAME_PATTERN,
        help: 'The name of a role on this branch.'
      }
    ],
    capabilities: FULL,
    reversible: false,
    refs: [
      { field: 'project', type: T_PROJECT, required: true },
      { field: 'branch', type: T_BRANCH, required: true }
    ],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive', 'data_loss')
      return out
    },
    outputs: CONNECTION_OUTPUTS
  },
  {
    key: T_ROLE,
    label: 'Neon role',
    scope: 'app',
    nameField: 'name',
    fields: [
      PROJECT_REF,
      BRANCH_REF,
      {
        key: 'name',
        label: 'Name',
        kind: 'string',
        required: true,
        replaceOnChange: true,
        pattern: NAME_PATTERN
      },
      { key: 'protected', label: 'Protected', kind: 'boolean', readOnly: true }
    ],
    capabilities: {
      create: true,
      update: false,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [
      { field: 'project', type: T_PROJECT, required: true },
      { field: 'branch', type: T_BRANCH, required: true }
    ],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive')
      return out
    },
    outputs: [
      { key: 'user', label: 'User', secret: false },
      { key: 'password', label: 'Password', secret: true }
    ]
  }
]

// ── Plan ──

const specOf = (type: string) => TYPES.find((t) => t.key === type)
const labelOf = (type: string) => specOf(type)?.label ?? type
const wordsOf = (type: string, changes: Array<{ field: string }>) =>
  fieldWords(specOf(type)?.fields, changes)

const PROJECT_MUTABLE = ['name', 'historyRetentionSeconds']
const PROJECT_CREATE = ['name', 'region', 'pgVersion', 'historyRetentionSeconds']
const BRANCH_MUTABLE = ['name', 'protected']
const ENDPOINT_MUTABLE = ['minCu', 'maxCu', 'suspendTimeoutSeconds', 'poolerEnabled']
const ENDPOINT_CREATE = ['type', ...ENDPOINT_MUTABLE]

interface PlanShape {
  type: string
  mutable: string[]
  create: string[]
  /** Fields whose value the delete precondition pins. */
  pin: string[]
}

function generalPlan(
  shape: PlanShape,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const { type } = shape
  const label = labelOf(type)
  if (!desired) {
    if (!observed) return []
    const pre: Record<string, unknown> = {}
    for (const k of shape.pin) pre[k] = observed.fields[k] ?? null
    return [
      {
        kind: 'delete',
        type,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(label, observed.name)}${type === T_PROJECT ? ' with all its branches and data' : ''}.`,
        changes: [],
        preconditions: pre,
        risk: []
      }
    ]
  }
  if (!observed) {
    const changes = shape.create
      .filter((k) => norm(desired.fields[k]) !== null)
      .map((k) => ({ field: k, to: desired.fields[k] }))
    const name = desired.fields.name ?? desired.fields.type
    return [
      {
        kind: 'create',
        type,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(label, name == null ? '' : String(name))}.`,
        changes,
        preconditions: {},
        risk: []
      }
    ]
  }
  const changes = diffFields(shape.mutable, desired.fields, observed.fields)
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

function planBranch(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const ops = generalPlan(
    {
      type: T_BRANCH,
      mutable: BRANCH_MUTABLE,
      create: ['name', 'parent', 'protected'],
      pin: ['name']
    },
    desired,
    observed
  )
  if (!desired && observed) {
    const del = ops[0]
    const kids = Number(observed.fields.children ?? 0)
    if (del) {
      del.reason = `Delete ${typedName(labelOf(T_BRANCH), observed.name)}. The Hub cannot bring its data back.`
      if (kids > 0)
        del.data = {
          ...(del.data ?? {}),
          $blocker: {
            code: 'BRANCH_HAS_CHILDREN',
            message: `${observed.name ?? 'The branch'} still has ${kids} child branch${kids === 1 ? '' : 'es'}. Delete them first.`
          }
        }
    }
  }
  // The reset trigger needs a branch that exists; a create never resets.
  if (desired && observed && desired.fields.resetFromParent === true) {
    ops.push({
      kind: 'update',
      type: T_BRANCH,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Reset ${typedName(labelOf(T_BRANCH), observed.name)} from its parent: everything written to it since it was made is lost.`,
      changes: [{ field: 'resetFromParent', from: false, to: true }],
      preconditions: { name: observed.fields.name ?? null, parent: observed.fields.parent ?? null },
      risk: [],
      action: RESET_ACTION
    })
  }
  return ops
}

function planDatabase(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  return generalPlan(
    {
      type: T_DATABASE,
      mutable: ['name', 'owner'],
      create: ['name', 'owner'],
      pin: ['name', 'owner']
    },
    desired,
    observed
  )
}

function planRole(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  return generalPlan(
    { type: T_ROLE, mutable: [], create: ['name'], pin: ['name'] },
    desired,
    observed
  )
}

// ── Apply ──

async function applyProject(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const id = op.externalId as string
    seg(id)
    if (!(await projectForWrite(ctx, id))) return ok(id, null, { already: 'gone' })
    const r = await neonCall(ctx, 'DELETE', `/projects/${seg(id)}`)
    await waitOperations(ctx, id, r.body?.operations).catch(() => undefined)
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'create') {
    const name = String(desired.fields.name)
    const found = await findProject(ctx, name)
    if (found) {
      refuseUnlessResumed(desired, found.externalId, `A project named ${name} already exists`)
      return ok(found.externalId, found, { already: 'exists' })
    }
    const project: Record<string, unknown> = {
      name,
      region_id: desired.fields.region,
      org_id: orgIdOf(ctx)
    }
    if (norm(desired.fields.pgVersion) !== null)
      project.pg_version = Number(desired.fields.pgVersion)
    if (norm(desired.fields.historyRetentionSeconds) !== null)
      project.history_retention_seconds = Number(desired.fields.historyRetentionSeconds)
    const r = await neonCall(ctx, 'POST', '/projects', { body: { project } })
    const id = String(r.body?.project?.id ?? '')
    if (!id) throw new ProviderError('PROVIDER_REJECTED', 'Neon did not say which project it made.')
    // The answer also carries the first role's password: it is never read or kept here.
    await waitOperations(ctx, id, r.body?.operations)
    const created = (await readProjectRaw(ctx, id)) ?? r.body.project
    return ok(id, projectObserved(created))
  }
  const id = op.externalId as string
  const have = await mustProject(ctx, id)
  const now = projectObserved(have)
  const changes = diffFields(PROJECT_MUTABLE, desired.fields, now.fields)
  if (!changes.length) return ok(id, now, { already: 'matches' })
  const body: Record<string, unknown> = {}
  for (const c of changes) {
    if (c.field === 'name') body.name = c.to
    if (c.field === 'historyRetentionSeconds') body.history_retention_seconds = Number(c.to)
  }
  const r = await neonCall(ctx, 'PATCH', `/projects/${seg(id)}`, { body: { project: body } })
  await waitOperations(ctx, id, r.body?.operations)
  return ok(id, projectObserved(r.body?.project ?? have))
}

async function findProject(ctx: ProviderContext, name: string): Promise<Observed | null> {
  const { projects } = await listProjects(ctx, null, name)
  const hit = projects.find((p) => String(p.name ?? '').toLowerCase() === name.toLowerCase())
  return hit ? projectObserved(hit) : null
}

/** A parent given by id or name → its branch id. */
function resolveParent(branches: any[], wanted: string): string {
  const hit =
    branches.find((b) => b.id === wanted) ?? branches.find((b) => String(b.name) === wanted)
  if (!hit) throw new ProviderError('INVALID_FIELDS', `The parent branch ${wanted} was not found.`)
  return String(hit.id)
}

async function applyBranch(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const [p, b] = parts(op.externalId, 2)
    if (!(await projectForWrite(ctx, p))) return ok(op.externalId, null, { already: 'gone' })
    const raw = await readBranchRaw(ctx, p, b)
    if (!raw) return ok(op.externalId, null, { already: 'gone' })
    if (raw.default ?? raw.primary)
      throw new ProviderError(
        'PRIMARY_BRANCH',
        'The primary branch cannot be deleted. Delete the project, or make another branch primary in Neon first.'
      )
    const kids = (await listBranchesRaw(ctx, p)).filter((x) => x.parent_id === b)
    if (kids.length)
      throw new ProviderError(
        'BRANCH_HAS_CHILDREN',
        `${raw.name ?? 'The branch'} still has ${kids.length} child branch${kids.length === 1 ? '' : 'es'}. Delete them first.`
      )
    try {
      const r = await neonCall(ctx, 'DELETE', `/projects/${seg(p)}/branches/${seg(b)}`)
      await waitOperations(ctx, p, r.body?.operations)
    } catch (err) {
      if (
        err instanceof ProviderError &&
        [400, 409, 422].includes(err.status ?? 0) &&
        /child/i.test(err.message)
      )
        throw new ProviderError(
          'BRANCH_HAS_CHILDREN',
          'Neon cannot delete a branch that still has child branches Delete the children first.'
        )
      throw err
    }
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const project = refString(desired, 'project')
  seg(project)
  if (op.kind === 'create') {
    await mustProject(ctx, project)
    const name = String(desired.fields.name)
    const branches = await listBranchesRaw(ctx, project)
    const same = branches.find((x) => String(x.name) === name)
    if (same) {
      const id = `${project}/${same.id}`
      refuseUnlessResumed(desired, id, `A branch named ${name} already exists in the project`)
      return ok(
        id,
        branchObserved(project, same),
        { already: 'exists' },
        await tryOutputs(ctx, T_BRANCH, id)
      )
    }
    const branch: Record<string, unknown> = { name }
    if (norm(desired.fields.parent) !== null)
      branch.parent_id = resolveParent(branches, String(desired.fields.parent))
    if (desired.fields.protected === true) branch.protected = true
    // No compute is made here: an endpoint is its own resource.
    const r = await neonCall(ctx, 'POST', `/projects/${seg(project)}/branches`, {
      body: { branch }
    })
    await waitOperations(ctx, project, r.body?.operations)
    const made = r.body?.branch ?? {}
    const id = `${project}/${made.id}`
    seg(String(made.id ?? ''))
    return ok(id, branchObserved(project, made), undefined, await tryOutputs(ctx, T_BRANCH, id))
  }
  // Named or plain write on an existing branch: the target is the resource this row is.
  const [p, b] = parts(op.externalId, 2)
  if (p !== project)
    throw new ProviderError('PROJECT_MISMATCH', 'The branch belongs to a different project.')
  if (desired.externalId && desired.externalId !== op.externalId)
    throw new ProviderError(
      'TARGET_MISMATCH',
      'The change names a different branch than this resource.'
    )
  await mustProject(ctx, p)
  const raw = await readBranchRaw(ctx, p, b)
  if (!raw) throw new ProviderError('NOT_FOUND', 'The branch no longer exists.', { status: 404 })
  if (op.action === RESET_ACTION) {
    const parentId = typeof raw.parent_id === 'string' ? raw.parent_id : ''
    if (!parentId) throw new ProviderError('NO_PARENT', 'This branch has no parent to reset from.')
    const r = await neonCall(ctx, 'POST', `/projects/${seg(p)}/branches/${seg(b)}/restore`, {
      body: { source_branch_id: parentId }
    })
    await waitOperations(ctx, p, r.body?.operations)
    return ok(op.externalId, branchObserved(p, r.body?.branch ?? raw), { reset: true })
  }
  const now = branchObserved(p, raw)
  const changes = diffFields(BRANCH_MUTABLE, desired.fields, now.fields)
  if (!changes.length) return ok(op.externalId, now, { already: 'matches' })
  const body: Record<string, unknown> = {}
  for (const c of changes) body[c.field] = c.to
  const r = await neonCall(ctx, 'PATCH', `/projects/${seg(p)}/branches/${seg(b)}`, {
    body: { branch: body }
  })
  await waitOperations(ctx, p, r.body?.operations)
  return ok(op.externalId, branchObserved(p, r.body?.branch ?? raw))
}

function endpointBody(fields: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const k of keys) {
    const v = fields[k]
    if (norm(v) === null) continue
    if (k === 'type') body.type = v
    if (k === 'minCu') body.autoscaling_limit_min_cu = Number(v)
    if (k === 'maxCu') body.autoscaling_limit_max_cu = Number(v)
    if (k === 'suspendTimeoutSeconds') body.suspend_timeout_seconds = Number(v)
    if (k === 'poolerEnabled') body.pooler_enabled = !!v
  }
  return body
}

function checkCuRange(fields: Record<string, unknown>): void {
  const min = num(fields.minCu)
  const max = num(fields.maxCu)
  if (min != null && max != null && min > max)
    throw new ProviderError('INVALID_FIELDS', 'The minimum compute cannot be above the maximum.')
}

async function applyEndpoint(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const [p, e] = parts(op.externalId, 2)
    if (!(await projectForWrite(ctx, p))) return ok(op.externalId, null, { already: 'gone' })
    const have = await readEndpoint(ctx, p, e)
    if (!have) return ok(op.externalId, null, { already: 'gone' })
    const r = await neonCall(ctx, 'DELETE', `/projects/${seg(p)}/endpoints/${seg(e)}`)
    await waitOperations(ctx, p, r.body?.operations)
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const { project, branch } = childRefs(desired)
  if (op.kind === 'create') {
    await mustProject(ctx, project)
    checkCuRange(desired.fields)
    const type = String(desired.fields.type ?? 'read_write')
    const same = (await listEndpointsRaw(ctx, project)).find(
      (e) => e.branch_id === branch && e.type === type
    )
    if (same) {
      const id = `${project}/${same.id}`
      refuseUnlessResumed(desired, id, `A ${type} endpoint already exists on that branch`)
      return ok(id, endpointObserved(project, same), { already: 'exists' })
    }
    const body = { ...endpointBody(desired.fields, ENDPOINT_CREATE), branch_id: branch, type }
    const r = await neonCall(ctx, 'POST', `/projects/${seg(project)}/endpoints`, {
      body: { endpoint: body }
    })
    await waitOperations(ctx, project, r.body?.operations)
    const made = r.body?.endpoint ?? {}
    seg(String(made.id ?? ''))
    return ok(`${project}/${made.id}`, endpointObserved(project, made))
  }
  const [p, e] = parts(op.externalId, 2)
  if (p !== project)
    throw new ProviderError('PROJECT_MISMATCH', 'The endpoint belongs to a different project.')
  await mustProject(ctx, p)
  const have = await readEndpoint(ctx, p, e)
  if (!have) throw new ProviderError('NOT_FOUND', 'The endpoint no longer exists.', { status: 404 })
  if (have.fields.branch !== `${project}/${branch}`)
    throw new ProviderError(
      'TARGET_MISMATCH',
      'The endpoint is on a different branch than this resource.'
    )
  checkCuRange({ ...have.fields, ...desired.fields })
  const changes = diffFields(ENDPOINT_MUTABLE, desired.fields, have.fields)
  if (!changes.length) return ok(op.externalId, have, { already: 'matches' })
  const r = await neonCall(ctx, 'PATCH', `/projects/${seg(p)}/endpoints/${seg(e)}`, {
    body: {
      endpoint: endpointBody(
        desired.fields,
        changes.map((c) => c.field)
      )
    }
  })
  await waitOperations(ctx, p, r.body?.operations)
  return ok(op.externalId, endpointObserved(p, r.body?.endpoint ?? {}))
}

async function applyDatabase(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const [p, b, name] = parts(op.externalId, 3)
    if (!(await projectForWrite(ctx, p))) return ok(op.externalId, null, { already: 'gone' })
    if (!(await readDatabase(ctx, p, b, name))) return ok(op.externalId, null, { already: 'gone' })
    const r = await neonCall(
      ctx,
      'DELETE',
      `/projects/${seg(p)}/branches/${seg(b)}/databases/${seg(name)}`
    )
    await waitOperations(ctx, p, r.body?.operations)
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const { project, branch } = childRefs(desired)
  if (op.kind === 'create') {
    await mustProject(ctx, project)
    const name = String(desired.fields.name)
    const existing = await readDatabase(ctx, project, branch, name)
    if (existing) {
      refuseUnlessResumed(
        desired,
        existing.externalId,
        `A database named ${name} already exists on that branch`
      )
      return ok(
        existing.externalId,
        existing,
        { already: 'exists' },
        await tryOutputs(ctx, T_DATABASE, existing.externalId)
      )
    }
    const r = await neonCall(
      ctx,
      'POST',
      `/projects/${seg(project)}/branches/${seg(branch)}/databases`,
      {
        body: { database: { name, owner_name: String(desired.fields.owner) } }
      }
    )
    await waitOperations(ctx, project, r.body?.operations)
    const id = `${project}/${branch}/${name}`
    return ok(
      id,
      databaseObserved(project, branch, r.body?.database ?? { name }),
      undefined,
      await tryOutputs(ctx, T_DATABASE, id)
    )
  }
  const [p, b, name] = parts(op.externalId, 3)
  if (p !== project || b !== branch)
    throw new ProviderError(
      'TARGET_MISMATCH',
      'The database is on a different branch than this resource.'
    )
  await mustProject(ctx, p)
  const have = await readDatabase(ctx, p, b, name)
  if (!have) throw new ProviderError('NOT_FOUND', 'The database no longer exists.', { status: 404 })
  const changes = diffFields(['name', 'owner'], desired.fields, have.fields)
  if (!changes.length) return ok(op.externalId, have, { already: 'matches' })
  const body: Record<string, unknown> = {}
  for (const c of changes) {
    if (c.field === 'name') body.name = c.to
    if (c.field === 'owner') body.owner_name = c.to
  }
  const r = await neonCall(
    ctx,
    'PATCH',
    `/projects/${seg(p)}/branches/${seg(b)}/databases/${seg(name)}`,
    { body: { database: body } }
  )
  await waitOperations(ctx, p, r.body?.operations)
  const newName = typeof body.name === 'string' ? body.name : name
  return ok(
    `${p}/${b}/${newName}`,
    databaseObserved(
      p,
      b,
      r.body?.database ?? { name: newName, owner_name: body.owner_name ?? have.fields.owner }
    )
  )
}

async function applyRole(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const [p, b, name] = parts(op.externalId, 3)
    if (!(await projectForWrite(ctx, p))) return ok(op.externalId, null, { already: 'gone' })
    if (!(await readRole(ctx, p, b, name))) return ok(op.externalId, null, { already: 'gone' })
    const r = await neonCall(
      ctx,
      'DELETE',
      `/projects/${seg(p)}/branches/${seg(b)}/roles/${seg(name)}`
    )
    await waitOperations(ctx, p, r.body?.operations)
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const { project, branch } = childRefs(desired)
  if (op.kind !== 'create') {
    const [p, b, name] = parts(op.externalId, 3)
    if (p !== project || b !== branch)
      throw new ProviderError(
        'TARGET_MISMATCH',
        'The role is on a different branch than this resource.'
      )
    return ok(op.externalId, await readRole(ctx, p, b, name), { already: 'matches' })
  }
  await mustProject(ctx, project)
  const name = String(desired.fields.name)
  const existing = await readRole(ctx, project, branch, name)
  if (existing) {
    refuseUnlessResumed(
      desired,
      existing.externalId,
      `A role named ${name} already exists on that branch`
    )
    return ok(
      existing.externalId,
      existing,
      { already: 'exists' },
      await tryOutputs(ctx, T_ROLE, existing.externalId)
    )
  }
  const r = await neonCall(ctx, 'POST', `/projects/${seg(project)}/branches/${seg(branch)}/roles`, {
    body: { role: { name } }
  })
  await waitOperations(ctx, project, r.body?.operations)
  const password = typeof r.body?.role?.password === 'string' ? r.body.role.password : ''
  const id = `${project}/${branch}/${name}`
  const outputs: Record<string, string> = { user: name }
  if (password) outputs.password = password
  else Object.assign(outputs, await tryOutputs(ctx, T_ROLE, id))
  return ok(id, roleObserved(project, branch, { name }), undefined, outputs)
}

// ── The adapter ──

export const neonAdapter: ProviderAdapter = {
  bundledPrices: NEON_BUNDLED,
  key: 'neon',
  label: 'Neon',
  connection: {
    fields: [
      {
        key: 'orgId',
        label: 'Organization id',
        kind: 'string',
        required: true,
        placeholder: 'org-…',
        help: 'Pinned: every list, create and read is limited to this organisation.'
      },
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'string',
        secret: true,
        required: true,
        help: 'An organisation API key (Neon console → Organization settings → API keys).'
      }
    ],
    hosts: () => ['console.neon.tech'],
    describe: (config) => `Neon organization ${String(config.orgId ?? '')}`,
    validate(config, secrets) {
      const problems: string[] = []
      if (!/^org-[a-z0-9-]{3,}$/.test(String(config.orgId ?? '')))
        problems.push('The organization id looks like org- followed by words and digits.')
      if (secrets.apiKey !== undefined && !secrets.apiKey.trim())
        problems.push('The API key is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const needs = (has: { read: boolean; write: boolean }) =>
      TYPES.flatMap((t) => [
        { type: t.key, need: `read ${t.key}`, has: has.read },
        {
          type: t.key,
          need: `write ${t.key} (an organization API key with member access)`,
          has: has.write
        }
      ])
    const fail = (message: string): ConnectionTest => {
      const permissions = needs({ read: false, write: false })
      return {
        ok: false,
        identity: null,
        permissions,
        missing: permissions.map((p) => p.need),
        message
      }
    }
    let read = false
    try {
      const r = await neonCall(ctx, 'GET', '/projects', {
        query: { org_id: orgIdOf(ctx), limit: 1 },
        allow: [401, 403, 404]
      })
      read = r.status === 200
      if (!read)
        return fail(
          'The key cannot list projects in this organisation (check the organization id and the key).'
        )
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    let name: string | null = null
    try {
      const r = await neonCall(ctx, 'GET', `/organizations/${seg(orgIdOf(ctx))}`, {
        allow: [401, 403, 404]
      })
      if (r.status === 200 && typeof r.body?.name === 'string') name = r.body.name
    } catch {
      // Identity is a nicety; the projects read already worked.
    }
    // Neon cannot list what an API key may do: a working read is the evidence, writes are assumed.
    const permissions = needs({ read, write: read })
    return {
      ok: true,
      identity: `organization ${name ?? orgIdOf(ctx)}`,
      permissions,
      missing: [],
      message:
        'Neon does not report an API key’s scope, so write access is assumed from a working read.'
    }
  },

  async observe(ctx, type, externalId) {
    if (type === T_PROJECT) {
      seg(externalId)
      const p = await projectInOrg(ctx, externalId)
      return p ? projectObserved(p) : null
    }
    if (type === T_BRANCH) {
      const [p, b] = parts(externalId, 2)
      return readBranch(ctx, p, b)
    }
    if (type === T_ENDPOINT) {
      const [p, e] = parts(externalId, 2)
      return readEndpoint(ctx, p, e)
    }
    if (type === T_DATABASE) {
      const [p, b, n] = parts(externalId, 3)
      return readDatabase(ctx, p, b, n)
    }
    if (type === T_ROLE) {
      const [p, b, n] = parts(externalId, 3)
      return readRole(ctx, p, b, n)
    }
    throw new ProviderError('UNKNOWN_TYPE', `Neon has no ${type}.`)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    if (!TYPES.some((t) => t.key === type))
      throw new ProviderError('UNKNOWN_TYPE', `Neon has no ${type}.`)
    const { projects, next } = await listProjects(ctx, cursor)
    if (type === T_PROJECT) return { items: projects.map(projectObserved), cursor: next }
    // Children are listed per page of projects; the cursor pages the projects.
    const items: Observed[] = []
    for (const proj of projects) {
      const p = String(proj.id)
      if (type === T_BRANCH) {
        const all = await listBranchesRaw(ctx, p)
        for (const b of all)
          items.push(branchObserved(p, b, all.filter((x) => x.parent_id === b.id).length))
      } else if (type === T_ENDPOINT)
        for (const e of await listEndpointsRaw(ctx, p)) items.push(endpointObserved(p, e))
      else
        for (const b of await listBranchesRaw(ctx, p)) {
          if (type === T_DATABASE)
            for (const d of await listDatabasesRaw(ctx, p, String(b.id)))
              items.push(databaseObserved(p, String(b.id), d))
          else
            for (const r of await listRolesRaw(ctx, p, String(b.id)))
              items.push(roleObserved(p, String(b.id), r))
        }
    }
    return { items, cursor: next }
  },

  /** Plan time: a project / branch / database / role of that name, an endpoint of that type on the branch. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    if (type === T_PROJECT) return findProject(ctx, String(desired.fields.name ?? ''))
    const project = desired.refs?.project
    // A parent made in the same change has no id yet, so nothing can collide yet.
    if (typeof project !== 'string' || !project) return null
    if (!(await projectInOrg(ctx, project))) return null
    if (type === T_BRANCH) {
      const name = String(desired.fields.name ?? '')
      const hit = (await listBranchesRaw(ctx, project)).find((b) => String(b.name) === name)
      return hit ? branchObserved(project, hit) : null
    }
    const ref = desired.refs?.branch
    if (typeof ref !== 'string' || !ref) return null
    const [bp, branch] = ref.split('/')
    if (bp !== project || !branch) return null
    if (type === T_ENDPOINT) {
      const t = String(desired.fields.type ?? 'read_write')
      const hit = (await listEndpointsRaw(ctx, project)).find(
        (e) => e.branch_id === branch && e.type === t
      )
      return hit ? endpointObserved(project, hit) : null
    }
    const name = String(desired.fields.name ?? '')
    if (type === T_DATABASE) return readDatabase(ctx, project, branch, name)
    if (type === T_ROLE) return readRole(ctx, project, branch, name)
    return null
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (!type) return []
    if (type === T_PROJECT)
      return generalPlan(
        { type, mutable: PROJECT_MUTABLE, create: PROJECT_CREATE, pin: ['name'] },
        desired,
        observed
      )
    if (type === T_BRANCH) return planBranch(desired, observed)
    if (type === T_ENDPOINT)
      return generalPlan(
        { type, mutable: ENDPOINT_MUTABLE, create: ENDPOINT_CREATE, pin: ['type'] },
        desired,
        observed
      )
    if (type === T_DATABASE) return planDatabase(desired, observed)
    if (type === T_ROLE) return planRole(desired, observed)
    throw new ProviderError('UNKNOWN_TYPE', `Neon has no ${String(type)}.`)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    if (op.type === T_PROJECT) return applyProject(ctx, op, desired)
    if (op.type === T_BRANCH) return applyBranch(ctx, op, desired)
    if (op.type === T_ENDPOINT) return applyEndpoint(ctx, op, desired)
    if (op.type === T_DATABASE) return applyDatabase(ctx, op, desired)
    if (op.type === T_ROLE) return applyRole(ctx, op, desired)
    throw new ProviderError('UNKNOWN_TYPE', `Neon has no ${op.type}.`)
  },

  async readOutputs(ctx, type, externalId) {
    return outputsFor(ctx, type, externalId)
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Neon.', checkedAt }
    const state = String(seen.status ?? '')
    if (['init', 'creating', 'starting', 'stopping'].includes(state))
      return { status: 'warn', message: `Neon says it is ${state}.`, checkedAt, details: { state } }
    if (state === 'error')
      return {
        status: 'down',
        message: 'Neon reports an error state.',
        checkedAt,
        details: { state }
      }
    return { status: 'ok', checkedAt, ...(state ? { details: { state } } : {}) }
  }
}
