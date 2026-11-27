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
import { baseOf, idSeg, ptCall, withScrub } from './client.js'

/**
 * Portainer (`portainer`): an API key (access token) + the address of a self-hosted Portainer
 * (https only; a private address only through SSRF_ALLOW_HOSTS). Types: environment (a Hub
 * Docker host registered in Portainer as an Edge agent; its edge key is an OUTPUT), team, team
 * access (a team's role on one environment; read-only by default, anything higher is
 * `public_exposure`), registry (credentials sealed, write-only) and stack (READ-ONLY).
 *
 * THE RULING: the Hub agent is the only Docker writer. This adapter manages Portainer's own
 * setup (environments, teams, access, registries) and never deploys, updates, restarts or
 * removes a stack, container or service: a stack write is refused `DOCKER_WRITE_NOT_ALLOWED`,
 * and the client (client.ts) refuses any call outside Portainer's own setup before a request
 * is made.
 *
 * External ids: environment / team / registry / stack = the numeric id; team access =
 * `<environment id>/<team id>`.
 */

const ENV = 'portainer.environment'
const TEAM = 'portainer.team'
const ACCESS = 'portainer.team_access'
const REGISTRY = 'portainer.registry'
const STACK = 'portainer.stack'

type Obj = Record<string, unknown>
const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

// ── Roles ──

/** Portainer's role ids by the name the Hub uses. */
const ROLE_IDS: Record<string, number> = {
  admin: 1,
  helpdesk: 2,
  standard: 3,
  readonly: 4,
  operator: 5
}
const ROLE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(ROLE_IDS).map(([k, v]) => [v, k])
)
const ROLE_OPTIONS = [
  { value: 'readonly', label: 'Read-only user' },
  { value: 'helpdesk', label: 'Helpdesk' },
  { value: 'operator', label: 'Operator' },
  { value: 'standard', label: 'Standard user' },
  { value: 'admin', label: 'Environment administrator' }
]

const REGISTRY_TYPES: Record<string, number> = { quay: 1, custom: 3, gitlab: 4, dockerhub: 6 }
const REGISTRY_TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(REGISTRY_TYPES).map(([k, v]) => [v, k])
)

const NAME_RE = '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$'

// ── Resource types ──

const f = (spec: FieldSpec): FieldSpec => spec

