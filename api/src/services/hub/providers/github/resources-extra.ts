import {
  type DesiredResource,
  type ListPage,
  type Observed,
  type ProviderContext,
  ProviderError
} from '../types.js'
import {
  assertInAccount,
  branchPath,
  checkEnvName,
  checkNumericId,
  checkOwner,
  checkRepoName,
  checkSlug,
  checkVarName,
  filePath,
  gh,
  ghAll,
  nextPage,
  ownerOf,
  seg
} from './api.js'
import {
  bad,
  bool,
  type Handler,
  inChunks,
  list,
  listPerRepo,
  num,
  parentRepo,
  secretPlain,
  splitChild,
  splitRepo,
  text
} from './resources.js'
import { sealSecretValue } from './seal.js'

/**
 * Task 19: the handlers of the types added to the Task 5 adapter. External ids:
 *   github.team                    org#team-slug
 *   github.team_repo_access        owner/repo#team-slug
 *   github.ruleset                 owner/repo#<id>   (repository) or  org#<id>  (organisation)
 *   github.environment_secret      owner/repo@environment#NAME
 *   github.environment_variable    owner/repo@environment#NAME
 *   github.environment_protection  owner/repo#environment   (the same object as github.environment)
 *   github.org_secret / _variable  org#NAME
 *   github.dependabot_secret       owner/repo#NAME
 *   github.runner_group            org#<id>
 *   github.pages                   owner/repo#pages
 *   github.repo_file               owner/repo@branch#path
 * Every id names the account first; the adapter refuses an id of any other account. Nothing here
 * returns or logs a secret value.
 */

type Json = Record<string, any>

// ── Helpers ──

const orgName = (ctx: ProviderContext): string => checkOwner(ownerOf(ctx))
const orgBase = (ctx: ProviderContext): string => `/orgs/${seg(orgName(ctx))}`

/** `left#rest` where left has no slash (an organisation-level id). */
function splitOrgChild(ctx: ProviderContext, ext: string): { org: string; rest: string } {
  const i = ext.indexOf('#')
  if (i <= 0 || i === ext.length - 1 || ext.slice(0, i).includes('/'))
    bad('BAD_ID', `"${ext}" is not org#name.`)
  assertInAccount(ctx, ext)
  return { org: checkOwner(ext.slice(0, i)), rest: ext.slice(i + 1) }
}

function refOne(d: DesiredResource, field: string): string | null {
  const r = d.refs[field]
  const v = Array.isArray(r) ? r[0] : r
  return v ?? null
}

function needRef(d: DesiredResource, field: string, what: string): string {
  const v = refOne(d, field)
  if (!v) bad('REF_UNRESOLVED', `The ${what} this resource belongs to has not been created yet.`)
  return v
}

async function orgPage(
  ctx: ProviderContext,
  cursor: string | null,
  path: string,
  rows: (json: unknown) => Json[],
  map: (j: Json) => Observed,
  what: string
): Promise<ListPage> {
  const page = cursor ? Number(cursor) || 1 : 1
  const sep = path.includes('?') ? '&' : '?'
  const r = await gh<unknown>(ctx, 'GET', `${orgBase(ctx)}${path}${sep}per_page=30&page=${page}`, {
    ok: [404],
    what
  })
  if (r.status === 404) return { items: [], cursor: null }
  const next = nextPage(r.headers)
  return { items: rows(r.json).map(map), cursor: next ? String(next) : null }
}

const arr = (j: unknown, key: string): Json[] => {
  const v = (j as Json | null)?.[key]
  return Array.isArray(v) ? (v as Json[]) : []
}

async function repoIdByName(ctx: ProviderContext, name: string): Promise<number> {
  const r = await gh<Json>(ctx, 'GET', `/repos/${seg(orgName(ctx))}/${seg(checkRepoName(name))}`, {
    ok: [404],
    what: `read the repository ${name}`
  })
  const id = Number(r.json?.id)
  if (r.status === 404 || !Number.isSafeInteger(id))
    bad('NOT_FOUND', `The repository ${name} is not in ${orgName(ctx)}.`)
  return id
}

const repoIds = (ctx: ProviderContext, names: string[]): Promise<number[]> =>
  inChunks(names, 5, (n) => repoIdByName(ctx, n))

/** Libsodium sealed box under the public key at `${base}/public-key`; PUT to `${base}/${name}`. */
async function putSealed(
  ctx: ProviderContext,
  base: string,
  name: string,
  plain: string | null,
  extra: Json = {}
): Promise<void> {
  if (plain === null)
    bad('SECRET_VALUE_MISSING', `A value for the secret ${name} is needed to write it.`)
  const key = (await gh<Json>(ctx, 'GET', `${base}/public-key`, { what: 'read the public key' }))
    .json
  if (typeof key?.key !== 'string' || typeof key?.key_id !== 'string')
    bad('PROVIDER_ERROR', 'GitHub did not return a public key for the secret.')
  const sealed = await sealSecretValue(plain, key.key)
  await gh(ctx, 'PUT', `${base}/${seg(checkVarName(name))}`, {
    body: { encrypted_value: sealed, key_id: key.key_id, ...extra },
    what: 'write the secret'
  })
}

/** Every item of a list endpoint; a 404 (a user account has no organisation endpoints) is none. */
async function allOrNone<T>(
  ctx: ProviderContext,
  path: string,
  pick?: (json: unknown) => T[]
): Promise<T[]> {
  try {
    return await ghAll<T>(ctx, path, pick)
  } catch (e) {
    if (e instanceof ProviderError && e.code === 'NOT_FOUND') return []
    throw e
  }
}

// ── Teams ──

const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

function observedTeam(org: string, j: Json): Observed {
  return {
    type: 'github.team',
    externalId: `${org}#${j.slug}`,
    name: j.name ?? null,
    fields: {
      name: j.name ?? '',
      slug: j.slug ?? '',
      description: j.description ?? '',
      privacy: j.privacy ?? 'closed',
      parent: j.parent?.slug ?? ''
    },
    tags: {},
    version: null,
    status: 'active',
    url: j.html_url ?? null
  }
}

async function teamId(ctx: ProviderContext, slug: string): Promise<number> {
  const r = await gh<Json>(ctx, 'GET', `${orgBase(ctx)}/teams/${seg(checkSlug(slug))}`, {
    ok: [404],
    what: `read the team ${slug}`
  })
  const id = Number(r.json?.id)
  if (r.status === 404 || !Number.isSafeInteger(id))
    bad('NOT_FOUND', `The team ${slug} does not exist in ${orgName(ctx)}.`)
  return id
}

