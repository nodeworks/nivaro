import { fieldWords, typedName } from '../plan-words.js'
import { estimateOf, unknownEstimate } from '../pricing/index.js'
import {
  type ConnectionTest,
  type CostEstimate,
  type CostRow,
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
import { ANALYTICS_BETA, anthropicCall, pageAll, seg } from './client.js'

/**
 * Anthropic (`anthropic`): one Admin API credential (an `sk-ant-admin…` key or an `org:admin`
 * OAuth token) is the connection secret. Host `api.anthropic.com`. The key IS the organization, so
 * the connection is the pin.
 *
 * Types:
 *  - `anthropic.workspace`        create, rename, archive (archive = the delete, no way back)
 *  - `anthropic.workspace_member` add / change role / remove; the person is matched by email
 *  - `anthropic.api_key`          read + adopt + rename + (de)activate ONLY: the Admin API cannot
 *                                 create keys. A person creates the key in the Console inside the
 *                                 Hub-made workspace and pastes it once into the `api_key` secret
 *                                 field; the adapter checks it against the key's hint and hands it
 *                                 out as the sealed output `api_key` (binding → `anthropic_api_key`)
 *  - `anthropic.spend_limit`      a workspace spend limit where the organization has the API
 *  - `anthropic.rate_limits`      read only (organization + per workspace)
 *
 * The plan's costs: `usageNow` answers the Usage and Cost Analytics API cost rows per workspace
 * (Task 44a); `costs()` is Task 34's and not built here.
 */

const T_WS = 'anthropic.workspace'
const T_MEMBER = 'anthropic.workspace_member'
const T_KEY = 'anthropic.api_key'
const T_SPEND = 'anthropic.spend_limit'
const T_RATE = 'anthropic.rate_limits'

export const WORKSPACE_ROLES = [
  'workspace_user',
  'workspace_developer',
  'workspace_admin',
  'workspace_billing'
]

const CONSOLE = 'https://platform.claude.com'

// ── Small helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function diffFields(
  keys: string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (norm(want[k]) !== norm(have[k]))
      out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
}

function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} already exists at Anthropic. Adopt it instead of creating it.`,
    { retryable: false }
  )
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

const isDefaultWs = (w: any) => String(w?.name ?? '') === 'Default'

function refOf(desired: DesiredResource, field: string): string {
  const v = desired.refs[field]
  if (typeof v !== 'string' || !v)
    throw new ProviderError('INVALID_FIELDS', `The ${field} is not created yet.`)
  return v
}

// ── Workspaces ──

function wsObserved(w: any): Observed {
  return {
    type: T_WS,
    externalId: String(w.id),
    name: w.name ?? null,
    fields: { name: w.name ?? null, color: w.display_color ?? null },
    tags: {},
    version: null,
    status: w.archived_at ? 'archived' : 'active',
    url: `${CONSOLE}/settings/workspaces/${encodeURIComponent(String(w.id))}`
  }
}

/** The raw workspace, or null when it is gone or archived. */
async function readWsRaw(ctx: ProviderContext, id: string): Promise<any | null> {
  const r = await anthropicCall(ctx, 'GET', `/workspaces/${seg(id, 'workspace id')}`, {
    allow: [404]
  })
  if (r.status === 404 || !r.body || typeof r.body !== 'object' || r.body.archived_at) return null
  return r.body
}

async function listWsRaw(ctx: ProviderContext): Promise<any[]> {
  return (await pageAll(ctx, '/workspaces', { include_archived: 'false' })).filter(
    (w) => w && !w.archived_at && !isDefaultWs(w)
  )
}

const WS_FIELDS: ResourceTypeSpec['fields'] = [
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    required: true,
    help: 'One workspace per app, or per environment. Keys, members and limits live inside it.'
  },
  { key: 'color', label: 'Color', kind: 'string', readOnly: true }
]
const WS_LABEL = 'Anthropic workspace'

function planWs(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: T_WS,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Archive ${typedName(WS_LABEL, observed.name)}. Every API key in it stops working and the archive cannot be undone.`,
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
        type: T_WS,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(WS_LABEL, String(desired.fields.name ?? ''))}. Make its API key in the Console, then paste it on the key resource.`,
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
      type: T_WS,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Rename ${typedName(WS_LABEL, observed.name)} to ${String(desired.fields.name)}.`,
      changes,
      preconditions: { name: observed.fields.name },
      risk: []
    }
  ]
}

