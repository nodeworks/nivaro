import { fieldWords, typedName } from '../plan-words.js'
import { estimateOf, unknownEstimate } from '../pricing/index.js'
import {
  type ConnectionTest,
  type CostEstimate,
  type CostRow,
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
  type RiskFlag,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import { clip, ORG, openaiCall, openaiPages, segment } from './client.js'

/**
 * OpenAI (`openai`): an organization admin key (sealed) and, optionally, the organization id
 * (sent as a header). Host `api.openai.com`. Types: `openai.project` (create, rename, archive),
 * `openai.service_account` (per environment; its API key is the once-only output `api_key`),
 * `openai.project_user`, `openai.project_rate_limit` (per model; OpenAI makes the limits, the Hub
 * sets them) and `openai.project_api_key` (read, adopt, delete only).
 *
 * Provider ids: a project is `<projectId>`; everything inside one is `<projectId>:<childId>`
 * (OpenAI ids never hold a colon). Children are always judged through their project: an op
 * whose id names another project than `desired.refs.project` is refused PROJECT_MISMATCH.
 * Archive is the delete of a project (OpenAI cannot bring an archived project back) and an
 * archived project reads as gone. Estimates and the run-rate come from usage, not a price table.
 */

const T = {
  project: 'openai.project',
  serviceAccount: 'openai.service_account',
  projectUser: 'openai.project_user',
  rateLimit: 'openai.project_rate_limit',
  apiKey: 'openai.project_api_key'
} as const

const CONSOLE = 'https://platform.openai.com/settings/organization'

export const RATE_LIMIT_FIELDS = [
  'max_requests_per_1_minute',
  'max_tokens_per_1_minute',
  'max_images_per_1_minute',
  'max_audio_megabytes_per_1_minute',
  'max_requests_per_1_day',
  'batch_1_day_max_input_tokens'
] as const

// ── Small helpers ──

const norm = (v: unknown): unknown => (v === '' || v === undefined ? null : v)

function diffFields(
  keys: readonly string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>,
  /** true = a wanted null / empty means "leave it alone" (rate limits). */
  skipEmpty = false
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (skipEmpty && norm(want[k]) === null) continue
    if (norm(want[k]) !== norm(have[k]))
      out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
}

const alreadyExists = (what: string): ProviderError =>
  new ProviderError(
    'ALREADY_EXISTS',
    `${what} already exists at OpenAI. Adopt it instead of creating it.`,
    { retryable: false }
  )

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

/** `<project>:<child>` → both parts, each a safe path segment. */
export function splitId(ext: unknown): { project: string; child: string } {
  const s = typeof ext === 'string' ? ext : ''
  const i = s.indexOf(':')
  if (i < 1) throw new ProviderError('BAD_ID', 'The provider id has the wrong shape.')
  const project = s.slice(0, i)
  const child = s.slice(i + 1)
  segment(project)
  segment(child)
  return { project, child }
}

/** The project a child's desired state points at (resolved by the engine). */
function projectOf(desired: DesiredResource): string {
  const p = desired.refs.project
  if (typeof p !== 'string' || !p)
    throw new ProviderError('INVALID_FIELDS', 'The project is not created yet.')
  segment(p)
  return p
}

/** A named op must stay inside the project its desired state names. */
function sameProject(externalId: string, desired: DesiredResource | null): string {
  const { project } = splitId(externalId)
  if (desired && projectOf(desired) !== project)
    throw new ProviderError(
      'PROJECT_MISMATCH',
      'That resource belongs to a different project than the one this change names.'
    )
  return project
}

// ── Observed mappers (never carry a key value) ──

function projectObserved(p: any): Observed {
  return {
    type: T.project,
    externalId: String(p.id),
    name: p.name ?? null,
    fields: { name: p.name ?? null, status: p.status ?? 'active' },
    tags: {},
    version: null,
    status: p.status ?? null,
    url: `${CONSOLE}/projects`
  }
}

function serviceAccountObserved(project: string, s: any): Observed {
  return {
    type: T.serviceAccount,
    externalId: `${project}:${s.id}`,
    name: s.name ?? null,
    fields: { project, name: s.name ?? null, role: s.role ?? null },
    tags: {},
    version: null,
    status: null,
    url: `${CONSOLE}/projects`
  }
}

function projectUserObserved(project: string, u: any): Observed {
  return {
    type: T.projectUser,
    externalId: `${project}:${u.id}`,
    name: u.email ?? u.name ?? null,
    fields: { project, email: u.email ?? null, role: u.role ?? null },
    tags: {},
    version: null,
    status: null,
    url: `${CONSOLE}/projects`
  }
}

function rateLimitObserved(project: string, r: any): Observed {
  const fields: Record<string, unknown> = { project, model: r.model ?? null }
  for (const k of RATE_LIMIT_FIELDS) fields[k] = typeof r[k] === 'number' ? r[k] : null
  return {
    type: T.rateLimit,
    externalId: `${project}:${r.id}`,
    name: r.model ?? null,
    fields,
    tags: {},
    version: null,
    status: null,
    url: `${CONSOLE}/limits`
  }
}

function apiKeyObserved(project: string, k: any): Observed {
  const owner = k.owner ?? {}
  const ownerType = String(owner.type ?? '')
  const ownerRecord = ownerType === 'service_account' ? owner.service_account : owner.user
  return {
    type: T.apiKey,
    externalId: `${project}:${k.id}`,
    name: k.name ?? null,
    fields: {
      project,
      name: k.name ?? null,
      redacted: k.redacted_value ?? null,
      owner_type: ownerType || null,
      owner: ownerRecord?.name ?? ownerRecord?.email ?? ownerRecord?.id ?? null
    },
    tags: {},
    version: null,
    status: null,
    url: `${CONSOLE}/api-keys`
  }
}

// ── Reads ──

async function readProjectRaw(ctx: ProviderContext, id: string): Promise<any | null> {
  const r = await openaiCall(ctx, 'GET', `${ORG}/projects/${segment(id)}`, { allow: [404] })
  if (r.status === 404 || !r.body || typeof r.body !== 'object') return null
  if (String(r.body.status ?? '').toLowerCase() === 'archived') return null
  return r.body
}

async function listProjectsRaw(ctx: ProviderContext): Promise<any[]> {
  return (await openaiPages(ctx, `${ORG}/projects`)).filter(
    (p) => p && String(p.status ?? '').toLowerCase() !== 'archived'
  )
}

/** A child's parent must exist and not be archived: a missing one reads the child as gone. */
async function parentLive(ctx: ProviderContext, project: string): Promise<boolean> {
  return (await readProjectRaw(ctx, project)) !== null
}

async function readServiceAccount(ctx: ProviderContext, ext: string): Promise<Observed | null> {
  const { project, child } = splitId(ext)
  if (!(await parentLive(ctx, project))) return null
  const r = await openaiCall(
    ctx,
    'GET',
    `${ORG}/projects/${segment(project)}/service_accounts/${segment(child)}`,
    { allow: [404] }
  )
  if (r.status === 404 || !r.body?.id) return null
  return serviceAccountObserved(project, r.body)
}

async function readProjectUser(ctx: ProviderContext, ext: string): Promise<Observed | null> {
  const { project, child } = splitId(ext)
  if (!(await parentLive(ctx, project))) return null
  const r = await openaiCall(
    ctx,
    'GET',
    `${ORG}/projects/${segment(project)}/users/${segment(child)}`,
    { allow: [404] }
  )
  if (r.status === 404 || !r.body?.id) return null
  return projectUserObserved(project, r.body)
}

async function listRateLimits(ctx: ProviderContext, project: string): Promise<any[]> {
  return openaiPages(ctx, `${ORG}/projects/${segment(project)}/rate_limits`)
}

async function readRateLimit(ctx: ProviderContext, ext: string): Promise<Observed | null> {
  const { project, child } = splitId(ext)
  if (!(await parentLive(ctx, project))) return null
  const hit = (await listRateLimits(ctx, project)).find((r) => r?.id === child)
  return hit ? rateLimitObserved(project, hit) : null
}

async function readApiKey(ctx: ProviderContext, ext: string): Promise<Observed | null> {
  const { project, child } = splitId(ext)
  if (!(await parentLive(ctx, project))) return null
  const r = await openaiCall(
    ctx,
    'GET',
    `${ORG}/projects/${segment(project)}/api_keys/${segment(child)}`,
    { allow: [404] }
  )
  if (r.status === 404 || !r.body?.id) return null
  return apiKeyObserved(project, r.body)
}

async function orgUserIdByEmail(ctx: ProviderContext, email: string): Promise<string | null> {
  const want = email.trim().toLowerCase()
  const users = await openaiPages(ctx, `${ORG}/users`, {}, 100)
  const hit = users.find((u) => String(u?.email ?? '').toLowerCase() === want)
  return hit?.id ? String(hit.id) : null
}

// ── Field specs ──

const PROJECT_REF: FieldSpec = {
  key: 'project',
  label: 'Project',
  kind: 'ref',
  refType: T.project,
  required: true,
  replaceOnChange: true,
  createOnly: true
}

const PROJECT_FIELDS: FieldSpec[] = [
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    required: true,
    pattern: '^.{1,128}$'
  },
  { key: 'status', label: 'Status', kind: 'string', readOnly: true }
]