const SPECS: Record<string, ResourceTypeSpec> = {
  [ENV]: {
    key: ENV,
    label: 'Portainer environment',
    scope: 'shared',
    reversible: false,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    refs: [],
    fields: [
      f({
        key: 'name',
        label: 'Name',
        kind: 'string',
        required: true,
        pattern: NAME_RE,
        help: 'How the Docker host shows in Portainer.'
      }),
      f({
        key: 'publicUrl',
        label: 'Public address',
        kind: 'string',
        help: 'The host name or address people reach published ports on (shown in Portainer).'
      }),
      f({
        key: 'groupId',
        label: 'Group',
        kind: 'number',
        default: 1,
        min: 1,
        help: 'The Portainer environment group id (1 = Unassigned).'
      }),
      f({
        key: 'edgeCheckinInterval',
        label: 'Check-in every (seconds)',
        kind: 'number',
        default: 5,
        min: 1,
        max: 3600,
        help: 'How often the Edge agent on the host asks Portainer for work.'
      }),
      f({
        key: 'kind',
        label: 'Kind',
        kind: 'string',
        readOnly: true,
        help: 'The Hub registers Edge agents; others shown here were made in Portainer.'
      })
    ],
    outputs: [{ key: 'edge_key', label: 'Edge key', secret: true }],
    risk: (op) => (op.kind === 'delete' ? ['destructive'] : [])
  },
  [TEAM]: {
    key: TEAM,
    label: 'Portainer team',
    scope: 'shared',
    reversible: false,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    refs: [],
    fields: [
      f({
        key: 'name',
        label: 'Name',
        kind: 'string',
        required: true,
        pattern: NAME_RE
      })
    ],
    risk: (op) => (op.kind === 'delete' ? ['destructive'] : [])
  },
  [ACCESS]: {
    key: ACCESS,
    label: 'Portainer team access',
    scope: 'shared',
    reversible: true,
    nameField: 'team',
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    refs: [
      { field: 'environment', type: ENV },
      { field: 'team', type: TEAM }
    ],
    fields: [
      f({
        key: 'environment',
        label: 'Environment',
        kind: 'ref',
        refType: ENV,
        required: true,
        replaceOnChange: true
      }),
      f({
        key: 'team',
        label: 'Team',
        kind: 'ref',
        refType: TEAM,
        required: true,
        replaceOnChange: true
      }),
      f({
        key: 'role',
        label: 'Role',
        kind: 'enum',
        default: 'readonly',
        options: ROLE_OPTIONS,
        help: 'Read-only by default. Any role above read-only lets the team act on the host’s containers through Portainer and needs a Hub administrator.'
      })
    ],
    // Judged on what is SENT: any role above read-only gives the team more than reading.
    risk: (op, desired) => {
      if (op.kind === 'delete' || !desired) return []
      const role = String(desired.fields.role ?? 'readonly')
      return role === 'readonly' ? [] : (['public_exposure'] as RiskFlag[])
    }
  },
  [REGISTRY]: {
    key: REGISTRY,
    label: 'Portainer registry',
    scope: 'shared',
    reversible: false,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    refs: [],
    fields: [
      f({ key: 'name', label: 'Name', kind: 'string', required: true, pattern: NAME_RE }),
      f({
        key: 'type',
        label: 'Kind',
        kind: 'enum',
        default: 'custom',
        createOnly: true,
        replaceOnChange: true,
        options: [
          { value: 'custom', label: 'Custom registry' },
          { value: 'dockerhub', label: 'Docker Hub' },
          { value: 'gitlab', label: 'GitLab' },
          { value: 'quay', label: 'Quay.io' }
        ]
      }),
      f({
        key: 'url',
        label: 'Registry address',
        kind: 'string',
        required: true,
        pattern: '^(https?://)?[A-Za-z0-9][A-Za-z0-9.:/_-]*$',
        help: 'For example registry.example.com:5000 or docker.io.'
      }),
      f({ key: 'authentication', label: 'Needs a login', kind: 'boolean', default: true }),
      f({ key: 'username', label: 'Username', kind: 'string' }),
      f({
        key: 'password',
        label: 'Password or token',
        kind: 'secret',
        help: 'Sealed by the Hub and written to Portainer; never shown again.'
      })
    ],
    risk: (op) => (op.kind === 'delete' ? ['destructive'] : [])
  },
  [STACK]: {
    key: STACK,
    label: 'Portainer stack',
    scope: 'shared',
    reversible: false,
    capabilities: {
      create: false,
      update: false,
      delete: false,
      adopt: true,
      snapshot: false,
      tag: false
    },
    refs: [{ field: 'environment', type: ENV, required: false }],
    fields: [
      f({ key: 'name', label: 'Name', kind: 'string', readOnly: true }),
      f({ key: 'environment', label: 'Environment', kind: 'ref', refType: ENV, readOnly: true }),
      f({ key: 'kind', label: 'Kind', kind: 'string', readOnly: true }),
      f({ key: 'status', label: 'Status', kind: 'string', readOnly: true })
    ],
    risk: () => []
  }
}

const TYPES: ResourceTypeSpec[] = [
  SPECS[ENV]!,
  SPECS[TEAM]!,
  SPECS[ACCESS]!,
  SPECS[REGISTRY]!,
  SPECS[STACK]!
]

// ── Observed shapes (explicit picks only: an edge key or a password never enters one) ──

function envKind(type: unknown): string {
  const t = num(type)
  if (t === 4) return 'edge'
  if (t === 2) return 'agent'
  if (t === 1) return 'docker'
  return 'other'
}

function consoleUrl(ctx: ProviderContext, path: string): string | null {
  const b = baseOf(ctx.config)
  return b ? `${b.origin}/#!${path}` : null
}

