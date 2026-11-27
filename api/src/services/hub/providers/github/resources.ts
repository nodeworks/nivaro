import {
  type DesiredResource,
  type ListPage,
  type Observed,
  type ProviderContext,
  ProviderError
} from '../types.js'
import {
  branchPath,
  checkEnvName,
  checkNumericId,
  checkOwner,
  checkRepoName,
  checkVarName,
  checkWorkflowFile,
  type GhResponse,
  gh,
  ghAll,
  nextPage,
  ownerOf,
  seg
} from './api.js'
import { sealSecretValue } from './seal.js'

/**
 * One handler per GitHub resource type: observe / list / create / update / remove against the
 * REST API. Handlers read before they write (the adapter's `apply` observes first and only calls
 * the write the diff still needs). Nothing here returns or logs a secret value.
 */

type Json = Record<string, any>

export interface Handler {
  key: string
  /** Field keys the plan compares between desired and observed. */
  compare: string[]
  /** A diff in one of these forces replace (delete + create). */
  replaceKeys: string[]
  /** A write-only field: when its `SecretValue.changed` is true the resource is updated. */
  secretField?: string
  /** Types with no create/delete of their own (workflows). */
  readOnlyLifecycle?: boolean
  observe(ctx: ProviderContext, ext: string): Promise<Observed | null>
  /** The external id of a resource that already holds the identity `desired` would create. */
  existing(ctx: ProviderContext, desired: DesiredResource): Promise<string | null>
  list(ctx: ProviderContext, cursor: string | null): Promise<ListPage>
  /** The external id a create will have, if known before the call. */
  create(ctx: ProviderContext, desired: DesiredResource): Promise<string>
  update(
    ctx: ProviderContext,
    ext: string,
    desired: DesiredResource,
    observed: Observed
  ): Promise<string>
  remove(ctx: ProviderContext, ext: string): Promise<void>
}

// ── Small helpers ──

export function bad(code: string, message: string): never {
  throw new ProviderError(code, message)
}

export function splitRepo(full: string): { owner: string; repo: string } {
  const i = full.indexOf('/')
  if (i <= 0 || i === full.length - 1) bad('BAD_ID', `"${full}" is not owner/repo.`)
  return { owner: checkOwner(full.slice(0, i)), repo: checkRepoName(full.slice(i + 1)) }
}

/** `owner/repo#rest` → both halves. */
export function splitChild(ext: string): { repo: string; rest: string } {
  const i = ext.indexOf('#')
  if (i <= 0 || i === ext.length - 1) bad('BAD_ID', `"${ext}" is not owner/repo#name.`)
  return { repo: ext.slice(0, i), rest: ext.slice(i + 1) }
}

/** `owner/repo[@environment]#NAME` → repo, environment, name. */
export function splitScoped(ext: string): { repo: string; env: string | null; name: string } {
  const { repo: left, rest } = splitChild(ext)
  const at = left.indexOf('@')
  if (at < 0) return { repo: left, env: null, name: rest }
  return { repo: left.slice(0, at), env: left.slice(at + 1), name: rest }
}