const SA_FIELDS: FieldSpec[] = [
  PROJECT_REF,
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    required: true,
    replaceOnChange: true,
    pattern: '^.{1,128}$',
    help: 'A new name makes a new service account (and a new key). OpenAI cannot rename one.'
  },
  { key: 'role', label: 'Role', kind: 'string', readOnly: true },
  {
    key: ROTATE_OUTPUTS_FIELD,
    label: 'Make a new key now',
    kind: 'boolean',
    trigger: true,
    help: 'OpenAI shows a service account key once. This makes a new service account with the same name, hands its key to what is bound to it and removes the old one.'
  }
]

const USER_FIELDS: FieldSpec[] = [
  PROJECT_REF,
  {
    key: 'email',
    label: 'Email',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    help: 'A person who is already in the organization. The Hub never invites anyone.'
  },
  {
    key: 'role',
    label: 'Role',
    kind: 'enum',
    required: true,
    options: [
      { value: 'member', label: 'Member' },
      { value: 'owner', label: 'Owner' }
    ],
    default: 'member'
  }
]

const RL_NUMBER = (key: string, label: string): FieldSpec => ({
  key,
  label,
  kind: 'number',
  min: 0,
  help: 'Leave empty to keep what OpenAI has.'
})

const RATE_FIELDS: FieldSpec[] = [
  PROJECT_REF,
  {
    key: 'model',
    label: 'Model',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    help: 'The model name, for example gpt-4o. OpenAI makes the limit; the Hub sets its numbers.'
  },
  RL_NUMBER('max_requests_per_1_minute', 'Requests per minute'),
  RL_NUMBER('max_tokens_per_1_minute', 'Tokens per minute'),
  RL_NUMBER('max_images_per_1_minute', 'Images per minute'),
  RL_NUMBER('max_audio_megabytes_per_1_minute', 'Audio megabytes per minute'),
  RL_NUMBER('max_requests_per_1_day', 'Requests per day'),
  RL_NUMBER('batch_1_day_max_input_tokens', 'Batch input tokens per day')
]