function fromEnv(ctx: ProviderContext, b: any): Observed {
  const id = String(b.Id)
  return {
    type: ENV,
    externalId: id,
    name: str(b.Name),
    fields: {
      name: str(b.Name),
      publicUrl: str(b.PublicURL),
      groupId: num(b.GroupId ?? b.GroupID),
      edgeCheckinInterval: num(b.EdgeCheckinInterval),
      kind: envKind(b.Type)
    },
    tags: {},
    status: num(b.Status) === 1 ? 'up' : num(b.Status) === 2 ? 'down' : null,
    url: consoleUrl(ctx, `/${id}/docker/dashboard`)
  }
}

function fromTeam(b: any): Observed {
  return {
    type: TEAM,
    externalId: String(b.Id),
    name: str(b.Name),
    fields: { name: str(b.Name) },
    tags: {}
  }
}

function fromRegistry(ctx: ProviderContext, b: any): Observed {
  return {
    type: REGISTRY,
    externalId: String(b.Id),
    name: str(b.Name),
    fields: {
      name: str(b.Name),
      type: REGISTRY_TYPE_NAMES[num(b.Type) ?? -1] ?? 'custom',
      url: str(b.URL),
      authentication: b.Authentication === true,
      username: str(b.Username)
    },
    tags: {},
    url: consoleUrl(ctx, `/registries/${String(b.Id)}`)
  }
}

function fromStack(ctx: ProviderContext, b: any): Observed {
  const t = num(b.Type)
  return {
    type: STACK,
    externalId: String(b.Id),
    name: str(b.Name),
    fields: {
      name: str(b.Name),
      environment: b.EndpointId != null ? String(b.EndpointId) : null,
      kind: t === 1 ? 'swarm' : t === 2 ? 'compose' : t === 3 ? 'kubernetes' : 'other',
      status: num(b.Status) === 1 ? 'active' : num(b.Status) === 2 ? 'inactive' : null
    },
    tags: {},
    status: num(b.Status) === 1 ? 'active' : num(b.Status) === 2 ? 'inactive' : null,
    url: consoleUrl(ctx, `/${String(b.EndpointId ?? '')}/docker/stacks/${String(b.Name ?? '')}`)
  }
}

function splitAccess(externalId: string): [string, string] {
  const i = externalId.indexOf('/')
  if (i < 1 || i === externalId.length - 1)
    throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return [
    idSeg(externalId.slice(0, i), 'environment id'),
    idSeg(externalId.slice(i + 1), 'team id')
  ]
}

function fromAccess(envId: string, teamId: string, policy: any): Observed {
  return {
    type: ACCESS,
    externalId: `${envId}/${teamId}`,
    name: `team ${teamId} on environment ${envId}`,
    fields: {
      environment: envId,
      team: teamId,
      role: ROLE_NAMES[num(policy?.RoleId) ?? -1] ?? 'other'
    },
    tags: {}
  }
}

// ── Reads ──

async function getOne(ctx: ProviderContext, kind: string, id: string): Promise<any | null> {
  const a = await ptCall(ctx, 'GET', `/${kind}/${idSeg(id)}`, { allow: [404] })
  return a.status === 404 ? null : asObj(a.body)
}

async function getList(ctx: ProviderContext, kind: string, query?: Record<string, string>) {
  const a = await ptCall(ctx, 'GET', `/${kind}`, query ? { query } : {})
  return Array.isArray(a.body) ? (a.body as any[]) : []
}

async function observeOne(
  ctx: ProviderContext,
  type: string,
  externalId: string
): Promise<Observed | null> {
  switch (type) {
    case ENV: {
      const b = await getOne(ctx, 'endpoints', externalId)
      return b ? fromEnv(ctx, b) : null
    }
    case TEAM: {
      const b = await getOne(ctx, 'teams', externalId)
      return b ? fromTeam(b) : null
    }
    case REGISTRY: {
      const b = await getOne(ctx, 'registries', externalId)
      return b ? fromRegistry(ctx, b) : null
    }
    case STACK: {
      const b = await getOne(ctx, 'stacks', externalId)
      return b ? fromStack(ctx, b) : null
    }
    case ACCESS: {
      const [envId, teamId] = splitAccess(externalId)
      const b = await getOne(ctx, 'endpoints', envId)
      const policy = b ? asObj(b.TeamAccessPolicies)[teamId] : undefined
      return policy ? fromAccess(envId, teamId, policy) : null
    }
    default:
      throw new ProviderError('UNKNOWN_TYPE', `Portainer has no resource type ${type}.`)
  }
}