export const text = (v: unknown): string => (typeof v === 'string' ? v : '')
export const bool = (v: unknown, dflt = false): boolean => (typeof v === 'boolean' ? v : dflt)
export const num = (v: unknown, dflt = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : dflt
export const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

export function parentRepo(desired: DesiredResource): string {
  const r = desired.refs.repository
  const id = Array.isArray(r) ? r[0] : r
  if (!id)
    bad('REF_UNRESOLVED', 'The repository this resource belongs to has not been created yet.')
  return id
}

export function secretPlain(desired: DesiredResource, key: string): string | null {
  const v = desired.fields[key] as { plain?: string } | undefined
  return typeof v?.plain === 'string' && v.plain !== '' ? v.plain : null
}

const sameKey = (a: string, b: string): boolean =>
  a.trim().split(/\s+/).slice(0, 2).join(' ') === b.trim().split(/\s+/).slice(0, 2).join(' ')

export async function inChunks<T, R>(
  items: T[],
  size: number,
  fn: (x: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

// ── Repositories ──

function repoFields(j: Json): Record<string, unknown> {
  return {
    name: j.name ?? null,
    description: j.description ?? '',
    visibility: j.visibility ?? (j.private ? 'private' : 'public'),
    default_branch: j.default_branch ?? null,
    has_issues: !!j.has_issues,
    has_wiki: !!j.has_wiki,
    archived: !!j.archived,
    topics: Array.isArray(j.topics) ? j.topics : []
  }
}

function observedRepo(j: Json): Observed {
  return {
    type: 'github.repository',
    externalId: String(j.full_name),
    name: j.name ?? null,
    fields: repoFields(j),
    tags: {},
    version: null,
    status: j.archived ? 'archived' : 'active',
    url: j.html_url ?? null
  }
}

export async function ownerRepos(ctx: ProviderContext, page: number): Promise<GhResponse> {
  const owner = seg(checkOwner(ownerOf(ctx)))
  const q = `per_page=20&page=${page}`
  const r = await gh(ctx, 'GET', `/orgs/${owner}/repos?${q}`, { ok: [404] })
  if (r.status !== 404) return r
  return gh(ctx, 'GET', `/users/${owner}/repos?${q}`)
}

const repository: Handler = {
  key: 'github.repository',
  async existing(ctx, d) {
    return (
      (await repository.observe(ctx, `${ownerOf(ctx)}/${text(d.fields.name)}`))?.externalId ?? null
    )
  },
  compare: [
    'name',
    'description',
    'visibility',
    'default_branch',
    'has_issues',
    'has_wiki',
    'archived',
    'topics'
  ],
  replaceKeys: [],
  async observe(ctx, ext) {
    const { owner, repo } = splitRepo(ext)
    const r = await gh<Json>(ctx, 'GET', `/repos/${seg(owner)}/${seg(repo)}`, { ok: [404] })
    return r.status === 404 ? null : observedRepo(r.json)
  },
  async list(ctx, cursor) {
    const page = cursor ? Number(cursor) || 1 : 1
    const r = await ownerRepos(ctx, page)
    const items = (Array.isArray(r.json) ? (r.json as Json[]) : []).map(observedRepo)
    const next = nextPage(r.headers)
    return { items, cursor: next ? String(next) : null }
  },
  async create(ctx, desired) {
    const owner = ownerOf(ctx)
    const name = text(desired.fields.name)
    const existing = await repository.observe(ctx, `${owner}/${name}`)
    let full = existing?.externalId ?? ''
    if (!existing) {
      const visibility = text(desired.fields.visibility) || 'private'
      const template = text(desired.fields.template)
      if (template) {
        const t = splitRepo(template)
        const r = await gh<Json>(ctx, 'POST', `/repos/${seg(t.owner)}/${seg(t.repo)}/generate`, {
          body: {
            owner,
            name,
            description: text(desired.fields.description),
            private: visibility !== 'public',
            include_all_branches: false
          },
          what: 'create the repository from the template'
        })
        full = String(r.json.full_name)
      } else {
        const body = {
          name,
          description: text(desired.fields.description),
          visibility,
          private: visibility !== 'public',
          has_issues: bool(desired.fields.has_issues, true),
          has_wiki: bool(desired.fields.has_wiki, false)
        }
        let r = await gh<Json>(ctx, 'POST', `/orgs/${seg(owner)}/repos`, {
          body,
          ok: [404],
          what: 'create the repository'
        })
        if (r.status === 404)
          r = await gh<Json>(ctx, 'POST', '/user/repos', {
            body: { ...body, visibility: undefined },
            what: 'create the repository'
          })
        full = String(r.json.full_name)
      }
    }
    // Whatever the creation call did not set (topics, default branch, visibility 'internal'…).
    const now = await repository.observe(ctx, full)
    if (now) return repository.update(ctx, full, desired, now)
    return full
  },
  async update(ctx, ext, desired, observed) {
    const { owner, repo } = splitRepo(ext)
    const base = `/repos/${seg(owner)}/${seg(repo)}`
    const want = desired.fields
    const was = observed.fields
    let full = ext
    const wantArchived = want.archived === undefined ? undefined : bool(want.archived)
    // An archived repository refuses every other edit: lift it first, apply it last.
    if (was.archived === true && wantArchived === false)
      await gh(ctx, 'PATCH', base, { body: { archived: false }, what: 'unarchive the repository' })
    const patch: Json = {}
    for (const k of ['description', 'visibility', 'default_branch', 'has_issues', 'has_wiki']) {
      if (want[k] !== undefined && !same(want[k], was[k])) patch[k] = want[k]
    }
    if (want.name !== undefined && want.name !== was.name) patch.name = want.name
    if (Object.keys(patch).length) {
      const r = await gh<Json>(ctx, 'PATCH', base, {
        body: patch,
        what: 'update the repository'
      })
      if (typeof r.json?.full_name === 'string') full = r.json.full_name
    }
    if (want.topics !== undefined && !same(want.topics, was.topics)) {
      const r2 = splitRepo(full)
      await gh(ctx, 'PUT', `/repos/${seg(r2.owner)}/${seg(r2.repo)}/topics`, {
        body: { names: list(want.topics) },
        what: 'set the repository topics'
      })
    }
    if (wantArchived === true && was.archived !== true) {
      const r2 = splitRepo(full)
      await gh(ctx, 'PATCH', `/repos/${seg(r2.owner)}/${seg(r2.repo)}`, {
        body: { archived: true },
        what: 'archive the repository'
      })
    }
    return full
  },
  async remove(ctx, ext) {
    // The adapter decides archive vs delete (see apply); this is the permanent delete.
    const { owner, repo } = splitRepo(ext)
    await gh(ctx, 'DELETE', `/repos/${seg(owner)}/${seg(repo)}`, {
      ok: [404],
      what: 'delete the repository'
    })
  }
}

/** Archives a repository (what removing a repository resource does by default). */
export async function archiveRepository(ctx: ProviderContext, ext: string): Promise<boolean> {
  const { owner, repo } = splitRepo(ext)
  const r = await gh(ctx, 'PATCH', `/repos/${seg(owner)}/${seg(repo)}`, {
    body: { archived: true },
    ok: [404],
    what: 'archive the repository'
  })
  return r.status !== 404
}

// ── Branch protection ──

function protectionFields(repo: string, branch: string, j: Json): Record<string, unknown> {
  const reviews = j.required_pull_request_reviews
  const checks = j.required_status_checks
  const contexts: string[] = Array.isArray(checks?.contexts)
    ? checks.contexts
    : Array.isArray(checks?.checks)
      ? checks.checks.map((c: Json) => c.context)
      : []
  return {
    repository: repo,
    branch,
    required_reviews: reviews ? num(reviews.required_approving_review_count, 1) : 0,
    dismiss_stale_reviews: !!reviews?.dismiss_stale_reviews,
    require_code_owner_reviews: !!reviews?.require_code_owner_reviews,
    required_status_checks: contexts,
    strict_status_checks: !!checks?.strict,
    enforce_admins: !!j.enforce_admins?.enabled,
    allow_force_pushes: !!j.allow_force_pushes?.enabled,
    allow_deletions: !!j.allow_deletions?.enabled,
    required_linear_history: !!j.required_linear_history?.enabled,
    required_conversation_resolution: !!j.required_conversation_resolution?.enabled
  }
}

function observedProtection(repo: string, branch: string, j: Json): Observed {
  return {
    type: 'github.branch_protection',
    externalId: `${repo}#${branch}`,
    name: branch,
    fields: protectionFields(repo, branch, j),
    tags: {},
    version: null,
    status: 'protected',
    url: typeof j.url === 'string' ? j.url : null
  }
}

function protectionBody(d: DesiredResource): Json {
  const f = d.fields
  const reviews = num(f.required_reviews, 1)
  const contexts = list(f.required_status_checks)
  return {
    required_status_checks: contexts.length
      ? { strict: bool(f.strict_status_checks), contexts }
      : null,
    enforce_admins: bool(f.enforce_admins),
    required_pull_request_reviews:
      reviews > 0
        ? {
            required_approving_review_count: reviews,
            dismiss_stale_reviews: bool(f.dismiss_stale_reviews),
            require_code_owner_reviews: bool(f.require_code_owner_reviews)
          }
        : null,
    restrictions: null,
    allow_force_pushes: bool(f.allow_force_pushes),
    allow_deletions: bool(f.allow_deletions),
    required_linear_history: bool(f.required_linear_history),
    required_conversation_resolution: bool(f.required_conversation_resolution)
  }
}

const protectionPath = (repo: string, branch: string): string => {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/branches/${branchPath(branch)}/protection`
}

const branchProtection: Handler = {
  key: 'github.branch_protection',
  async existing(ctx, d) {
    const ext = `${parentRepo(d)}#${text(d.fields.branch)}`
    return (await branchProtection.observe(ctx, ext)) ? ext : null
  },
  compare: [
    'required_reviews',
    'dismiss_stale_reviews',
    'require_code_owner_reviews',
    'required_status_checks',
    'strict_status_checks',
    'enforce_admins',
    'allow_force_pushes',
    'allow_deletions',
    'required_linear_history',
    'required_conversation_resolution'
  ],
  replaceKeys: [],
  async observe(ctx, ext) {
    const { repo, rest: branch } = splitChild(ext)
    const r = await gh<Json>(ctx, 'GET', protectionPath(repo, branch), { ok: [404] })
    return r.status === 404 ? null : observedProtection(repo, branch, r.json)
  },
  async list(ctx, cursor) {
    return listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const { owner, repo: r } = splitRepo(repo)
      const branches = await gh<Json[]>(
        ctx,
        'GET',
        `/repos/${seg(owner)}/${seg(r)}/branches?protected=true&per_page=100`,
        { ok: [404] }
      )
      const out: Observed[] = []
      for (const b of Array.isArray(branches.json) ? branches.json : []) {
        const o = await branchProtection.observe(ctx, `${repo}#${b.name}`)
        if (o) out.push(o)
      }
      return out
    })
  },
  async create(ctx, desired) {
    const repo = parentRepo(desired)
    const branch = text(desired.fields.branch)
    await gh(ctx, 'PUT', protectionPath(repo, branch), {
      body: protectionBody(desired),
      what: 'protect the branch'
    })
    return `${repo}#${branch}`
  },
  async update(ctx, ext, desired) {
    const { repo, rest: branch } = splitChild(ext)
    await gh(ctx, 'PUT', protectionPath(repo, branch), {
      body: protectionBody(desired),
      what: 'update the branch protection'
    })
    return ext
  },
  async remove(ctx, ext) {
    const { repo, rest: branch } = splitChild(ext)
    await gh(ctx, 'DELETE', protectionPath(repo, branch), {
      ok: [404],
      what: 'remove the branch protection'
    })
  }
}