const team: Handler = {
  key: 'github.team',
  async existing(ctx, d) {
    const slug = slugOf(text(d.fields.name))
    if (!slug) return null
    return (await team.observe(ctx, `${orgName(ctx)}#${slug}`))?.externalId ?? null
  },
  compare: ['name', 'description', 'privacy', 'parent'],
  replaceKeys: [],
  async observe(ctx, ext) {
    const { org, rest } = splitOrgChild(ctx, ext)
    const r = await gh<Json>(ctx, 'GET', `/orgs/${seg(org)}/teams/${seg(checkSlug(rest))}`, {
      ok: [404]
    })
    return r.status === 404 ? null : observedTeam(org, r.json)
  },
  list: (ctx, cursor) =>
    orgPage(
      ctx,
      cursor,
      '/teams',
      (j) => (Array.isArray(j) ? (j as Json[]) : []),
      (j) => observedTeam(orgName(ctx), j),
      'list the teams'
    ),
  async create(ctx, d) {
    const parent = text(d.fields.parent)
    const r = await gh<Json>(ctx, 'POST', `${orgBase(ctx)}/teams`, {
      body: {
        name: text(d.fields.name),
        description: text(d.fields.description),
        privacy: text(d.fields.privacy) || 'closed',
        ...(parent ? { parent_team_id: await teamId(ctx, parent) } : {})
      },
      what: 'create the team (organisation accounts only)'
    })
    return `${orgName(ctx)}#${String(r.json.slug)}`
  },
  async update(ctx, ext, d) {
    const { org, rest } = splitOrgChild(ctx, ext)
    const parent = text(d.fields.parent)
    const r = await gh<Json>(ctx, 'PATCH', `/orgs/${seg(org)}/teams/${seg(checkSlug(rest))}`, {
      body: {
        name: text(d.fields.name),
        description: text(d.fields.description),
        privacy: text(d.fields.privacy) || 'closed',
        parent_team_id: parent ? await teamId(ctx, parent) : null
      },
      what: 'update the team'
    })
    // A renamed team gets a new slug, so a new id.
    return typeof r.json?.slug === 'string' ? `${org}#${r.json.slug}` : ext
  },
  async remove(ctx, ext) {
    const { org, rest } = splitOrgChild(ctx, ext)
    await gh(ctx, 'DELETE', `/orgs/${seg(org)}/teams/${seg(checkSlug(rest))}`, {
      ok: [404],
      what: 'delete the team'
    })
  }
}

// ── A team's access to a repository ──

function teamSlugFromRef(ctx: ProviderContext, d: DesiredResource): string {
  return splitOrgChild(ctx, needRef(d, 'team', 'team')).rest
}

async function teamAccess(ctx: ProviderContext, repo: string, slug: string): Promise<Json | null> {
  const { owner, repo: r } = splitRepo(repo)
  const r2 = await gh<Json[]>(ctx, 'GET', `/repos/${seg(owner)}/${seg(r)}/teams?per_page=100`, {
    ok: [404]
  })
  const rows = Array.isArray(r2.json) ? r2.json : []
  return rows.find((t) => text(t.slug).toLowerCase() === slug.toLowerCase()) ?? null
}

function observedAccess(repo: string, j: Json): Observed {
  const { owner } = splitRepo(repo)
  return {
    type: 'github.team_repo_access',
    externalId: `${repo}#${j.slug}`,
    name: String(j.slug),
    fields: { repository: repo, team: `${owner}#${j.slug}`, permission: j.permission ?? 'pull' },
    tags: {},
    version: null,
    status: 'active',
    url: null
  }
}

const teamRepoAccess: Handler = {
  key: 'github.team_repo_access',
  async existing(ctx, d) {
    const ext = `${parentRepo(d)}#${teamSlugFromRef(ctx, d)}`
    return (await teamRepoAccess.observe(ctx, ext)) ? ext : null
  },
  compare: ['permission'],
  replaceKeys: [],
  async observe(ctx, ext) {
    const { repo, rest } = splitChild(ext)
    const t = await teamAccess(ctx, repo, checkSlug(rest))
    return t ? observedAccess(repo, t) : null
  },
  list: (ctx, cursor) =>
    listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const { owner, repo: r } = splitRepo(repo)
      const rows = await gh<Json[]>(
        ctx,
        'GET',
        `/repos/${seg(owner)}/${seg(r)}/teams?per_page=100`,
        { ok: [404] }
      )
      return (Array.isArray(rows.json) ? rows.json : []).map((t) => observedAccess(repo, t))
    }),
  async create(ctx, d) {
    const repo = parentRepo(d)
    const slug = teamSlugFromRef(ctx, d)
    await grantAccess(ctx, repo, slug, text(d.fields.permission) || 'pull')
    return `${repo}#${slug}`
  },
  async update(ctx, ext, d) {
    const { repo, rest } = splitChild(ext)
    await grantAccess(ctx, repo, checkSlug(rest), text(d.fields.permission) || 'pull')
    return ext
  },
  async remove(ctx, ext) {
    const { repo, rest } = splitChild(ext)
    const { owner, repo: r } = splitRepo(repo)
    await gh(
      ctx,
      'DELETE',
      `${orgBase(ctx)}/teams/${seg(checkSlug(rest))}/repos/${seg(owner)}/${seg(r)}`,
      { ok: [404], what: 'remove the team from the repository' }
    )
  }
}

async function grantAccess(
  ctx: ProviderContext,
  repo: string,
  slug: string,
  permission: string
): Promise<void> {
  const { owner, repo: r } = splitRepo(repo)
  await gh(ctx, 'PUT', `${orgBase(ctx)}/teams/${seg(slug)}/repos/${seg(owner)}/${seg(r)}`, {
    body: { permission },
    what: 'give the team access to the repository'
  })
}

// ── Rulesets (repository or organisation) ──

const MODELLED_RULES = new Set([
  'deletion',
  'non_fast_forward',
  'required_linear_history',
  'required_signatures',
  'pull_request',
  'required_status_checks'
])

/** `owner/repo#id` → the repository; `org#id` → null (an organisation ruleset). */
function rulesetWhere(ctx: ProviderContext, ext: string): { repo: string | null; id: string } {
  const i = ext.indexOf('#')
  if (i <= 0 || i === ext.length - 1) bad('BAD_ID', `"${ext}" is not owner/repo#id or org#id.`)
  assertInAccount(ctx, ext)
  const left = ext.slice(0, i)
  const id = checkNumericId(ext.slice(i + 1))
  if (left.includes('/')) {
    splitRepo(left)
    return { repo: left, id }
  }
  checkOwner(left)
  return { repo: null, id }
}

function rulesetBase(ctx: ProviderContext, repo: string | null): string {
  if (!repo) return `${orgBase(ctx)}/rulesets`
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/rulesets`
}

function observedRuleset(left: string, repo: string | null, j: Json): Observed {
  const rules: Json[] = Array.isArray(j.rules) ? j.rules : []
  const has = (t: string) => rules.some((r) => r.type === t)
  const pr = rules.find((r) => r.type === 'pull_request')?.parameters
  const sc = rules.find((r) => r.type === 'required_status_checks')?.parameters
  const ref = j.conditions?.ref_name
  return {
    type: 'github.ruleset',
    externalId: `${left}#${j.id}`,
    name: j.name ?? null,
    fields: {
      repository: repo ?? '',
      name: j.name ?? '',
      target: j.target ?? 'branch',
      enforcement: j.enforcement ?? 'active',
      include: Array.isArray(ref?.include) ? ref.include : [],
      exclude: Array.isArray(ref?.exclude) ? ref.exclude : [],
      repositories: repo
        ? []
        : Array.isArray(j.conditions?.repository_name?.include)
          ? j.conditions.repository_name.include
          : [],
      required_reviews: pr ? num(pr.required_approving_review_count, 0) : 0,
      dismiss_stale_reviews: !!pr?.dismiss_stale_reviews_on_push,
      require_code_owner_review: !!pr?.require_code_owner_review,
      require_conversation_resolution: !!pr?.required_review_thread_resolution,
      required_status_checks: (Array.isArray(sc?.required_status_checks)
        ? (sc.required_status_checks as Json[])
        : []
      ).map((c) => text(c.context)),
      strict_status_checks: !!sc?.strict_required_status_checks_policy,
      block_deletions: has('deletion'),
      block_force_pushes: has('non_fast_forward'),
      require_linear_history: has('required_linear_history'),
      require_signatures: has('required_signatures')
    },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: j.enforcement ?? 'active',
    url: typeof j._links?.html?.href === 'string' ? j._links.html.href : null
  }
}

