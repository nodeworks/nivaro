import { fieldWords, typedName } from '../plan-words.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag,
  type SecretValue
} from '../types.js'
import { teamIdOf, vercelCall } from './client.js'
import { VERCEL_BUNDLED, vercelEstimate } from './pricing.js'

/**
 * Vercel (`vercel`): team access token + pinned team id. Types: project, environment variable
 * (values are write-only: never read back, never in an Observed — a change is detected by the
 * person sending a new value, `SecretValue.changed`), domain, and deployment (promote / roll back
 * to a recorded deployment id, as named ops). Host `api.vercel.com`; every call carries `teamId`.
 *
 * External ids: project = project id (`prj_…`); env var = `<projectId>/<envId>`; domain =
 * `<projectId>/<domain name>`; deployment = deployment id (`dpl_…`).
 *
 * Production promote risk (decision): `downtime` only when the target build is not READY or its
 * checks concluded `failed`; promoting a healthy, checked build carries no flag.
 */

const WRITE_ROLES = ['OWNER', 'MEMBER', 'DEVELOPER']
const TYPE_PROJECT = 'vercel.project'
const TYPE_ENV = 'vercel.env_var'
const TYPE_DOMAIN = 'vercel.domain'
const TYPE_DEPLOYMENT = 'vercel.deployment'
const PAGE = 20

// ── Small helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function sameValue(a: unknown, b: unknown): boolean {
  const x = norm(a)
  const y = norm(b)
  if (Array.isArray(x) || Array.isArray(y)) {
    const l = (Array.isArray(x) ? x : []).map(String).sort()
    const r = (Array.isArray(y) ? y : []).map(String).sort()
    return l.length === r.length && l.every((v, i) => v === r[i])
  }
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

function isSecret(v: unknown): v is SecretValue {
  return !!v && typeof v === 'object' && 'fingerprint' in (v as object)
}

function split(externalId: string): [string, string] {
  const i = externalId.indexOf('/')
  if (i < 1) throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return [externalId.slice(0, i), externalId.slice(i + 1)]
}

function iso(ms: unknown): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null
}

function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} at Vercel. Adopt it instead of creating it.`,
    {
      retryable: false
    }
  )
}

function refId(desired: DesiredResource | null, field: string): string {
  const v = desired?.refs?.[field]
  if (typeof v === 'string' && v) return v
  throw new ProviderError(
    'INVALID_FIELDS',
    `The ${field} this change belongs to is not created yet.`
  )
}

// ── Observed mappers (never carry a secret value) ──

function projectObserved(p: any): Observed {
  return {
    type: TYPE_PROJECT,
    externalId: String(p.id),
    name: p.name ?? null,
    fields: {
      name: p.name ?? null,
      framework: p.framework ?? null,
      rootDirectory: p.rootDirectory ?? null,
      buildCommand: p.buildCommand ?? null,
      installCommand: p.installCommand ?? null,
      outputDirectory: p.outputDirectory ?? null,
      nodeVersion: p.nodeVersion ?? null,
      repoType: p.link?.type ?? null,
      repo: p.link?.repo ?? null
    },
    tags: {},
    version: p.updatedAt != null ? String(p.updatedAt) : null,
    status: null,
    url: null
  }
}

function envObserved(projectId: string, e: any): Observed {
  return {
    type: TYPE_ENV,
    externalId: `${projectId}/${e.id}`,
    name: e.key ?? null,
    // `value` is write-only here: never copied, even for a plain variable.
    fields: {
      project: projectId,
      key: e.key ?? null,
      type: e.type ?? null,
      target: Array.isArray(e.target) ? e.target : e.target ? [e.target] : [],
      gitBranch: e.gitBranch ?? null
    },
    tags: {},
    version: e.updatedAt != null ? String(e.updatedAt) : null,
    status: null,
    url: null
  }
}

function domainObserved(projectId: string, d: any): Observed {
  return {
    type: TYPE_DOMAIN,
    externalId: `${projectId}/${d.name}`,
    name: d.name ?? null,
    fields: {
      project: projectId,
      name: d.name ?? null,
      redirect: d.redirect ?? null,
      redirectStatusCode: d.redirectStatusCode != null ? String(d.redirectStatusCode) : null,
      gitBranch: d.gitBranch ?? null,
      verified: d.verified ?? null
    },
    tags: {},
    version: d.updatedAt != null ? String(d.updatedAt) : null,
    status: d.verified === false ? 'unverified' : 'verified',
    url: null
  }
}

function deploymentObserved(d: any): Observed {
  const id = String(d.id ?? d.uid)
  const state = d.readyState ?? d.state ?? null
  const target = d.target ?? null
  const production =
    target === 'production' &&
    state === 'READY' &&
    !!d.aliasAssigned &&
    (d.readySubstate ?? 'PROMOTED') !== 'STAGED'
  return {
    type: TYPE_DEPLOYMENT,
    externalId: id,
    name: d.url ?? d.name ?? id,
    fields: {
      project: d.projectId ?? null,
      projectName: d.name ?? null,
      deploymentId: id,
      state,
      target,
      checks: d.checksConclusion ?? null,
      production,
      url: d.url ?? null,
      createdAt: iso(d.createdAt ?? d.created)
    },
    tags: {},
    version: null,
    status: state,
    url: d.url ? `https://${d.url}` : null
  }
}

