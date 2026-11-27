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
  type RiskFlag
} from '../types.js'
import { dhCall, namespaceOf, repoSeg, seg, tagSeg, usernameOf } from './api.js'
import { isHubImageRepo, pinnedTagSet, readPins } from './pins.js'
import { DOCKERHUB_BUNDLED, repositoryEstimate } from './pricing.js'

/**
 * Docker Hub (`dockerhub`): a username + personal or organization access token, pinned to ONE
 * namespace (the person's or the organization's). Hosts `hub.docker.com`, `auth.docker.io`,
 * `registry-1.docker.io`; every call goes through `ctx.fetch` and a login JWT cached in
 * `ctx.tokens`. Types: repository (private by default; private → public is `public_exposure`),
 * repo team permission (organizations), and tag (list + delete only; a tag a Hub image pin uses
 * is never deleted: `TAG_PINNED`).
 *
 * External ids: repository = `<namespace>/<name>`; team permission = `<namespace>/<repo>/<team>`;
 * tag = `<namespace>/<repo>/<tag>`. The pinned namespace is enforced on EVERY read by id and on
 * every write; anything else is null (observe) or `DOCKERHUB_OUT_OF_ACCOUNT`.
 *
 * The adapter has no outputs and no `notify`: nothing here is a secret the Hub hands out, and
 * Docker Hub sends no messages. The list of tags is the read-only feed the Hub image pin picker
 * may use; this adapter never changes what the pin picker reads.
 */

const TYPE_REPO = 'dockerhub.repository'
const TYPE_TEAM = 'dockerhub.repo_team_permission'
const TYPE_TAG = 'dockerhub.tag'
const PAGE = 50
const REPO_PAGE = 10
const TAGS_PER_REPO = 100
const PERMISSIONS = ['read', 'write', 'admin']
const REPO_FIELDS = ['description', 'fullDescription', 'private']

// ── Small helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function sameValue(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b)
}

function diffFields(
  keys: string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    // A list page does not carry the long description: nothing to compare against there.
    if (have[k] === undefined && k === 'fullDescription') continue
    if (!sameValue(want[k], have[k])) out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
}

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>
): OpResult => ({ ok: true, externalId, observed, ...(answer ? { answer } : {}) })

const labelOf = (type: string): string => TYPES.find((t) => t.key === type)?.label ?? type
const wordsOf = (type: string, changes: FieldChange[]): string =>
  fieldWords(TYPES.find((t) => t.key === type)?.fields, changes)

function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} at Docker Hub. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

function outOfAccount(): ProviderError {
  return new ProviderError(
    'DOCKERHUB_OUT_OF_ACCOUNT',
    'That belongs to a different Docker Hub namespace than this connection.',
    { retryable: false, status: 403 }
  )
}

/** The parts of an external id; a wrong shape is BAD_EXTERNAL_ID, each part a valid segment. */
function parts(externalId: string, count: number): string[] {
  const p = String(externalId ?? '').split('/')
  if (p.length !== count || p.some((x) => !x))
    throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  for (const x of p) seg(x)
  return p
}

/** True when `ns` is the connection's namespace. */
const inAccount = (ctx: ProviderContext, ns: string): boolean => ns === namespaceOf(ctx)

/** The repository id a child resource points at (`<ns>/<name>`), inside the account. */
function repoRefOf(ctx: ProviderContext, desired: DesiredResource | null): string {
  const v = desired?.refs?.repository
  if (typeof v !== 'string' || !v)
    throw new ProviderError(
      'INVALID_FIELDS',
      'The repository this change belongs to is not created yet.'
    )
  const [ns, name] = parts(v, 2)
  if (!inAccount(ctx, ns)) throw outOfAccount()
  repoSeg(name)
  return v
}

// ── Observed mappers (no secret ever sits in one) ──

const consoleUrl = (ns: string, name: string) =>
  `https://hub.docker.com/repository/docker/${ns}/${name}/general`

function repoObserved(ns: string, r: any): Observed {
  const name = String(r.name)
  return {
    type: TYPE_REPO,
    externalId: `${ns}/${name}`,
    name,
    fields: {
      name,
      description: r.description ?? null,
      // Only the single-repository read carries the long description.
      ...(r.full_description !== undefined ? { fullDescription: r.full_description ?? null } : {}),
      private: r.is_private === true,
      pullCount: typeof r.pull_count === 'number' ? r.pull_count : null,
      starCount: typeof r.star_count === 'number' ? r.star_count : null,
      lastUpdated: r.last_updated ?? null
    },
    tags: {},
    version: r.last_updated ?? null,
    status: null,
    url: consoleUrl(ns, name)
  }
}