/** The rules a desired ruleset carries (only the modelled ones). */
function rulesOf(d: DesiredResource): Json[] {
  const f = d.fields
  const out: Json[] = []
  if (bool(f.block_deletions)) out.push({ type: 'deletion' })
  if (bool(f.block_force_pushes)) out.push({ type: 'non_fast_forward' })
  if (bool(f.require_linear_history)) out.push({ type: 'required_linear_history' })
  if (bool(f.require_signatures)) out.push({ type: 'required_signatures' })
  const reviews = num(f.required_reviews, 0)
  if (reviews > 0)
    out.push({
      type: 'pull_request',
      parameters: {
        required_approving_review_count: reviews,
        dismiss_stale_reviews_on_push: bool(f.dismiss_stale_reviews),
        require_code_owner_review: bool(f.require_code_owner_review),
        require_last_push_approval: false,
        required_review_thread_resolution: bool(f.require_conversation_resolution)
      }
    })
  const checks = list(f.required_status_checks)
  if (checks.length)
    out.push({
      type: 'required_status_checks',
      parameters: {
        required_status_checks: checks.map((context) => ({ context })),
        strict_required_status_checks_policy: bool(f.strict_status_checks)
      }
    })
  return out
}

function rulesetBody(d: DesiredResource, repo: string | null, current: Json | null): Json {
  const include = list(d.fields.include)
  const conditions: Json = {
    ref_name: {
      include: include.length ? include : ['~DEFAULT_BRANCH'],
      exclude: list(d.fields.exclude)
    }
  }
  if (!repo) {
    const repos = list(d.fields.repositories)
    conditions.repository_name = { include: repos.length ? repos : ['~ALL'], exclude: [] }
  }
  // What the Hub does not model stays as it is: other rules and the bypass list.
  const keep = (Array.isArray(current?.rules) ? (current.rules as Json[]) : []).filter(
    (r) => !MODELLED_RULES.has(text(r.type))
  )
  return {
    name: text(d.fields.name),
    target: text(d.fields.target) || 'branch',
    enforcement: text(d.fields.enforcement) || 'active',
    bypass_actors: Array.isArray(current?.bypass_actors) ? current.bypass_actors : [],
    conditions,
    rules: [...rulesOf(d), ...keep]
  }
}

function rulesetRepoOf(d: DesiredResource): string | null {
  if (!d.fields.repository) return null
  return needRef(d, 'repository', 'repository')
}

async function rulesetRaw(
  ctx: ProviderContext,
  repo: string | null,
  id: string
): Promise<Json | null> {
  const r = await gh<Json>(ctx, 'GET', `${rulesetBase(ctx, repo)}/${seg(id)}`, { ok: [404] })
  return r.status === 404 ? null : r.json
}