// ── Reads ──

async function readProject(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const r = await vercelCall(ctx, 'GET', `/v9/projects/${encodeURIComponent(id)}`, { allow: [404] })
  return r.status === 404 ? null : projectObserved(r.body)
}

async function readEnvs(ctx: ProviderContext, projectId: string): Promise<Observed[]> {
  const r = await vercelCall(ctx, 'GET', `/v9/projects/${encodeURIComponent(projectId)}/env`, {
    query: { decrypt: 'false' },
    allow: [404]
  })
  if (r.status === 404) return []
  return (r.body?.envs ?? []).map((e: any) => envObserved(projectId, e))
}

async function readDomain(
  ctx: ProviderContext,
  projectId: string,
  name: string
): Promise<Observed | null> {
  const r = await vercelCall(
    ctx,
    'GET',
    `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(name)}`,
    { allow: [404] }
  )
  return r.status === 404 ? null : domainObserved(projectId, r.body)
}

async function readDeployment(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const r = await vercelCall(ctx, 'GET', `/v13/deployments/${encodeURIComponent(id)}`, {
    allow: [404]
  })
  return r.status === 404 ? null : deploymentObserved(r.body)
}

// ── Resource types ──

const PROJECT_FIELDS = [
  'name',
  'framework',
  'rootDirectory',
  'buildCommand',
  'installCommand',
  'outputDirectory',
  'nodeVersion'
]

const FULL = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: false }

function deploymentDowntime(op: PlannedOp): boolean {
  if (op.action !== 'promote' && op.action !== 'rollback') return false
  const p = op.preconditions ?? {}
  return (p.checks != null && p.checks === 'failed') || (p.state != null && p.state !== 'READY')
}