// ── Environments ──

function envFields(repo: string, j: Json): Record<string, unknown> {
  const rules: Json[] = Array.isArray(j.protection_rules) ? j.protection_rules : []
  const wait = rules.find((r) => r.type === 'wait_timer')
  const reviewers = rules.find((r) => r.type === 'required_reviewers')
  const policy = j.deployment_branch_policy
  return {
    repository: repo,
    name: j.name,
    wait_timer: num(wait?.wait_timer, 0),
    prevent_self_review: !!reviewers?.prevent_self_review,
    deployment_branches: !policy
      ? 'all'
      : policy.protected_branches
        ? 'protected'
        : policy.custom_branch_policies
          ? 'selected'
          : 'all'
  }
}

function envPath(repo: string, name: string): string {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/environments/${seg(checkEnvName(name))}`
}

function observedEnv(repo: string, j: Json): Observed {
  return {
    type: 'github.environment',
    externalId: `${repo}#${j.name}`,
    name: j.name ?? null,
    fields: envFields(repo, j),
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: 'active',
    url: j.html_url ?? null
  }
}

function envBody(d: DesiredResource): Json {
  const policy = text(d.fields.deployment_branches) || 'all'
  return {
    wait_timer: num(d.fields.wait_timer, 0),
    prevent_self_review: bool(d.fields.prevent_self_review),
    deployment_branch_policy:
      policy === 'protected'
        ? { protected_branches: true, custom_branch_policies: false }
        : policy === 'selected'
          ? { protected_branches: false, custom_branch_policies: true }
          : null
  }
}