const ruleset: Handler = {
  key: 'github.ruleset',
  async existing(ctx, d) {
    const repo = rulesetRepoOf(d)
    const rows = await allOrNone<Json>(ctx, rulesetBase(ctx, repo))
    const hit = rows.find((r) => text(r.name) === text(d.fields.name))
    return hit ? `${repo ?? orgName(ctx)}#${hit.id}` : null
  },
  compare: [
    'name',
    'target',
    'enforcement',
    'include',
    'exclude',
    'repositories',
    'required_reviews',
    'dismiss_stale_reviews',
    'require_code_owner_review',
    'require_conversation_resolution',
    'required_status_checks',
    'strict_status_checks',
    'block_deletions',
    'block_force_pushes',
    'require_linear_history',
    'require_signatures'
  ],
  replaceKeys: [],
  async observe(ctx, ext) {
    const { repo, id } = rulesetWhere(ctx, ext)
    const j = await rulesetRaw(ctx, repo, id)
    return j ? observedRuleset(repo ?? orgName(ctx), repo, j) : null
  },
  async list(ctx, cursor) {
    // The organisation's rulesets first, then every repository's, a page of repositories at a time.
    if (!cursor) {
      const rows = await ghAll<Json>(ctx, rulesetBase(ctx, null)).catch((e) => {
        if (e instanceof ProviderError && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN'))
          return []
        throw e
      })
      const items: Observed[] = []
      for (const row of rows) {
        const j = await rulesetRaw(ctx, null, checkNumericId(String(row.id)))
        if (j) items.push(observedRuleset(orgName(ctx), null, j))
      }
      return { items, cursor: 'r:1' }
    }
    const page = await listPerRepo(ctx, cursor.replace(/^r:/, ''), async (repo, archived) => {
      if (archived) return []
      const rows = await ghAll<Json>(ctx, rulesetBase(ctx, repo)).catch(() => [] as Json[])
      const out: Observed[] = []
      for (const row of rows) {
        // Rulesets inherited from the organisation also show here; they are listed above.
        if (row.source_type && row.source_type !== 'Repository') continue
        const j = await rulesetRaw(ctx, repo, checkNumericId(String(row.id)))
        if (j) out.push(observedRuleset(repo, repo, j))
      }
      return out
    })
    return { items: page.items, cursor: page.cursor ? `r:${page.cursor}` : null }
  },
  async create(ctx, d) {
    const repo = rulesetRepoOf(d)
    const r = await gh<Json>(ctx, 'POST', rulesetBase(ctx, repo), {
      body: rulesetBody(d, repo, null),
      what: 'create the ruleset'
    })
    return `${repo ?? orgName(ctx)}#${checkNumericId(String(r.json.id))}`
  },
  async update(ctx, ext, d) {
    const { repo, id } = rulesetWhere(ctx, ext)
    const current = await rulesetRaw(ctx, repo, id)
    await gh(ctx, 'PUT', `${rulesetBase(ctx, repo)}/${seg(id)}`, {
      body: rulesetBody(d, repo, current),
      what: 'update the ruleset'
    })
    return ext
  },
  async remove(ctx, ext) {
    const { repo, id } = rulesetWhere(ctx, ext)
    await gh(ctx, 'DELETE', `${rulesetBase(ctx, repo)}/${seg(id)}`, {
      ok: [404],
      what: 'delete the ruleset'
    })
  }
}

// ── Environment secrets and variables (the environment is a ref) ──

function splitEnvRef(d: DesiredResource): { repo: string; env: string } {
  const ref = needRef(d, 'environment', 'environment')
  const { repo, rest } = splitChild(ref)
  splitRepo(repo)
  return { repo, env: checkEnvName(rest) }
}

function envKindBase(repo: string, env: string, kind: 'secrets' | 'variables'): string {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/environments/${seg(checkEnvName(env))}/${kind}`
}

/** `owner/repo@env#NAME` → parts (an environment is required here). */
function splitEnvScoped(ext: string): { repo: string; env: string; name: string } {
  const { repo: left, rest } = splitChild(ext)
  const at = left.indexOf('@')
  if (at < 0) bad('BAD_ID', `"${ext}" is not owner/repo@environment#NAME.`)
  return { repo: left.slice(0, at), env: left.slice(at + 1), name: rest }
}

const envSecretId = (repo: string, env: string, name: string): string => `${repo}@${env}#${name}`

function observedEnvSecret(repo: string, env: string, j: Json): Observed {
  return {
    type: 'github.environment_secret',
    externalId: envSecretId(repo, env, String(j.name)),
    name: j.name ?? null,
    // The value is write-only: GitHub never returns it.
    fields: { environment: `${repo}#${env}`, name: j.name },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: 'active',
    url: null
  }
}

const environmentSecret: Handler = {
  key: 'github.environment_secret',
  async existing(ctx, d) {
    const { repo, env } = splitEnvRef(d)
    const ext = envSecretId(repo, env, text(d.fields.name))
    return (await environmentSecret.observe(ctx, ext)) ? ext : null
  },
  compare: [],
  replaceKeys: ['name'],
  secretField: 'value',
  async observe(ctx, ext) {
    const { repo, env, name } = splitEnvScoped(ext)
    const r = await gh<Json>(
      ctx,
      'GET',
      `${envKindBase(repo, env, 'secrets')}/${seg(checkVarName(name))}`,
      { ok: [404] }
    )
    return r.status === 404 ? null : observedEnvSecret(repo, env, r.json)
  },
  list: (ctx, cursor) =>
    listPerEnvironment(ctx, cursor, async (repo, env) => {
      const res = await gh<Json>(ctx, 'GET', `${envKindBase(repo, env, 'secrets')}?per_page=100`, {
        ok: [404]
      })
      return arr(res.json, 'secrets').map((s) => observedEnvSecret(repo, env, s))
    }),
  async create(ctx, d) {
    const { repo, env } = splitEnvRef(d)
    const name = text(d.fields.name)
    await putSealed(ctx, envKindBase(repo, env, 'secrets'), name, secretPlain(d, 'value'))
    return envSecretId(repo, env, name)
  },
  async update(ctx, ext, d) {
    const { repo, env, name } = splitEnvScoped(ext)
    await putSealed(ctx, envKindBase(repo, env, 'secrets'), name, secretPlain(d, 'value'))
    return ext
  },
  async remove(ctx, ext) {
    const { repo, env, name } = splitEnvScoped(ext)
    await gh(ctx, 'DELETE', `${envKindBase(repo, env, 'secrets')}/${seg(checkVarName(name))}`, {
      ok: [404],
      what: 'delete the secret'
    })
  }
}

function observedEnvVariable(repo: string, env: string, j: Json): Observed {
  return {
    type: 'github.environment_variable',
    externalId: envSecretId(repo, env, String(j.name)),
    name: j.name ?? null,
    fields: { environment: `${repo}#${env}`, name: j.name, value: j.value ?? '' },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: 'active',
    url: null
  }
}

const environmentVariable: Handler = {
  key: 'github.environment_variable',
  async existing(ctx, d) {
    const { repo, env } = splitEnvRef(d)
    const ext = envSecretId(repo, env, text(d.fields.name))
    return (await environmentVariable.observe(ctx, ext)) ? ext : null
  },
  compare: ['value'],
  replaceKeys: ['name'],
  async observe(ctx, ext) {
    const { repo, env, name } = splitEnvScoped(ext)
    const r = await gh<Json>(
      ctx,
      'GET',
      `${envKindBase(repo, env, 'variables')}/${seg(checkVarName(name))}`,
      { ok: [404] }
    )
    return r.status === 404 ? null : observedEnvVariable(repo, env, r.json)
  },
  list: (ctx, cursor) =>
    listPerEnvironment(ctx, cursor, async (repo, env) => {
      const res = await gh<Json>(ctx, 'GET', `${envKindBase(repo, env, 'variables')}?per_page=30`, {
        ok: [404]
      })
      return arr(res.json, 'variables').map((v) => observedEnvVariable(repo, env, v))
    }),
  async create(ctx, d) {
    const { repo, env } = splitEnvRef(d)
    const name = text(d.fields.name)
    const id = envSecretId(repo, env, name)
    // Only the Hub's own interrupted create reaches here with the variable already there.
    const have = await environmentVariable.observe(ctx, id)
    if (have) return environmentVariable.update(ctx, id, d, have)
    await gh(ctx, 'POST', envKindBase(repo, env, 'variables'), {
      body: { name, value: text(d.fields.value) },
      what: 'create the variable'
    })
    return id
  },
  async update(ctx, ext, d) {
    const { repo, env, name } = splitEnvScoped(ext)
    await gh(ctx, 'PATCH', `${envKindBase(repo, env, 'variables')}/${seg(checkVarName(name))}`, {
      body: { name, value: text(d.fields.value) },
      what: 'update the variable'
    })
    return ext
  },
  async remove(ctx, ext) {
    const { repo, env, name } = splitEnvScoped(ext)
    await gh(ctx, 'DELETE', `${envKindBase(repo, env, 'variables')}/${seg(checkVarName(name))}`, {
      ok: [404],
      what: 'delete the variable'
    })
  }
}

/** Walks the account's repositories, then each one's environments. */
function listPerEnvironment(
  ctx: ProviderContext,
  cursor: string | null,
  each: (repo: string, env: string) => Promise<Observed[]>
): Promise<ListPage> {
  return listPerRepo(ctx, cursor, async (repo, archived) => {
    if (archived) return []
    const { owner, repo: r } = splitRepo(repo)
    const envs = await gh<Json>(
      ctx,
      'GET',
      `/repos/${seg(owner)}/${seg(r)}/environments?per_page=100`,
      { ok: [404] }
    )
    const out: Observed[] = []
    for (const e of arr(envs.json, 'environments')) out.push(...(await each(repo, text(e.name))))
    return out
  })
}

// ── Environment protection (reviewers, wait timer, branch policy) ──

const REVIEWER_RE = /^(user|team):[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

function envPathOf(repo: string, name: string): string {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/environments/${seg(checkEnvName(name))}`
}

function reviewersOf(j: Json): string[] {
  const rules: Json[] = Array.isArray(j.protection_rules) ? j.protection_rules : []
  const rule = rules.find((r) => r.type === 'required_reviewers')
  const out: string[] = []
  for (const x of Array.isArray(rule?.reviewers) ? (rule.reviewers as Json[]) : []) {
    if (x?.type === 'User' && x.reviewer?.login) out.push(`user:${x.reviewer.login}`)
    else if (x?.type === 'Team' && x.reviewer?.slug) out.push(`team:${x.reviewer.slug}`)
  }
  return out
}

async function branchPatterns(ctx: ProviderContext, repo: string, env: string): Promise<string[]> {
  const r = await gh<Json>(
    ctx,
    'GET',
    `${envPathOf(repo, env)}/deployment-branch-policies?per_page=100`,
    { ok: [404] }
  )
  return arr(r.json, 'branch_policies').map((p) => text(p.name))
}

function policyKind(j: Json): 'all' | 'protected' | 'selected' {
  const p = j.deployment_branch_policy
  if (!p) return 'all'
  return p.protected_branches ? 'protected' : p.custom_branch_policies ? 'selected' : 'all'
}

async function observedProtection(ctx: ProviderContext, repo: string, j: Json): Promise<Observed> {
  const rules: Json[] = Array.isArray(j.protection_rules) ? j.protection_rules : []
  const wait = rules.find((r) => r.type === 'wait_timer')
  const rev = rules.find((r) => r.type === 'required_reviewers')
  const kind = policyKind(j)
  return {
    type: 'github.environment_protection',
    externalId: `${repo}#${j.name}`,
    name: j.name ?? null,
    fields: {
      environment: `${repo}#${j.name}`,
      reviewers: reviewersOf(j),
      wait_timer: num(wait?.wait_timer, 0),
      prevent_self_review: !!rev?.prevent_self_review,
      deployment_branches: kind,
      branch_patterns: kind === 'selected' ? await branchPatterns(ctx, repo, text(j.name)) : []
    },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: 'active',
    url: j.html_url ?? null
  }
}

function isProtected(j: Json): boolean {
  const rules: Json[] = Array.isArray(j.protection_rules) ? j.protection_rules : []
  return rules.length > 0 || policyKind(j) !== 'all'
}

async function reviewerIds(
  ctx: ProviderContext,
  entries: string[]
): Promise<Array<{ type: 'User' | 'Team'; id: number }>> {
  if (entries.length > 6) bad('VALIDATION', 'An environment takes at most 6 required reviewers.')
  const out: Array<{ type: 'User' | 'Team'; id: number }> = []
  for (const e of entries) {
    if (!REVIEWER_RE.test(e)) bad('BAD_ID', `"${e}" is not user:login or team:slug.`)
    const [kind, name] = [e.slice(0, e.indexOf(':')), e.slice(e.indexOf(':') + 1)]
    if (kind === 'user') {
      const r = await gh<Json>(ctx, 'GET', `/users/${seg(checkOwner(name))}`, {
        ok: [404],
        what: `read the user ${name}`
      })
      if (r.status === 404) bad('NOT_FOUND', `GitHub has no user ${name}.`)
      out.push({ type: 'User', id: Number(r.json.id) })
    } else out.push({ type: 'Team', id: await teamId(ctx, name) })
  }
  return out
}

async function writeProtection(
  ctx: ProviderContext,
  repo: string,
  env: string,
  d: DesiredResource
): Promise<void> {
  const policy = text(d.fields.deployment_branches) || 'all'
  const patterns = list(d.fields.branch_patterns)
  await gh(ctx, 'PUT', envPathOf(repo, env), {
    body: {
      wait_timer: num(d.fields.wait_timer, 0),
      prevent_self_review: bool(d.fields.prevent_self_review),
      reviewers: await reviewerIds(ctx, list(d.fields.reviewers)),
      deployment_branch_policy:
        policy === 'protected'
          ? { protected_branches: true, custom_branch_policies: false }
          : policy === 'selected'
            ? { protected_branches: false, custom_branch_policies: true }
            : null
    },
    what: 'set the environment protection'
  })
  if (policy !== 'selected') return
  // The custom branch policies are separate objects: add the missing, remove the extra.
  const base = `${envPathOf(repo, env)}/deployment-branch-policies`
  const have = arr(
    (await gh<Json>(ctx, 'GET', `${base}?per_page=100`, { ok: [404] })).json,
    'branch_policies'
  )
  for (const p of have) {
    if (!patterns.includes(text(p.name)))
      await gh(ctx, 'DELETE', `${base}/${seg(checkNumericId(String(p.id)))}`, {
        ok: [404],
        what: 'remove a deployment branch pattern'
      })
  }
  for (const name of patterns) {
    if (have.some((p) => text(p.name) === name)) continue
    if (!name || /[\\\0]/.test(name)) bad('BAD_ID', `"${name}" is not a branch pattern.`)
    await gh(ctx, 'POST', base, {
      body: { name, type: 'branch' },
      what: 'add a deployment branch pattern'
    })
  }
}

const environmentProtection: Handler = {
  key: 'github.environment_protection',
  async existing(ctx, d) {
    const ref = needRef(d, 'environment', 'environment')
    const { repo, rest } = splitChild(ref)
    const r = await gh<Json>(ctx, 'GET', envPathOf(repo, rest), { ok: [404] })
    return r.status === 200 && isProtected(r.json) ? ref : null
  },
  compare: [
    'reviewers',
    'wait_timer',
    'prevent_self_review',
    'deployment_branches',
    'branch_patterns'
  ],
  replaceKeys: [],
  async observe(ctx, ext) {
    const { repo, rest } = splitChild(ext)
    const r = await gh<Json>(ctx, 'GET', envPathOf(repo, rest), { ok: [404] })
    return r.status === 404 ? null : observedProtection(ctx, repo, r.json)
  },
  list: (ctx, cursor) =>
    listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const { owner, repo: r } = splitRepo(repo)
      const res = await gh<Json>(
        ctx,
        'GET',
        `/repos/${seg(owner)}/${seg(r)}/environments?per_page=100`,
        { ok: [404] }
      )
      const out: Observed[] = []
      for (const e of arr(res.json, 'environments'))
        if (isProtected(e)) out.push(await observedProtection(ctx, repo, e))
      return out
    }),
  async create(ctx, d) {
    const ref = needRef(d, 'environment', 'environment')
    const { repo, rest } = splitChild(ref)
    await writeProtection(ctx, repo, checkEnvName(rest), d)
    return ref
  },
  async update(ctx, ext, d) {
    const { repo, rest } = splitChild(ext)
    await writeProtection(ctx, repo, checkEnvName(rest), d)
    return ext
  },
  async remove(ctx, ext) {
    // Removing the protection clears it; the environment itself stays.
    const { repo, rest } = splitChild(ext)
    await gh(ctx, 'PUT', envPathOf(repo, checkEnvName(rest)), {
      body: {
        wait_timer: 0,
        prevent_self_review: false,
        reviewers: [],
        deployment_branch_policy: null
      },
      ok: [404],
      what: 'clear the environment protection'
    })
  }
}