const KEY_FIELDS: FieldSpec[] = [
  { ...PROJECT_REF, readOnly: true },
  { key: 'name', label: 'Name', kind: 'string', readOnly: true },
  { key: 'redacted', label: 'Key (redacted)', kind: 'string', readOnly: true },
  { key: 'owner_type', label: 'Owner type', kind: 'string', readOnly: true },
  { key: 'owner', label: 'Owner', kind: 'string', readOnly: true }
]

const words = (fields: FieldSpec[], changes: Array<{ field: string }>) =>
  fieldWords(fields, changes)

// ── Planning ──

function deleteOp(
  type: string,
  observed: Observed,
  label: string,
  reason: string,
  pre: Record<string, unknown>
): PlannedOp {
  return {
    kind: 'delete',
    type,
    resourceId: null,
    externalId: observed.externalId,
    reason: `${reason} ${typedName(label, observed.name)}`.trim(),
    changes: [],
    preconditions: pre,
    risk: []
  }
}

function planProject(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const label = 'OpenAI project'
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: T.project,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Archive ${typedName(label, observed.name)}. Its service accounts and keys stop working and OpenAI cannot bring an archived project back. There is no way back.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  if (!observed)
    return [
      {
        kind: 'create',
        type: T.project,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(label, String(desired.fields.name ?? ''))}.`,
        changes: [{ field: 'name', to: desired.fields.name }],
        preconditions: {},
        risk: []
      }
    ]
  const changes = diffFields(['name'], desired.fields, observed.fields)
  if (!changes.length) return []
  return [
    {
      kind: 'update',
      type: T.project,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Rename ${typedName(label, observed.name)} to ${String(desired.fields.name)}.`,
      changes,
      preconditions: { name: observed.fields.name },
      risk: []
    }
  ]
}