// ── Plan ──

const KEYS: Record<string, string[]> = {
  [ENV]: ['name', 'publicUrl', 'groupId', 'edgeCheckinInterval'],
  [TEAM]: ['name'],
  [ACCESS]: ['role'],
  [REGISTRY]: ['name', 'type', 'url', 'authentication', 'username'],
  [STACK]: ['name']
}

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function same(a: unknown, b: unknown): boolean {
  const x = norm(a)
  const y = norm(b)
  if (typeof x === 'number' || typeof y === 'number') return Number(x) === Number(y)
  return x === y
}

function planPortainer(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const type = desired?.type ?? observed?.type ?? ''
  const spec = SPECS[type]
  if (!spec) return []
  const label = spec.label
  const base = {
    type,
    resourceId: desired?.resourceId ?? null,
    externalId: observed?.externalId ?? desired?.externalId ?? null,
    preconditions: {} as Record<string, unknown>,
    risk: [] as RiskFlag[]
  }
  const stackBlock = (text: string): Record<string, unknown> => ({
    $blocker: {
      code: 'DOCKER_WRITE_NOT_ALLOWED',
      message: `${text} The Hub never changes stacks through Portainer: the Hub agent is the only thing that writes Docker.`
    }
  })

  if (!desired) {
    if (!observed) return []
    return [
      {
        ...base,
        kind: 'delete',
        reason: `Delete ${typedName(label, observed.name)}`,
        changes: [],
        ...(type === STACK ? { data: stackBlock('A stack cannot be removed here.') } : {})
      }
    ]
  }
  const keys = KEYS[type] ?? []
  const want = desired.fields
  if (!observed) {
    return [
      {
        ...base,
        kind: 'create',
        reason: `Create ${typedName(label, str(want.name))}`,
        changes: [
          ...keys
            .filter((k) => want[k] !== undefined && want[k] !== null)
            .map((k) => ({ field: k, to: want[k] })),
          ...(type === REGISTRY && (want.password as any)?.changed
            ? [{ field: 'password', secret: true } as FieldChange]
            : [])
        ],
        ...(type === STACK ? { data: stackBlock('A stack cannot be created here.') } : {})
      }
    ]
  }
  const changes: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (!same(want[k], observed.fields[k]))
      changes.push({ field: k, from: norm(observed.fields[k]), to: norm(want[k]) })
  }
  if (type === REGISTRY && (want.password as any)?.changed)
    changes.push({ field: 'password', secret: true })
  if (!changes.length)
    return [
      {
        ...base,
        kind: 'noop',
        reason: `${typedName(label, observed.name)} is up to date`,
        changes: []
      }
    ]
  return [
    {
      ...base,
      kind: 'update',
      reason: `Change ${fieldWords(spec.fields, changes)} of ${typedName(label, observed.name)}`,
      changes,
      ...(type === STACK ? { data: stackBlock('A stack cannot be changed here.') } : {})
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
  ...(outputs && Object.keys(outputs).length ? { outputs } : {})
})

function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} at Portainer. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

function refId(desired: DesiredResource | null, field: string): string {
  const v = desired?.refs?.[field]
  const one = Array.isArray(v) ? v[0] : v
  if (typeof one === 'string' && one) return idSeg(one, field)
  throw new ProviderError(
    'INVALID_FIELDS',
    `The ${field} this change belongs to is not created yet.`
  )
}

const dockerRefusal = (): ProviderError =>
  new ProviderError(
    'DOCKER_WRITE_NOT_ALLOWED',
    'The Hub never changes stacks, containers or services through Portainer: the Hub agent is the only thing that writes Docker.'
  )