// ── Organisation secrets and variables ──

const VISIBILITY = ['all', 'private', 'selected']
const visibilityOf = (d: DesiredResource): string => {
  const v = text(d.fields.visibility) || 'private'
  if (!VISIBILITY.includes(v)) bad('VALIDATION', `"${v}" is not all, private or selected.`)
  return v
}

async function selectedNames(ctx: ProviderContext, path: string): Promise<string[]> {
  const r = await gh<Json>(ctx, 'GET', `${orgBase(ctx)}${path}/repositories?per_page=100`, {
    ok: [404]
  })
  return arr(r.json, 'repositories').map((x) => text(x.name))
}

function observedOrgSecret(org: string, j: Json, repos: string[]): Observed {
  return {
    type: 'github.org_secret',
    externalId: `${org}#${j.name}`,
    name: j.name ?? null,
    // The value is write-only: GitHub never returns it.
    fields: { name: j.name, visibility: j.visibility ?? 'private', repositories: repos },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: 'active',
    url: null
  }
}

const orgSecret: Handler = {
  key: 'github.org_secret',
  async existing(ctx, d) {
    const ext = `${orgName(ctx)}#${text(d.fields.name)}`
    return (await orgSecret.observe(ctx, ext)) ? ext : null
  },
  compare: ['visibility', 'repositories'],
  replaceKeys: ['name'],
  secretField: 'value',
  async observe(ctx, ext) {
    const { org, rest } = splitOrgChild(ctx, ext)
    const path = `/actions/secrets/${seg(checkVarName(rest))}`
    const r = await gh<Json>(ctx, 'GET', `/orgs/${seg(org)}${path}`, { ok: [404] })
    if (r.status === 404) return null
    const repos = r.json.visibility === 'selected' ? await selectedNames(ctx, path) : []
    return observedOrgSecret(org, r.json, repos)
  },
  list: (ctx, cursor) =>
    orgPage(
      ctx,
      cursor,
      '/actions/secrets',
      (j) => arr(j, 'secrets'),
      (s) => observedOrgSecret(orgName(ctx), s, []),
      'list the organisation secrets'
    ),
  async create(ctx, d) {
    const name = text(d.fields.name)
    await writeOrgSecret(ctx, name, d)
    return `${orgName(ctx)}#${name}`
  },
  async update(ctx, ext, d) {
    const { rest } = splitOrgChild(ctx, ext)
    if (secretPlain(d, 'value') !== null) await writeOrgSecret(ctx, rest, d)
    else {
      // Without the value only the list of repositories of a "selected" secret can change.
      const have = await orgSecret.observe(ctx, ext)
      if (!have || visibilityOf(d) !== have.fields.visibility || visibilityOf(d) !== 'selected')
        bad('SECRET_VALUE_MISSING', `Changing who can use ${rest} needs its value again.`)
      await gh(
        ctx,
        'PUT',
        `${orgBase(ctx)}/actions/secrets/${seg(checkVarName(rest))}/repositories`,
        {
          body: { selected_repository_ids: await repoIds(ctx, list(d.fields.repositories)) },
          what: 'set the repositories of the secret'
        }
      )
    }
    return ext
  },
  async remove(ctx, ext) {
    const { rest } = splitOrgChild(ctx, ext)
    await gh(ctx, 'DELETE', `${orgBase(ctx)}/actions/secrets/${seg(checkVarName(rest))}`, {
      ok: [404],
      what: 'delete the organisation secret'
    })
  }
}