const environment: Handler = {
  key: 'github.environment',
  async existing(ctx, d) {
    const ext = `${parentRepo(d)}#${text(d.fields.name)}`
    return (await environment.observe(ctx, ext)) ? ext : null
  },
  compare: ['wait_timer', 'prevent_self_review', 'deployment_branches'],
  replaceKeys: [],
  async observe(ctx, ext) {
    const { repo, rest: name } = splitChild(ext)
    const r = await gh<Json>(ctx, 'GET', envPath(repo, name), { ok: [404] })
    return r.status === 404 ? null : observedEnv(repo, r.json)
  },
  async list(ctx, cursor) {
    return listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const { owner, repo: r } = splitRepo(repo)
      const res = await gh<Json>(
        ctx,
        'GET',
        `/repos/${seg(owner)}/${seg(r)}/environments?per_page=100`,
        {
          ok: [404]
        }
      )
      const envs: Json[] = Array.isArray(res.json?.environments) ? res.json.environments : []
      return envs.map((e) => observedEnv(repo, e))
    })
  },
  async create(ctx, desired) {
    const repo = parentRepo(desired)
    const name = text(desired.fields.name)
    await gh(ctx, 'PUT', envPath(repo, name), {
      body: envBody(desired),
      what: 'create the environment'
    })
    return `${repo}#${name}`
  },
  async update(ctx, ext, desired) {
    const { repo, rest: name } = splitChild(ext)
    // PUT replaces the environment: keep the required reviewers it has (github.environment_protection
    // owns them), or this resource would clear them.
    const current = await gh<Json>(ctx, 'GET', envPath(repo, name), { ok: [404] })
    const rules: Json[] = Array.isArray(current.json?.protection_rules)
      ? current.json.protection_rules
      : []
    const reviewers = (rules.find((r) => r.type === 'required_reviewers')?.reviewers ?? [])
      .map((x: Json) => ({ type: x?.type, id: x?.reviewer?.id }))
      .filter((x: Json) => (x.type === 'User' || x.type === 'Team') && Number.isSafeInteger(x.id))
    await gh(ctx, 'PUT', envPath(repo, name), {
      body: { ...envBody(desired), ...(reviewers.length ? { reviewers } : {}) },
      what: 'update the environment'
    })
    return ext
  },
  async remove(ctx, ext) {
    const { repo, rest: name } = splitChild(ext)
    await gh(ctx, 'DELETE', envPath(repo, name), { ok: [404], what: 'delete the environment' })
  }
}

// ── Actions secrets and variables (repository level or one environment) ──

function actionsBase(repo: string, env: string | null, kind: 'secrets' | 'variables'): string {
  const { owner, repo: r } = splitRepo(repo)
  const root = `/repos/${seg(owner)}/${seg(r)}`
  return env ? `${root}/environments/${seg(checkEnvName(env))}/${kind}` : `${root}/actions/${kind}`
}

const scopedId = (repo: string, env: string | null, name: string): string =>
  `${repo}${env ? `@${env}` : ''}#${name}`

function observedSecret(repo: string, env: string | null, j: Json): Observed {
  return {
    type: 'github.actions_secret',
    externalId: scopedId(repo, env, String(j.name)),
    name: j.name ?? null,
    // The value is write-only: GitHub never returns it, so it is absent here.
    fields: { repository: repo, environment: env ?? '', name: j.name },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: 'active',
    url: null
  }
}

const actionsSecret: Handler = {
  key: 'github.actions_secret',
  async existing(ctx, d) {
    const ext = scopedId(parentRepo(d), text(d.fields.environment) || null, text(d.fields.name))
    return (await actionsSecret.observe(ctx, ext)) ? ext : null
  },
  compare: [],
  replaceKeys: ['environment', 'name'],
  secretField: 'value',
  async observe(ctx, ext) {
    const { repo, env, name } = splitScoped(ext)
    const r = await gh<Json>(
      ctx,
      'GET',
      `${actionsBase(repo, env, 'secrets')}/${seg(checkVarName(name))}`,
      {
        ok: [404]
      }
    )
    return r.status === 404 ? null : observedSecret(repo, env, r.json)
  },
  async list(ctx, cursor) {
    return listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const res = await gh<Json>(ctx, 'GET', `${actionsBase(repo, null, 'secrets')}?per_page=100`, {
        ok: [404]
      })
      const rows: Json[] = Array.isArray(res.json?.secrets) ? res.json.secrets : []
      return rows.map((s) => observedSecret(repo, null, s))
    })
  },
  async create(ctx, desired) {
    const repo = parentRepo(desired)
    const env = text(desired.fields.environment) || null
    const name = text(desired.fields.name)
    await putSecret(ctx, repo, env, name, secretPlain(desired, 'value'))
    return scopedId(repo, env, name)
  },
  async update(ctx, ext, desired) {
    const { repo, env, name } = splitScoped(ext)
    await putSecret(ctx, repo, env, name, secretPlain(desired, 'value'))
    return ext
  },
  async remove(ctx, ext) {
    const { repo, env, name } = splitScoped(ext)
    await gh(ctx, 'DELETE', `${actionsBase(repo, env, 'secrets')}/${seg(checkVarName(name))}`, {
      ok: [404],
      what: 'delete the secret'
    })
  }
}