async function existingByName(
  ctx: ProviderContext,
  type: string,
  name: string
): Promise<Observed | null> {
  const lower = name.toLowerCase()
  if (type === ENV) {
    const list = await getList(ctx, 'endpoints', { name })
    const hit = list.find((e) => String(e?.Name ?? '').toLowerCase() === lower)
    return hit ? fromEnv(ctx, hit) : null
  }
  if (type === TEAM) {
    const hit = (await getList(ctx, 'teams')).find(
      (t) => String(t?.Name ?? '').toLowerCase() === lower
    )
    return hit ? fromTeam(hit) : null
  }
  if (type === REGISTRY) {
    const hit = (await getList(ctx, 'registries')).find(
      (r) => String(r?.Name ?? '').toLowerCase() === lower
    )
    return hit ? fromRegistry(ctx, hit) : null
  }
  return null
}

function plainOf(desired: DesiredResource | null): string[] {
  const p = (desired?.fields?.password as any)?.plain
  return typeof p === 'string' && p ? [p] : []
}

async function currentPolicies(ctx: ProviderContext, envId: string): Promise<Obj> {
  const b = await getOne(ctx, 'endpoints', envId)
  if (!b) throw new ProviderError('NOT_FOUND', 'The environment no longer exists.', { status: 404 })
  return { ...asObj(b.TeamAccessPolicies) }
}