async function applyWs(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    const name = String(desired.fields.name ?? '').trim()
    if (!name) throw new ProviderError('INVALID_FIELDS', 'The workspace needs a name.')
    if (desired.externalId) {
      const raw = await readWsRaw(ctx, desired.externalId)
      if (raw) return ok(String(raw.id), wsObserved(raw), { already: 'exists' })
    }
    const hit = (await listWsRaw(ctx)).find((w) => w.name === name)
    if (hit) throw alreadyExists(`A workspace named ${name}`)
    const r = await anthropicCall(ctx, 'POST', '/workspaces', { body: { name } })
    if (!r.body?.id)
      throw new ProviderError('PROVIDER_REJECTED', 'Anthropic did not return the new workspace.')
    return ok(String(r.body.id), wsObserved(r.body), { created: true })
  }
  const id = op.externalId as string
  if (op.kind === 'delete') {
    const raw = await readWsRaw(ctx, id)
    if (!raw) return ok(id, null, { already: 'gone' })
    if (isDefaultWs(raw))
      throw new ProviderError('DEFAULT_WORKSPACE', 'The Default Workspace cannot be archived.')
    await anthropicCall(ctx, 'POST', `/workspaces/${seg(id, 'workspace id')}/archive`)
    return ok(id, null, { archived: true })
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const have = await readWsRaw(ctx, id)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The workspace no longer exists.', { status: 404 })
  if (isDefaultWs(have))
    throw new ProviderError('DEFAULT_WORKSPACE', 'The Default Workspace cannot be renamed.')
  const name = String(desired.fields.name ?? '').trim()
  if (!name) throw new ProviderError('INVALID_FIELDS', 'The workspace needs a name.')
  if (name === have.name) return ok(id, wsObserved(have), { already: 'matches' })
  const r = await anthropicCall(ctx, 'POST', `/workspaces/${seg(id, 'workspace id')}`, {
    body: { name }
  })
  return ok(id, wsObserved(r.body?.id ? r.body : { ...have, name }), { renamed: true })
}

// ── Workspace members (external id = <workspace id>:<user id>) ──

function memberId(ws: string, user: string): string {
  return `${ws}:${user}`
}

function splitMemberId(id: string): { ws: string; user: string } {
  const parts = String(id).split(':')
  if (parts.length !== 2)
    throw new ProviderError('BAD_ID', 'That member id cannot be used in an Anthropic address.')
  return { ws: seg(parts[0], 'workspace id'), user: seg(parts[1], 'user id') }
}

async function readUser(ctx: ProviderContext, userId: string): Promise<any | null> {
  const r = await anthropicCall(ctx, 'GET', `/users/${seg(userId, 'user id')}`, { allow: [404] })
  return r.status === 404 ? null : r.body
}

/** The organization member with this email (case-insensitive), or null. */
async function findUserByEmail(ctx: ProviderContext, email: string): Promise<any | null> {
  const want = email.trim().toLowerCase()
  const match = (list: any[]) =>
    list.find((u) => String(u?.email ?? '').toLowerCase() === want) ?? null
  const r = await anthropicCall(ctx, 'GET', '/users', { query: { email: want, limit: 100 } })
  const first = match(Array.isArray(r.body?.data) ? r.body.data : [])
  if (first) return first
  return match(await pageAll(ctx, '/users'))
}

async function readMemberRaw(ctx: ProviderContext, ws: string, user: string): Promise<any | null> {
  // Children through their parent: a gone / archived / Default workspace has no members here.
  const parent = await readWsRaw(ctx, ws)
  if (!parent || isDefaultWs(parent)) return null
  const r = await anthropicCall(ctx, 'GET', `/workspaces/${ws}/members/${user}`, { allow: [404] })
  if (r.status === 404 || !r.body || typeof r.body !== 'object') return null
  return r.body
}

function memberObserved(m: any, email: string | null): Observed {
  const ws = String(m.workspace_id)
  const user = String(m.user_id)
  return {
    type: T_MEMBER,
    externalId: memberId(ws, user),
    name: email ?? user,
    fields: { workspace: ws, email, role: m.workspace_role ?? null },
    tags: {},
    version: null,
    status: 'active',
    url: `${CONSOLE}/settings/workspaces/${encodeURIComponent(ws)}`
  }
}

async function readMember(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const { ws, user } = splitMemberId(id)
  const raw = await readMemberRaw(ctx, ws, user)
  if (!raw) return null
  const u = await readUser(ctx, user)
  return memberObserved({ ...raw, workspace_id: raw.workspace_id ?? ws }, u?.email ?? null)
}

const MEMBER_FIELDS: ResourceTypeSpec['fields'] = [
  {
    key: 'workspace',
    label: 'Workspace',
    kind: 'ref',
    refType: T_WS,
    required: true,
    createOnly: true,
    replaceOnChange: true
  },
  {
    key: 'email',
    label: 'Email',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    help: 'The person must already be a member of the organization (invite them in the Console first).'
  },
  {
    key: 'role',
    label: 'Role',
    kind: 'enum',
    required: true,
    default: 'workspace_developer',
    options: WORKSPACE_ROLES.map((r) => ({ value: r, label: r.replace('workspace_', '') }))
  }
]
const MEMBER_LABEL = 'Anthropic workspace member'
const memberWords = (changes: Array<{ field: string }>) => fieldWords(MEMBER_FIELDS, changes)

function planMember(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: T_MEMBER,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Remove ${String(observed.fields.email ?? observed.name)} from the workspace.`,
        changes: [],
        preconditions: { role: observed.fields.role },
        risk: []
      }
    ]
  }
  if (!observed)
    return [
      {
        kind: 'create',
        type: T_MEMBER,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Add ${String(desired.fields.email ?? '')} to the workspace as ${String(desired.fields.role ?? 'workspace_developer').replace('workspace_', '')}.`,
        changes: ['email', 'role']
          .filter((k) => norm(desired.fields[k]) !== null)
          .map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: []
      }
    ]
  const wsDesired = desired.refs.workspace
  const replace: FieldChange[] = diffFields(['email'], desired.fields, observed.fields)
  if (typeof wsDesired === 'string' && wsDesired !== observed.fields.workspace)
    replace.push({ field: 'workspace', from: observed.fields.workspace, to: wsDesired })
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: T_MEMBER,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(MEMBER_LABEL, observed.name)}: ${memberWords(replace)} cannot change in place, so the member is removed and added again.`,
        changes: replace,
        preconditions: { email: observed.fields.email, role: observed.fields.role },
        risk: []
      }
    ]
  const changes = diffFields(['role'], desired.fields, observed.fields)
  if (!changes.length) return []
  return [
    {
      kind: 'update',
      type: T_MEMBER,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${memberWords(changes)} of ${String(observed.fields.email ?? observed.name)}.`,
      changes,
      preconditions: { role: observed.fields.role },
      risk: []
    }
  ]
}