async function putSecret(
  ctx: ProviderContext,
  repo: string,
  env: string | null,
  name: string,
  plain: string | null
): Promise<void> {
  if (plain === null)
    bad('SECRET_VALUE_MISSING', `A value for the secret ${name} is needed to write it.`)
  const base = actionsBase(repo, env, 'secrets')
  const key = (await gh<Json>(ctx, 'GET', `${base}/public-key`, { what: 'read the public key' }))
    .json
  if (typeof key?.key !== 'string' || typeof key?.key_id !== 'string')
    bad('PROVIDER_ERROR', 'GitHub did not return a public key for the secret.')
  const sealed = await sealSecretValue(plain, key.key)
  await gh(ctx, 'PUT', `${base}/${seg(checkVarName(name))}`, {
    body: { encrypted_value: sealed, key_id: key.key_id },
    what: 'write the secret'
  })
}

function observedVariable(repo: string, env: string | null, j: Json): Observed {
  return {
    type: 'github.actions_variable',
    externalId: scopedId(repo, env, String(j.name)),
    name: j.name ?? null,
    fields: { repository: repo, environment: env ?? '', name: j.name, value: j.value ?? '' },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: 'active',
    url: null
  }
}

const actionsVariable: Handler = {
  key: 'github.actions_variable',
  async existing(ctx, d) {
    const ext = scopedId(parentRepo(d), text(d.fields.environment) || null, text(d.fields.name))
    return (await actionsVariable.observe(ctx, ext)) ? ext : null
  },
  compare: ['value'],
  replaceKeys: ['environment', 'name'],
  async observe(ctx, ext) {
    const { repo, env, name } = splitScoped(ext)
    const r = await gh<Json>(
      ctx,
      'GET',
      `${actionsBase(repo, env, 'variables')}/${seg(checkVarName(name))}`,
      {
        ok: [404]
      }
    )
    return r.status === 404 ? null : observedVariable(repo, env, r.json)
  },
  async list(ctx, cursor) {
    return listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const res = await gh<Json>(
        ctx,
        'GET',
        `${actionsBase(repo, null, 'variables')}?per_page=30`,
        {
          ok: [404]
        }
      )
      const rows: Json[] = Array.isArray(res.json?.variables) ? res.json.variables : []
      return rows.map((v) => observedVariable(repo, null, v))
    })
  },
  async create(ctx, desired) {
    const repo = parentRepo(desired)
    const env = text(desired.fields.environment) || null
    const name = text(desired.fields.name)
    const id = scopedId(repo, env, name)
    const have = await actionsVariable.observe(ctx, id)
    if (have) return actionsVariable.update(ctx, id, desired, have)
    await gh(ctx, 'POST', actionsBase(repo, env, 'variables'), {
      body: { name, value: text(desired.fields.value) },
      what: 'create the variable'
    })
    return scopedId(repo, env, name)
  },
  async update(ctx, ext, desired) {
    const { repo, env, name } = splitScoped(ext)
    await gh(ctx, 'PATCH', `${actionsBase(repo, env, 'variables')}/${seg(checkVarName(name))}`, {
      body: { name, value: text(desired.fields.value) },
      what: 'update the variable'
    })
    return ext
  },
  async remove(ctx, ext) {
    const { repo, env, name } = splitScoped(ext)
    await gh(ctx, 'DELETE', `${actionsBase(repo, env, 'variables')}/${seg(checkVarName(name))}`, {
      ok: [404],
      what: 'delete the variable'
    })
  }
}

// ── Workflows (read + enable/disable; dispatch is an op, see index.ts) ──

function observedWorkflow(repo: string, j: Json): Observed {
  const file =
    String(j.path ?? '')
      .split('/')
      .pop() || String(j.id)
  return {
    type: 'github.workflow',
    externalId: `${repo}#${file}`,
    name: j.name ?? file,
    fields: {
      repository: repo,
      workflow: file,
      name: j.name ?? file,
      enabled: j.state === 'active'
    },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: typeof j.state === 'string' ? j.state : null,
    url: j.html_url ?? null
  }
}

function workflowPath(repo: string, file: string): string {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/actions/workflows/${seg(checkWorkflowFile(file))}`
}

export async function dispatchWorkflow(
  ctx: ProviderContext,
  ext: string,
  ref: string,
  inputs: Record<string, unknown>
): Promise<void> {
  const { repo, rest: file } = splitChild(ext)
  const found = await workflow.observe(ctx, ext)
  if (!found) bad('NOT_FOUND', `The workflow ${file} does not exist in ${repo}.`)
  if (found.status !== 'active')
    bad(
      'WORKFLOW_DISABLED',
      `The workflow ${file} is ${found.status ?? 'not active'}; enable it first.`
    )
  let branch = ref
  if (!branch) {
    const { owner, repo: r } = splitRepo(repo)
    const info = await gh<Json>(ctx, 'GET', `/repos/${seg(owner)}/${seg(r)}`)
    branch = text(info.json?.default_branch)
  }
  await gh(ctx, 'POST', `${workflowPath(repo, file)}/dispatches`, {
    body: Object.keys(inputs).length ? { ref: branch, inputs } : { ref: branch },
    what: 'start the workflow'
  })
}

/** Run events a promotion may approve: a dispatch or a push to the repository itself. */
export const APPROVABLE_EVENTS = ['workflow_dispatch', 'push'] as const

const SHA_RE = /^[0-9a-f]{40}$/

/** A waiting run a promotion would approve (read while the promotion is planned). */
export interface WaitingRun {
  runId: number
  headSha: string
  event: string
  createdAt: string | null
  url: string | null
}

function pendingPath(repo: string, runId: string): string {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/actions/runs/${seg(checkNumericId(runId))}/pending_deployments`
}