async function writeOrgSecret(ctx: ProviderContext, name: string, d: DesiredResource) {
  const visibility = visibilityOf(d)
  await putSealed(ctx, `${orgBase(ctx)}/actions/secrets`, name, secretPlain(d, 'value'), {
    visibility,
    ...(visibility === 'selected'
      ? { selected_repository_ids: await repoIds(ctx, list(d.fields.repositories)) }
      : {})
  })
}

function observedOrgVariable(org: string, j: Json, repos: string[]): Observed {
  return {
    type: 'github.org_variable',
    externalId: `${org}#${j.name}`,
    name: j.name ?? null,
    fields: {
      name: j.name,
      value: j.value ?? '',
      visibility: j.visibility ?? 'private',
      repositories: repos
    },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: 'active',
    url: null
  }
}

const orgVariable: Handler = {
  key: 'github.org_variable',
  async existing(ctx, d) {
    const ext = `${orgName(ctx)}#${text(d.fields.name)}`
    return (await orgVariable.observe(ctx, ext)) ? ext : null
  },
  compare: ['value', 'visibility', 'repositories'],
  replaceKeys: ['name'],
  async observe(ctx, ext) {
    const { org, rest } = splitOrgChild(ctx, ext)
    const path = `/actions/variables/${seg(checkVarName(rest))}`
    const r = await gh<Json>(ctx, 'GET', `/orgs/${seg(org)}${path}`, { ok: [404] })
    if (r.status === 404) return null
    const repos = r.json.visibility === 'selected' ? await selectedNames(ctx, path) : []
    return observedOrgVariable(org, r.json, repos)
  },
  list: (ctx, cursor) =>
    orgPage(
      ctx,
      cursor,
      '/actions/variables',
      (j) => arr(j, 'variables'),
      (v) => observedOrgVariable(orgName(ctx), v, []),
      'list the organisation variables'
    ),
  async create(ctx, d) {
    const name = text(d.fields.name)
    const id = `${orgName(ctx)}#${name}`
    // Only the Hub's own interrupted create reaches here with the variable already there.
    const have = await orgVariable.observe(ctx, id)
    if (have) return orgVariable.update(ctx, id, d, have)
    const visibility = visibilityOf(d)
    await gh(ctx, 'POST', `${orgBase(ctx)}/actions/variables`, {
      body: {
        name,
        value: text(d.fields.value),
        visibility,
        ...(visibility === 'selected'
          ? { selected_repository_ids: await repoIds(ctx, list(d.fields.repositories)) }
          : {})
      },
      what: 'create the organisation variable'
    })
    return id
  },
  async update(ctx, ext, d) {
    const { rest } = splitOrgChild(ctx, ext)
    const visibility = visibilityOf(d)
    const path = `${orgBase(ctx)}/actions/variables/${seg(checkVarName(rest))}`
    await gh(ctx, 'PATCH', path, {
      body: {
        name: rest,
        value: text(d.fields.value),
        visibility,
        ...(visibility === 'selected'
          ? { selected_repository_ids: await repoIds(ctx, list(d.fields.repositories)) }
          : {})
      },
      what: 'update the organisation variable'
    })
    return ext
  },
  async remove(ctx, ext) {
    const { rest } = splitOrgChild(ctx, ext)
    await gh(ctx, 'DELETE', `${orgBase(ctx)}/actions/variables/${seg(checkVarName(rest))}`, {
      ok: [404],
      what: 'delete the organisation variable'
    })
  }
}

// ── Dependabot secrets (repository level) ──

function dependabotBase(repo: string): string {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/dependabot/secrets`
}

function observedDependabot(repo: string, j: Json): Observed {
  return {
    type: 'github.dependabot_secret',
    externalId: `${repo}#${j.name}`,
    name: j.name ?? null,
    fields: { repository: repo, name: j.name },
    tags: {},
    version: typeof j.updated_at === 'string' ? j.updated_at : null,
    status: 'active',
    url: null
  }
}

const dependabotSecret: Handler = {
  key: 'github.dependabot_secret',
  async existing(ctx, d) {
    const ext = `${parentRepo(d)}#${text(d.fields.name)}`
    return (await dependabotSecret.observe(ctx, ext)) ? ext : null
  },
  compare: [],
  replaceKeys: ['name'],
  secretField: 'value',
  async observe(ctx, ext) {
    const { repo, rest } = splitChild(ext)
    const r = await gh<Json>(ctx, 'GET', `${dependabotBase(repo)}/${seg(checkVarName(rest))}`, {
      ok: [404]
    })
    return r.status === 404 ? null : observedDependabot(repo, r.json)
  },
  list: (ctx, cursor) =>
    listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const res = await gh<Json>(ctx, 'GET', `${dependabotBase(repo)}?per_page=100`, {
        ok: [404]
      })
      return arr(res.json, 'secrets').map((s) => observedDependabot(repo, s))
    }),
  async create(ctx, d) {
    const repo = parentRepo(d)
    const name = text(d.fields.name)
    await putSealed(ctx, dependabotBase(repo), name, secretPlain(d, 'value'))
    return `${repo}#${name}`
  },
  async update(ctx, ext, d) {
    const { repo, rest } = splitChild(ext)
    await putSealed(ctx, dependabotBase(repo), rest, secretPlain(d, 'value'))
    return ext
  },
  async remove(ctx, ext) {
    const { repo, rest } = splitChild(ext)
    await gh(ctx, 'DELETE', `${dependabotBase(repo)}/${seg(checkVarName(rest))}`, {
      ok: [404],
      what: 'delete the Dependabot secret'
    })
  }
}