function teamObserved(ns: string, repo: string, g: any): Observed {
  const team = String(g.group_name ?? g.name ?? '')
  return {
    type: TYPE_TEAM,
    externalId: `${ns}/${repo}/${team}`,
    name: `${team} on ${repo}`,
    fields: { repository: `${ns}/${repo}`, team, permission: g.permission ?? null },
    tags: {},
    version: null,
    status: null,
    url: `https://hub.docker.com/repository/docker/${ns}/${repo}/collaborators`
  }
}

function tagObserved(ns: string, repo: string, t: any, pinned: boolean | null): Observed {
  const name = String(t.name)
  return {
    type: TYPE_TAG,
    externalId: `${ns}/${repo}/${name}`,
    name,
    fields: {
      repository: `${ns}/${repo}`,
      name,
      digest: t.digest ?? null,
      lastPushed: t.tag_last_pushed ?? t.last_updated ?? null,
      sizeBytes: typeof t.full_size === 'number' ? t.full_size : null,
      pinned
    },
    tags: {},
    version: t.digest ?? null,
    status: null,
    url: `https://hub.docker.com/repository/docker/${ns}/${repo}/tags`
  }
}

/** Whether a Hub image pin uses this tag: null = not the Hub image, or the pins cannot be read. */
async function pinnedState(ns: string, repo: string, tag: string): Promise<boolean | null> {
  if (!(await isHubImageRepo(ns, repo))) return null
  try {
    return pinnedTagSet(await readPins()).has(tag)
  } catch {
    return null
  }
}

// ── Reads (always inside the pinned namespace) ──

async function readRepo(ctx: ProviderContext, name: string): Promise<Observed | null> {
  const ns = namespaceOf(ctx)
  const r = await dhCall(ctx, 'GET', `/v2/namespaces/${seg(ns)}/repositories/${repoSeg(name)}`, {
    allow: [404]
  })
  return r.status === 404 ? null : repoObserved(ns, r.body)
}

async function readGroups(ctx: ProviderContext, repo: string): Promise<any[]> {
  const ns = namespaceOf(ctx)
  const r = await dhCall(ctx, 'GET', `/v2/repositories/${seg(ns)}/${repoSeg(repo)}/groups`, {
    query: { page_size: 100 },
    allow: [403, 404]
  })
  return r.status === 200 ? (r.body?.results ?? []) : []
}

async function readTeam(
  ctx: ProviderContext,
  repo: string,
  team: string
): Promise<Observed | null> {
  const found = (await readGroups(ctx, repo)).find((g) => String(g.group_name ?? '') === team)
  return found ? teamObserved(namespaceOf(ctx), repo, found) : null
}

async function readTag(ctx: ProviderContext, repo: string, tag: string): Promise<Observed | null> {
  const ns = namespaceOf(ctx)
  const r = await dhCall(
    ctx,
    'GET',
    `/v2/namespaces/${seg(ns)}/repositories/${repoSeg(repo)}/tags/${tagSeg(tag)}`,
    { allow: [404] }
  )
  if (r.status === 404) return null
  return tagObserved(ns, repo, r.body, await pinnedState(ns, repo, tag))
}

// ── Resource types ──

const FULL = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: false }