const TYPES: ResourceTypeSpec[] = [
  {
    key: TYPE_PROJECT,
    label: 'Vercel project',
    scope: 'app',
    nameField: 'name',
    fields: [
      {
        key: 'name',
        label: 'Name',
        kind: 'string',
        required: true,
        pattern: '^[a-z0-9._-]{1,100}$'
      },
      { key: 'framework', label: 'Framework preset', kind: 'string', help: 'e.g. nextjs, vite' },
      { key: 'rootDirectory', label: 'Root directory', kind: 'string' },
      { key: 'buildCommand', label: 'Build command', kind: 'string' },
      { key: 'installCommand', label: 'Install command', kind: 'string' },
      { key: 'outputDirectory', label: 'Output directory', kind: 'string' },
      { key: 'nodeVersion', label: 'Node.js version', kind: 'string', help: 'e.g. 22.x' },
      {
        key: 'repoType',
        label: 'Git provider',
        kind: 'enum',
        createOnly: true,
        options: [
          { value: 'github', label: 'GitHub' },
          { value: 'gitlab', label: 'GitLab' },
          { value: 'bitbucket', label: 'Bitbucket' }
        ]
      },
      { key: 'repo', label: 'Repository', kind: 'string', createOnly: true, help: 'owner/name' }
    ],
    capabilities: FULL,
    reversible: false,
    refs: [],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive', 'data_loss')
      return out
    },
    costClass: () => 'none',
    estimate: vercelEstimate('project')
  },
  {
    key: TYPE_ENV,
    label: 'Vercel environment variable',
    scope: 'app',
    nameField: 'key',
    fields: [
      {
        key: 'project',
        label: 'Project',
        kind: 'ref',
        refType: TYPE_PROJECT,
        required: true,
        replaceOnChange: true
      },
      {
        key: 'key',
        label: 'Name',
        kind: 'string',
        required: true,
        replaceOnChange: true,
        pattern: '^[A-Za-z_][A-Za-z0-9_]*$'
      },
      {
        key: 'value',
        label: 'Value',
        kind: 'secret',
        required: true,
        help: 'Write-only: Vercel never gives the value back, so it is compared by fingerprint.'
      },
      {
        key: 'type',
        label: 'Type',
        kind: 'enum',
        default: 'sensitive',
        replaceOnChange: true,
        options: [
          { value: 'sensitive', label: 'Sensitive' },
          { value: 'encrypted', label: 'Encrypted' },
          { value: 'plain', label: 'Plain' }
        ]
      },
      {
        key: 'target',
        label: 'Environments',
        kind: 'list',
        required: true,
        items: {
          key: 'target',
          label: 'Environment',
          kind: 'enum',
          options: [
            { value: 'production', label: 'Production' },
            { value: 'preview', label: 'Preview' },
            { value: 'development', label: 'Development' }
          ]
        }
      },
      { key: 'gitBranch', label: 'Git branch', kind: 'string', help: 'Preview only' }
    ],
    capabilities: FULL,
    // The value cannot be read, so a value change has no before-state to restore.
    reversible: (field) => field !== 'value',
    refs: [{ field: 'project', type: TYPE_PROJECT, required: true }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive')
      return out
    },
    costClass: () => 'none',
    estimate: vercelEstimate('env_var')
  },
  {
    key: TYPE_DOMAIN,
    label: 'Vercel domain',
    scope: 'app',
    nameField: 'name',
    fields: [
      {
        key: 'project',
        label: 'Project',
        kind: 'ref',
        refType: TYPE_PROJECT,
        required: true,
        replaceOnChange: true
      },
      { key: 'name', label: 'Domain', kind: 'string', required: true, replaceOnChange: true },
      { key: 'redirect', label: 'Redirect to', kind: 'string', help: 'Another domain, or empty' },
      {
        key: 'redirectStatusCode',
        label: 'Redirect status',
        kind: 'enum',
        options: [
          { value: '301', label: '301' },
          { value: '302', label: '302' },
          { value: '307', label: '307' },
          { value: '308', label: '308' }
        ]
      },
      { key: 'gitBranch', label: 'Git branch', kind: 'string' },
      { key: 'verified', label: 'Verified', kind: 'boolean', readOnly: true }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [{ field: 'project', type: TYPE_PROJECT, required: true }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'create') out.push('public_exposure')
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive', 'downtime')
      return out
    },
    costClass: () => 'none',
    estimate: vercelEstimate('domain')
  },
  {
    key: TYPE_DEPLOYMENT,
    label: 'Vercel deployment',
    scope: 'app',
    nameField: 'deploymentId',
    fields: [
      {
        key: 'project',
        label: 'Project',
        kind: 'ref',
        refType: TYPE_PROJECT,
        required: true,
        createOnly: true
      },
      { key: 'deploymentId', label: 'Deployment id', kind: 'string', readOnly: true },
      {
        key: 'mode',
        label: 'Make it live by',
        kind: 'enum',
        default: 'promote',
        help: 'Promote a newer build, or roll back to an earlier one.',
        options: [
          { value: 'promote', label: 'Promote to production' },
          { value: 'rollback', label: 'Roll production back to it' }
        ]
      },
      { key: 'state', label: 'Build state', kind: 'string', readOnly: true },
      { key: 'target', label: 'Target', kind: 'string', readOnly: true },
      { key: 'checks', label: 'Checks', kind: 'string', readOnly: true },
      { key: 'production', label: 'Live in production', kind: 'boolean', readOnly: true },
      { key: 'url', label: 'Address', kind: 'string', readOnly: true },
      { key: 'createdAt', label: 'Created', kind: 'string', readOnly: true }
    ],
    // Deployments are made by Git / CI: the Hub adopts one and points production at it.
    capabilities: {
      create: false,
      update: true,
      delete: false,
      adopt: true,
      snapshot: false,
      tag: false
    },
    // Undo of a promote is another rollback the person plans; the previous live build is not recorded.
    reversible: false,
    refs: [{ field: 'project', type: TYPE_PROJECT, required: true }],
    risk(op) {
      return deploymentDowntime(op) ? ['downtime'] : []
    },
    costClass: () => 'none',
    estimate: vercelEstimate('deployment')
  }
]

// ── Plan ──

function secretChange(v: unknown): boolean {
  return isSecret(v) ? v.changed : v !== undefined
}

/** A type's label and the labels of its fields, for plan reasons. */
const specOf = (type: string) => TYPES.find((t) => t.key === type)
const labelOf = (type: string) => specOf(type)?.label ?? type
const wordsOf = (type: string, changes: Array<{ field: string }>) =>
  fieldWords(specOf(type)?.fields, changes)