async function applyOne(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const type = op.type
  if (type === STACK) throw dockerRefusal()
  const want = asObj(desired?.fields)
  const ext = op.externalId ?? desired?.externalId ?? null

  // ── delete ──
  if (op.kind === 'delete') {
    if (!ext) throw new ProviderError('INVALID_FIELDS', 'There is nothing to delete.')
    if (type === ACCESS) {
      const [envId, teamId] = splitAccess(ext)
      if (desired) {
        if (refId(desired, 'environment') !== envId || refId(desired, 'team') !== teamId)
          throw new ProviderError(
            'TARGET_MISMATCH',
            'That access is not the one this change names.'
          )
      }
      const b = await getOne(ctx, 'endpoints', envId)
      if (!b) return ok(ext, null, { alreadyGone: true })
      const policies = { ...asObj(b.TeamAccessPolicies) }
      if (!(teamId in policies)) return ok(ext, null, { alreadyGone: true })
      delete policies[teamId]
      await ptCall(ctx, 'PUT', `/endpoints/${envId}`, { body: { TeamAccessPolicies: policies } })
      return ok(ext, null)
    }
    const kind = type === ENV ? 'endpoints' : type === TEAM ? 'teams' : 'registries'
    const seen = await getOne(ctx, kind, ext)
    if (!seen) return ok(ext, null, { alreadyGone: true })
    await ptCall(ctx, 'DELETE', `/${kind}/${idSeg(ext)}`, { allow: [404] })
    return ok(ext, null)
  }

  // ── create ──
  if (op.kind === 'create') {
    const resumed = !!desired?.externalId
    if (type === ENV) {
      const name = str(want.name)
      if (!name) throw new ProviderError('INVALID_FIELDS', 'An environment needs a name.')
      if (!resumed && (await existingByName(ctx, ENV, name)))
        throw alreadyExists(`An environment named ${name} already exists`)
      const origin = baseOf(ctx.config)?.origin
      const made = await ptCall(ctx, 'POST', '/endpoints', {
        form: {
          Name: name,
          EndpointCreationType: 4,
          URL: origin,
          PublicURL: str(want.publicUrl) ?? undefined,
          GroupID: num(want.groupId) ?? 1,
          EdgeCheckinInterval: num(want.edgeCheckinInterval) ?? 5
        }
      })
      const id = asObj(made.body).Id
      if (id == null)
        throw new ProviderError('PROVIDER_REJECTED', 'Portainer did not answer an id.')
      const key = str(asObj(made.body).EdgeKey)
      const outputs = key ? { edge_key: key } : undefined
      return ok(String(id), await observeOne(ctx, ENV, String(id)), undefined, outputs)
    }
    if (type === TEAM) {
      const name = str(want.name)
      if (!name) throw new ProviderError('INVALID_FIELDS', 'A team needs a name.')
      if (!resumed && (await existingByName(ctx, TEAM, name)))
        throw alreadyExists(`A team named ${name} already exists`)
      const made = await ptCall(ctx, 'POST', '/teams', { body: { Name: name } })
      const id = asObj(made.body).Id
      if (id == null)
        throw new ProviderError('PROVIDER_REJECTED', 'Portainer did not answer an id.')
      return ok(String(id), await observeOne(ctx, TEAM, String(id)))
    }
    if (type === REGISTRY) {
      const name = str(want.name)
      const url = str(want.url)
      if (!name || !url)
        throw new ProviderError('INVALID_FIELDS', 'A registry needs a name and an address.')
      if (!resumed && (await existingByName(ctx, REGISTRY, name)))
        throw alreadyExists(`A registry named ${name} already exists`)
      const auth = want.authentication !== false
      const plain = (want.password as any)?.plain
      if (auth && (!str(want.username) || typeof plain !== 'string' || !plain))
        throw new ProviderError(
          'INVALID_FIELDS',
          'A registry that needs a login needs a username and a password.'
        )
      const made = await ptCall(ctx, 'POST', '/registries', {
        extraScrub: plainOf(desired),
        body: {
          Name: name,
          Type: REGISTRY_TYPES[String(want.type ?? 'custom')] ?? 3,
          URL: url,
          Authentication: auth,
          ...(auth ? { Username: str(want.username), Password: plain } : {})
        }
      })
      const id = asObj(made.body).Id
      if (id == null)
        throw new ProviderError('PROVIDER_REJECTED', 'Portainer did not answer an id.')
      return ok(String(id), await observeOne(ctx, REGISTRY, String(id)))
    }
    if (type === ACCESS) {
      const envId = refId(desired, 'environment')
      const teamId = refId(desired, 'team')
      const role = String(want.role ?? 'readonly')
      const roleId = ROLE_IDS[role]
      if (!roleId) throw new ProviderError('INVALID_FIELDS', `${role} is not a Portainer role.`)
      if (!(await getOne(ctx, 'teams', teamId)))
        throw new ProviderError('NOT_FOUND', 'The team no longer exists.', { status: 404 })
      const policies = await currentPolicies(ctx, envId)
      if (teamId in policies && !resumed)
        throw alreadyExists('That team already has access to the environment')
      policies[teamId] = { RoleId: roleId }
      await ptCall(ctx, 'PUT', `/endpoints/${envId}`, { body: { TeamAccessPolicies: policies } })
      const id = `${envId}/${teamId}`
      return ok(id, await observeOne(ctx, ACCESS, id))
    }
    throw new ProviderError('UNKNOWN_TYPE', `Portainer has no resource type ${type}.`)
  }

  // ── update ──
  if (!ext) throw new ProviderError('INVALID_FIELDS', 'There is nothing to update.')
  const changed = new Set(op.changes.map((c) => c.field))
  if (type === ENV) {
    const have = await getOne(ctx, 'endpoints', ext)
    if (!have)
      throw new ProviderError('NOT_FOUND', 'The environment no longer exists.', { status: 404 })
    const body: Obj = {}
    if (changed.has('name')) body.Name = str(want.name)
    if (changed.has('publicUrl')) body.PublicURL = str(want.publicUrl) ?? ''
    if (changed.has('groupId')) body.GroupID = num(want.groupId) ?? 1
    if (changed.has('edgeCheckinInterval'))
      body.EdgeCheckinInterval = num(want.edgeCheckinInterval) ?? 5
    await ptCall(ctx, 'PUT', `/endpoints/${idSeg(ext)}`, { body })
    return ok(ext, await observeOne(ctx, ENV, ext))
  }
  if (type === TEAM) {
    if (!(await getOne(ctx, 'teams', ext)))
      throw new ProviderError('NOT_FOUND', 'The team no longer exists.', { status: 404 })
    await ptCall(ctx, 'PUT', `/teams/${idSeg(ext)}`, { body: { Name: str(want.name) } })
    return ok(ext, await observeOne(ctx, TEAM, ext))
  }
  if (type === REGISTRY) {
    if (!(await getOne(ctx, 'registries', ext)))
      throw new ProviderError('NOT_FOUND', 'The registry no longer exists.', { status: 404 })
    const body: Obj = {}
    if (changed.has('name')) body.Name = str(want.name)
    if (changed.has('url')) body.URL = str(want.url)
    if (changed.has('authentication')) body.Authentication = want.authentication !== false
    const newPassword = changed.has('password')
    if (changed.has('username') || newPassword) body.Username = str(want.username)
    if (newPassword) {
      const plain = (want.password as any)?.plain
      if (typeof plain !== 'string' || !plain)
        throw new ProviderError('INVALID_FIELDS', 'The new password is missing.')
      body.Password = plain
    }
    await ptCall(ctx, 'PUT', `/registries/${idSeg(ext)}`, { body, extraScrub: plainOf(desired) })
    return ok(ext, await observeOne(ctx, REGISTRY, ext))
  }
  if (type === ACCESS) {
    const [envId, teamId] = splitAccess(ext)
    if (desired && (refId(desired, 'environment') !== envId || refId(desired, 'team') !== teamId))
      throw new ProviderError('TARGET_MISMATCH', 'That access is not the one this change names.')
    const roleId = ROLE_IDS[String(want.role ?? 'readonly')]
    if (!roleId) throw new ProviderError('INVALID_FIELDS', 'That is not a Portainer role.')
    const policies = await currentPolicies(ctx, envId)
    if (!(teamId in policies))
      throw new ProviderError('NOT_FOUND', 'The team no longer has access to the environment.', {
        status: 404
      })
    policies[teamId] = { RoleId: roleId }
    await ptCall(ctx, 'PUT', `/endpoints/${envId}`, { body: { TeamAccessPolicies: policies } })
    return ok(ext, await observeOne(ctx, ACCESS, ext))
  }
  throw new ProviderError('UNKNOWN_TYPE', `Portainer has no resource type ${type}.`)
}