function roleOf(desired: DesiredResource): string {
  const role = String(desired.fields.role ?? 'workspace_developer')
  if (!WORKSPACE_ROLES.includes(role))
    throw new ProviderError('INVALID_FIELDS', `${role} is not a workspace role.`)
  return role
}

async function createMember(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const email = String(desired.fields.email ?? '').trim()
  if (!email) throw new ProviderError('INVALID_FIELDS', 'The member needs an email.')
  const ws = seg(refOf(desired, 'workspace'), 'workspace id')
  const role = roleOf(desired)
  const parent = await readWsRaw(ctx, ws)
  if (!parent)
    throw new ProviderError('NOT_FOUND', 'The workspace no longer exists.', { status: 404 })
  if (isDefaultWs(parent))
    throw new ProviderError(
      'DEFAULT_WORKSPACE',
      'The Default Workspace has no member list: access follows the organization role.'
    )
  const user = await findUserByEmail(ctx, email)
  if (!user?.id)
    throw new ProviderError(
      'USER_NOT_IN_ORG',
      `${email} is not a member of the organization. Invite them in the Console first.`
    )
  const uid = seg(user.id, 'user id')
  const id = memberId(ws, uid)
  const have = await readMemberRaw(ctx, ws, uid)
  if (have) {
    // Only a resumed run (the Hub already has this id on the row) may take the member as made.
    if (desired.externalId === id)
      return ok(id, memberObserved(have, user.email ?? email), { already: 'exists' })
    throw alreadyExists(`${email} in this workspace`)
  }
  const r = await anthropicCall(ctx, 'POST', `/workspaces/${ws}/members`, {
    body: { user_id: uid, workspace_role: role }
  })
  return ok(
    id,
    memberObserved(
      { ...r.body, workspace_id: r.body?.workspace_id ?? ws, user_id: uid },
      user.email ?? email
    ),
    { created: true }
  )
}

async function removeMember(ctx: ProviderContext, id: string): Promise<void> {
  const { ws, user } = splitMemberId(id)
  await anthropicCall(ctx, 'DELETE', `/workspaces/${ws}/members/${user}`, { allow: [404] })
}

async function applyMember(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    return createMember(ctx, desired)
  }
  const id = op.externalId as string
  if (op.kind === 'delete') {
    await removeMember(ctx, id)
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'replace') {
    await removeMember(ctx, id)
    return createMember(ctx, { ...desired, externalId: null })
  }
  const { ws, user } = splitMemberId(id)
  const have = await readMemberRaw(ctx, ws, user)
  if (!have) throw new ProviderError('NOT_FOUND', 'The member no longer exists.', { status: 404 })
  const role = roleOf(desired)
  if (have.workspace_role === role) return ok(id, await readMember(ctx, id), { already: 'matches' })
  await anthropicCall(ctx, 'POST', `/workspaces/${ws}/members/${user}`, {
    body: { workspace_role: role }
  })
  return ok(id, await readMember(ctx, id), { changed: ['role'] })
}

// ── API keys (read + adopt + rename + deactivate; the pasted value is the output) ──

function keyWorkspace(k: any): string | null {
  const s = k?.scope
  if (s && s.type === 'workspace' && typeof s.workspace_id === 'string') return s.workspace_id
  // Older shape (API version 2023-06-01): workspace_id, null for default / all-workspaces keys.
  return typeof k?.workspace_id === 'string' ? k.workspace_id : null
}

function keyObserved(k: any): Observed {
  return {
    type: T_KEY,
    externalId: String(k.id),
    name: k.name ?? null,
    fields: {
      name: k.name ?? null,
      status:
        k.status === 'inactive'
          ? 'inactive'
          : k.status === 'active'
            ? 'active'
            : (k.status ?? null),
      workspace: keyWorkspace(k),
      hint: k.partial_key_hint ?? null
    },
    tags: {},
    version: null,
    status: k.status ?? null,
    url: `${CONSOLE}/settings/keys`
  }
}

async function readKeyRaw(ctx: ProviderContext, id: string): Promise<any | null> {
  const r = await anthropicCall(ctx, 'GET', `/api_keys/${seg(id, 'api key id')}`, { allow: [404] })
  if (r.status === 404 || !r.body || typeof r.body !== 'object') return null
  return r.body
}

async function listKeysRaw(ctx: ProviderContext): Promise<any[]> {
  return (await pageAll(ctx, '/api_keys')).filter((k) => k && k.status !== 'archived')
}