const TYPES: ResourceTypeSpec[] = [
  {
    key: TYPE_REPO,
    label: 'Docker Hub repository',
    scope: 'app',
    nameField: 'name',
    fields: [
      {
        key: 'name',
        label: 'Name',
        kind: 'string',
        required: true,
        createOnly: true,
        pattern: '^[a-z0-9][a-z0-9_.-]{1,254}$',
        help: 'Lowercase letters, digits, dot, dash and underscore.'
      },
      {
        key: 'private',
        label: 'Private',
        kind: 'boolean',
        default: true,
        help: 'Private by default. Making a repository public lets anyone pull its images.'
      },
      { key: 'description', label: 'Short description', kind: 'string', max: 100 },
      { key: 'fullDescription', label: 'Long description', kind: 'string' },
      { key: 'pullCount', label: 'Pulls', kind: 'number', readOnly: true },
      { key: 'lastUpdated', label: 'Last updated', kind: 'string', readOnly: true }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [],
    risk(op, desired) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive', 'data_loss')
      if (op.kind === 'create' && desired?.fields.private === false) out.push('public_exposure')
      if (op.kind === 'update' && op.changes.some((c) => c.field === 'private' && c.to === false))
        out.push('public_exposure')
      return out
    },
    // Past the free plan's one private repository, private repositories need a paid plan.
    costClass: (desired) => (desired.fields.private === false ? 'none' : 'monthly'),
    estimate: repositoryEstimate
  },
  {
    key: TYPE_TEAM,
    label: 'Docker Hub team access',
    scope: 'app',
    nameField: 'team',
    fields: [
      {
        key: 'repository',
        label: 'Repository',
        kind: 'ref',
        refType: TYPE_REPO,
        required: true,
        replaceOnChange: true
      },
      {
        key: 'team',
        label: 'Team',
        kind: 'string',
        required: true,
        replaceOnChange: true,
        help: 'An existing team of the organization (read only here).'
      },
      {
        key: 'permission',
        label: 'Permission',
        kind: 'enum',
        required: true,
        default: 'read',
        options: [
          { value: 'read', label: 'Read' },
          { value: 'write', label: 'Read and write' },
          { value: 'admin', label: 'Admin' }
        ]
      }
    ],
    capabilities: FULL,
    reversible: true,
    refs: [{ field: 'repository', type: TYPE_REPO, required: true }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive')
      return out
    }
  },
  {
    key: TYPE_TAG,
    label: 'Docker Hub image tag',
    scope: 'app',
    nameField: 'name',
    fields: [
      {
        key: 'repository',
        label: 'Repository',
        kind: 'ref',
        refType: TYPE_REPO,
        required: true,
        replaceOnChange: true
      },
      { key: 'name', label: 'Tag', kind: 'string', required: true, createOnly: true },
      { key: 'digest', label: 'Digest', kind: 'string', readOnly: true },
      { key: 'lastPushed', label: 'Last pushed', kind: 'string', readOnly: true },
      { key: 'sizeBytes', label: 'Size (bytes)', kind: 'number', readOnly: true },
      {
        key: 'pinned',
        label: 'Pinned by the Hub',
        kind: 'boolean',
        readOnly: true,
        help: 'A tag a Hub image pin uses cannot be deleted.'
      }
    ],
    // Tags are pushed by docker, never created here: list, adopt and delete only.
    capabilities: {
      create: false,
      update: false,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [{ field: 'repository', type: TYPE_REPO, required: true }],
    risk(op) {
      return op.kind === 'delete' ? ['destructive', 'data_loss'] : []
    }
  }
]

// ── Planning (pure) ──

function planRepo(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: TYPE_REPO,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(labelOf(TYPE_REPO), observed.name)} with every tag in it.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  if (!observed) {
    const changes: FieldChange[] = [
      { field: 'name', to: desired.fields.name },
      { field: 'private', to: desired.fields.private !== false }
    ]
    for (const k of ['description', 'fullDescription'])
      if (norm(desired.fields[k]) !== null) changes.push({ field: k, to: desired.fields[k] })
    return [
      {
        kind: 'create',
        type: TYPE_REPO,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(labelOf(TYPE_REPO), String(desired.fields.name ?? ''))}${
          desired.fields.private === false ? ' as a public repository' : ' as a private repository'
        }.`,
        changes,
        preconditions: {},
        risk: []
      }
    ]
  }
  const want = { ...desired.fields, private: desired.fields.private !== false }
  const changes = diffFields(REPO_FIELDS, want, observed.fields)
  if (!changes.length) return []
  const pre: Record<string, unknown> = { version: observed.version ?? null }
  for (const c of changes) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: TYPE_REPO,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${wordsOf(TYPE_REPO, changes)} on ${typedName(labelOf(TYPE_REPO), observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

function planTeam(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: TYPE_TEAM,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Remove ${typedName(labelOf(TYPE_TEAM), observed.name)}.`,
        changes: [],
        preconditions: { permission: observed.fields.permission },
        risk: []
      }
    ]
  }
  const permission = String(desired.fields.permission ?? 'read')
  if (!observed)
    return [
      {
        kind: 'create',
        type: TYPE_TEAM,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Give team ${String(desired.fields.team ?? '')} ${permission} access.`,
        changes: [
          { field: 'team', to: desired.fields.team },
          { field: 'permission', to: permission }
        ],
        preconditions: {},
        risk: []
      }
    ]
  if (observed.fields.permission === permission) return []
  return [
    {
      kind: 'update',
      type: TYPE_TEAM,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${wordsOf(TYPE_TEAM, [{ field: 'permission' }])} on ${typedName(labelOf(TYPE_TEAM), observed.name)}.`,
      changes: [{ field: 'permission', from: observed.fields.permission, to: permission }],
      preconditions: { permission: observed.fields.permission },
      risk: []
    }
  ]
}