// ── Health ──

function envHealth(b: any, checkedAt: string): HealthAnswer {
  const status = num(b.Status)
  const snap = asObj(Array.isArray(b.Snapshots) ? b.Snapshots[0] : null)
  const details: Record<string, string | number | boolean> = {}
  const put = (k: string, v: unknown) => {
    const n = num(v)
    if (n !== null) details[k] = n
  }
  put('containersRunning', snap.RunningContainerCount)
  put('containersStopped', snap.StoppedContainerCount)
  put('containersUnhealthy', snap.UnhealthyContainerCount)
  put('stacks', snap.StackCount)
  if (status === 2)
    return {
      status: 'down',
      message: 'Portainer says this environment is down.',
      checkedAt,
      details
    }
  if (status === 1) {
    const unhealthy = num(snap.UnhealthyContainerCount) ?? 0
    if (unhealthy > 0)
      return {
        status: 'warn',
        message: `Portainer sees ${unhealthy} unhealthy container${unhealthy === 1 ? '' : 's'}.`,
        checkedAt,
        details
      }
    return { status: 'ok', checkedAt, details }
  }
  return {
    status: 'unknown',
    message: 'Portainer has no status for this environment.',
    checkedAt,
    details
  }
}

// ── Connection ──

const PERMISSIONS: Array<{ type: string; write: boolean }> = TYPES.map((t) => ({
  type: t.key,
  write: t.capabilities.create || t.capabilities.update || t.capabilities.delete
}))