/**
 * Why a run is not one a promotion may approve, or null: it must be a run of this workflow file,
 * from this repository (never a fork), on the branch, started by an allowed event.
 */
function runProblem(run: Json, repo: string, file: string, branch: string): string | null {
  const path = text(run.path)
  if (path && path.split('@')[0] !== `.github/workflows/${file}`)
    return `run ${run.id} is not a run of ${file}`
  if (text(run.head_repository?.full_name).toLowerCase() !== repo.toLowerCase())
    return `run ${run.id} comes from ${text(run.head_repository?.full_name) || 'another repository'}, not ${repo}`
  if (text(run.head_branch) !== branch)
    return `run ${run.id} is on ${text(run.head_branch) || 'no branch'}, not ${branch}`
  if (!(APPROVABLE_EVENTS as readonly string[]).includes(text(run.event)))
    return `run ${run.id} was started by ${text(run.event) || 'an unknown event'}; only a dispatch or a push is approved`
  return null
}

function hitFor(pending: unknown, envName: string): Json | null {
  return (
    (Array.isArray(pending) ? (pending as Json[]) : []).find(
      (p) => text(p?.environment?.name).toLowerCase() === envName.toLowerCase()
    ) ?? null
  )
}

/**
 * Task 11c: the newest run of the workflow on `branch` that waits for review on `environment`
 * (read only; the promotion plan names it so the approval is bound to that run and commit).
 * Runs from a fork, on another branch or started by another event are skipped. null = none.
 */
export async function findWaitingRun(
  ctx: ProviderContext,
  ext: string,
  environment: string,
  branch: string
): Promise<WaitingRun | null> {
  const { repo, rest: file } = splitChild(ext)
  const envName = checkEnvName(environment)
  if (!branch) bad('BAD_ID', 'Name the branch the workflow runs on.')
  branchPath(branch)
  const query = new URLSearchParams({ status: 'waiting', branch, per_page: '10' })
  const runs = await gh<Json>(ctx, 'GET', `${workflowPath(repo, file)}/runs?${query}`, {
    what: 'list the waiting workflow runs'
  })
  const list = Array.isArray(runs.json?.workflow_runs) ? (runs.json.workflow_runs as Json[]) : []
  for (const run of list.slice(0, 5)) {
    if (runProblem(run, repo, file, branch)) continue
    const sha = text(run.head_sha).toLowerCase()
    if (!SHA_RE.test(sha)) continue
    const runId = checkNumericId(String(run.id ?? ''))
    const pending = await gh<Json[]>(ctx, 'GET', pendingPath(repo, runId), {
      what: 'list the run’s pending deployments'
    })
    if (!hitFor(pending.json, envName)) continue
    return {
      runId: Number(runId),
      headSha: sha,
      event: text(run.event),
      createdAt: text(run.created_at) || null,
      url: text(run.html_url) || null
    }
  }
  return null
}

/**
 * Task 11c: environment approval, bound to one run. Reads exactly `runId` and approves its
 * pending deployment on `environment` only when the run is still waiting, is a run of this
 * workflow from this repository (no fork) on `branch`, started by a dispatch or a push, and its
 * head commit is `headSha` (TARGET_MISMATCH otherwise). FORBIDDEN when the connection's account
 * may not approve; RUN_NOT_WAITING (not retryable — plan the promotion again) when the run no
 * longer waits on that environment. Nothing is approved on any refusal.
 */
export async function approvePendingDeployment(
  ctx: ProviderContext,
  ext: string,
  want: { environment: string; branch: string; runId: string; headSha: string }
): Promise<{ runId: number; environmentId: number; environment: string; headSha: string }> {
  const { repo, rest: file } = splitChild(ext)
  const { owner, repo: r } = splitRepo(repo)
  const envName = checkEnvName(want.environment)
  if (!want.branch) bad('TARGET_MISMATCH', 'An approval names the branch its run is on.')
  branchPath(want.branch)
  const runId = checkNumericId(want.runId)
  const sha = want.headSha.toLowerCase()
  if (!SHA_RE.test(sha)) bad('TARGET_MISMATCH', 'An approval names the commit of its run.')
  const got = await gh<Json>(
    ctx,
    'GET',
    `/repos/${seg(owner)}/${seg(r)}/actions/runs/${seg(runId)}`,
    { ok: [404], what: 'read the workflow run' }
  )
  const run = got.status === 404 ? null : got.json
  if (!run)
    throw new ProviderError('RUN_NOT_WAITING', `Run ${runId} is gone — plan the promotion again.`, {
      retryable: false,
      status: 409
    })
  const problem = runProblem(run, repo, file, want.branch)
  if (problem) bad('TARGET_MISMATCH', `Not approved: ${problem}.`)
  if (text(run.head_sha).toLowerCase() !== sha)
    bad(
      'TARGET_MISMATCH',
      `Not approved: run ${runId} is at commit ${text(run.head_sha).slice(0, 12) || '?'}, not the planned ${sha.slice(0, 12)}.`
    )
  if (text(run.status) !== 'waiting')
    throw new ProviderError(
      'RUN_NOT_WAITING',
      `Run ${runId} is ${text(run.status) || 'not waiting'} — plan the promotion again.`,
      { retryable: false, status: 409 }
    )
  const path = pendingPath(repo, runId)
  const pending = await gh<Json[]>(ctx, 'GET', path, { what: 'list the run’s pending deployments' })
  const hit = hitFor(pending.json, envName)
  if (!hit)
    throw new ProviderError(
      'RUN_NOT_WAITING',
      `Run ${runId} does not wait for approval to ${envName} — plan the promotion again.`,
      { retryable: false, status: 409 }
    )
  const envId = Number(hit.environment?.id)
  if (!Number.isSafeInteger(envId) || envId < 1)
    bad('PROVIDER_ERROR', 'GitHub answered a pending deployment without an environment id.')
  if (hit.current_user_can_approve !== true)
    bad(
      'FORBIDDEN',
      `The connection’s account may not approve deployments to ${envName} — add it as a required reviewer of that environment.`
    )
  await gh(ctx, 'POST', path, {
    body: {
      environment_ids: [envId],
      state: 'approved',
      comment: 'Approved by a Nivaro Hub promotion.'
    },
    what: 'approve the deployment'
  })
  return {
    runId: Number(runId),
    environmentId: envId,
    environment: text(hit.environment.name),
    headSha: sha
  }
}