function planTag(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (desired && !observed)
    throw new ProviderError(
      'NOT_SUPPORTED',
      'Docker Hub tags are pushed with docker, not created here. Push the image, then adopt the tag.'
    )
  if (desired) return [] // Nothing on a tag is editable.
  if (!observed) return []
  const pinned = observed.fields.pinned === true
  return [
    {
      kind: 'delete',
      type: TYPE_TAG,
      resourceId: null,
      externalId: observed.externalId,
      reason: pinned
        ? `Delete tag ${observed.name}, which a Hub image pin uses. Docker Hub tags in use cannot be deleted; the change is refused.`
        : `Delete tag ${observed.name} and the image it names (other tags of the same image stay).`,
      changes: [],
      preconditions: {
        digest: observed.fields.digest ?? null,
        pinned: observed.fields.pinned ?? null
      },
      risk: []
    }
  ]
}

// ── Applying ──

async function applyRepo(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const ns = namespaceOf(ctx)
  if (op.kind === 'delete') {
    const [ens, name] = parts(op.externalId as string, 2)
    if (!inAccount(ctx, ens)) throw outOfAccount()
    if (!(await readRepo(ctx, name))) return ok(op.externalId, null, { already: 'gone' })
    if (await isHubImageRepo(ens, name)) {
      const pins = await pinsOrRefuse()
      if (pins.size)
        throw new ProviderError(
          'REPO_PINNED',
          'This repository holds the Hub image and a Hub image pin uses it. Change the pins first.'
        )
    }
    await dhCall(ctx, 'DELETE', `/v2/namespaces/${seg(ns)}/repositories/${repoSeg(name)}`, {
      allow: [404]
    })
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'create') {
    const name = repoSeg(desired.fields.name)
    const existing = await readRepo(ctx, name)
    if (existing) {
      // Only a resumed run (this resource already recorded that id) may reuse it.
      if (desired.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists(`A repository named ${name} already exists`)
    }
    const body: Record<string, unknown> = {
      name,
      namespace: ns,
      is_private: desired.fields.private !== false
    }
    if (norm(desired.fields.description) !== null) body.description = desired.fields.description
    if (norm(desired.fields.fullDescription) !== null)
      body.full_description = desired.fields.fullDescription
    await dhCall(ctx, 'POST', `/v2/namespaces/${seg(ns)}/repositories`, { body })
    const created = await readRepo(ctx, name)
    return ok(`${ns}/${name}`, created)
  }
  const [ens, name] = parts(op.externalId as string, 2)
  if (!inAccount(ctx, ens)) throw outOfAccount()
  const have = await readRepo(ctx, name)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The repository no longer exists.', { status: 404 })
  const changes = diffFields(
    REPO_FIELDS,
    { ...desired.fields, private: desired.fields.private !== false },
    have.fields
  )
  if (!changes.length) return ok(op.externalId, have, { already: 'matches' })
  const body: Record<string, unknown> = {}
  for (const c of changes) {
    if (c.field === 'private') body.is_private = c.to
    else if (c.field === 'fullDescription') body.full_description = c.to ?? ''
    else body.description = c.to ?? ''
  }
  await dhCall(ctx, 'PATCH', `/v2/namespaces/${seg(ns)}/repositories/${repoSeg(name)}`, { body })
  return ok(op.externalId, await readRepo(ctx, name))
}

/** A team's numeric id in the organization (the permission calls need it). */
async function groupId(ctx: ProviderContext, team: string): Promise<number> {
  const r = await dhCall(
    ctx,
    'GET',
    `/v2/orgs/${seg(namespaceOf(ctx))}/groups/${seg(team, 'team')}`,
    {
      allow: [403, 404]
    }
  )
  const id = Number(r.body?.id)
  if (r.status !== 200 || !Number.isInteger(id) || id < 1)
    throw new ProviderError(
      'TEAM_NOT_FOUND',
      `The organization has no team named ${team} (or this token cannot see it).`
    )
  return id
}

async function applyTeam(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const ns = namespaceOf(ctx)
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
    const repo = parts(repoRefOf(ctx, desired), 2)[1]
    const team = seg(desired.fields.team, 'team')
    const permission = String(desired.fields.permission ?? 'read')
    if (!PERMISSIONS.includes(permission))
      throw new ProviderError('INVALID_FIELDS', 'The permission is read, write or admin.')
    const existing = await readTeam(ctx, repo, team)
    if (existing) {
      if (desired.externalId === existing.externalId)
        return ok(existing.externalId, existing, { already: 'exists' })
      throw alreadyExists(`Team ${team} already has access to ${repo}`)
    }
    const id = await groupId(ctx, team)
    await dhCall(ctx, 'POST', `/v2/repositories/${seg(ns)}/${repoSeg(repo)}/groups`, {
      body: { group_id: id, permission }
    })
    const created = await readTeam(ctx, repo, team)
    return ok(`${ns}/${repo}/${team}`, created)
  }
  const [ens, repo, team] = parts(op.externalId as string, 3)
  if (!inAccount(ctx, ens)) throw outOfAccount()
  if (desired) {
    if (desired.fields.team !== undefined && desired.fields.team !== team)
      throw new ProviderError(
        'TARGET_MISMATCH',
        'This change names a different team than the one it targets.'
      )
    const ref = desired.refs?.repository
    if (typeof ref === 'string' && ref !== `${ens}/${repo}`)
      throw new ProviderError(
        'TARGET_MISMATCH',
        'This change names a different repository than the one it targets.'
      )
  }
  const groups = await readGroups(ctx, repo)
  const found = groups.find((g) => String(g.group_name ?? '') === team)
  if (op.kind === 'delete') {
    if (!found) return ok(op.externalId, null, { already: 'gone' })
    await dhCall(
      ctx,
      'DELETE',
      `/v2/repositories/${seg(ens)}/${repoSeg(repo)}/groups/${seg(String(found.group_id), 'team id')}`,
      { allow: [404] }
    )
    return ok(op.externalId, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (!found)
    throw new ProviderError('NOT_FOUND', 'The team access no longer exists.', { status: 404 })
  const permission = String(desired.fields.permission ?? 'read')
  if (!PERMISSIONS.includes(permission))
    throw new ProviderError('INVALID_FIELDS', 'The permission is read, write or admin.')
  if (found.permission === permission)
    return ok(op.externalId, teamObserved(ens, repo, found), { already: 'matches' })
  await dhCall(
    ctx,
    'PUT',
    `/v2/repositories/${seg(ens)}/${repoSeg(repo)}/groups/${seg(String(found.group_id), 'team id')}`,
    { body: { permission } }
  )
  return ok(op.externalId, await readTeam(ctx, repo, team))
}

/** The tags the pins use, or a refusal when the pins cannot be read (a delete fails closed). */
async function pinsOrRefuse(): Promise<Set<string>> {
  try {
    return pinnedTagSet(await readPins())
  } catch {
    throw new ProviderError(
      'PINS_UNREADABLE',
      'The Hub image pins could not be read, so no tag is deleted now. Try again.',
      { retryable: true }
    )
  }
}

async function applyTag(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind !== 'delete')
    throw new ProviderError(
      'NOT_SUPPORTED',
      'Docker Hub tags can only be listed, adopted and deleted here.'
    )
  const [ns, repo, tag] = parts(op.externalId as string, 3)
  if (!inAccount(ctx, ns)) throw outOfAccount()
  if (desired) {
    const ref = desired.refs?.repository
    if (typeof ref === 'string' && ref !== `${ns}/${repo}`)
      throw new ProviderError(
        'TARGET_MISMATCH',
        'This change names a different repository than the one it targets.'
      )
  }
  const have = await readTag(ctx, repo, tag)
  if (!have) return ok(op.externalId, null, { already: 'gone' })
  if ((await isHubImageRepo(ns, repo)) && (await pinsOrRefuse()).has(tag))
    throw new ProviderError(
      'TAG_PINNED',
      `Tag ${tag} is pinned by a Hub environment or shared deployment. Move the pin first, then delete it.`
    )
  await dhCall(
    ctx,
    'DELETE',
    `/v2/namespaces/${seg(ns)}/repositories/${repoSeg(repo)}/tags/${tagSeg(tag)}`,
    { allow: [404] }
  )
  return ok(op.externalId, null)
}

// ── The adapter ──

export const dockerhubAdapter: ProviderAdapter = {
  bundledPrices: DOCKERHUB_BUNDLED,
  key: 'dockerhub',
  label: 'Docker Hub',
  connection: {
    fields: [
      {
        key: 'username',
        label: 'Username',
        kind: 'string',
        required: true,
        help: 'The user that owns the access token (for an organization access token, the organization name).'
      },
      {
        key: 'namespace',
        label: 'Namespace',
        kind: 'string',
        required: true,
        help: 'Pinned: the user or organization whose repositories the Hub may manage.'
      },
      {
        key: 'token',
        label: 'Access token',
        kind: 'string',
        secret: true,
        required: true,
        help: 'A personal or organization access token (Docker Hub → Account settings → Personal access tokens).'
      }
    ],
    hosts: () => ['hub.docker.com', 'auth.docker.io', 'registry-1.docker.io'],
    describe: (config) => `Docker Hub ${String(config.namespace ?? '')}`,
    validate(config, secrets) {
      const problems: string[] = []
      if (!/^[a-z0-9][a-z0-9_.-]{1,254}$/.test(String(config.username ?? '')))
        problems.push('The username is lowercase letters, digits, dot, dash or underscore.')
      if (!/^[a-z0-9][a-z0-9_-]{1,254}$/.test(String(config.namespace ?? '')))
        problems.push('The namespace is lowercase letters, digits, dash or underscore.')
      if (secrets.token !== undefined && !secrets.token.trim())
        problems.push('The access token is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const ns = namespaceOf(ctx)
    const needs = (has: { read: boolean; org: boolean }) => [
      { type: TYPE_REPO, need: `read repositories in ${ns}`, has: has.read },
      {
        type: TYPE_REPO,
        need: `write repositories (token access Read & Write)`,
        has: has.read
      },
      { type: TYPE_TAG, need: 'delete tags (token access Read, Write & Delete)', has: has.read },
      { type: TYPE_TEAM, need: 'organization owner, to manage team access', has: has.org }
    ]
    const fail = (message: string): ConnectionTest => {
      const permissions = needs({ read: false, org: false })
      return {
        ok: false,
        identity: null,
        permissions,
        missing: permissions.map((p) => p.need),
        message
      }
    }
    let canRead = false
    let isOrg = false
    try {
      const r = await dhCall(ctx, 'GET', `/v2/namespaces/${seg(ns)}/repositories`, {
        query: { page_size: 1 },
        allow: [403, 404]
      })
      canRead = r.status === 200
      if (canRead) {
        const o = await dhCall(ctx, 'GET', `/v2/orgs/${seg(ns)}`, { allow: [403, 404] })
        isOrg = o.status === 200
      }
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    if (!canRead)
      return fail(
        `The access token cannot see repositories in ${ns} (check the namespace and the token).`
      )
    const permissions = needs({ read: canRead, org: isOrg })
    return {
      ok: true,
      identity: `${usernameOf(ctx)} · ${ns}${isOrg ? ' (organization)' : ''}`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need),
      message: 'Write and delete access is proven when a change is applied.'
    }
  },

  async observe(ctx, type, externalId) {
    if (type === TYPE_REPO) {
      const [ns, name] = parts(externalId, 2)
      return inAccount(ctx, ns) ? readRepo(ctx, name) : null
    }
    if (type === TYPE_TEAM) {
      const [ns, repo, team] = parts(externalId, 3)
      return inAccount(ctx, ns) ? readTeam(ctx, repo, team) : null
    }
    if (type === TYPE_TAG) {
      const [ns, repo, tag] = parts(externalId, 3)
      return inAccount(ctx, ns) ? readTag(ctx, repo, tag) : null
    }
    throw new ProviderError('UNKNOWN_TYPE', `Docker Hub has no ${type}.`)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    const ns = namespaceOf(ctx)
    const page = Math.max(1, Number.parseInt(cursor ?? '1', 10) || 1)
    if (type === TYPE_REPO) {
      const r = await dhCall(ctx, 'GET', `/v2/namespaces/${seg(ns)}/repositories`, {
        query: { page, page_size: PAGE }
      })
      return {
        items: (r.body?.results ?? []).map((x: any) => repoObserved(ns, x)),
        cursor: r.body?.next ? String(page + 1) : null
      }
    }
    if (type !== TYPE_TAG && type !== TYPE_TEAM)
      throw new ProviderError('UNKNOWN_TYPE', `Docker Hub has no ${type}.`)
    // Children are listed per page of repositories; the cursor pages the repositories. Tags: the
    // newest TAGS_PER_REPO of each repository.
    const repos = await dhCall(ctx, 'GET', `/v2/namespaces/${seg(ns)}/repositories`, {
      query: { page, page_size: REPO_PAGE }
    })
    const items: Observed[] = []
    for (const repo of repos.body?.results ?? []) {
      const name = String(repo.name)
      if (type === TYPE_TEAM) {
        for (const g of await readGroups(ctx, name)) items.push(teamObserved(ns, name, g))
        continue
      }
      const tags = await dhCall(
        ctx,
        'GET',
        `/v2/namespaces/${seg(ns)}/repositories/${repoSeg(name)}/tags`,
        { query: { page: 1, page_size: TAGS_PER_REPO }, allow: [404] }
      )
      const hub = await isHubImageRepo(ns, name)
      let pins: Set<string> | null = null
      if (hub) {
        try {
          pins = pinnedTagSet(await readPins())
        } catch {
          pins = null
        }
      }
      for (const t of tags.body?.results ?? [])
        items.push(tagObserved(ns, name, t, hub && pins ? pins.has(String(t.name)) : null))
    }
    return { items, cursor: repos.body?.next ? String(page + 1) : null }
  },

  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    if (type === TYPE_REPO) {
      const name = String(desired.fields.name ?? '')
      return name ? readRepo(ctx, name) : null
    }
    if (type === TYPE_TEAM) {
      const ref = desired.refs?.repository
      const team = String(desired.fields.team ?? '')
      if (typeof ref !== 'string' || !ref || !team) return null
      const [ns, repo] = parts(ref, 2)
      return inAccount(ctx, ns) ? readTeam(ctx, repo, team) : null
    }
    return null
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === TYPE_REPO) return planRepo(desired, observed)
    if (type === TYPE_TEAM) return planTeam(desired, observed)
    if (type === TYPE_TAG) return planTag(desired, observed)
    throw new ProviderError('UNKNOWN_TYPE', `Docker Hub has no ${String(type)}.`)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    if (op.type === TYPE_REPO) return applyRepo(ctx, op, desired)
    if (op.type === TYPE_TEAM) return applyTeam(ctx, op, desired)
    if (op.type === TYPE_TAG) return applyTag(ctx, op, desired)
    throw new ProviderError('UNKNOWN_TYPE', `Docker Hub has no ${op.type}.`)
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Docker Hub.', checkedAt }
    if (type === TYPE_REPO) {
      const [ns, name] = parts(externalId, 2)
      const t = await dhCall(
        ctx,
        'GET',
        `/v2/namespaces/${seg(ns)}/repositories/${repoSeg(name)}/tags`,
        { query: { page_size: 1 }, allow: [404] }
      )
      const tagCount = typeof t.body?.count === 'number' ? t.body.count : 0
      const first = t.body?.results?.[0]
      const lastPush = String(
        first?.tag_last_pushed ?? first?.last_updated ?? seen.fields.lastUpdated ?? ''
      )
      const details: Record<string, string | number | boolean> = { tagCount }
      if (lastPush) details.lastPush = lastPush
      if (typeof seen.fields.pullCount === 'number') details.pullCount = seen.fields.pullCount
      return tagCount === 0
        ? { status: 'warn', message: 'No image has been pushed yet.', checkedAt, details }
        : { status: 'ok', checkedAt, details }
    }
    if (type === TYPE_TAG) {
      const details: Record<string, string | number | boolean> = {}
      if (seen.fields.lastPushed) details.lastPushed = String(seen.fields.lastPushed)
      if (typeof seen.fields.pinned === 'boolean') details.pinned = seen.fields.pinned
      return { status: 'ok', checkedAt, details }
    }
    return { status: 'ok', checkedAt }
  }
}