function planProject(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: TYPE_PROJECT,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(labelOf(TYPE_PROJECT), observed.name)} and all of its deployments.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  if (!observed) {
    const changes = PROJECT_FIELDS.concat(['repoType', 'repo'])
      .filter((k) => norm(desired.fields[k]) !== null)
      .map((k) => ({ field: k, to: desired.fields[k] }))
    return [
      {
        kind: 'create',
        type: TYPE_PROJECT,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(labelOf(TYPE_PROJECT), String(desired.fields.name ?? ''))}.`,
        changes,
        preconditions: {},
        risk: []
      }
    ]
  }
  const changes = diffFields(PROJECT_FIELDS, desired.fields, observed.fields)
  if (!changes.length) return []
  const pre: Record<string, unknown> = { version: observed.version ?? null }
  for (const c of changes) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: TYPE_PROJECT,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${wordsOf(TYPE_PROJECT, changes)} on ${typedName(labelOf(TYPE_PROJECT), observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

function planEnv(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: TYPE_ENV,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(labelOf(TYPE_ENV), observed.name)}.`,
        changes: [],
        preconditions: { key: observed.fields.key, target: observed.fields.target },
        risk: []
      }
    ]
  }
  const targets = (desired.fields.target as string[] | undefined) ?? []
  const secretChanged = secretChange(desired.fields.value)
  if (!observed) {
    return [
      {
        kind: 'create',
        type: TYPE_ENV,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(labelOf(TYPE_ENV), String(desired.fields.key ?? ''))} for ${targets.join(', ') || 'no environment'}.`,
        changes: [
          { field: 'key', to: desired.fields.key },
          { field: 'type', to: desired.fields.type ?? 'sensitive' },
          { field: 'target', to: targets },
          { field: 'gitBranch', to: norm(desired.fields.gitBranch) },
          { field: 'value', secret: true }
        ],
        preconditions: {},
        risk: []
      }
    ]
  }
  const replaceKeys = ['key', 'type']
  const replaceChanges = diffFields(replaceKeys, desired.fields, observed.fields)
  const refChanged =
    typeof desired.refs.project === 'string' && desired.refs.project !== observed.fields.project
  if (replaceChanges.length || refChanged) {
    return [
      {
        kind: 'replace',
        type: TYPE_ENV,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(labelOf(TYPE_ENV), observed.name)}: ${refChanged ? 'its project' : wordsOf(TYPE_ENV, replaceChanges)} cannot change in place.`,
        changes: [
          ...replaceChanges,
          ...(refChanged
            ? [{ field: 'project', from: observed.fields.project, to: desired.refs.project }]
            : []),
          { field: 'value', secret: true }
        ],
        preconditions: {
          key: observed.fields.key,
          type: observed.fields.type,
          version: observed.version ?? null
        },
        risk: []
      }
    ]
  }
  const changes = diffFields(['target', 'gitBranch'], desired.fields, observed.fields)
  if (secretChanged) changes.push({ field: 'value', secret: true })
  if (!changes.length) return []
  const pre: Record<string, unknown> = { version: observed.version ?? null }
  for (const c of changes) if (!c.secret) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: TYPE_ENV,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${wordsOf(TYPE_ENV, changes)} on ${typedName(labelOf(TYPE_ENV), observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

function planDomain(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: TYPE_DOMAIN,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Remove ${typedName(labelOf(TYPE_DOMAIN), observed.name)} from the project.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  if (!observed) {
    return [
      {
        kind: 'create',
        type: TYPE_DOMAIN,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Add ${typedName(labelOf(TYPE_DOMAIN), String(desired.fields.name ?? ''))} to the project.`,
        changes: ['name', 'redirect', 'redirectStatusCode', 'gitBranch']
          .filter((k) => norm(desired.fields[k]) !== null)
          .map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: []
      }
    ]
  }
  const replace = diffFields(['name'], desired.fields, observed.fields)
  const refChanged =
    typeof desired.refs.project === 'string' && desired.refs.project !== observed.fields.project
  if (replace.length || refChanged) {
    return [
      {
        kind: 'replace',
        type: TYPE_DOMAIN,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(labelOf(TYPE_DOMAIN), observed.name)}: the domain or its project changed.`,
        changes: replace,
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  const changes = diffFields(
    ['redirect', 'redirectStatusCode', 'gitBranch'],
    desired.fields,
    observed.fields
  )
  if (!changes.length) return []
  const pre: Record<string, unknown> = { version: observed.version ?? null }
  for (const c of changes) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: TYPE_DOMAIN,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${wordsOf(TYPE_DOMAIN, changes)} on ${typedName(labelOf(TYPE_DOMAIN), observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

function planDeployment(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired || !observed)
    throw new ProviderError(
      'CAPABILITY_MISSING',
      'Deployments are made by Git or CI: the Hub can adopt, promote or roll one back, not create or delete it.'
    )
  const wantedProject = desired.refs?.project
  if (typeof wantedProject !== 'string' || !wantedProject)
    throw new ProviderError('INVALID_FIELDS', 'The project this deployment belongs to is not set.')
  if (observed.fields.project !== wantedProject)
    throw new ProviderError(
      'PROJECT_MISMATCH',
      `Deployment ${observed.externalId} belongs to project ${String(observed.fields.projectName ?? observed.fields.project)}, not the one this change names.`
    )
  if (observed.fields.production === true) return []
  const projectName = (observed.fields.projectName as string | null) ?? wantedProject
  const mode = desired.fields.mode === 'rollback' ? 'rollback' : 'promote'
  const checks = observed.fields.checks ?? null
  const state = observed.fields.state ?? null
  const bad =
    checks === 'failed'
      ? ' Its checks failed.'
      : state && state !== 'READY'
        ? ` Its build is ${String(state).toLowerCase()}.`
        : ''
  return [
    {
      kind: 'update',
      type: TYPE_DEPLOYMENT,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      action: mode,
      reason: `${mode === 'rollback' ? 'Roll production back to' : 'Promote'} ${typedName(labelOf(TYPE_DEPLOYMENT), observed.externalId)} of ${typedName(labelOf(TYPE_PROJECT), projectName)} to production.${bad}`,
      changes: [{ field: 'production', from: false, to: true }],
      preconditions: {
        production: false,
        project: wantedProject,
        projectName,
        state,
        checks,
        target: observed.fields.target ?? null
      },
      risk: [],
      data: {
        deploymentId: observed.externalId,
        projectId: (observed.fields.project as string | null) ?? null
      }
    }
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

function envBody(desired: DesiredResource, withValue: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    key: desired.fields.key,
    type: desired.fields.type ?? 'sensitive',
    target: desired.fields.target ?? []
  }
  if (norm(desired.fields.gitBranch) !== null) body.gitBranch = desired.fields.gitBranch
  if (withValue) {
    const v = desired.fields.value
    const plain = isSecret(v) ? v.plain : typeof v === 'string' ? v : undefined
    if (plain === undefined)
      throw new ProviderError(
        'INVALID_FIELDS',
        'A value is needed to add this environment variable.'
      )
    body.value = plain
  }
  return body
}

function plainOf(desired: DesiredResource | null): string[] {
  const v = desired?.fields?.value
  const plain = isSecret(v) ? v.plain : typeof v === 'string' ? v : undefined
  return plain ? [plain] : []
}

function overlaps(a: unknown, b: unknown): boolean {
  const l = Array.isArray(a) ? a : []
  const r = Array.isArray(b) ? b : []
  return l.some((x) => r.includes(x))
}

async function applyProject(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const id = op.externalId as string
    if (!(await readProject(ctx, id))) return ok(id, null, { already: 'gone' })
    await vercelCall(ctx, 'DELETE', `/v9/projects/${encodeURIComponent(id)}`)
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'create') {
    const name = String(desired.fields.name)
    const existing = await readProject(ctx, name)
    if (existing) {
      // Only a resumed run (this resource already recorded that id) may reuse it.
      if (desired.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists(`A project named ${name} already exists`)
    }
    const body: Record<string, unknown> = { name }
    for (const k of PROJECT_FIELDS.slice(1))
      if (norm(desired.fields[k]) !== null) body[k] = desired.fields[k]
    if (norm(desired.fields.repo) !== null)
      body.gitRepository = { type: desired.fields.repoType ?? 'github', repo: desired.fields.repo }
    const r = await vercelCall(ctx, 'POST', '/v11/projects', { body })
    const created = projectObserved(r.body)
    return ok(created.externalId, created)
  }
  const id = op.externalId as string
  const have = await readProject(ctx, id)
  if (!have) throw new ProviderError('NOT_FOUND', 'The project no longer exists.', { status: 404 })
  const changes = diffFields(PROJECT_FIELDS, desired.fields, have.fields)
  if (!changes.length) return ok(id, have, { already: 'matches' })
  const body: Record<string, unknown> = {}
  for (const c of changes) body[c.field] = c.to
  const r = await vercelCall(ctx, 'PATCH', `/v9/projects/${encodeURIComponent(id)}`, { body })
  return ok(id, projectObserved(r.body))
}

async function applyEnv(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const extra = plainOf(desired)
  const call = { extraScrub: extra }
  const removeOne = async (externalId: string) => {
    const [pid, eid] = split(externalId)
    await vercelCall(
      ctx,
      'DELETE',
      `/v9/projects/${encodeURIComponent(pid)}/env/${encodeURIComponent(eid)}`,
      {
        ...call,
        allow: [404]
      }
    )
  }
  const addOne = async (pid: string): Promise<OpResult> => {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
    const existing = (await readEnvs(ctx, pid)).find(
      (e) =>
        e.fields.key === desired.fields.key &&
        overlaps(e.fields.target, desired.fields.target) &&
        sameValue(e.fields.gitBranch, desired.fields.gitBranch)
    )
    if (existing) {
      if (desired.externalId !== existing.externalId)
        throw alreadyExists(
          `Environment variable ${String(desired.fields.key)} already exists for ${(existing.fields.target as string[]).join(', ')}`
        )
      // A resumed create: refresh the value only, never the type or the targets.
      const [, eid] = split(existing.externalId)
      const r = await vercelCall(
        ctx,
        'PATCH',
        `/v9/projects/${encodeURIComponent(pid)}/env/${encodeURIComponent(eid)}`,
        { ...call, body: { value: envBody(desired, true).value } }
      )
      return ok(existing.externalId, envObserved(pid, r.body ?? existing.fields), {
        already: 'exists'
      })
    }
    const r = await vercelCall(ctx, 'POST', `/v10/projects/${encodeURIComponent(pid)}/env`, {
      ...call,
      body: envBody(desired, true)
    })
    const made = r.body?.created ?? r.body
    const row = Array.isArray(made) ? made[0] : made
    const seen = envObserved(pid, row)
    return ok(seen.externalId, seen)
  }

  if (op.kind === 'delete') {
    const id = op.externalId as string
    await removeOne(id)
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'create') return addOne(refId(desired, 'project'))
  if (op.kind === 'replace') {
    // Check the new value is at hand BEFORE the old variable goes away.
    envBody(desired, true)
    await removeOne(op.externalId as string)
    return addOne(refId(desired, 'project'))
  }
  const externalId = op.externalId as string
  const [pid, eid] = split(externalId)
  const have = (await readEnvs(ctx, pid)).find((e) => e.externalId === externalId)
  if (!have) throw new ProviderError('NOT_FOUND', 'The variable no longer exists.', { status: 404 })
  const diff = diffFields(['target', 'gitBranch'], desired.fields, have.fields)
  const v = desired.fields.value
  const newValue = isSecret(v) && v.changed ? v.plain : undefined
  if (!diff.length && newValue === undefined) return ok(externalId, have, { already: 'matches' })
  const body: Record<string, unknown> = {}
  for (const c of diff) body[c.field] = c.to
  if (newValue !== undefined) body.value = newValue
  const r = await vercelCall(
    ctx,
    'PATCH',
    `/v9/projects/${encodeURIComponent(pid)}/env/${encodeURIComponent(eid)}`,
    { ...call, body }
  )
  return ok(externalId, envObserved(pid, r.body ?? have.fields))
}

async function applyDomain(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const removeOne = async (externalId: string) => {
    const [pid, name] = split(externalId)
    await vercelCall(
      ctx,
      'DELETE',
      `/v9/projects/${encodeURIComponent(pid)}/domains/${encodeURIComponent(name)}`,
      { allow: [404] }
    )
  }
  const addOne = async (pid: string): Promise<OpResult> => {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
    const name = String(desired.fields.name)
    const existing = await readDomain(ctx, pid, name)
    if (existing) {
      if (desired.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists(`Domain ${name} is already on this project`)
    }
    const body: Record<string, unknown> = { name }
    for (const k of ['redirect', 'gitBranch'])
      if (norm(desired.fields[k]) !== null) body[k] = desired.fields[k]
    if (norm(desired.fields.redirectStatusCode) !== null)
      body.redirectStatusCode = Number(desired.fields.redirectStatusCode)
    const r = await vercelCall(ctx, 'POST', `/v10/projects/${encodeURIComponent(pid)}/domains`, {
      body
    })
    const seen = domainObserved(pid, r.body)
    return ok(seen.externalId, seen)
  }
  if (op.kind === 'delete') {
    await removeOne(op.externalId as string)
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'create') return addOne(refId(desired, 'project'))
  if (op.kind === 'replace') {
    await removeOne(op.externalId as string)
    return addOne(refId(desired, 'project'))
  }
  const externalId = op.externalId as string
  const [pid, name] = split(externalId)
  const have = await readDomain(ctx, pid, name)
  if (!have) throw new ProviderError('NOT_FOUND', 'The domain no longer exists.', { status: 404 })
  const diff = diffFields(
    ['redirect', 'redirectStatusCode', 'gitBranch'],
    desired.fields,
    have.fields
  )
  if (!diff.length) return ok(externalId, have, { already: 'matches' })
  const body: Record<string, unknown> = {}
  for (const c of diff)
    body[c.field] = c.field === 'redirectStatusCode' && c.to != null ? Number(c.to) : c.to
  const r = await vercelCall(
    ctx,
    'PATCH',
    `/v9/projects/${encodeURIComponent(pid)}/domains/${encodeURIComponent(name)}`,
    { body }
  )
  return ok(externalId, domainObserved(pid, r.body))
}

async function applyDeployment(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const action = op.action
  if (action !== 'promote' && action !== 'rollback')
    throw new ProviderError(
      'CAPABILITY_MISSING',
      'A deployment can only be promoted or rolled back.'
    )
  const id = op.externalId as string
  const have = await readDeployment(ctx, id)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The deployment no longer exists.', { status: 404 })
  if (have.fields.production === true) return ok(id, have, { already: 'production' })
  const wanted = desired?.refs?.project
  if (typeof wanted !== 'string' || !wanted)
    throw new ProviderError('INVALID_FIELDS', 'The project this deployment belongs to is not set.')
  const pid = String(have.fields.project ?? '')
  if (pid !== wanted)
    throw new ProviderError(
      'PROJECT_MISMATCH',
      `Deployment ${id} belongs to a different project than the one this change names. Nothing was changed.`
    )
  const path =
    action === 'promote'
      ? `/v10/projects/${encodeURIComponent(pid)}/promote/${encodeURIComponent(id)}`
      : `/v9/projects/${encodeURIComponent(pid)}/rollback/${encodeURIComponent(id)}`
  await vercelCall(ctx, 'POST', path)
  // The alias switch is asynchronous: report what Vercel says now, the drift check sees the rest.
  const after = await readDeployment(ctx, id)
  return ok(id, after, { requested: action })
}

// ── List ──

async function listProjects(ctx: ProviderContext, cursor?: string | null) {
  const r = await vercelCall(ctx, 'GET', '/v9/projects', {
    query: { limit: PAGE, until: cursor ?? undefined }
  })
  const next = r.body?.pagination?.next
  return {
    projects: (r.body?.projects ?? []) as any[],
    next: next != null ? String(next) : null
  }
}

// ── The adapter ──

export const vercelAdapter: ProviderAdapter = {
  bundledPrices: VERCEL_BUNDLED,
  key: 'vercel',
  label: 'Vercel',
  connection: {
    fields: [
      {
        key: 'teamId',
        label: 'Team id',
        kind: 'string',
        required: true,
        placeholder: 'team_…',
        help: 'Pinned: every call is scoped to this team.'
      },
      {
        key: 'token',
        label: 'Access token',
        kind: 'string',
        secret: true,
        required: true,
        help: 'A team access token (Vercel → Account → Tokens).'
      }
    ],
    hosts: () => ['api.vercel.com'],
    describe: (config) => `Vercel team ${String(config.teamId ?? '')}`,
    validate(config, secrets) {
      const problems: string[] = []
      if (!/^team_[A-Za-z0-9]+$/.test(String(config.teamId ?? '')))
        problems.push('The team id looks like team_ followed by letters and digits.')
      if (secrets.token !== undefined && !secrets.token.trim())
        problems.push('The access token is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const needs = (has: { read: boolean; write: boolean }) =>
      TYPES.flatMap((t) => [
        { type: t.key, need: `read ${t.key}`, has: has.read },
        { type: t.key, need: `write ${t.key} (team role Developer or above)`, has: has.write }
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
    let team: any
    try {
      const r = await vercelCall(ctx, 'GET', `/v2/teams/${encodeURIComponent(teamIdOf(ctx))}`, {
        allow: [403, 404]
      })
      if (r.status !== 200)
        return fail('The token cannot see this team (check the team id and the token scope).')
      team = r.body
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    let canRead = false
    try {
      const r = await vercelCall(ctx, 'GET', '/v9/projects', { query: { limit: 1 }, allow: [403] })
      canRead = r.status === 200
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err
    }
    const role = String(team?.membership?.role ?? '').toUpperCase()
    const canWrite = canRead && WRITE_ROLES.includes(role)
    const permissions = needs({ read: canRead, write: canWrite })
    return {
      ok: canRead,
      identity: `team ${team?.slug ?? teamIdOf(ctx)}${role ? ` (${role.toLowerCase()})` : ''}`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need)
    }
  },

  async observe(ctx, type, externalId) {
    if (type === TYPE_PROJECT) return readProject(ctx, externalId)
    if (type === TYPE_DEPLOYMENT) return readDeployment(ctx, externalId)
    const [pid, rest] = split(externalId)
    if (type === TYPE_DOMAIN) return readDomain(ctx, pid, rest)
    if (type === TYPE_ENV)
      return (await readEnvs(ctx, pid)).find((e) => e.externalId === externalId) ?? null
    throw new ProviderError('UNKNOWN_TYPE', `Vercel has no ${type}.`)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    if (type === TYPE_PROJECT) {
      const { projects, next } = await listProjects(ctx, cursor)
      return { items: projects.map(projectObserved), cursor: next }
    }
    if (type !== TYPE_ENV && type !== TYPE_DOMAIN && type !== TYPE_DEPLOYMENT)
      throw new ProviderError('UNKNOWN_TYPE', `Vercel has no ${type}.`)
    // Children are listed per page of projects; the cursor pages the projects.
    const { projects, next } = await listProjects(ctx, cursor)
    const items: Observed[] = []
    for (const p of projects) {
      const pid = String(p.id)
      if (type === TYPE_ENV) items.push(...(await readEnvs(ctx, pid)))
      else if (type === TYPE_DOMAIN) {
        const r = await vercelCall(ctx, 'GET', `/v9/projects/${encodeURIComponent(pid)}/domains`, {
          allow: [404]
        })
        for (const d of r.body?.domains ?? []) items.push(domainObserved(pid, d))
      } else {
        const r = await vercelCall(ctx, 'GET', '/v6/deployments', {
          query: { projectId: pid, target: 'production', limit: PAGE },
          allow: [404]
        })
        for (const d of r.body?.deployments ?? [])
          items.push(deploymentObserved({ ...d, projectId: pid }))
      }
    }
    return { items, cursor: next }
  },

  /** Plan time: a project of that name, a variable with that key and target, a domain on the project. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    if (type === TYPE_PROJECT) return readProject(ctx, String(desired.fields.name ?? ''))
    if (type !== TYPE_ENV && type !== TYPE_DOMAIN) return null
    const pid = desired.refs?.project
    // A project made in the same change has no id yet, so nothing can collide yet.
    if (typeof pid !== 'string' || !pid) return null
    if (type === TYPE_DOMAIN) return readDomain(ctx, pid, String(desired.fields.name ?? ''))
    return (
      (await readEnvs(ctx, pid)).find(
        (e) =>
          e.fields.key === desired.fields.key &&
          overlaps(e.fields.target, desired.fields.target) &&
          sameValue(e.fields.gitBranch, desired.fields.gitBranch)
      ) ?? null
    )
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === TYPE_PROJECT) return planProject(desired, observed)
    if (type === TYPE_ENV) return planEnv(desired, observed)
    if (type === TYPE_DOMAIN) return planDomain(desired, observed)
    if (type === TYPE_DEPLOYMENT) return planDeployment(desired, observed)
    throw new ProviderError('UNKNOWN_TYPE', `Vercel has no ${String(type)}.`)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    if (op.type === TYPE_PROJECT) return applyProject(ctx, op, desired)
    if (op.type === TYPE_ENV) return applyEnv(ctx, op, desired)
    if (op.type === TYPE_DOMAIN) return applyDomain(ctx, op, desired)
    if (op.type === TYPE_DEPLOYMENT) return applyDeployment(ctx, op, desired)
    throw new ProviderError('UNKNOWN_TYPE', `Vercel has no ${op.type}.`)
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Vercel.', checkedAt }
    if (type === TYPE_DEPLOYMENT) {
      const state = String(seen.fields.state ?? '')
      if (state === 'READY' && seen.fields.checks !== 'failed')
        return { status: 'ok', checkedAt, details: { state } }
      if (state === 'ERROR' || state === 'CANCELED')
        return {
          status: 'down',
          message: `Build ${state.toLowerCase()}.`,
          checkedAt,
          details: { state }
        }
      return {
        status: 'warn',
        message: `Build ${state.toLowerCase() || 'unknown'}.`,
        checkedAt,
        details: { state }
      }
    }
    if (type === TYPE_DOMAIN && seen.fields.verified === false)
      return { status: 'warn', message: 'The domain is not verified yet.', checkedAt }
    return { status: 'ok', checkedAt }
  }
}