const workflow: Handler = {
  key: 'github.workflow',
  async existing() {
    return null
  },
  compare: ['enabled'],
  replaceKeys: [],
  readOnlyLifecycle: true,
  async observe(ctx, ext) {
    const { repo, rest: file } = splitChild(ext)
    const r = await gh<Json>(ctx, 'GET', workflowPath(repo, file), { ok: [404] })
    return r.status === 404 ? null : observedWorkflow(repo, r.json)
  },
  async list(ctx, cursor) {
    return listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const { owner, repo: r } = splitRepo(repo)
      const res = await gh<Json>(
        ctx,
        'GET',
        `/repos/${seg(owner)}/${seg(r)}/actions/workflows?per_page=100`,
        {
          ok: [404]
        }
      )
      const rows: Json[] = Array.isArray(res.json?.workflows) ? res.json.workflows : []
      return rows.map((w) => observedWorkflow(repo, w))
    })
  },
  async create(_ctx, desired) {
    bad(
      'WORKFLOW_FILE_MISSING',
      `Workflow ${text(desired.fields.workflow)} is not in the repository. Workflows are created by committing the file; then adopt it.`
    )
  },
  async update(ctx, ext, desired) {
    const { repo, rest: file } = splitChild(ext)
    const want = bool(desired.fields.enabled, true)
    await gh(ctx, 'PUT', `${workflowPath(repo, file)}/${want ? 'enable' : 'disable'}`, {
      what: `${want ? 'enable' : 'disable'} the workflow`
    })
    return ext
  },
  async remove() {
    bad('NOT_SUPPORTED', 'A workflow is removed by deleting its file from the repository.')
  }
}

// ── Deploy keys ──

function observedKey(repo: string, j: Json): Observed {
  return {
    type: 'github.deploy_key',
    externalId: `${repo}#${j.id}`,
    name: j.title ?? null,
    fields: { repository: repo, title: j.title ?? '', key: j.key ?? '', read_only: !!j.read_only },
    tags: {},
    version: null,
    status: j.verified === false ? 'unverified' : 'active',
    url: null
  }
}

const keysPath = (repo: string): string => {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/keys`
}

const deployKey: Handler = {
  key: 'github.deploy_key',
  async existing(ctx, d) {
    const repo = parentRepo(d)
    const have = await ghAll<Json>(ctx, keysPath(repo))
    const hit = have.find((k) => sameKey(text(k.key), text(d.fields.key)))
    return hit ? `${repo}#${hit.id}` : null
  },
  compare: ['title', 'key', 'read_only'],
  replaceKeys: ['title', 'key', 'read_only'],
  async observe(ctx, ext) {
    const { repo, rest: id } = splitChild(ext)
    const r = await gh<Json>(ctx, 'GET', `${keysPath(repo)}/${seg(checkNumericId(id))}`, {
      ok: [404]
    })
    return r.status === 404 ? null : observedKey(repo, r.json)
  },
  async list(ctx, cursor) {
    return listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const keys = await gh<Json[]>(ctx, 'GET', `${keysPath(repo)}?per_page=100`, { ok: [404] })
      return (Array.isArray(keys.json) ? keys.json : []).map((k) => observedKey(repo, k))
    })
  },
  async create(ctx, desired) {
    const repo = parentRepo(desired)
    const key = text(desired.fields.key)
    const have = await ghAll<Json>(ctx, keysPath(repo))
    const same = have.find((k) => sameKey(text(k.key), key))
    if (same) return `${repo}#${same.id}`
    const r = await gh<Json>(ctx, 'POST', keysPath(repo), {
      body: {
        title: text(desired.fields.title),
        key,
        read_only: bool(desired.fields.read_only, true)
      },
      what: 'add the deploy key'
    })
    return `${repo}#${r.json.id}`
  },
  async update() {
    bad('NOT_SUPPORTED', 'A deploy key cannot be edited; it is replaced.')
  },
  async remove(ctx, ext) {
    const { repo, rest: id } = splitChild(ext)
    await gh(ctx, 'DELETE', `${keysPath(repo)}/${seg(checkNumericId(id))}`, {
      ok: [404],
      what: 'remove the deploy key'
    })
  }
}