// ── Runner groups ──

function observedGroup(org: string, j: Json, repos: string[]): Observed {
  return {
    type: 'github.runner_group',
    externalId: `${org}#${j.id}`,
    name: j.name ?? null,
    fields: {
      name: j.name ?? '',
      visibility: j.visibility ?? 'all',
      repositories: repos,
      allows_public_repositories: !!j.allows_public_repositories
    },
    tags: {},
    version: null,
    status: j.default ? 'default' : 'active',
    url: null
  }
}

const groupPath = (ctx: ProviderContext, id: string): string =>
  `${orgBase(ctx)}/actions/runner-groups/${seg(checkNumericId(id))}`

async function writeGroupRepos(ctx: ProviderContext, id: string, names: string[]): Promise<void> {
  await gh(ctx, 'PUT', `${groupPath(ctx, id)}/repositories`, {
    body: { selected_repository_ids: await repoIds(ctx, names) },
    what: 'set the repositories of the runner group'
  })
}

const runnerGroup: Handler = {
  key: 'github.runner_group',
  async existing(ctx, d) {
    const rows = await allOrNone<Json>(ctx, `${orgBase(ctx)}/actions/runner-groups`, (j) =>
      arr(j, 'runner_groups')
    )
    const hit = rows.find((g) => text(g.name) === text(d.fields.name))
    return hit ? `${orgName(ctx)}#${hit.id}` : null
  },
  compare: ['name', 'visibility', 'repositories', 'allows_public_repositories'],
  replaceKeys: [],
  async observe(ctx, ext) {
    const { rest } = splitOrgChild(ctx, ext)
    const r = await gh<Json>(ctx, 'GET', groupPath(ctx, rest), { ok: [404] })
    if (r.status === 404) return null
    const repos =
      r.json.visibility === 'selected'
        ? arr(
            (
              await gh<Json>(ctx, 'GET', `${groupPath(ctx, rest)}/repositories?per_page=100`, {
                ok: [404]
              })
            ).json,
            'repositories'
          ).map((x) => text(x.name))
        : []
    return observedGroup(orgName(ctx), r.json, repos)
  },
  list: (ctx, cursor) =>
    orgPage(
      ctx,
      cursor,
      '/actions/runner-groups',
      (j) => arr(j, 'runner_groups'),
      (g) => observedGroup(orgName(ctx), g, []),
      'list the runner groups'
    ),
  async create(ctx, d) {
    const visibility = visibilityOf(d)
    const r = await gh<Json>(ctx, 'POST', `${orgBase(ctx)}/actions/runner-groups`, {
      body: {
        name: text(d.fields.name),
        visibility,
        allows_public_repositories: bool(d.fields.allows_public_repositories),
        ...(visibility === 'selected'
          ? { selected_repository_ids: await repoIds(ctx, list(d.fields.repositories)) }
          : {})
      },
      what: 'create the runner group (organisation accounts only)'
    })
    return `${orgName(ctx)}#${checkNumericId(String(r.json.id))}`
  },
  async update(ctx, ext, d) {
    const { rest } = splitOrgChild(ctx, ext)
    const visibility = visibilityOf(d)
    await gh(ctx, 'PATCH', groupPath(ctx, rest), {
      body: {
        name: text(d.fields.name),
        visibility,
        allows_public_repositories: bool(d.fields.allows_public_repositories)
      },
      what: 'update the runner group'
    })
    if (visibility === 'selected') await writeGroupRepos(ctx, rest, list(d.fields.repositories))
    return ext
  },
  async remove(ctx, ext) {
    const { rest } = splitOrgChild(ctx, ext)
    const have = await runnerGroup.observe(ctx, ext)
    if (have?.status === 'default')
      bad('NOT_SUPPORTED', 'The default runner group cannot be deleted.')
    await gh(ctx, 'DELETE', groupPath(ctx, rest), { ok: [404], what: 'delete the runner group' })
  }
}

/**
 * The runner registration token of the organisation (valid about an hour; GitHub shows it once).
 * Never put in observed, desired, steps or an error: the adapter returns it only as an output.
 */
export async function registrationToken(
  ctx: ProviderContext
): Promise<{ token: string; expiresAt: string | null }> {
  const r = await gh<Json>(ctx, 'POST', `${orgBase(ctx)}/actions/runners/registration-token`, {
    what: 'create a runner registration token (organisation accounts only)'
  })
  if (typeof r.json?.token !== 'string' || !r.json.token)
    bad('PROVIDER_ERROR', 'GitHub did not return a registration token.')
  return {
    token: r.json.token,
    expiresAt: typeof r.json.expires_at === 'string' ? r.json.expires_at : null
  }
}

// ── Pages ──

function pagesPath(repo: string): string {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/pages`
}

function observedPages(repo: string, j: Json): Observed {
  return {
    type: 'github.pages',
    externalId: `${repo}#pages`,
    name: repo,
    fields: {
      repository: repo,
      build_type: j.build_type ?? 'legacy',
      source_branch: j.source?.branch ?? '',
      source_path: j.source?.path ?? '/',
      cname: j.cname ?? '',
      https_enforced: !!j.https_enforced
    },
    tags: {},
    version: null,
    status: typeof j.status === 'string' ? j.status : 'active',
    url: typeof j.html_url === 'string' ? j.html_url : null
  }
}

function pagesBody(d: DesiredResource): Json {
  const build = text(d.fields.build_type) || 'workflow'
  const cname = text(d.fields.cname)
  return {
    build_type: build,
    ...(build === 'legacy'
      ? {
          source: { branch: text(d.fields.source_branch), path: text(d.fields.source_path) || '/' }
        }
      : {}),
    cname: cname || null,
    https_enforced: bool(d.fields.https_enforced, true)
  }
}