export const portainerAdapter: ProviderAdapter = {
  key: 'portainer',
  label: 'Portainer',
  connection: {
    fields: [
      {
        key: 'baseUrl',
        label: 'Portainer address',
        kind: 'string',
        required: true,
        placeholder: 'https://portainer.example.com:9443',
        help: 'https only. A Portainer on a private network must also be listed in SSRF_ALLOW_HOSTS on this Hub.'
      },
      {
        key: 'token',
        label: 'Access token',
        kind: 'string',
        secret: true,
        required: true,
        help: 'A Portainer access token (ptr_…) of an administrator. The Hub uses it for environments, teams, access and registries only; it never deploys or changes a stack, container or service.'
      }
    ],
    hosts: (config) => {
      const b = baseOf(config)
      return b ? [b.host] : []
    },
    describe: (config) => `Portainer ${baseOf(config)?.host ?? 'unknown host'}`,
    validate(config, secrets) {
      const problems: string[] = []
      if (!baseOf(config))
        problems.push(
          'The Portainer address must be an https URL with a host name (no login, path or query).'
        )
      if (secrets.token !== undefined && !secrets.token.trim())
        problems.push('The access token is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const needs = (read: boolean, write: boolean) =>
      PERMISSIONS.flatMap((p) => [
        { type: p.type, need: `read ${p.type}`, has: read },
        ...(p.write
          ? [{ type: p.type, need: `write ${p.type} (an administrator’s token)`, has: write }]
          : [])
      ])
    const fail = (message: string): ConnectionTest => {
      const permissions = needs(false, false)
      return {
        ok: false,
        identity: null,
        permissions,
        missing: permissions.map((p) => p.need),
        message
      }
    }
    if (!baseOf(ctx.config)) return fail('The Portainer address is not a valid https URL.')
    let me: any = null
    try {
      const a = await ptCall(ctx, 'GET', '/users/me', { allow: [401, 403] })
      if (a.status !== 200) return fail('Portainer did not accept the access token.')
      me = asObj(a.body)
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    let version: string | null = null
    try {
      const s = await ptCall(ctx, 'GET', '/system/status', { allow: [401, 403, 404] })
      version = s.status === 200 ? str(asObj(s.body).Version) : null
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err
    }
    const admin = num(me.Role) === 1
    const permissions = needs(true, admin)
    return {
      ok: true,
      identity: `${str(me.Username) ?? 'a user'}${version ? ` · Portainer ${version}` : ''}`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need),
      ...(admin ? {} : { message: 'The token is not an administrator’s: it can read, not change.' })
    }
  },

  async observe(ctx, type, externalId) {
    return observeOne(ctx, type, externalId)
  },

  async list(ctx, type): Promise<ListPage> {
    // Portainer answers each list in one page.
    if (type === ENV)
      return { items: (await getList(ctx, 'endpoints')).map((b) => fromEnv(ctx, b)), cursor: null }
    if (type === TEAM) return { items: (await getList(ctx, 'teams')).map(fromTeam), cursor: null }
    if (type === REGISTRY)
      return {
        items: (await getList(ctx, 'registries')).map((b) => fromRegistry(ctx, b)),
        cursor: null
      }
    if (type === STACK)
      return { items: (await getList(ctx, 'stacks')).map((b) => fromStack(ctx, b)), cursor: null }
    if (type === ACCESS) {
      const items: Observed[] = []
      for (const e of await getList(ctx, 'endpoints')) {
        const envId = String(e?.Id ?? '')
        if (!/^\d+$/.test(envId)) continue
        for (const [teamId, policy] of Object.entries(asObj(e.TeamAccessPolicies)))
          if (/^\d+$/.test(teamId)) items.push(fromAccess(envId, teamId, policy))
      }
      return { items, cursor: null }
    }
    throw new ProviderError('UNKNOWN_TYPE', `Portainer has no resource type ${type}.`)
  },

  plan(_ctx, desired, observed) {
    return planPortainer(desired, observed)
  },

  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    const name = str(desired.fields.name)
    if (!name) return null
    return existingByName(ctx, type, name)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    return applyOne(withScrub(ctx, plainOf(desired)), op, desired)
  },

  async readOutputs(ctx, type, externalId) {
    const out: Record<string, string> = {}
    if (type !== ENV) return out
    const b = await getOne(ctx, 'endpoints', externalId)
    const key = b ? str(b.EdgeKey) : null
    if (key) out.edge_key = key
    return out
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    if (type === ENV) {
      const b = await getOne(ctx, 'endpoints', externalId)
      if (!b) return { status: 'down', message: 'It is gone at Portainer.', checkedAt }
      return envHealth(b, checkedAt)
    }
    const seen = await observeOne(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Portainer.', checkedAt }
    if (type === STACK && seen.status === 'inactive')
      return { status: 'warn', message: 'Portainer shows the stack as inactive.', checkedAt }
    return { status: 'ok', checkedAt }
  }
}