// ── Webhooks ──

function observedHook(repo: string, j: Json): Observed {
  const cfg: Json = j.config ?? {}
  return {
    type: 'github.webhook',
    externalId: `${repo}#${j.id}`,
    name: cfg.url ?? null,
    // The secret is never returned by GitHub (masked), so it is absent here.
    fields: {
      repository: repo,
      url: cfg.url ?? '',
      content_type: cfg.content_type ?? 'json',
      events: Array.isArray(j.events) ? j.events : [],
      active: !!j.active
    },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: j.active ? 'active' : 'inactive',
    url: null
  }
}

const hooksPath = (repo: string): string => {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/hooks`
}

function hookBody(d: DesiredResource): Json {
  const secret = secretPlain(d, 'secret')
  return {
    active: bool(d.fields.active, true),
    events: list(d.fields.events).length ? list(d.fields.events) : ['push'],
    config: {
      url: text(d.fields.url),
      content_type: text(d.fields.content_type) || 'json',
      insecure_ssl: '0',
      // PATCH replaces the config object: send the secret whenever we hold it.
      ...(secret ? { secret } : {})
    }
  }
}

const webhook: Handler = {
  key: 'github.webhook',
  async existing(ctx, d) {
    const repo = parentRepo(d)
    const have = await ghAll<Json>(ctx, hooksPath(repo))
    const hit = have.find((h) => h?.config?.url === text(d.fields.url))
    return hit ? `${repo}#${hit.id}` : null
  },
  compare: ['url', 'content_type', 'events', 'active'],
  replaceKeys: [],
  secretField: 'secret',
  async observe(ctx, ext) {
    const { repo, rest: id } = splitChild(ext)
    const r = await gh<Json>(ctx, 'GET', `${hooksPath(repo)}/${seg(checkNumericId(id))}`, {
      ok: [404]
    })
    return r.status === 404 ? null : observedHook(repo, r.json)
  },
  async list(ctx, cursor) {
    return listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const hooks = await gh<Json[]>(ctx, 'GET', `${hooksPath(repo)}?per_page=100`, { ok: [404] })
      return (Array.isArray(hooks.json) ? hooks.json : []).map((h) => observedHook(repo, h))
    })
  },
  async create(ctx, desired) {
    const repo = parentRepo(desired)
    const url = text(desired.fields.url)
    const have = await ghAll<Json>(ctx, hooksPath(repo))
    const same = have.find((h) => h?.config?.url === url)
    if (same) {
      const id = `${repo}#${same.id}`
      await gh(ctx, 'PATCH', `${hooksPath(repo)}/${same.id}`, {
        body: hookBody(desired),
        what: 'update the webhook'
      })
      return id
    }
    const r = await gh<Json>(ctx, 'POST', hooksPath(repo), {
      body: { name: 'web', ...hookBody(desired) },
      what: 'create the webhook'
    })
    return `${repo}#${r.json.id}`
  },
  async update(ctx, ext, desired) {
    const { repo, rest: id } = splitChild(ext)
    await gh(ctx, 'PATCH', `${hooksPath(repo)}/${seg(checkNumericId(id))}`, {
      body: hookBody(desired),
      what: 'update the webhook'
    })
    return ext
  },
  async remove(ctx, ext) {
    const { repo, rest: id } = splitChild(ext)
    await gh(ctx, 'DELETE', `${hooksPath(repo)}/${seg(checkNumericId(id))}`, {
      ok: [404],
      what: 'delete the webhook'
    })
  }
}

// ── Listing children: walk the account's repositories a page at a time ──

export async function listPerRepo(
  ctx: ProviderContext,
  cursor: string | null,
  each: (repo: string, archived: boolean) => Promise<Observed[]>
): Promise<ListPage> {
  const page = cursor ? Number(cursor) || 1 : 1
  const r = await ownerRepos(ctx, page)
  const repos = (Array.isArray(r.json) ? (r.json as Json[]) : []).map((j) => ({
    full: String(j.full_name),
    archived: !!j.archived
  }))
  const groups = await inChunks(repos, 5, (x) => each(x.full, x.archived))
  const next = nextPage(r.headers)
  return { items: groups.flat(), cursor: next ? String(next) : null }
}

// ── Comparison ──

/** Equality that treats null / '' alike and lists as sets. */
export function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = [...list(a)].sort()
    const y = [...list(b)].sort()
    return x.length === y.length && x.every((v, i) => v === y[i])
  }
  if (typeof a === 'string' && typeof b === 'string' && /^(ssh|ecdsa)-/.test(a) && sameKey(a, b))
    return true
  const norm = (v: unknown) => (v === null || v === undefined ? '' : v)
  return norm(a) === norm(b)
}

export const HANDLERS: Record<string, Handler> = {
  'github.repository': repository,
  'github.branch_protection': branchProtection,
  'github.environment': environment,
  'github.actions_secret': actionsSecret,
  'github.actions_variable': actionsVariable,
  'github.workflow': workflow,
  'github.deploy_key': deployKey,
  'github.webhook': webhook
}

export function handlerFor(type: string): Handler {
  const h = HANDLERS[type]
  if (!h) bad('UNKNOWN_TYPE', `GitHub has no resource type ${type}.`)
  return h
}