const pages: Handler = {
  key: 'github.pages',
  async existing(ctx, d) {
    const repo = parentRepo(d)
    return (await pages.observe(ctx, `${repo}#pages`)) ? `${repo}#pages` : null
  },
  compare: ['build_type', 'source_branch', 'source_path', 'cname', 'https_enforced'],
  replaceKeys: [],
  async observe(ctx, ext) {
    const { repo, rest } = splitChild(ext)
    if (rest !== 'pages') bad('BAD_ID', `"${ext}" is not owner/repo#pages.`)
    const r = await gh<Json>(ctx, 'GET', pagesPath(repo), { ok: [404] })
    return r.status === 404 ? null : observedPages(repo, r.json)
  },
  list: (ctx, cursor) =>
    listPerRepo(ctx, cursor, async (repo, archived) => {
      if (archived) return []
      const r = await gh<Json>(ctx, 'GET', pagesPath(repo), { ok: [404] })
      return r.status === 404 ? [] : [observedPages(repo, r.json)]
    }),
  async create(ctx, d) {
    const repo = parentRepo(d)
    const body = pagesBody(d)
    await gh(ctx, 'POST', pagesPath(repo), {
      body:
        body.build_type === 'legacy'
          ? { build_type: 'legacy', source: body.source }
          : { build_type: 'workflow' },
      what: 'turn on GitHub Pages'
    })
    // The custom domain and HTTPS enforcement are set after the site exists.
    if (body.cname || body.https_enforced === false)
      await gh(ctx, 'PUT', pagesPath(repo), { body, what: 'set up GitHub Pages' })
    return `${repo}#pages`
  },
  async update(ctx, ext, d) {
    const { repo } = splitChild(ext)
    await gh(ctx, 'PUT', pagesPath(repo), { body: pagesBody(d), what: 'update GitHub Pages' })
    return ext
  },
  async remove(ctx, ext) {
    const { repo } = splitChild(ext)
    await gh(ctx, 'DELETE', pagesPath(repo), { ok: [404], what: 'turn off GitHub Pages' })
  }
}

// ── Managed files (the contents API) ──

/** Contents-API files this size or smaller are read inline; larger ones are refused on write. */
export const MAX_FILE_BYTES = 1_000_000
const COMMITTER = { name: 'Nivaro Hub', email: 'noreply@nivaro.dev' }

/** `owner/repo@branch#path` → parts. The branch may hold slashes, never `@` or `#`. */
export function splitFileId(
  ctx: ProviderContext,
  ext: string
): { repo: string; branch: string; path: string } {
  const i = ext.indexOf('#')
  if (i <= 0 || i === ext.length - 1) bad('BAD_ID', `"${ext}" is not owner/repo@branch#path.`)
  assertInAccount(ctx, ext)
  const left = ext.slice(0, i)
  const at = left.indexOf('@')
  if (at <= 0 || at === left.length - 1) bad('BAD_ID', `"${ext}" is not owner/repo@branch#path.`)
  const repo = left.slice(0, at)
  splitRepo(repo)
  const branch = left.slice(at + 1)
  branchPath(branch)
  const path = ext.slice(i + 1)
  filePath(path)
  return { repo, branch, path }
}

const contentsPath = (repo: string, path: string): string => {
  const { owner, repo: r } = splitRepo(repo)
  return `/repos/${seg(owner)}/${seg(r)}/contents/${filePath(path)}`
}

function observedFile(repo: string, branch: string, path: string, j: Json): Observed {
  const inline = j.encoding === 'base64' && typeof j.content === 'string'
  return {
    type: 'github.repo_file',
    externalId: `${repo}@${branch}#${path}`,
    name: path,
    fields: {
      repository: repo,
      path,
      branch,
      content: inline ? Buffer.from(j.content.replace(/\s/g, ''), 'base64').toString('utf8') : null
    },
    tags: {},
    // The blob id: any commit that changes the file moves it, so a plan started before one stops.
    version: typeof j.sha === 'string' ? j.sha : null,
    status: inline ? 'active' : 'too_large',
    url: typeof j.html_url === 'string' ? j.html_url : null
  }
}

async function fileDefaultBranch(ctx: ProviderContext, repo: string): Promise<string> {
  const { owner, repo: r } = splitRepo(repo)
  const info = await gh<Json>(ctx, 'GET', `/repos/${seg(owner)}/${seg(r)}`)
  return text(info.json?.default_branch) || 'main'
}

async function desiredFileId(ctx: ProviderContext, d: DesiredResource): Promise<string> {
  const repo = parentRepo(d)
  const path = text(d.fields.path)
  filePath(path)
  const branch = text(d.fields.branch) || (await fileDefaultBranch(ctx, repo))
  if (/[@#]/.test(branch)) bad('BAD_ID', 'A branch name with @ or # cannot be managed.')
  branchPath(branch)
  return `${repo}@${branch}#${path}`
}

async function readFile(ctx: ProviderContext, ext: string): Promise<Observed | null> {
  const { repo, branch, path } = splitFileId(ctx, ext)
  const r = await gh<Json>(
    ctx,
    'GET',
    `${contentsPath(repo, path)}?ref=${encodeURIComponent(branch)}`,
    { ok: [404] }
  )
  // A directory answers a list; only a plain file is a managed file.
  if (r.status === 404 || Array.isArray(r.json) || r.json?.type !== 'file') return null
  return observedFile(repo, branch, path, r.json)
}

async function commitFile(
  ctx: ProviderContext,
  ext: string,
  d: DesiredResource,
  sha: string | null
): Promise<void> {
  const { repo, branch, path } = splitFileId(ctx, ext)
  const content = text(d.fields.content)
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length > MAX_FILE_BYTES) bad('VALIDATION', 'A managed file can be at most 1 MB.')
  const message = text(d.fields.message).trim() || `Update ${path} (Nivaro Hub)`
  await gh(ctx, 'PUT', contentsPath(repo, path), {
    body: {
      message,
      content: bytes.toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
      committer: COMMITTER,
      author: COMMITTER
    },
    what: 'commit the file'
  })
}

const repoFile: Handler = {
  key: 'github.repo_file',
  async existing(ctx, d) {
    const ext = await desiredFileId(ctx, d)
    return (await readFile(ctx, ext)) ? ext : null
  },
  compare: ['content'],
  replaceKeys: ['path', 'branch'],
  observe: (ctx, ext) => readFile(ctx, ext),
  // A repository holds any number of files: they are managed by path, adopted by id, not listed.
  async list() {
    return { items: [], cursor: null }
  },
  async create(ctx, d) {
    const ext = await desiredFileId(ctx, d)
    // A resumed create finds its own commit already there: continue as an update.
    const have = await readFile(ctx, ext)
    await commitFile(ctx, ext, d, have?.version ?? null)
    return ext
  },
  async update(ctx, ext, d, observed) {
    // The blob id is read again right before the write; a file changed since is not overwritten.
    const now = (await readFile(ctx, ext)) ?? observed
    await commitFile(ctx, ext, d, now.version ?? null)
    return ext
  },
  async remove(ctx, ext) {
    const { repo, branch, path } = splitFileId(ctx, ext)
    const have = await readFile(ctx, ext)
    if (!have?.version) return
    await gh(ctx, 'DELETE', contentsPath(repo, path), {
      body: {
        message: `Remove ${path} (Nivaro Hub)`,
        sha: have.version,
        branch,
        committer: COMMITTER,
        author: COMMITTER
      },
      ok: [404],
      what: 'remove the file'
    })
  }
}

export const EXTRA_HANDLERS: Record<string, Handler> = {
  'github.team': team,
  'github.team_repo_access': teamRepoAccess,
  'github.ruleset': ruleset,
  'github.environment_secret': environmentSecret,
  'github.environment_variable': environmentVariable,
  'github.environment_protection': environmentProtection,
  'github.org_secret': orgSecret,
  'github.org_variable': orgVariable,
  'github.dependabot_secret': dependabotSecret,
  'github.runner_group': runnerGroup,
  'github.pages': pages,
  'github.repo_file': repoFile
}