function planServiceAccount(
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const label = 'OpenAI service account'
  if (!desired) {
    if (!observed) return []
    return [
      deleteOp(
        T.serviceAccount,
        observed,
        label,
        'Delete (its API key stops working at once, no way back):',
        { name: observed.fields.name }
      )
    ]
  }
  if (!observed)
    return [
      {
        kind: 'create',
        type: T.serviceAccount,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(label, String(desired.fields.name ?? ''))}. OpenAI shows its API key once: the Hub seals it and hands it to what you bound it to (the stack secret OPENAI_API_KEY or an app AI gateway key). If it is lost it can only be replaced.`,
        changes: [{ field: 'name', to: desired.fields.name }],
        preconditions: {},
        risk: []
      }
    ]
  const rename = diffFields(['name'], desired.fields, observed.fields)
  if (rename.length)
    return [
      {
        kind: 'replace',
        type: T.serviceAccount,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(label, observed.name)}: OpenAI cannot rename a service account, so the old one and its key are deleted and a new one is made with a new key.`,
        changes: rename,
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  if (desired.fields[ROTATE_OUTPUTS_FIELD] === true)
    return [
      {
        kind: 'update',
        type: T.serviceAccount,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        action: 'rotate',
        reason: `Make a new API key for ${typedName(label, observed.name)}: a new service account with the same name is made, its key goes to what is bound to it, then the old one is deleted and its key stops working at once.`,
        changes: [{ field: ROTATE_OUTPUTS_FIELD, from: false, to: true }],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  return []
}

function planProjectUser(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const label = 'OpenAI project member'
  if (!desired) {
    if (!observed) return []
    return [
      deleteOp(T.projectUser, observed, label, 'Remove', {
        email: observed.fields.email,
        role: observed.fields.role
      })
    ]
  }
  if (!observed)
    return [
      {
        kind: 'create',
        type: T.projectUser,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Add ${String(desired.fields.email ?? '')} to the project as ${String(desired.fields.role ?? 'member')}. They must already be in the organization.`,
        changes: ['email', 'role']
          .filter((k) => norm(desired.fields[k]) !== null)
          .map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: []
      }
    ]
  const replace = diffFields(['email'], desired.fields, observed.fields)
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: T.projectUser,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(label, observed.name)}: the person cannot change, so the old member is removed and the new one added.`,
        changes: replace,
        preconditions: { email: observed.fields.email },
        risk: []
      }
    ]
  const changes = diffFields(['role'], desired.fields, observed.fields)
  if (!changes.length) return []
  return [
    {
      kind: 'update',
      type: T.projectUser,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${words(USER_FIELDS, changes)} of ${typedName(label, observed.name)}.`,
      changes,
      preconditions: { role: observed.fields.role },
      risk: []
    }
  ]
}

function planRateLimit(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const label = 'OpenAI rate limit'
  // OpenAI makes and removes limits itself; dropping this from the Hub leaves the numbers as they are.
  if (!desired) return []
  if (!observed)
    return [
      {
        kind: 'create',
        type: T.rateLimit,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Set the limits of ${typedName(label, String(desired.fields.model ?? ''))} (the limit already exists at OpenAI; the Hub sets its numbers).`,
        changes: RATE_LIMIT_FIELDS.filter((k) => norm(desired.fields[k]) !== null).map((k) => ({
          field: k,
          to: desired.fields[k]
        })),
        preconditions: {},
        risk: []
      }
    ]
  const changes = diffFields(RATE_LIMIT_FIELDS, desired.fields, observed.fields, true)
  if (!changes.length) return []
  const pre: Record<string, unknown> = {}
  for (const c of changes) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: T.rateLimit,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${words(RATE_FIELDS, changes)} of ${typedName(label, observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

function planApiKey(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const label = 'OpenAI project API key'
  if (!desired) {
    if (!observed) return []
    return [
      deleteOp(T.apiKey, observed, label, 'Delete (it stops working at once, no way back):', {
        name: observed.fields.name
      })
    ]
  }
  if (!observed)
    return [
      {
        kind: 'create',
        type: T.apiKey,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `${label} cannot be created through the OpenAI API. Make a service account instead, or create the key in the OpenAI console and adopt it.`,
        changes: [],
        preconditions: {},
        risk: []
      }
    ]
  return []
}

// ── Applying ──

function checkName(desired: DesiredResource): string {
  const name = String(desired.fields.name ?? '').trim()
  if (!name) throw new ProviderError('INVALID_FIELDS', 'It needs a name.')
  return name
}

async function applyProject(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    const name = checkName(desired)
    if (desired.externalId) {
      const raw = await readProjectRaw(ctx, desired.externalId)
      if (raw) return ok(String(raw.id), projectObserved(raw), { already: 'exists' })
    }
    if ((await listProjectsRaw(ctx)).some((p) => p.name === name)) throw alreadyExists(name)
    const r = await openaiCall(ctx, 'POST', `${ORG}/projects`, { body: { name } })
    if (!r.body?.id)
      throw new ProviderError('PROVIDER_REJECTED', 'OpenAI did not return the new project.')
    return ok(String(r.body.id), projectObserved(r.body), { created: true })
  }
  const id = op.externalId as string
  if (op.kind === 'delete') {
    await openaiCall(ctx, 'POST', `${ORG}/projects/${segment(id)}/archive`, { allow: [404] })
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const have = await readProjectRaw(ctx, id)
  if (!have) throw new ProviderError('NOT_FOUND', 'The project no longer exists.', { status: 404 })
  const name = checkName(desired)
  if (have.name === name) return ok(id, projectObserved(have), { already: 'matches' })
  const r = await openaiCall(ctx, 'POST', `${ORG}/projects/${segment(id)}`, { body: { name } })
  return ok(id, projectObserved(r.body?.id ? r.body : { ...have, name }), { renamed: true })
}

/** One service account made in a project; its key comes back once, as an output only. */
async function makeServiceAccount(
  ctx: ProviderContext,
  project: string,
  name: string
): Promise<{ observed: Observed; key: string | null }> {
  const r = await openaiCall(ctx, 'POST', `${ORG}/projects/${segment(project)}/service_accounts`, {
    body: { name }
  })
  if (!r.body?.id)
    throw new ProviderError('PROVIDER_REJECTED', 'OpenAI did not return the new service account.')
  const value = r.body.api_key?.value
  return {
    observed: serviceAccountObserved(project, r.body),
    key: typeof value === 'string' && value ? value : null
  }
}

async function removeScoped(ctx: ProviderContext, ext: string, path: string): Promise<void> {
  const { project, child } = splitId(ext)
  await openaiCall(ctx, 'DELETE', `${ORG}/projects/${segment(project)}/${path}/${segment(child)}`, {
    allow: [404]
  })
}

async function applyServiceAccount(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    const project = projectOf(desired)
    const name = checkName(desired)
    if (!(await parentLive(ctx, project)))
      throw new ProviderError('NOT_FOUND', 'The project is gone or archived.', { status: 404 })
    if (desired.externalId) {
      const seen = await readServiceAccount(ctx, desired.externalId)
      // A resumed create: the key was shown once already, it cannot be read again.
      if (seen) return ok(seen.externalId, seen, { already: 'exists' })
    }
    const existing = (
      await openaiPages(ctx, `${ORG}/projects/${segment(project)}/service_accounts`)
    ).find((s) => s?.name === name)
    if (existing) throw alreadyExists(`A service account named ${name}`)
    const made = await makeServiceAccount(ctx, project, name)
    return ok(
      made.observed.externalId,
      made.observed,
      { created: true },
      made.key ? { api_key: made.key } : undefined
    )
  }
  const ext = op.externalId as string
  if (op.kind === 'delete') {
    sameProject(ext, desired)
    await removeScoped(ctx, ext, 'service_accounts')
    return ok(ext, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const project = sameProject(ext, desired)
  const name = checkName(desired)
  if (op.kind === 'replace') {
    await removeScoped(ctx, ext, 'service_accounts')
    const made = await makeServiceAccount(ctx, project, name)
    return ok(
      made.observed.externalId,
      made.observed,
      { replaced: true },
      made.key ? { api_key: made.key } : undefined
    )
  }
  if (op.action === 'rotate') {
    const old = await readServiceAccount(ctx, ext)
    if (!old)
      throw new ProviderError('NOT_FOUND', 'The service account no longer exists.', {
        status: 404
      })
    // New first, old after: a failure to remove the old one never loses the new key.
    const made = await makeServiceAccount(ctx, project, String(old.fields.name ?? name))
    let oldRemoved = true
    try {
      await removeScoped(ctx, ext, 'service_accounts')
    } catch (err) {
      oldRemoved = false
      ctx.log.warn('openai rotate: the old service account was not removed', {
        message: clip(ctx.scrub(err instanceof Error ? err.message : String(err)))
      })
    }
    return ok(
      made.observed.externalId,
      made.observed,
      { rotated: true, replaced: ext, old_removed: oldRemoved },
      made.key ? { api_key: made.key } : undefined
    )
  }
  const have = await readServiceAccount(ctx, ext)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The service account no longer exists.', { status: 404 })
  return ok(ext, have, { already: 'matches' })
}

async function applyProjectUser(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const createUser = async (d: DesiredResource): Promise<OpResult> => {
    const project = projectOf(d)
    const email = String(d.fields.email ?? '').trim()
    const role = d.fields.role === 'owner' ? 'owner' : 'member'
    if (!email) throw new ProviderError('INVALID_FIELDS', 'It needs an email address.')
    if (!(await parentLive(ctx, project)))
      throw new ProviderError('NOT_FOUND', 'The project is gone or archived.', { status: 404 })
    if (d.externalId) {
      const seen = await readProjectUser(ctx, d.externalId)
      if (seen) return ok(seen.externalId, seen, { already: 'exists' })
    }
    const userId = await orgUserIdByEmail(ctx, email)
    if (!userId)
      throw new ProviderError(
        'USER_NOT_IN_ORG',
        `${email} is not in the OpenAI organization. Invite them in the OpenAI console first.`
      )
    const members = await openaiPages(ctx, `${ORG}/projects/${segment(project)}/users`)
    if (members.some((m) => m?.id === userId)) throw alreadyExists(`${email} in this project`)
    const r = await openaiCall(ctx, 'POST', `${ORG}/projects/${segment(project)}/users`, {
      body: { user_id: userId, role }
    })
    const made = r.body?.id ? r.body : { id: userId, email, role }
    return ok(`${project}:${made.id}`, projectUserObserved(project, made), { created: true })
  }
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    return createUser(desired)
  }
  const ext = op.externalId as string
  if (op.kind === 'delete') {
    sameProject(ext, desired)
    await removeScoped(ctx, ext, 'users')
    return ok(ext, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const project = sameProject(ext, desired)
  if (op.kind === 'replace') {
    await removeScoped(ctx, ext, 'users')
    return createUser({ ...desired, externalId: null })
  }
  const have = await readProjectUser(ctx, ext)
  if (!have) throw new ProviderError('NOT_FOUND', 'The member no longer exists.', { status: 404 })
  const role = desired.fields.role === 'owner' ? 'owner' : 'member'
  if (have.fields.role === role) return ok(ext, have, { already: 'matches' })
  const { child } = splitId(ext)
  await openaiCall(ctx, 'POST', `${ORG}/projects/${segment(project)}/users/${segment(child)}`, {
    body: { role }
  })
  return ok(ext, await readProjectUser(ctx, ext), { changed: ['role'] })
}

async function applyRateLimit(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete')
    throw new ProviderError(
      'CAPABILITY_MISSING',
      'OpenAI keeps a rate limit for every model; it cannot be removed.'
    )
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  let project: string
  let limitId: string | null = null
  if (op.kind === 'create') {
    project = projectOf(desired)
  } else {
    const ext = op.externalId as string
    project = sameProject(ext, desired)
    limitId = splitId(ext).child
  }
  if (!(await parentLive(ctx, project)))
    throw new ProviderError('NOT_FOUND', 'The project is gone or archived.', { status: 404 })
  const model = String(desired.fields.model ?? '').trim()
  const limits = await listRateLimits(ctx, project)
  const hit = limitId
    ? limits.find((r) => r?.id === limitId)
    : limits.find((r) => r?.model === model)
  if (!hit)
    throw new ProviderError(
      'NOT_FOUND',
      limitId
        ? 'The rate limit no longer exists.'
        : `OpenAI has no rate limit for ${model || 'that model'} in this project.`,
      { status: 404 }
    )
  const seen = rateLimitObserved(project, hit)
  // Named from the desired fields only; op.data is never sent.
  const body: Record<string, number> = {}
  for (const c of diffFields(RATE_LIMIT_FIELDS, desired.fields, seen.fields, true)) {
    const n = Number(c.to)
    if (!Number.isFinite(n) || n < 0)
      throw new ProviderError('INVALID_FIELDS', `${c.field} must be a number of zero or more.`)
    body[c.field] = n
  }
  if (!Object.keys(body).length) {
    if (op.kind === 'create' && !RATE_LIMIT_FIELDS.some((k) => norm(desired.fields[k]) !== null))
      throw new ProviderError('INVALID_FIELDS', 'Set at least one limit.')
    return ok(seen.externalId, seen, { already: 'matches' })
  }
  await openaiCall(
    ctx,
    'POST',
    `${ORG}/projects/${segment(project)}/rate_limits/${segment(String(hit.id))}`,
    { body }
  )
  const after = (await listRateLimits(ctx, project)).find((r) => r?.id === hit.id)
  return ok(seen.externalId, after ? rateLimitObserved(project, after) : null, {
    changed: Object.keys(body)
  })
}

async function applyApiKey(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const ext = op.externalId as string
    sameProject(ext, desired)
    await removeScoped(ctx, ext, 'api_keys')
    return ok(ext, null)
  }
  throw new ProviderError(
    'CAPABILITY_MISSING',
    'A project API key can be read, adopted and deleted here, never made or changed.'
  )
}

// ── Costs ──

interface CostBucketRow {
  date: string
  project: string | undefined
  currency: string
  value: number
}

/** Cost buckets (one per UTC day) between two instants, optionally for one project. */
async function costRows(
  ctx: ProviderContext,
  from: Date,
  to: Date,
  projectId?: string
): Promise<CostBucketRow[]> {
  const out: CostBucketRow[] = []
  let page: string | undefined
  for (let i = 0; i < 20; i++) {
    const r = await openaiCall(ctx, 'GET', `${ORG}/costs`, {
      query: {
        start_time: Math.floor(from.getTime() / 1000),
        end_time: Math.max(Math.floor(to.getTime() / 1000), Math.floor(from.getTime() / 1000) + 1),
        bucket_width: '1d',
        limit: 180,
        'group_by[]': 'project_id',
        ...(projectId ? { 'project_ids[]': projectId } : {}),
        page
      }
    })
    for (const bucket of Array.isArray(r.body?.data) ? r.body.data : []) {
      const start = Number(bucket?.start_time)
      if (!Number.isFinite(start)) continue
      const date = new Date(start * 1000).toISOString().slice(0, 10)
      for (const row of Array.isArray(bucket.results) ? bucket.results : []) {
        const value = Number(row?.amount?.value)
        if (!Number.isFinite(value)) continue
        // The filter is asked of OpenAI and kept here too: another project's spend never counts.
        if (projectId && row.project_id !== projectId) continue
        out.push({
          date,
          project: typeof row.project_id === 'string' ? row.project_id : undefined,
          currency: String(row?.amount?.currency ?? 'usd').toUpperCase(),
          value
        })
      }
    }
    if (!r.body?.has_more || !r.body?.next_page) break
    page = String(r.body.next_page)
  }
  return out
}

const money = (n: number) => Math.round(n * 100) / 100

async function usageNow(
  ctx: ProviderContext,
  range: { from: string; to: string }
): Promise<CostRow[]> {
  const from = new Date(range.from)
  const to = new Date(range.to)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return []
  const sums = new Map<string, CostBucketRow>()
  for (const r of await costRows(ctx, from, to)) {
    const key = `${r.date}|${r.project ?? ''}|${r.currency}`
    const have = sums.get(key)
    if (have) have.value += r.value
    else sums.set(key, { ...r })
  }
  const out: CostRow[] = []
  for (const r of sums.values()) {
    const amountCents = Math.round(r.value * 100)
    if (amountCents === 0) continue
    out.push({
      date: r.date,
      amountCents,
      currency: r.currency,
      ...(r.project ? { externalId: r.project } : {}),
      service: 'openai',
      recordType: amountCents < 0 ? 'credit' : 'usage'
    })
  }
  return out
}

/**
 * Task 34: the daily cost feed. `range` names whole days (both ends included), so the last day's
 * end is the next midnight, never later than now; the rows are usageNow's (project id = the
 * managed resource).
 */
async function costs(
  ctx: ProviderContext,
  range: { from: string; to: string }
): Promise<CostRow[]> {
  const from = new Date(`${range.from.slice(0, 10)}T00:00:00Z`)
  const dayAfter = new Date(`${range.to.slice(0, 10)}T00:00:00Z`).getTime() + 86_400_000
  const end = new Date(Math.min(dayAfter, ctx.now().getTime()))
  if (Number.isNaN(from.getTime()) || Number.isNaN(end.getTime()) || end <= from) return []
  return usageNow(ctx, { from: from.toISOString(), to: end.toISOString() })
}

/** What a service account costs: nothing fixed, whatever its key spends. */
async function serviceAccountEstimate(
  _ctx: ProviderContext,
  _desired: DesiredResource | null,
  _observed: Observed | null
): Promise<CostEstimate> {
  try {
    return estimateOf({
      basis: 'usage',
      confidence: 'usage_varies',
      lines: [],
      priceAsOf: null,
      note: 'Nothing fixed each month, plus usage: OpenAI bills what the key’s requests use, at the model prices on its pricing page.'
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}

// ── Types ──

const caps = (over: Partial<ResourceTypeSpec['capabilities']>) => ({
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false,
  ...over
})

const raised = (c: FieldChange): boolean =>
  typeof c.to === 'number' && (typeof c.from !== 'number' || c.to > c.from)

const TYPES: ResourceTypeSpec[] = [
  {
    key: T.project,
    label: 'OpenAI project',
    scope: 'app',
    nameField: 'name',
    fields: PROJECT_FIELDS,
    capabilities: caps({}),
    reversible: false,
    refs: [],
    risk(op) {
      return op.kind === 'delete' ? ['destructive', 'data_loss'] : []
    }
  },
  {
    key: T.serviceAccount,
    label: 'OpenAI service account',
    scope: 'app',
    nameField: 'name',
    fields: SA_FIELDS,
    capabilities: caps({ update: false }),
    reversible: false,
    refs: [{ field: 'project', type: T.project, required: true }],
    outputs: [{ key: 'api_key', label: 'API key', secret: true, onceOnly: true }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive')
      if (op.kind === 'replace') out.push('destructive', 'downtime')
      if (op.action === 'rotate') out.push('downtime')
      return out
    },
    costClass: () => 'monthly',
    estimate: serviceAccountEstimate
  },
  {
    key: T.projectUser,
    label: 'OpenAI project member',
    scope: 'app',
    nameField: 'email',
    fields: USER_FIELDS,
    capabilities: caps({}),
    reversible: true,
    refs: [{ field: 'project', type: T.project, required: true }],
    risk() {
      return []
    }
  },
  {
    key: T.rateLimit,
    label: 'OpenAI rate limit',
    scope: 'app',
    nameField: 'model',
    fields: RATE_FIELDS,
    // OpenAI makes a limit for every model and never removes one: "create" sets numbers on the
    // project's existing limit; the Hub cannot delete it.
    capabilities: caps({ delete: false }),
    reversible: true,
    refs: [{ field: 'project', type: T.project, required: true }],
    risk(op) {
      // Raising a limit lets more spend through; a create cannot compare with what is there.
      if (op.kind === 'create') return ['cost']
      return op.changes.some(raised) ? ['cost'] : []
    }
  },
  {
    key: T.apiKey,
    label: 'OpenAI project API key',
    scope: 'app',
    nameField: 'name',
    fields: KEY_FIELDS,
    capabilities: caps({ create: false, update: false }),
    reversible: false,
    refs: [{ field: 'project', type: T.project, required: true }],
    risk(op) {
      return op.kind === 'delete' ? ['destructive'] : []
    }
  }
]

const TYPE_KEYS = new Set<string>(TYPES.map((t) => t.key))

function knownType(type: unknown): string {
  if (typeof type !== 'string' || !TYPE_KEYS.has(type))
    throw new ProviderError('UNKNOWN_TYPE', `OpenAI has no ${String(type)}.`)
  return type
}

// ── Reads by type ──

async function observeType(
  ctx: ProviderContext,
  type: string,
  externalId: string
): Promise<Observed | null> {
  switch (knownType(type)) {
    case T.project: {
      const raw = await readProjectRaw(ctx, externalId)
      return raw ? projectObserved(raw) : null
    }
    case T.serviceAccount:
      return readServiceAccount(ctx, externalId)
    case T.projectUser:
      return readProjectUser(ctx, externalId)
    case T.rateLimit:
      return readRateLimit(ctx, externalId)
    default:
      return readApiKey(ctx, externalId)
  }
}

async function listType(ctx: ProviderContext, type: string): Promise<Observed[]> {
  const projects = await listProjectsRaw(ctx)
  if (knownType(type) === T.project) return projects.map(projectObserved)
  const out: Observed[] = []
  for (const p of projects.slice(0, 100)) {
    const id = String(p.id)
    const base = `${ORG}/projects/${segment(id)}`
    if (type === T.serviceAccount)
      for (const s of await openaiPages(ctx, `${base}/service_accounts`))
        out.push(serviceAccountObserved(id, s))
    else if (type === T.projectUser)
      for (const u of await openaiPages(ctx, `${base}/users`)) out.push(projectUserObserved(id, u))
    else if (type === T.rateLimit)
      for (const r of await listRateLimits(ctx, id)) out.push(rateLimitObserved(id, r))
    else for (const k of await openaiPages(ctx, `${base}/api_keys`)) out.push(apiKeyObserved(id, k))
  }
  return out
}

// ── The adapter ──

export const openaiAdapter: ProviderAdapter = {
  key: 'openai',
  label: 'OpenAI',
  connection: {
    fields: [
      {
        key: 'adminKey',
        label: 'Admin key',
        kind: 'string',
        secret: true,
        required: true,
        help: 'OpenAI platform → Settings → Organization → Admin keys. It has the organization’s full management access.'
      },
      {
        key: 'organization',
        label: 'Organization id',
        kind: 'string',
        placeholder: 'org-…',
        help: 'Optional. Sent with every call when you belong to more than one organization.'
      }
    ],
    hosts: () => ['api.openai.com'],
    describe: (config) =>
      `OpenAI${String(config.organization ?? '').trim() ? ` ${String(config.organization).trim()}` : ''}`,
    validate(config, secrets) {
      const problems: string[] = []
      const org = String(config.organization ?? '').trim()
      if (org && !/^org-[A-Za-z0-9_-]{2,64}$/.test(org))
        problems.push('The organization id looks like org-… .')
      if (secrets.adminKey !== undefined && !secrets.adminKey.trim())
        problems.push('The admin key is empty.')
      return problems
    }
  },
  types: TYPES,
  usageNow,
  costs,

  async testConnection(ctx): Promise<ConnectionTest> {
    const needs = (has: boolean, costs: boolean) => [
      { type: T.project, need: 'read and manage projects', has },
      { type: T.serviceAccount, need: 'manage service accounts', has },
      { type: T.projectUser, need: 'manage project members', has },
      { type: T.rateLimit, need: 'manage project rate limits', has },
      { type: '*', need: 'read organization costs', has: has && costs }
    ]
    try {
      await openaiCall(ctx, 'GET', `${ORG}/projects`, { query: { limit: 1 } })
    } catch (err) {
      if (err instanceof ProviderError) {
        const permissions = needs(false, false)
        return {
          ok: false,
          identity: null,
          permissions,
          missing: permissions.map((p) => p.need),
          message: ctx.scrub(err.message)
        }
      }
      throw err
    }
    let costs = true
    try {
      const now = Math.floor(ctx.now().getTime() / 1000)
      await openaiCall(ctx, 'GET', `${ORG}/costs`, {
        query: { start_time: now - 86400, end_time: now, limit: 1 }
      })
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'FORBIDDEN') costs = false
    }
    const permissions = needs(true, costs)
    const org = String(ctx.config.organization ?? '').trim()
    return {
      ok: true,
      identity: `OpenAI organization${org ? ` ${org}` : ''}`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need)
    }
  },

  observe: (ctx, type, externalId) => observeType(ctx, type, externalId),

  async list(ctx, type): Promise<ListPage> {
    return { items: await listType(ctx, type), cursor: null }
  },

  /** Plan time: a project / service account / member of that name or email already there. */
  async findExisting(ctx, type, desired) {
    knownType(type)
    if (desired.externalId) return null
    if (type === T.project) {
      const name = String(desired.fields.name ?? '').trim()
      if (!name) return null
      const hit = (await listProjectsRaw(ctx)).find((p) => p.name === name)
      return hit ? projectObserved(hit) : null
    }
    const project = desired.refs.project
    if (typeof project !== 'string' || !project) return null
    const base = `${ORG}/projects/${segment(project)}`
    if (type === T.serviceAccount) {
      const name = String(desired.fields.name ?? '').trim()
      const hit = name
        ? (await openaiPages(ctx, `${base}/service_accounts`)).find((s) => s?.name === name)
        : null
      return hit ? serviceAccountObserved(project, hit) : null
    }
    if (type === T.projectUser) {
      const email = String(desired.fields.email ?? '')
        .trim()
        .toLowerCase()
      const hit = email
        ? (await openaiPages(ctx, `${base}/users`)).find(
            (u) => String(u?.email ?? '').toLowerCase() === email
          )
        : null
      return hit ? projectUserObserved(project, hit) : null
    }
    return null
  },

  plan(_ctx, desired, observed) {
    const type = knownType(desired?.type ?? observed?.type)
    switch (type) {
      case T.project:
        return planProject(desired, observed)
      case T.serviceAccount:
        return planServiceAccount(desired, observed)
      case T.projectUser:
        return planProjectUser(desired, observed)
      case T.rateLimit:
        return planRateLimit(desired, observed)
      default:
        return planApiKey(desired, observed)
    }
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    switch (knownType(op.type)) {
      case T.project:
        return applyProject(ctx, op, desired)
      case T.serviceAccount:
        return applyServiceAccount(ctx, op, desired)
      case T.projectUser:
        return applyProjectUser(ctx, op, desired)
      case T.rateLimit:
        return applyRateLimit(ctx, op, desired)
      default:
        return applyApiKey(ctx, op, desired)
    }
  },

  /** Project: state plus its spend today (UTC) and month to date; the rest: there or not. */
  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await observeType(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at OpenAI.', checkedAt }
    if (type !== T.project) return { status: 'ok', checkedAt }
    const now = ctx.now()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    try {
      const rows = await costRows(ctx, monthStart, now, externalId)
      const today = now.toISOString().slice(0, 10)
      const currency = rows[0]?.currency ?? 'USD'
      const month = money(rows.reduce((n, r) => n + r.value, 0))
      const day = money(rows.filter((r) => r.date === today).reduce((n, r) => n + r.value, 0))
      return {
        status: 'ok',
        message: `Spent ${day.toFixed(2)} ${currency} today (UTC) and ${month.toFixed(2)} ${currency} this month.`,
        checkedAt,
        details: { cost_today: day, cost_month_to_date: month, currency }
      }
    } catch (err) {
      const why = err instanceof ProviderError ? ctx.scrub(err.message) : 'unknown error'
      return {
        status: 'ok',
        message: `The project is active. Its costs could not be read: ${clip(why)}`,
        checkedAt
      }
    }
  }
}