const KEY_FIELDS: ResourceTypeSpec['fields'] = [
  { key: 'name', label: 'Name', kind: 'string', required: true },
  {
    key: 'status',
    label: 'Status',
    kind: 'enum',
    required: true,
    default: 'active',
    options: [
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' }
    ],
    help: 'Inactive stops the key working at once; it can be switched back on.'
  },
  {
    key: 'workspace',
    label: 'Workspace',
    kind: 'ref',
    refType: T_WS,
    help: 'The workspace this key must belong to. The Hub refuses to hand out a key from any other.'
  },
  {
    key: 'api_key',
    label: 'Key value',
    kind: 'secret',
    help: 'Create the key in the Console inside that workspace and paste it here once. It is sealed and bound to the app; the Admin API cannot show it again.'
  },
  { key: 'hint', label: 'Key hint', kind: 'string', readOnly: true }
]
const KEY_LABEL = 'Anthropic API key'
const keyWords = (changes: Array<{ field: string }>) => fieldWords(KEY_FIELDS, changes)

function secretOf(desired: DesiredResource): SecretValue | null {
  const v = desired.fields.api_key
  return v && typeof v === 'object' ? (v as SecretValue) : null
}

function planKey(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired || !observed) return []
  const changes = diffFields(['name', 'status'], desired.fields, observed.fields)
  const wsDesired = desired.refs.workspace
  const secret = secretOf(desired)
  const paste = secret?.changed === true
  if (paste) changes.push({ field: 'api_key', secret: true })
  if (!changes.length) return []
  const parts: string[] = []
  const plain = changes.filter((c) => c.field !== 'api_key')
  if (plain.length)
    parts.push(`Change ${keyWords(plain)} on ${typedName(KEY_LABEL, observed.name)}`)
  if (paste)
    parts.push(
      `Check the pasted key against ${typedName(KEY_LABEL, observed.name)} and seal it as the output`
    )
  let reason = `${parts.join('. ')}.`
  if (typeof wsDesired === 'string' && wsDesired !== observed.fields.workspace)
    reason += ' The key is not in the chosen workspace, so the Hub will refuse this.'
  const pre: Record<string, unknown> = {
    status: observed.fields.status,
    name: observed.fields.name
  }
  return [
    {
      kind: 'update',
      type: T_KEY,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

/** The pasted value must look like a regular API key and fit the key's hint (prefix…suffix). */
function checkPasted(plain: string, hint: unknown): void {
  const v = plain.trim()
  if (!v.startsWith('sk-ant-') || v.length < 20)
    throw new ProviderError('INVALID_FIELDS', 'That does not look like an Anthropic API key.')
  if (v.startsWith('sk-ant-admin'))
    throw new ProviderError(
      'INVALID_FIELDS',
      'That is an Admin API key. Paste the workspace API key, never an Admin key.'
    )
  const h = typeof hint === 'string' ? hint : ''
  const m = /^(.*?)\.{2,}(.*)$/.exec(h)
  if (m && (!v.startsWith(m[1] ?? '') || !v.endsWith(m[2] ?? '')))
    throw new ProviderError(
      'KEY_MISMATCH',
      'The pasted key does not match this key resource (its start and end differ from the hint the Console shows).'
    )
}

async function applyKey(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind !== 'update')
    throw new ProviderError(
      'NOT_SUPPORTED',
      'Anthropic API keys cannot be created or deleted through the Admin API. Create the key in the Console, adopt it here, and set its status to inactive to switch it off.'
    )
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const id = op.externalId as string
  const have = await readKeyRaw(ctx, id)
  if (!have) throw new ProviderError('NOT_FOUND', 'The key no longer exists.', { status: 404 })
  if (have.status === 'archived')
    throw new ProviderError('KEY_ARCHIVED', 'The key is archived and cannot be changed.')
  const wsWant = desired.refs.workspace
  if (typeof wsWant === 'string' && wsWant !== keyWorkspace(have))
    throw new ProviderError(
      'TARGET_MISMATCH',
      'That key does not belong to the workspace chosen for it.'
    )
  const body: Record<string, string> = {}
  const name = String(desired.fields.name ?? '').trim()
  if (name && name !== have.name) body.name = name
  const status = String(desired.fields.status ?? '')
  if (status && status !== have.status) {
    if (status !== 'active' && status !== 'inactive')
      throw new ProviderError('INVALID_FIELDS', `${status} is not a key status.`)
    body.status = status
  }
  const secret = secretOf(desired)
  let outputs: Record<string, string> | undefined
  if (secret?.changed) {
    const plain = secret.plain
    if (!plain) throw new ProviderError('INVALID_FIELDS', 'The pasted key is missing.')
    checkPasted(plain, have.partial_key_hint)
    if ((body.status ?? have.status) !== 'active')
      throw new ProviderError('INVALID_FIELDS', 'An inactive key cannot be handed to an app.')
    outputs = { api_key: plain.trim() }
  }
  let after = have
  if (Object.keys(body).length) {
    const r = await anthropicCall(ctx, 'POST', `/api_keys/${seg(id, 'api key id')}`, { body })
    after = r.body && typeof r.body === 'object' && r.body.id ? r.body : { ...have, ...body }
  }
  return ok(
    id,
    keyObserved(after),
    { changed: Object.keys(body), sealed: outputs ? 'api_key' : undefined },
    outputs
  )
}

// ── Rate limits (read only) ──

function limitsList(rows: any[]): string[] {
  const out: string[] = []
  for (const r of rows) {
    const g = r?.group ?? {}
    const label = String(g.display_name ?? g.type ?? 'group')
    for (const l of Array.isArray(r?.limits) ? r.limits : [])
      if (l && typeof l.type === 'string') out.push(`${label} · ${l.type}: ${String(l.value)}`)
  }
  return out
}

async function readRates(ctx: ProviderContext, id: string): Promise<Observed | null> {
  if (id === 'organization') {
    const rows = await pageAll(ctx, '/rate_limits')
    return {
      type: T_RATE,
      externalId: id,
      name: 'Organization',
      fields: { scope: 'organization', limits: limitsList(rows) },
      tags: {},
      version: null,
      status: 'active',
      url: `${CONSOLE}/settings/limits`
    }
  }
  const ws = await readWsRaw(ctx, id)
  if (!ws) return null
  const rows = await pageAll(ctx, `/workspaces/${seg(id, 'workspace id')}/rate_limits`, {
    include_inherited: 'true'
  })
  return {
    type: T_RATE,
    externalId: id,
    name: ws.name ?? id,
    fields: { scope: id, limits: limitsList(rows) },
    tags: {},
    version: null,
    status: 'active',
    url: `${CONSOLE}/settings/limits`
  }
}

const RATE_FIELDS: ResourceTypeSpec['fields'] = [
  { key: 'scope', label: 'Scope', kind: 'string', readOnly: true },
  {
    key: 'limits',
    label: 'Limits',
    kind: 'list',
    readOnly: true,
    items: { key: 'limit', label: 'Limit', kind: 'string' }
  }
]

// ── Spend limits (workspace scope, where the organization has the API) ──

const SPEND_CACHE_KEY = 'spend_limits_available'

/** True when the organization has the Spend Limits API (probed once per five minutes). */
async function spendLimitsAvailable(ctx: ProviderContext): Promise<boolean> {
  const cached = ctx.tokens.get(SPEND_CACHE_KEY)
  if (cached) return cached === '1'
  let has = false
  try {
    const r = await anthropicCall(ctx, 'GET', '/spend_limits/effective', {
      query: { limit: 1 },
      allow: [400, 403, 404]
    })
    has = r.status === 200
  } catch {
    return false
  }
  ctx.tokens.set(
    SPEND_CACHE_KEY,
    has ? '1' : '0',
    new Date(ctx.now().getTime() + 5 * 60_000 + 60_000)
  )
  return has
}

function spendObserved(s: any): Observed | null {
  const scope = s?.scope
  const ws = scope?.type === 'workspace' ? String(scope.workspace_id ?? '') : ''
  const id = String(s?.id ?? s?.spend_limit_id ?? '')
  if (!ws || !id) return null
  const cents = s.amount === null || s.amount === undefined ? null : Number(s.amount)
  return {
    type: T_SPEND,
    externalId: id,
    name: ws,
    fields: { workspace: ws, amount_cents: Number.isFinite(cents) ? cents : null },
    tags: {},
    version: null,
    status: 'active',
    url: `${CONSOLE}/settings/limits`
  }
}

const SPEND_FIELDS: ResourceTypeSpec['fields'] = [
  {
    key: 'workspace',
    label: 'Workspace',
    kind: 'ref',
    refType: T_WS,
    required: true,
    createOnly: true,
    replaceOnChange: true
  },
  {
    key: 'amount_cents',
    label: 'Monthly limit (US cents)',
    kind: 'number',
    required: true,
    min: 0,
    help: '5000 = $50.00 a month. Only organizations with workspace spend limits have this.'
  }
]
const SPEND_LABEL = 'Anthropic spend limit'

function planSpend(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: T_SPEND,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Remove the spend limit of workspace ${String(observed.fields.workspace)}: it then spends with no cap from this limit.`,
        changes: [],
        preconditions: { amount_cents: observed.fields.amount_cents },
        risk: []
      }
    ]
  }
  if (!observed)
    return [
      {
        kind: 'create',
        type: T_SPEND,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Set a monthly spend limit of ${Number(desired.fields.amount_cents ?? 0) / 100} US dollars on the workspace.`,
        changes: [{ field: 'amount_cents', to: desired.fields.amount_cents }],
        preconditions: {},
        risk: []
      }
    ]
  const changes = diffFields(['amount_cents'], desired.fields, observed.fields)
  if (!changes.length) return []
  return [
    {
      kind: 'update',
      type: T_SPEND,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change the monthly limit of ${typedName(SPEND_LABEL, String(observed.fields.workspace))}.`,
      changes,
      preconditions: { amount_cents: observed.fields.amount_cents },
      risk: []
    }
  ]
}

function spendBody(ws: string, cents: unknown): Record<string, unknown> {
  const n = Number(cents)
  if (!Number.isInteger(n) || n < 0)
    throw new ProviderError('INVALID_FIELDS', 'The limit is a whole number of cents, 0 or more.')
  return {
    scope: { type: 'workspace', workspace_id: ws },
    amount: String(n),
    currency: 'USD',
    period: 'monthly'
  }
}

async function applySpend(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (!(await spendLimitsAvailable(ctx)))
    throw new ProviderError(
      'NOT_AVAILABLE',
      'Spend limits are not available for this organization.'
    )
  const id = op.externalId
  if (op.kind === 'delete') {
    await anthropicCall(ctx, 'DELETE', `/spend_limits/${seg(id, 'spend limit id')}`, {
      allow: [404]
    })
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const ws = seg(refOf(desired, 'workspace'), 'workspace id')
  const parent = await readWsRaw(ctx, ws)
  if (!parent)
    throw new ProviderError('NOT_FOUND', 'The workspace no longer exists.', { status: 404 })
  if (op.kind === 'create') {
    const all = await pageAll(ctx, '/spend_limits/effective')
    const hit = all
      .map((s) => spendObserved({ ...s, id: s.spend_limit_id }))
      .find((o) => o?.fields.workspace === ws)
    if (hit && desired.externalId !== hit.externalId)
      throw alreadyExists('A spend limit for this workspace')
  } else {
    const cur = await anthropicCall(ctx, 'GET', `/spend_limits/${seg(id, 'spend limit id')}`, {
      allow: [404]
    })
    const seen = cur.status === 404 ? null : spendObserved(cur.body)
    if (!seen)
      throw new ProviderError('NOT_FOUND', 'The spend limit no longer exists.', { status: 404 })
    if (seen.fields.workspace !== ws)
      throw new ProviderError('TARGET_MISMATCH', 'That spend limit belongs to another workspace.')
  }
  const r = await anthropicCall(ctx, 'POST', '/spend_limits', {
    body: spendBody(ws, desired.fields.amount_cents)
  })
  const made = spendObserved({ ...r.body, id: r.body?.id ?? r.body?.spend_limit_id })
  if (!made)
    throw new ProviderError('PROVIDER_REJECTED', 'Anthropic did not return the spend limit.')
  return ok(made.externalId, made, { set: true })
}

// ── Usage and cost (health + usageNow) ──

const sumCents = (rows: any[]): number =>
  rows.reduce((n, r) => n + (Number.parseFloat(String(r?.cost?.amount ?? '0')) || 0), 0)
const sumTokens = (rows: any[]): number =>
  rows.reduce((n, r) => n + (Number(r?.usage?.total_tokens) || 0), 0)

const floorHour = (d: Date): string => `${d.toISOString().slice(0, 13)}:00:00Z`

async function analytics(
  ctx: ProviderContext,
  kind: 'usage' | 'cost',
  query: Record<string, string | string[]>
): Promise<{ rows: any[]; refreshedAt: string | null }> {
  const rows: any[] = []
  let refreshedAt: string | null = null
  let page: string | null = null
  for (let i = 0; i < 20; i++) {
    const r: { body: any } = await anthropicCall(ctx, 'GET', `/analytics/${kind}`, {
      beta: ANALYTICS_BETA,
      query: { limit: 1000, ...query, ...(page ? { page } : {}) }
    })
    for (const x of Array.isArray(r.body?.data) ? r.body.data : []) rows.push(x)
    if (typeof r.body?.data_refreshed_at === 'string') refreshedAt = r.body.data_refreshed_at
    if (r.body?.has_more === true && typeof r.body?.next_page === 'string') page = r.body.next_page
    else break
  }
  return { rows, refreshedAt }
}

async function workspaceHealth(ctx: ProviderContext, id: string): Promise<HealthAnswer> {
  const checkedAt = ctx.now().toISOString()
  const ws = await readWsRaw(ctx, id)
  if (!ws) return { status: 'down', message: 'It is gone or archived at Anthropic.', checkedAt }
  const now = ctx.now()
  const day = floorHour(new Date(now.getTime() - 24 * 3600_000))
  const month = `${now.toISOString().slice(0, 7)}-01T00:00:00Z`
  const filter = { 'workspace_ids[]': [id] }
  const [c24, u24, cm, um] = await Promise.all([
    analytics(ctx, 'cost', { starting_at: day, ...filter }),
    analytics(ctx, 'usage', { starting_at: day, ...filter }),
    analytics(ctx, 'cost', { starting_at: month, ...filter }),
    analytics(ctx, 'usage', { starting_at: month, ...filter })
  ])
  const usd = (cents: number) => Math.round(cents) / 100
  const details: Record<string, string | number | boolean> = {
    cost_24h_usd: usd(sumCents(c24.rows)),
    tokens_24h: sumTokens(u24.rows),
    cost_month_to_date_usd: usd(sumCents(cm.rows)),
    tokens_month_to_date: sumTokens(um.rows)
  }
  const refreshed = c24.refreshedAt ?? cm.refreshedAt
  if (refreshed) details.data_refreshed_at = refreshed
  return refreshed
    ? { status: 'ok', checkedAt, details }
    : {
        status: 'unknown',
        message: 'Anthropic has no usage data for this period yet (it lands within 4 to 24 hours).',
        checkedAt,
        details
      }
}

/** Cost rows per workspace and day (completed days) plus per hour for today so far. */
async function costRows(
  ctx: ProviderContext,
  range: { from: string; to: string }
): Promise<CostRow[]> {
  const now = ctx.now()
  const rangeStart = new Date(`${range.from.slice(0, 10)}T00:00:00Z`)
  const earliest = new Date(now.getTime() - 31 * 86_400_000)
  const start = new Date(Math.max(rangeStart.getTime(), earliest.getTime()))
  start.setUTCHours(0, 0, 0, 0)
  const todayStart = new Date(now)
  todayStart.setUTCHours(0, 0, 0, 0)
  const out: CostRow[] = []
  const push = (rows: any[]) => {
    for (const r of rows) {
      const ws = r?.group?.workspace_id
      const amount = Number.parseFloat(String(r?.cost?.amount ?? ''))
      if (typeof ws !== 'string' || !ws || !Number.isFinite(amount)) continue
      out.push({
        date: String(r.starting_at ?? '').slice(0, 10),
        amountCents: amount,
        currency: String(r.cost?.currency ?? 'USD'),
        externalId: ws,
        service: 'anthropic',
        recordType: 'usage'
      })
    }
  }
  if (start < todayStart) {
    const done = await analytics(ctx, 'cost', {
      starting_at: start.toISOString().replace('.000Z', 'Z'),
      ending_at: todayStart.toISOString().replace('.000Z', 'Z'),
      time_bucket_width: '1d',
      'group_by[]': ['workspace_id']
    })
    push(done.rows)
  }
  const hourNow = floorHour(now)
  if (hourNow > todayStart.toISOString().replace('.000Z', 'Z')) {
    const today = await analytics(ctx, 'cost', {
      starting_at: todayStart.toISOString().replace('.000Z', 'Z'),
      ending_at: hourNow,
      time_bucket_width: '1h',
      'group_by[]': ['workspace_id']
    })
    push(today.rows)
  }
  return out
}

// ── Cost estimate: a workspace is free; what it spends is usage ──

async function workspaceEstimate(
  _ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  try {
    if (!desired && !observed) return unknownEstimate('No workspace to price.')
    return estimateOf({
      basis: 'usage',
      confidence: 'usage_varies',
      lines: [],
      priceAsOf: '2026-11-27',
      note: 'A workspace costs nothing by itself: you pay for the tokens its keys use, plus usage. The Hub counts what it has used so far from the Usage and Cost Analytics API.'
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}

// ── Types ──

const TYPES: ResourceTypeSpec[] = [
  {
    key: T_WS,
    label: WS_LABEL,
    scope: 'app',
    nameField: 'name',
    fields: WS_FIELDS,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive', 'downtime')
      return out
    },
    costClass: () => 'monthly',
    estimate: workspaceEstimate
  },
  {
    key: T_MEMBER,
    label: MEMBER_LABEL,
    scope: 'app',
    nameField: 'email',
    fields: MEMBER_FIELDS,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: true,
    refs: [{ field: 'workspace', type: T_WS, required: true }],
    risk: () => []
  },
  {
    key: T_KEY,
    label: KEY_LABEL,
    scope: 'app',
    nameField: 'name',
    fields: KEY_FIELDS,
    capabilities: {
      create: false,
      update: true,
      delete: false,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: true,
    refs: [{ field: 'workspace', type: T_WS, required: false }],
    outputs: [{ key: 'api_key', label: 'Anthropic API key', secret: true, onceOnly: true }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.changes.some((c) => c.field === 'status' && c.to === 'inactive')) out.push('downtime')
      return out
    }
  },
  {
    key: T_SPEND,
    label: SPEND_LABEL,
    scope: 'app',
    nameField: 'workspace',
    fields: SPEND_FIELDS,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: true,
    refs: [{ field: 'workspace', type: T_WS, required: true }],
    risk: () => []
  },
  {
    key: T_RATE,
    label: 'Anthropic rate limits',
    scope: 'app',
    nameField: 'scope',
    fields: RATE_FIELDS,
    capabilities: {
      create: false,
      update: false,
      delete: false,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [],
    risk: () => []
  }
]

const TYPE_KEYS = TYPES.map((t) => t.key)

function known(type: unknown): string {
  if (typeof type !== 'string' || !TYPE_KEYS.includes(type))
    throw new ProviderError('UNKNOWN_TYPE', `Anthropic has no ${String(type)}.`)
  return type
}

// ── The adapter ──

export const anthropicAdapter: ProviderAdapter = {
  key: 'anthropic',
  label: 'Anthropic',
  connection: {
    fields: [
      {
        key: 'organization',
        label: 'Organization name',
        kind: 'string',
        placeholder: 'Acme',
        help: 'Shown in lists only.'
      },
      {
        key: 'credential',
        label: 'Admin API key',
        kind: 'string',
        secret: true,
        required: true,
        help: 'An Admin API key (sk-ant-admin…, Console → Settings → Admin keys) or an org:admin OAuth token. A regular API key does not work.'
      }
    ],
    hosts: () => ['api.anthropic.com'],
    describe: (config) => `Anthropic ${String(config.organization ?? 'organization')}`.trim(),
    validate(_config, secrets) {
      const problems: string[] = []
      const c = secrets.credential
      if (c !== undefined) {
        if (!c.trim()) problems.push('The Admin API key is empty.')
        else if (c.startsWith('sk-ant-api'))
          problems.push(
            'That is a regular API key. The Admin API needs an Admin API key (sk-ant-admin…) or an org:admin token.'
          )
      }
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const permissions: ConnectionTest['permissions'] = []
    const need = (type: string, what: string, has: boolean) =>
      permissions.push({ type, need: what, has })
    let identity: string | null = null
    try {
      const me = await anthropicCall(ctx, 'GET', '/me')
      identity = `Anthropic organization ${String(me.body?.name ?? me.body?.id ?? '')}`.trim()
    } catch (err) {
      if (err instanceof ProviderError) {
        need('*', 'Admin API access (an Admin API key or an org:admin token)', false)
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
    need('*', 'Admin API access (an Admin API key or an org:admin token)', true)
    const probe = async (
      path: string,
      query: Record<string, string | number> = {},
      beta?: string
    ) => {
      try {
        const r = await anthropicCall(ctx, 'GET', path, {
          query: { limit: 1, ...query },
          allow: [403, 404],
          ...(beta ? { beta } : {})
        })
        return r.status === 200
      } catch {
        return false
      }
    }
    need(T_WS, 'read and manage workspaces', await probe('/workspaces'))
    need(T_MEMBER, 'read and manage organization members', await probe('/users'))
    need(T_KEY, 'read and manage API keys', await probe('/api_keys'))
    need(T_RATE, 'read rate limits', await probe('/rate_limits'))
    const today = `${ctx.now().toISOString().slice(0, 10)}T00:00:00Z`
    need(
      T_WS,
      'read usage and cost (Usage and Cost Analytics API)',
      await probe('/analytics/cost', { starting_at: today }, ANALYTICS_BETA)
    )
    const missing = permissions.filter((p) => !p.has).map((p) => p.need)
    const spend = await spendLimitsAvailable(ctx)
    return {
      ok: missing.length === 0,
      identity,
      permissions,
      missing,
      ...(spend ? {} : { message: 'Spend limits are not available for this organization.' })
    }
  },

  async observe(ctx, type, externalId) {
    switch (known(type)) {
      case T_WS: {
        const raw = await readWsRaw(ctx, externalId)
        return raw && !isDefaultWs(raw) ? wsObserved(raw) : null
      }
      case T_MEMBER:
        return readMember(ctx, externalId)
      case T_KEY: {
        const raw = await readKeyRaw(ctx, externalId)
        return raw && raw.status !== 'archived' ? keyObserved(raw) : null
      }
      case T_RATE:
        return readRates(ctx, externalId)
      default: {
        if (!(await spendLimitsAvailable(ctx))) return null
        const r = await anthropicCall(
          ctx,
          'GET',
          `/spend_limits/${seg(externalId, 'spend limit id')}`,
          {
            allow: [404]
          }
        )
        return r.status === 404 ? null : spendObserved(r.body)
      }
    }
  },

  async list(ctx, type): Promise<ListPage> {
    switch (known(type)) {
      case T_WS:
        return { items: (await listWsRaw(ctx)).map(wsObserved), cursor: null }
      case T_KEY:
        return { items: (await listKeysRaw(ctx)).map(keyObserved), cursor: null }
      case T_MEMBER: {
        const items: Observed[] = []
        for (const w of await listWsRaw(ctx)) {
          const members = await pageAll(ctx, `/workspaces/${seg(w.id, 'workspace id')}/members`)
          for (const m of members) {
            const u = await readUser(ctx, String(m.user_id))
            items.push(
              memberObserved({ ...m, workspace_id: m.workspace_id ?? w.id }, u?.email ?? null)
            )
          }
        }
        return { items, cursor: null }
      }
      case T_RATE: {
        const items: Observed[] = []
        const org = await readRates(ctx, 'organization')
        if (org) items.push(org)
        for (const w of await listWsRaw(ctx)) {
          const o = await readRates(ctx, String(w.id))
          if (o) items.push(o)
        }
        return { items, cursor: null }
      }
      default: {
        if (!(await spendLimitsAvailable(ctx))) return { items: [], cursor: null }
        const rows = await pageAll(ctx, '/spend_limits/effective')
        const items = rows
          .map((s) => spendObserved({ ...s, id: s.spend_limit_id }))
          .filter((o): o is Observed => o !== null)
        return { items, cursor: null }
      }
    }
  },

  /** Plan time: a workspace of that name, or a member already in the workspace. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    if (type === T_WS) {
      const name = String(desired.fields.name ?? '').trim()
      if (!name) return null
      const hit = (await listWsRaw(ctx)).find((w) => w.name === name)
      return hit ? wsObserved(hit) : null
    }
    if (type === T_MEMBER) {
      const ws = desired.refs.workspace
      const email = String(desired.fields.email ?? '').trim()
      if (typeof ws !== 'string' || !email) return null
      const user = await findUserByEmail(ctx, email)
      if (!user?.id) return null
      return readMember(ctx, memberId(seg(ws, 'workspace id'), seg(user.id, 'user id')))
    }
    return null
  },

  plan(_ctx, desired, observed) {
    const type = known(desired?.type ?? observed?.type)
    if (type === T_WS) return planWs(desired, observed)
    if (type === T_MEMBER) return planMember(desired, observed)
    if (type === T_KEY) return planKey(desired, observed)
    if (type === T_SPEND) return planSpend(desired, observed)
    return []
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    switch (known(op.type)) {
      case T_WS:
        return applyWs(ctx, op, desired)
      case T_MEMBER:
        return applyMember(ctx, op, desired)
      case T_KEY:
        return applyKey(ctx, op, desired)
      case T_SPEND:
        return applySpend(ctx, op, desired)
      default:
        throw new ProviderError(
          'READ_ONLY',
          'Rate limits are read only here: change them in the Console.'
        )
    }
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    if (known(type) === T_WS) return workspaceHealth(ctx, externalId)
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Anthropic.', checkedAt }
    if (type === T_KEY && seen.fields.status === 'inactive')
      return {
        status: 'warn',
        message: 'The key is inactive.',
        checkedAt,
        details: { status: 'inactive' }
      }
    return { status: 'ok', checkedAt }
  },

  /** What each workspace spent in `range` (cost rows, workspace id as the external id). */
  async usageNow(ctx, range) {
    return costRows(ctx, range)
  }
}
