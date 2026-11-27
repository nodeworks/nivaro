import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sodium from 'libsodium-wrappers'
import { describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { githubAdapter } from '../../../services/hub/providers/github/index.js'
import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  type ProviderContext,
  ROTATE_OUTPUTS_FIELD
} from '../../../services/hub/providers/types.js'

// Nivaro Hub providers, Task 19: the GitHub adapter's full-coverage types (teams, rulesets,
// environment secrets and protection, organisation secrets, runner groups, Pages, managed files),
// driven through makeProviderContext with a fake fetch that answers from recorded-shape fixtures.

const FIX = join(import.meta.dirname, '../../../services/hub/providers/github/__fixtures__')
const full = JSON.parse(readFileSync(join(FIX, 'full.json'), 'utf8')) as Record<string, any>
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))
const NOW = new Date('2026-11-26T12:00:00Z')
const REG_TOKEN = 'test-secret-runner-token-0001'

interface Call {
  method: string
  path: string
  body: any
}
interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function fake(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  const calls: Call[] = []
  const impl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init.method ?? 'GET'),
      path: u.pathname,
      body: init.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    const hit = routes[`${call.method} ${call.path}`]
    const reply: Reply = (typeof hit === 'function' ? hit(call) : hit) ?? {
      status: 404,
      body: { message: 'Not Found' }
    }
    const status = reply.status ?? 200
    const body = reply.body === undefined ? '' : JSON.stringify(reply.body)
    return new Response(status === 204 || status === 304 ? null : body, {
      status,
      headers: reply.headers ?? {}
    })
  }
  return { calls, impl }
}

function ctxFor(impl: (url: string, init: any) => Promise<Response>): ProviderContext {
  return makeProviderContext({
    adapter: githubAdapter,
    connectionId: Math.floor(Math.random() * 1e6),
    config: { auth_method: 'pat', owner: 'acme' },
    secrets: { token: 'test-secret-pat-0000' },
    now: () => NOW,
    fetch: { fetchImpl: impl as any }
  })
}

function desired(
  type: string,
  fields: Record<string, unknown>,
  over: Partial<DesiredResource> = {}
): DesiredResource {
  return {
    resourceId: 1,
    type,
    externalId: null,
    scope: 'app',
    appId: 1,
    environmentId: null,
    fields,
    refs: { repository: 'acme/web' },
    tags: {},
    ...over
  }
}

const secretOf = (plain: string) => ({ fingerprint: 'f', changed: true, plain })

async function keypair() {
  await sodium.ready
  const kp = sodium.crypto_box_keypair()
  return { kp, b64: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL) }
}
function open(encrypted: string, kp: { publicKey: Uint8Array; privateKey: Uint8Array }): string {
  return sodium.to_string(
    sodium.crypto_box_seal_open(
      sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL),
      kp.publicKey,
      kp.privateKey
    )
  )
}

const planOne = (d: DesiredResource | null, o: Observed | null, i = 0): PlannedOp =>
  githubAdapter.plan(null as any, d, o)[i]

describe('github full: registration, scopes, outputs', () => {
  it('adds the twelve types; teams, org secrets/variables and runner groups are shared', () => {
    const keys = githubAdapter.types.map((t) => t.key)
    for (const k of [
      'github.team',
      'github.team_repo_access',
      'github.ruleset',
      'github.environment_secret',
      'github.environment_variable',
      'github.environment_protection',
      'github.org_secret',
      'github.org_variable',
      'github.dependabot_secret',
      'github.runner_group',
      'github.pages',
      'github.repo_file'
    ])
      expect(keys).toContain(k)
    const scope = (k: string) => githubAdapter.types.find((t) => t.key === k)?.scope
    expect(scope('github.team')).toBe('shared')
    expect(scope('github.org_secret')).toBe('shared')
    expect(scope('github.org_variable')).toBe('shared')
    expect(scope('github.runner_group')).toBe('shared')
    expect(scope('github.ruleset')).toBe('app')
  })

  it('declares outputs: the runner token is secret and once-only, with the rotate trigger', () => {
    const t = githubAdapter.types.find((x) => x.key === 'github.runner_group')!
    expect(t.outputs).toEqual([
      {
        key: 'registration_token',
        label: 'Runner registration token',
        secret: true,
        onceOnly: true
      }
    ])
    const rotate = t.fields.find((f) => f.key === ROTATE_OUTPUTS_FIELD)
    expect(rotate).toMatchObject({ kind: 'boolean', trigger: true })
    for (const other of githubAdapter.types.filter((x) => x.key !== 'github.runner_group'))
      expect(other.outputs).toBeUndefined()
  })

  it('declares outputs and none leak into observed/desired/plan/answer', async () => {
    const f = fake({
      'GET /orgs/acme/actions/runner-groups/7': { body: full.runner_group },
      'GET /orgs/acme/actions/runner-groups/7/repositories': { body: full.runner_group_repos },
      'POST /orgs/acme/actions/runners/registration-token': {
        status: 201,
        body: full.registration_token
      }
    })
    const ctx = ctxFor(f.impl)
    const d = desired(
      'github.runner_group',
      {
        name: 'builders',
        visibility: 'selected',
        repositories: ['web'],
        allows_public_repositories: false,
        register_runner: true
      },
      { externalId: 'acme#7', refs: {} }
    )
    const obs = (await githubAdapter.observe(ctx, 'github.runner_group', 'acme#7'))!
    const ops = githubAdapter.plan(null as any, d, obs)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ kind: 'update', action: 'register_runner' })
    const r = await githubAdapter.apply(ctx, ops[0], d)
    expect(r.outputs).toEqual({ registration_token: REG_TOKEN })
    expect(JSON.stringify({ obs, d, ops, observed: r.observed, answer: r.answer })).not.toContain(
      REG_TOKEN
    )
    // The rotate trigger plans the same op.
    const rotate = planOne(
      { ...d, fields: { ...d.fields, register_runner: false, [ROTATE_OUTPUTS_FIELD]: true } },
      obs
    )
    expect(rotate).toMatchObject({ action: 'register_runner' })
    // A group with no trigger plans nothing.
    expect(planOne({ ...d, fields: { ...d.fields, register_runner: false } }, obs).kind).toBe(
      'noop'
    )
  })

  it('register_runner for another group than the resource points at is TARGET_MISMATCH, no call', async () => {
    const f = fake({})
    const d = desired(
      'github.runner_group',
      { name: 'builders', register_runner: true },
      { externalId: 'acme#7', refs: {} }
    )
    const op: PlannedOp = {
      kind: 'update',
      type: 'github.runner_group',
      resourceId: 1,
      externalId: 'acme#8',
      action: 'register_runner',
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    await expect(githubAdapter.apply(ctxFor(f.impl), op, d)).rejects.toMatchObject({
      code: 'TARGET_MISMATCH'
    })
    expect(f.calls).toHaveLength(0)
  })
})

describe('github full: observe maps provider fields', () => {
  it('team, team access, rulesets (repository and organisation)', async () => {
    const f = fake({
      'GET /orgs/acme/teams/platform': { body: full.team },
      'GET /repos/acme/web/teams': { body: full.repo_teams },
      'GET /repos/acme/web/rulesets/9001': { body: full.ruleset },
      'GET /orgs/acme/rulesets/9100': { body: full.org_ruleset }
    })
    const ctx = ctxFor(f.impl)
    expect((await githubAdapter.observe(ctx, 'github.team', 'acme#platform'))?.fields).toEqual({
      name: 'Platform',
      slug: 'platform',
      description: 'Platform engineers',
      privacy: 'closed',
      parent: ''
    })
    const access = await githubAdapter.observe(ctx, 'github.team_repo_access', 'acme/web#platform')
    expect(access?.fields).toEqual({
      repository: 'acme/web',
      team: 'acme#platform',
      permission: 'push'
    })
    const rs = await githubAdapter.observe(ctx, 'github.ruleset', 'acme/web#9001')
    expect(rs?.fields).toMatchObject({
      repository: 'acme/web',
      name: 'protect-main',
      include: ['~DEFAULT_BRANCH'],
      required_reviews: 2,
      dismiss_stale_reviews: true,
      require_conversation_resolution: true,
      block_deletions: true,
      block_force_pushes: true,
      require_linear_history: false
    })
    const org = await githubAdapter.observe(ctx, 'github.ruleset', 'acme#9100')
    expect(org?.fields).toMatchObject({
      repository: '',
      enforcement: 'evaluate',
      repositories: ['~ALL'],
      require_linear_history: true
    })
  })

  it('environment secret never carries a value; variable does; protection lists reviewers and patterns', async () => {
    const f = fake({
      'GET /repos/acme/web/environments/production/secrets/DEPLOY_TOKEN': { body: fx('secret') },
      'GET /repos/acme/web/environments/production/variables/REGION': { body: fx('variable') },
      'GET /repos/acme/web/environments/production': { body: full.env_protected },
      'GET /repos/acme/web/environments/production/deployment-branch-policies': {
        body: full.branch_policies
      }
    })
    const ctx = ctxFor(f.impl)
    const secret = await githubAdapter.observe(
      ctx,
      'github.environment_secret',
      'acme/web@production#DEPLOY_TOKEN'
    )
    expect(secret?.fields).toEqual({ environment: 'acme/web#production', name: 'DEPLOY_TOKEN' })
    const variable = await githubAdapter.observe(
      ctx,
      'github.environment_variable',
      'acme/web@production#REGION'
    )
    expect(variable?.fields.value).toBe('us-east-1')
    const prot = await githubAdapter.observe(
      ctx,
      'github.environment_protection',
      'acme/web#production'
    )
    expect(prot?.fields).toEqual({
      environment: 'acme/web#production',
      reviewers: ['user:octo-reviewer', 'team:platform'],
      wait_timer: 30,
      prevent_self_review: true,
      deployment_branches: 'selected',
      branch_patterns: ['release/*', 'main']
    })
  })

  it('org secret/variable read their repositories when selected; dependabot, runner group, pages, file', async () => {
    const f = fake({
      'GET /orgs/acme/actions/secrets/NPM_TOKEN': { body: full.org_secret },
      'GET /orgs/acme/actions/secrets/NPM_TOKEN/repositories': { body: full.org_secret_repos },
      'GET /orgs/acme/actions/variables/REGION': { body: full.org_variable },
      'GET /repos/acme/web/dependabot/secrets/NPM_AUTH': { body: full.dependabot_secret },
      'GET /orgs/acme/actions/runner-groups/7': { body: full.runner_group },
      'GET /orgs/acme/actions/runner-groups/7/repositories': { body: full.runner_group_repos },
      'GET /repos/acme/web/pages': { body: full.pages },
      'GET /repos/acme/web/contents/CODEOWNERS': { body: full.file }
    })
    const ctx = ctxFor(f.impl)
    const secret = await githubAdapter.observe(ctx, 'github.org_secret', 'acme#NPM_TOKEN')
    expect(secret?.fields).toEqual({
      name: 'NPM_TOKEN',
      visibility: 'selected',
      repositories: ['web']
    })
    const v = await githubAdapter.observe(ctx, 'github.org_variable', 'acme#REGION')
    expect(v?.fields).toEqual({
      name: 'REGION',
      value: 'us-east-1',
      visibility: 'all',
      repositories: []
    })
    expect(
      (await githubAdapter.observe(ctx, 'github.dependabot_secret', 'acme/web#NPM_AUTH'))?.fields
    ).toEqual({ repository: 'acme/web', name: 'NPM_AUTH' })
    expect(
      (await githubAdapter.observe(ctx, 'github.runner_group', 'acme#7'))?.fields
    ).toMatchObject({ name: 'builders', visibility: 'selected', repositories: ['web'] })
    expect((await githubAdapter.observe(ctx, 'github.pages', 'acme/web#pages'))?.fields).toEqual({
      repository: 'acme/web',
      build_type: 'legacy',
      source_branch: 'main',
      source_path: '/docs',
      cname: 'docs.example.com',
      https_enforced: true
    })
    const file = await githubAdapter.observe(ctx, 'github.repo_file', 'acme/web@main#CODEOWNERS')
    expect(file?.fields).toEqual({
      repository: 'acme/web',
      path: 'CODEOWNERS',
      branch: 'main',
      content: '* @acme/platform\n'
    })
    expect(file?.version).toBe('3d21ec53a331a6f037a91c368710b99387d012c1')
  })

  it('a missing resource, a directory in place of a file, and an unprotected environment are as GitHub says', async () => {
    const f = fake({
      'GET /repos/acme/web/contents/docs': { body: full.directory },
      'GET /repos/acme/web/environments/staging': { body: full.env_unprotected }
    })
    const ctx = ctxFor(f.impl)
    expect(await githubAdapter.observe(ctx, 'github.team', 'acme#nope')).toBeNull()
    expect(await githubAdapter.observe(ctx, 'github.ruleset', 'acme/web#1')).toBeNull()
    expect(await githubAdapter.observe(ctx, 'github.pages', 'acme/web#pages')).toBeNull()
    expect(await githubAdapter.observe(ctx, 'github.repo_file', 'acme/web@main#docs')).toBeNull()
    expect(
      (await githubAdapter.observe(ctx, 'github.environment_protection', 'acme/web#staging'))
        ?.fields
    ).toMatchObject({ reviewers: [], wait_timer: 0, deployment_branches: 'all' })
  })

  it('list walks organisation rulesets first, then repositories; files are not listed', async () => {
    const f = fake({
      'GET /orgs/acme/rulesets': { body: [{ id: 9100 }] },
      'GET /orgs/acme/rulesets/9100': { body: full.org_ruleset },
      'GET /orgs/acme/teams': { body: full.team_list },
      'GET /orgs/acme/actions/runner-groups': { body: full.runner_group_list }
    })
    const ctx = ctxFor(f.impl)
    const first = await githubAdapter.list(ctx, 'github.ruleset', null)
    expect(first.items.map((i) => i.externalId)).toEqual(['acme#9100'])
    expect(first.cursor).toBe('r:1')
    expect(
      (await githubAdapter.list(ctx, 'github.team', null)).items.map((i) => i.externalId)
    ).toEqual(['acme#platform', 'acme#docs'])
    expect(
      (await githubAdapter.list(ctx, 'github.runner_group', null)).items.map((i) => i.externalId)
    ).toEqual(['acme#1', 'acme#7'])
    expect(await githubAdapter.list(ctx, 'github.repo_file', null)).toEqual({
      items: [],
      cursor: null
    })
  })
})

describe('github full: plan diff per type', () => {
  it('ruleset: only a changed field is an update; an organisation ruleset has no repository', () => {
    const obs = {
      type: 'github.ruleset',
      externalId: 'acme/web#9001',
      name: 'protect-main',
      fields: {
        name: 'protect-main',
        target: 'branch',
        enforcement: 'active',
        include: ['~DEFAULT_BRANCH'],
        exclude: [],
        required_reviews: 2,
        block_deletions: true
      },
      tags: {},
      version: null,
      status: 'active'
    } as Observed
    const same = desired('github.ruleset', { name: 'protect-main', required_reviews: 2 })
    expect(planOne(same, obs).kind).toBe('noop')
    const less = desired('github.ruleset', { name: 'protect-main', required_reviews: 1 })
    const op = planOne(less, obs)
    expect(op).toMatchObject({ kind: 'update' })
    expect(op.changes).toEqual([{ field: 'required_reviews', from: 2, to: 1 }])
    const create = planOne(desired('github.ruleset', { name: 'org-baseline' }, { refs: {} }), null)
    expect(create).toMatchObject({ kind: 'create' })
  })

  it('secrets: org and environment secrets update only with a new value; removal never shows a value', () => {
    const obs = {
      type: 'github.org_secret',
      externalId: 'acme#NPM_TOKEN',
      name: 'NPM_TOKEN',
      fields: { name: 'NPM_TOKEN', visibility: 'private', repositories: [] },
      tags: {},
      version: null,
      status: 'active'
    } as Observed
    const none = desired('github.org_secret', {
      name: 'NPM_TOKEN',
      visibility: 'private',
      value: { fingerprint: 'f', changed: false }
    })
    expect(planOne(none, obs).kind).toBe('noop')
    const changed = desired('github.org_secret', {
      name: 'NPM_TOKEN',
      visibility: 'private',
      value: { fingerprint: 'f2', changed: true }
    })
    const op = planOne(changed, obs)
    expect(op.kind).toBe('update')
    expect(op.changes).toEqual([{ field: 'value', secret: true }])
    expect(planOne(null, obs)).toMatchObject({ kind: 'delete' })
  })

  it('repo file: content drift is an update; a workflow or CODEOWNERS path says who may apply it', () => {
    const obs = {
      type: 'github.repo_file',
      externalId: 'acme/web@main#CODEOWNERS',
      name: 'CODEOWNERS',
      fields: { repository: 'acme/web', path: 'CODEOWNERS', branch: 'main', content: 'old\n' },
      tags: {},
      version: 'sha1',
      status: 'active'
    } as Observed
    const d = desired('github.repo_file', { path: 'CODEOWNERS', branch: 'main', content: 'new\n' })
    const op = planOne(d, obs)
    expect(op.kind).toBe('update')
    expect(op.reason).toMatch(/administrator/)
    expect(op.preconditions).toMatchObject({ content: 'old\n', version: 'sha1' })
    const plain = desired('github.repo_file', { path: 'docs/a.md', branch: 'main', content: 'x' })
    expect(planOne(plain, null).reason).not.toMatch(/administrator/)
  })

  it('runner group: no create-time trigger value is stored', () => {
    const op = planOne(
      desired(
        'github.runner_group',
        { name: 'builders', register_runner: true, [ROTATE_OUTPUTS_FIELD]: true },
        { refs: {} }
      ),
      null
    )
    expect(op.kind).toBe('create')
    expect(op.changes.map((c) => c.field)).toEqual(['name'])
  })
})

describe('github full: apply is idempotent (read-before-write)', () => {
  it('team: create with a parent, rename moves the slug, access is granted by PUT', async () => {
    let made = false
    const f = fake({
      'GET /orgs/acme/teams/eng': { body: { id: 55, slug: 'eng' } },
      'GET /orgs/acme/teams/platform': () => (made ? { body: full.team } : { status: 404 }),
      'POST /orgs/acme/teams': () => {
        made = true
        return { status: 201, body: full.team }
      },
      'PATCH /orgs/acme/teams/platform': { body: { ...full.team, slug: 'platform-eng' } },
      'PUT /orgs/acme/teams/platform/repos/acme/web': { status: 204 },
      'GET /repos/acme/web/teams': { body: full.repo_teams },
      'PUT /orgs/acme/teams/newcomers/repos/acme/web': { status: 204 }
    })
    const ctx = ctxFor(f.impl)
    const d = desired(
      'github.team',
      { name: 'Platform', parent: 'eng' },
      { scope: 'shared', refs: {} }
    )
    const r = await githubAdapter.apply(ctx, planOne(d, null), d)
    expect(r.externalId).toBe('acme#platform')
    expect(f.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      name: 'Platform',
      privacy: 'closed',
      parent_team_id: 55
    })

    const obs = (await githubAdapter.observe(ctx, 'github.team', 'acme#platform'))!
    const renamed = { ...d, externalId: 'acme#platform', fields: { name: 'Platform Eng' } }
    const upd = await githubAdapter.apply(ctx, planOne(renamed, obs), renamed)
    expect(upd.externalId).toBe('acme#platform-eng')

    const access = desired(
      'github.team_repo_access',
      { permission: 'push' },
      { refs: { repository: 'acme/web', team: 'acme#newcomers' } }
    )
    const done = await githubAdapter.apply(ctx, planOne(access, null), access)
    expect(done.externalId).toBe('acme/web#newcomers')
    expect(f.calls.find((c) => c.method === 'PUT')?.body).toEqual({ permission: 'push' })
  })

  it('ruleset update keeps the rules and bypass list the Hub does not model', async () => {
    const f = fake({
      'GET /repos/acme/web/rulesets/9001': { body: full.ruleset },
      'PUT /repos/acme/web/rulesets/9001': { body: full.ruleset }
    })
    const ctx = ctxFor(f.impl)
    const obs = (await githubAdapter.observe(ctx, 'github.ruleset', 'acme/web#9001'))!
    const d = desired(
      'github.ruleset',
      {
        repository: { resourceId: 1 },
        name: 'protect-main',
        required_reviews: 1,
        block_deletions: true,
        block_force_pushes: true,
        require_conversation_resolution: true,
        dismiss_stale_reviews: true
      },
      { externalId: 'acme/web#9001' }
    )
    await githubAdapter.apply(ctx, planOne(d, obs), d)
    const put = f.calls.find((c) => c.method === 'PUT')!
    expect(put.body.bypass_actors).toEqual(full.ruleset.bypass_actors)
    const types = put.body.rules.map((r: any) => r.type)
    expect(types).toEqual(['deletion', 'non_fast_forward', 'pull_request', 'update'])
    expect(put.body.rules.find((r: any) => r.type === 'pull_request').parameters).toMatchObject({
      required_approving_review_count: 1,
      required_review_thread_resolution: true
    })
    // Same values again write nothing.
    const again = desired(
      'github.ruleset',
      { ...d.fields, required_reviews: 2 },
      { externalId: 'acme/web#9001' }
    )
    expect(planOne(again, obs).kind).toBe('noop')
  })

  it('organisation ruleset create posts to the organisation with all repositories by default', async () => {
    let made = false
    const f = fake({
      'GET /orgs/acme/rulesets': () => ({ body: made ? [{ id: 9100, name: 'org-baseline' }] : [] }),
      'POST /orgs/acme/rulesets': () => {
        made = true
        return { status: 201, body: full.org_ruleset }
      },
      'GET /orgs/acme/rulesets/9100': { body: full.org_ruleset }
    })
    const d = desired(
      'github.ruleset',
      { name: 'org-baseline', enforcement: 'evaluate', require_linear_history: true },
      { refs: {}, scope: 'shared' }
    )
    const r = await githubAdapter.apply(ctxFor(f.impl), planOne(d, null), d)
    expect(r.externalId).toBe('acme#9100')
    const post = f.calls.find((c) => c.method === 'POST')!
    expect(post.body.conditions.repository_name).toEqual({ include: ['~ALL'], exclude: [] })
    expect(post.body.rules).toEqual([{ type: 'required_linear_history' }])
    expect(post.body.bypass_actors).toEqual([])
  })

  it('environment secret and Dependabot secret are sealed boxes; the plain value is never sent', async () => {
    const { kp, b64 } = await keypair()
    let envMade = false
    let depMade = false
    const f = fake({
      'GET /repos/acme/web/environments/production/secrets/API_KEY': () =>
        envMade
          ? { body: { name: 'API_KEY', updated_at: '2026-11-26T00:00:00Z' } }
          : { status: 404 },
      'GET /repos/acme/web/environments/production/secrets/public-key': {
        body: { key_id: 'k1', key: b64 }
      },
      'PUT /repos/acme/web/environments/production/secrets/API_KEY': () => {
        envMade = true
        return { status: 201 }
      },
      'GET /repos/acme/web/dependabot/secrets/NPM_AUTH': () =>
        depMade ? { body: full.dependabot_secret } : { status: 404 },
      'GET /repos/acme/web/dependabot/secrets/public-key': { body: { key_id: 'k2', key: b64 } },
      'PUT /repos/acme/web/dependabot/secrets/NPM_AUTH': () => {
        depMade = true
        return { status: 201 }
      }
    })
    const ctx = ctxFor(f.impl)
    const env = desired(
      'github.environment_secret',
      { name: 'API_KEY', value: secretOf('test-secret-value-env') },
      { refs: { environment: 'acme/web#production' } }
    )
    const r1 = await githubAdapter.apply(ctx, planOne(env, null), env)
    expect(r1.externalId).toBe('acme/web@production#API_KEY')
    const dep = desired('github.dependabot_secret', {
      name: 'NPM_AUTH',
      value: secretOf('test-secret-value-dep')
    })
    const r2 = await githubAdapter.apply(ctx, planOne(dep, null), dep)
    expect(r2.externalId).toBe('acme/web#NPM_AUTH')
    const puts = f.calls.filter((c) => c.method === 'PUT')
    expect(open(puts[0].body.encrypted_value, kp)).toBe('test-secret-value-env')
    expect(open(puts[1].body.encrypted_value, kp)).toBe('test-secret-value-dep')
    expect(JSON.stringify(puts)).not.toContain('test-secret-value')
  })

  it('environment variable create posts once; a resumed create updates instead of posting twice', async () => {
    const f = fake({
      'GET /repos/acme/web/environments/production/variables/REGION': { body: fx('variable') },
      'PATCH /repos/acme/web/environments/production/variables/REGION': { status: 204 }
    })
    const d = desired(
      'github.environment_variable',
      { name: 'REGION', value: 'eu-west-1' },
      { refs: { environment: 'acme/web#production' }, externalId: 'acme/web@production#REGION' }
    )
    await githubAdapter.apply(ctxFor(f.impl), planOne(d, null), d)
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false)
    expect(f.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      name: 'REGION',
      value: 'eu-west-1'
    })
  })

  it('environment protection resolves reviewers to ids and syncs the branch patterns', async () => {
    let wrote = false
    const f = fake({
      'GET /users/octo-reviewer': { body: full.user_octo },
      'GET /orgs/acme/teams/platform': { body: full.team },
      'GET /repos/acme/web/environments/production': () => ({
        body: wrote ? full.env_protected : { ...full.env_unprotected, name: 'production' }
      }),
      'PUT /repos/acme/web/environments/production': () => {
        wrote = true
        return { body: full.env_protected }
      },
      'GET /repos/acme/web/environments/production/deployment-branch-policies': {
        body: full.branch_policies
      },
      'DELETE /repos/acme/web/environments/production/deployment-branch-policies/11': {
        status: 204
      },
      'POST /repos/acme/web/environments/production/deployment-branch-policies': {
        status: 201,
        body: { id: 13, name: 'hotfix/*' }
      }
    })
    const ctx = ctxFor(f.impl)
    const d = desired(
      'github.environment_protection',
      {
        reviewers: ['user:octo-reviewer', 'team:platform'],
        wait_timer: 30,
        prevent_self_review: true,
        deployment_branches: 'selected',
        branch_patterns: ['main', 'hotfix/*']
      },
      { refs: { environment: 'acme/web#production' }, externalId: 'acme/web#production' }
    )
    const obs = (await githubAdapter.observe(
      ctx,
      'github.environment_protection',
      'acme/web#production'
    ))!
    const op = planOne(
      { ...d, fields: { ...d.fields } },
      { ...obs, fields: { ...obs.fields, reviewers: [], wait_timer: 0 } }
    )
    await githubAdapter.apply(ctx, op, d)
    const put = f.calls.find((c) => c.method === 'PUT')!
    expect(put.body).toEqual({
      wait_timer: 30,
      prevent_self_review: true,
      reviewers: [
        { type: 'User', id: 701 },
        { type: 'Team', id: 4001 }
      ],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
    })
    expect(f.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/11'))).toBe(true)
    expect(f.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'hotfix/*',
      type: 'branch'
    })
  })

  it('a plain environment update keeps the reviewers github.environment_protection owns', async () => {
    const f = fake({
      'GET /repos/acme/web/environments/production': { body: full.env_protected },
      'PUT /repos/acme/web/environments/production': { body: full.env_protected }
    })
    const d = desired(
      'github.environment',
      { name: 'production', wait_timer: 60 },
      { externalId: 'acme/web#production' }
    )
    const obs = {
      type: 'github.environment',
      externalId: 'acme/web#production',
      name: 'production',
      fields: { wait_timer: 30, prevent_self_review: false, deployment_branches: 'all' },
      tags: {},
      version: null,
      status: 'active'
    } as Observed
    await githubAdapter.apply(ctxFor(f.impl), planOne(d, obs), d)
    const put = f.calls.find((c) => c.method === 'PUT')!
    expect(put.body.reviewers).toEqual([
      { type: 'User', id: 701 },
      { type: 'Team', id: 4001 }
    ])
  })

  it('org secret: selected repositories become ids; visibility change without the value is refused', async () => {
    const { kp, b64 } = await keypair()
    let made = false
    const f = fake({
      'GET /orgs/acme/actions/secrets/NPM_TOKEN': () =>
        made ? { body: full.org_secret } : { status: 404 },
      'GET /orgs/acme/actions/secrets/NPM_TOKEN/repositories': { body: full.org_secret_repos },
      'GET /orgs/acme/actions/secrets/public-key': { body: { key_id: 'k9', key: b64 } },
      'GET /repos/acme/web': { body: fx('repo') },
      'PUT /orgs/acme/actions/secrets/NPM_TOKEN': () => {
        made = true
        return { status: 201 }
      },
      'PUT /orgs/acme/actions/secrets/NPM_TOKEN/repositories': { status: 204 }
    })
    const ctx = ctxFor(f.impl)
    const d = desired(
      'github.org_secret',
      {
        name: 'NPM_TOKEN',
        visibility: 'selected',
        repositories: ['web'],
        value: secretOf('test-secret-npm-1')
      },
      { scope: 'shared', refs: {} }
    )
    await githubAdapter.apply(ctx, planOne(d, null), d)
    const put = f.calls.find((c) => c.method === 'PUT')!
    expect(put.body).toMatchObject({
      visibility: 'selected',
      selected_repository_ids: [1296269],
      key_id: 'k9'
    })
    expect(open(put.body.encrypted_value, kp)).toBe('test-secret-npm-1')

    // Only the list changed and the value is not at hand: the list endpoint, no value needed.
    const obs = (await githubAdapter.observe(ctx, 'github.org_secret', 'acme#NPM_TOKEN'))!
    const list = desired(
      'github.org_secret',
      {
        name: 'NPM_TOKEN',
        visibility: 'selected',
        repositories: ['web', 'api'],
        value: { fingerprint: 'f', changed: false }
      },
      { scope: 'shared', refs: {}, externalId: 'acme#NPM_TOKEN' }
    )
    f.calls.length = 0
    const ok = fake({
      'GET /orgs/acme/actions/secrets/NPM_TOKEN': { body: full.org_secret },
      'GET /orgs/acme/actions/secrets/NPM_TOKEN/repositories': { body: full.org_secret_repos },
      'GET /repos/acme/web': { body: fx('repo') },
      'GET /repos/acme/api': { body: { id: 2222 } },
      'PUT /orgs/acme/actions/secrets/NPM_TOKEN/repositories': { status: 204 }
    })
    await githubAdapter.apply(ctxFor(ok.impl), planOne(list, obs), list)
    expect(ok.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      selected_repository_ids: [1296269, 2222]
    })

    const wider = desired(
      'github.org_secret',
      { name: 'NPM_TOKEN', visibility: 'all', value: { fingerprint: 'f', changed: false } },
      { scope: 'shared', refs: {}, externalId: 'acme#NPM_TOKEN' }
    )
    const refused = fake({
      'GET /orgs/acme/actions/secrets/NPM_TOKEN': { body: full.org_secret },
      'GET /orgs/acme/actions/secrets/NPM_TOKEN/repositories': { body: full.org_secret_repos }
    })
    await expect(
      githubAdapter.apply(ctxFor(refused.impl), planOne(wider, obs), wider)
    ).rejects.toMatchObject({ code: 'SECRET_VALUE_MISSING' })
    expect(refused.calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('org variable and runner group create with selected repository ids', async () => {
    let varMade = false
    let groupMade = false
    const f = fake({
      'GET /repos/acme/web': { body: fx('repo') },
      'GET /orgs/acme/actions/variables/REGION': () =>
        varMade ? { body: full.org_variable } : { status: 404 },
      'POST /orgs/acme/actions/variables': () => {
        varMade = true
        return { status: 201 }
      },
      'GET /orgs/acme/actions/runner-groups': () => ({
        body: groupMade ? full.runner_group_list : { total_count: 0, runner_groups: [] }
      }),
      'POST /orgs/acme/actions/runner-groups': () => {
        groupMade = true
        return { status: 201, body: full.runner_group }
      },
      'GET /orgs/acme/actions/runner-groups/7': { body: full.runner_group },
      'GET /orgs/acme/actions/runner-groups/7/repositories': { body: full.runner_group_repos }
    })
    const ctx = ctxFor(f.impl)
    const v = desired(
      'github.org_variable',
      { name: 'REGION', value: 'us-east-1', visibility: 'selected', repositories: ['web'] },
      { scope: 'shared', refs: {} }
    )
    await githubAdapter.apply(ctx, planOne(v, null), v)
    expect(f.calls.find((c) => c.path.endsWith('/variables') && c.method === 'POST')?.body).toEqual(
      {
        name: 'REGION',
        value: 'us-east-1',
        visibility: 'selected',
        selected_repository_ids: [1296269]
      }
    )
    const g = desired(
      'github.runner_group',
      { name: 'builders', visibility: 'selected', repositories: ['web'] },
      { scope: 'shared', refs: {} }
    )
    const r = await githubAdapter.apply(ctx, planOne(g, null), g)
    expect(r.externalId).toBe('acme#7')
    expect(
      f.calls.find((c) => c.path.endsWith('/runner-groups') && c.method === 'POST')?.body
    ).toMatchObject({
      name: 'builders',
      visibility: 'selected',
      selected_repository_ids: [1296269],
      allows_public_repositories: false
    })
  })

  it('the default runner group cannot be deleted', async () => {
    const f = fake({
      'GET /orgs/acme/actions/runner-groups/1': {
        body: { id: 1, name: 'Default', visibility: 'all', default: true }
      }
    })
    const obs = observedStub('github.runner_group', 'acme#1')
    await expect(
      githubAdapter.apply(ctxFor(f.impl), planOne(null, obs), null)
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('pages: create turns it on, then sets the domain; update PUTs; remove tolerates a missing site', async () => {
    let on = false
    const f = fake({
      'GET /repos/acme/web/pages': () => (on ? { body: full.pages } : { status: 404 }),
      'POST /repos/acme/web/pages': () => {
        on = true
        return { status: 201, body: full.pages }
      },
      'PUT /repos/acme/web/pages': { status: 204 },
      'DELETE /repos/acme/web/pages': { status: 404, body: {} }
    })
    const ctx = ctxFor(f.impl)
    const d = desired('github.pages', {
      build_type: 'legacy',
      source_branch: 'main',
      source_path: '/docs',
      cname: 'docs.example.com',
      https_enforced: true
    })
    const r = await githubAdapter.apply(ctx, planOne(d, null), d)
    expect(r.externalId).toBe('acme/web#pages')
    expect(f.calls.find((c) => c.method === 'POST')?.body).toEqual({
      build_type: 'legacy',
      source: { branch: 'main', path: '/docs' }
    })
    expect(f.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      cname: 'docs.example.com'
    })
    const gone = await githubAdapter.apply(
      ctx,
      planOne(null, observedStub('github.pages', 'acme/web#pages')),
      null
    )
    expect(gone.ok).toBe(true)
  })

  it('repo file: commits as the Hub, sends the sha on update, never overwrites a moved file', async () => {
    let made = false
    const f = fake({
      'GET /repos/acme/web': { body: fx('repo') },
      'GET /repos/acme/web/contents/CODEOWNERS': () =>
        made ? { body: full.file } : { status: 404 },
      'PUT /repos/acme/web/contents/CODEOWNERS': (c) => {
        made = true
        return { status: c.body.sha ? 200 : 201, body: { content: full.file } }
      }
    })
    const ctx = ctxFor(f.impl)
    const d = desired('github.repo_file', { path: 'CODEOWNERS', content: '* @acme/platform\n' })
    const r = await githubAdapter.apply(ctx, planOne(d, null), d)
    expect(r.externalId).toBe('acme/web@main#CODEOWNERS')
    const first = f.calls.find((c) => c.method === 'PUT')!
    expect(Buffer.from(first.body.content, 'base64').toString()).toBe('* @acme/platform\n')
    expect(first.body).toMatchObject({
      branch: 'main',
      message: 'Update CODEOWNERS (Nivaro Hub)',
      committer: { name: 'Nivaro Hub' },
      author: { name: 'Nivaro Hub' }
    })
    expect(first.body.sha).toBeUndefined()

    // Update: the sha is read again right before the write.
    const obs = (await githubAdapter.observe(ctx, 'github.repo_file', 'acme/web@main#CODEOWNERS'))!
    const next = desired(
      'github.repo_file',
      { path: 'CODEOWNERS', branch: 'main', content: '* @acme/core\n', message: 'Move ownership' },
      { externalId: 'acme/web@main#CODEOWNERS' }
    )
    await githubAdapter.apply(ctx, planOne(next, obs), next)
    const second = f.calls.filter((c) => c.method === 'PUT')[1]
    expect(second.body.sha).toBe(full.file.sha)
    expect(second.body.message).toBe('Move ownership')
  })

  it('repo file: a file over 1 MB and a bad path are refused before any write', async () => {
    const f = fake({ 'GET /repos/acme/web': { body: fx('repo') } })
    const big = desired('github.repo_file', {
      path: 'big.txt',
      branch: 'main',
      content: 'x'.repeat(1_000_001)
    })
    await expect(
      githubAdapter.apply(ctxFor(f.impl), planOne(big, null), big)
    ).rejects.toMatchObject({
      code: 'VALIDATION'
    })
    const bad = desired('github.repo_file', { path: 'a/../b', branch: 'main', content: 'x' })
    await expect(
      githubAdapter.apply(ctxFor(f.impl), planOne(bad, null), bad)
    ).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    expect(f.calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('create onto a resource the Hub did not make is ALREADY_EXISTS, for every new type, with no write', async () => {
    const f = fake({
      'GET /orgs/acme/teams/platform': { body: full.team },
      'GET /repos/acme/web/teams': { body: full.repo_teams },
      'GET /repos/acme/web/rulesets': { body: full.ruleset_list },
      'GET /repos/acme/web/rulesets/9001': { body: full.ruleset },
      'GET /orgs/acme/actions/runner-groups/7': { body: full.runner_group },
      'GET /orgs/acme/actions/runner-groups/7/repositories': { body: full.runner_group_repos },
      'GET /repos/acme/web/environments/production/secrets/DEPLOY_TOKEN': { body: fx('secret') },
      'GET /repos/acme/web/environments/production/variables/REGION': { body: fx('variable') },
      'GET /repos/acme/web/environments/production': { body: full.env_protected },
      'GET /repos/acme/web/environments/production/deployment-branch-policies': {
        body: full.branch_policies
      },
      'GET /orgs/acme/actions/secrets/NPM_TOKEN': { body: full.org_secret },
      'GET /orgs/acme/actions/secrets/NPM_TOKEN/repositories': { body: full.org_secret_repos },
      'GET /orgs/acme/actions/variables/REGION': { body: full.org_variable },
      'GET /repos/acme/web/dependabot/secrets/NPM_AUTH': { body: full.dependabot_secret },
      'GET /orgs/acme/actions/runner-groups': { body: full.runner_group_list },
      'GET /repos/acme/web/pages': { body: full.pages },
      'GET /repos/acme/web': { body: fx('repo') },
      'GET /repos/acme/web/contents/CODEOWNERS': { body: full.file }
    })
    const envRefs = { environment: 'acme/web#production' }
    const cases: Array<[string, Record<string, unknown>, Record<string, any>]> = [
      ['github.team', { name: 'Platform' }, { refs: {}, scope: 'shared' }],
      [
        'github.team_repo_access',
        { permission: 'pull' },
        { refs: { repository: 'acme/web', team: 'acme#platform' } }
      ],
      ['github.ruleset', { name: 'protect-main', repository: { resourceId: 1 } }, {}],
      [
        'github.environment_secret',
        { name: 'DEPLOY_TOKEN', value: secretOf('test-secret-1') },
        { refs: envRefs }
      ],
      ['github.environment_variable', { name: 'REGION', value: 'x' }, { refs: envRefs }],
      ['github.environment_protection', { wait_timer: 5 }, { refs: envRefs }],
      [
        'github.org_secret',
        { name: 'NPM_TOKEN', value: secretOf('test-secret-2') },
        { refs: {}, scope: 'shared' }
      ],
      ['github.org_variable', { name: 'REGION', value: 'x' }, { refs: {}, scope: 'shared' }],
      ['github.dependabot_secret', { name: 'NPM_AUTH', value: secretOf('test-secret-3') }, {}],
      ['github.runner_group', { name: 'builders' }, { refs: {}, scope: 'shared' }],
      ['github.pages', { build_type: 'workflow' }, {}],
      ['github.repo_file', { path: 'CODEOWNERS', branch: 'main', content: 'x' }, {}]
    ]
    for (const [type, fields, over] of cases) {
      const d = desired(type, fields, over)
      const found = await githubAdapter.findExisting?.(ctxFor(f.impl), type, d)
      expect(found, `${type} plan time`).not.toBeNull()
      await expect(
        githubAdapter.apply(ctxFor(f.impl), planOne(d, null), d),
        type
      ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    }
    expect(f.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })
})

function observedStub(type: string, ext: string): Observed {
  return {
    type,
    externalId: ext,
    name: null,
    fields: {},
    tags: {},
    version: null,
    status: 'active'
  }
}

describe('github full: the pinned account holds for every id', () => {
  it('an id of another account reads as missing and is never written, for every new type', async () => {
    const f = fake({})
    const ctx = ctxFor(f.impl)
    const ids: Array<[string, string]> = [
      ['github.team', 'other#platform'],
      ['github.team_repo_access', 'other/web#platform'],
      ['github.ruleset', 'other/web#1'],
      ['github.ruleset', 'other#1'],
      ['github.environment_secret', 'other/web@production#T'],
      ['github.environment_variable', 'other/web@production#T'],
      ['github.environment_protection', 'other/web#production'],
      ['github.org_secret', 'other#T'],
      ['github.org_variable', 'other#T'],
      ['github.dependabot_secret', 'other/web#T'],
      ['github.runner_group', 'other#7'],
      ['github.pages', 'other/web#pages'],
      ['github.repo_file', 'other/web@main#CODEOWNERS']
    ]
    for (const [type, ext] of ids) {
      expect(await githubAdapter.observe(ctx, type, ext), `${type} ${ext}`).toBeNull()
      const op: PlannedOp = {
        kind: 'delete',
        type,
        resourceId: 1,
        externalId: ext,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      }
      await expect(githubAdapter.apply(ctx, op, null), `${type} ${ext}`).rejects.toMatchObject({
        code: 'GITHUB_OUT_OF_ACCOUNT',
        retryable: false
      })
      await expect(githubAdapter.health?.(ctx, type, ext)).resolves.toMatchObject({
        status: 'unknown'
      })
    }
    expect(f.calls).toHaveLength(0)
  })

  it('a parent ref in another account is refused, and a named op for another account too', async () => {
    const f = fake({})
    const d = desired(
      'github.dependabot_secret',
      { name: 'X', value: secretOf('test-secret-4') },
      { refs: { repository: 'other/web' } }
    )
    await expect(githubAdapter.apply(ctxFor(f.impl), planOne(d, null), d)).rejects.toMatchObject({
      code: 'GITHUB_OUT_OF_ACCOUNT'
    })
    await expect(githubAdapter.findExisting?.(ctxFor(f.impl), d.type, d)).rejects.toMatchObject({
      code: 'GITHUB_OUT_OF_ACCOUNT'
    })
    expect(f.calls).toHaveLength(0)
  })

  it('a bad id is refused with BAD_ID before any call', async () => {
    const f = fake({})
    const ctx = ctxFor(f.impl)
    const bad: Array<[string, string]> = [
      ['github.team', 'acme#..'],
      ['github.team', 'acme#a/b'],
      ['github.team', '../x#a'],
      ['github.team_repo_access', 'acme/web#%2e%2e'],
      ['github.ruleset', 'acme/web#12a'],
      ['github.ruleset', 'acme#..'],
      ['github.environment_secret', 'acme/web#T'],
      ['github.environment_secret', 'acme/web@..#T'],
      ['github.environment_variable', 'acme/web@production#..'],
      ['github.environment_protection', 'acme/web#a/b'],
      ['github.org_secret', 'acme#..'],
      ['github.org_secret', 'acme/web#T'],
      ['github.org_variable', 'acme#a/b'],
      ['github.dependabot_secret', 'acme/web#../x'],
      ['github.runner_group', 'acme#7/../8'],
      ['github.runner_group', 'acme#abc'],
      ['github.pages', 'acme/web#other'],
      ['github.repo_file', 'acme/web@main#a/../b'],
      ['github.repo_file', 'acme/web@main#/etc'],
      ['github.repo_file', 'acme/web@main#dir/'],
      ['github.repo_file', 'acme/web@a..b#file'],
      ['github.repo_file', 'acme/web#file']
    ]
    for (const [type, ext] of bad) {
      await expect(githubAdapter.observe(ctx, type, ext), `${type} ${ext}`).rejects.toMatchObject({
        code: 'BAD_ID',
        retryable: false
      })
    }
    expect(f.calls).toHaveLength(0)
  })

  it('ordinary names work: dotted paths, slashes in files, spaces in environments', async () => {
    const f = fake({
      'GET /repos/acme/web/contents/.github/workflows/deploy.yml': {
        body: { ...full.file, path: '.github/workflows/deploy.yml' }
      },
      'GET /repos/acme/web/environments/QA%20team/secrets/T': { body: fx('secret') }
    })
    const ctx = ctxFor(f.impl)
    expect(
      await githubAdapter.observe(
        ctx,
        'github.repo_file',
        'acme/web@release/v1#.github/workflows/deploy.yml'
      )
    ).not.toBeNull()
    expect(
      await githubAdapter.observe(ctx, 'github.environment_secret', 'acme/web@QA team#T')
    ).not.toBeNull()
  })
})

describe('github full: maps 429 to retryable; secrets never appear in errors', () => {
  it('a rate limit on a new type retries, a refusal does not', async () => {
    const limited = fake({
      'GET /orgs/acme/teams/platform': { status: 429, body: { message: 'slow down' } },
      'GET /orgs/acme/actions/secrets/X': {
        status: 403,
        body: { message: 'Resource not accessible' }
      }
    })
    await expect(
      githubAdapter.observe(ctxFor(limited.impl), 'github.team', 'acme#platform')
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    await expect(
      githubAdapter.observe(ctxFor(limited.impl), 'github.org_secret', 'acme#X')
    ).rejects.toMatchObject({ code: 'FORBIDDEN', retryable: false })
  })

  it('the registration token and a written value are masked when GitHub echoes them back', async () => {
    const { b64 } = await keypair()
    const echo = fake({
      'GET /orgs/acme/actions/runner-groups/7': { body: full.runner_group },
      'GET /orgs/acme/actions/runner-groups/7/repositories': { body: full.runner_group_repos },
      'POST /orgs/acme/actions/runners/registration-token': {
        status: 500,
        body: { message: 'boom test-secret-pat-0000' }
      },
      'GET /orgs/acme/actions/secrets/public-key': { body: { key_id: 'k', key: b64 } },
      'GET /orgs/acme/actions/secrets/E': { status: 404 },
      'PUT /orgs/acme/actions/secrets/E': {
        status: 422,
        body: { message: 'bad value test-secret-echo-9' }
      }
    })
    const ctx = ctxFor(echo.impl)
    const d = desired(
      'github.runner_group',
      { name: 'builders', register_runner: true },
      { externalId: 'acme#7', refs: {} }
    )
    const obs = (await githubAdapter.observe(ctx, 'github.runner_group', 'acme#7'))!
    const err = await githubAdapter.apply(ctx, planOne(d, obs), d).catch((e) => e)
    expect(err.code).toBe('PROVIDER_UNAVAILABLE')
    expect(String(err.message)).not.toContain('test-secret-pat-0000')
    const s = desired(
      'github.org_secret',
      { name: 'E', value: secretOf('test-secret-echo-9') },
      { scope: 'shared', refs: {} }
    )
    const err2 = await githubAdapter.apply(ctx, planOne(s, null), s).catch((e) => e)
    expect(err2.code).toBe('VALIDATION')
    expect(String(err2.message)).not.toContain('test-secret-echo-9')
  })

  it('a registration token answer without a token fails clearly', async () => {
    const f = fake({
      'GET /orgs/acme/actions/runner-groups/7': { body: full.runner_group },
      'GET /orgs/acme/actions/runner-groups/7/repositories': { body: full.runner_group_repos },
      'POST /orgs/acme/actions/runners/registration-token': { status: 201, body: {} }
    })
    const ctx = ctxFor(f.impl)
    const d = desired(
      'github.runner_group',
      { name: 'builders', register_runner: true },
      { externalId: 'acme#7', refs: {} }
    )
    const obs = (await githubAdapter.observe(ctx, 'github.runner_group', 'acme#7'))!
    await expect(githubAdapter.apply(ctx, planOne(d, obs), d)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR'
    })
  })
})

describe('github full: risk flags per type', () => {
  const spec = (k: string) => githubAdapter.types.find((t) => t.key === k)!
  const op = (over: Partial<PlannedOp>): PlannedOp => ({
    kind: 'update',
    type: '',
    resourceId: 1,
    externalId: 'x',
    reason: '',
    changes: [],
    preconditions: {},
    risk: [],
    ...over
  })

  it('deletes: teams and rulesets destructive, secrets also lose data, groups destructive', () => {
    const del = op({ kind: 'delete' })
    expect(spec('github.team').risk(del, null)).toEqual(['destructive'])
    expect(spec('github.ruleset').risk(del, null)).toEqual(['destructive'])
    expect(spec('github.org_secret').risk(del, null)).toEqual(['destructive', 'data_loss'])
    expect(spec('github.environment_secret').risk(del, null)).toEqual(['destructive', 'data_loss'])
    expect(spec('github.dependabot_secret').risk(del, null)).toEqual(['destructive', 'data_loss'])
    expect(spec('github.org_variable').risk(del, null)).toEqual(['destructive'])
    expect(spec('github.runner_group').risk(del, null)).toEqual(['destructive'])
    expect(spec('github.pages').risk(del, null)).toEqual(['destructive'])
    expect(spec('github.repo_file').risk(del, null)).toEqual(['destructive'])
  })

  it('exposure: admin access, all-repository secrets, public runners, Pages, workflow files', () => {
    const d = (fields: Record<string, unknown>) => desired('x', fields)
    expect(spec('github.team_repo_access').risk(op({}), d({ permission: 'admin' }))).toEqual([
      'public_exposure'
    ])
    expect(spec('github.team_repo_access').risk(op({}), d({ permission: 'push' }))).toEqual([])
    expect(spec('github.org_secret').risk(op({}), d({ visibility: 'all' }))).toEqual([
      'public_exposure'
    ])
    expect(spec('github.org_secret').risk(op({}), d({ visibility: 'selected' }))).toEqual([])
    expect(spec('github.org_variable').risk(op({}), d({ visibility: 'all' }))).toEqual([
      'public_exposure'
    ])
    expect(
      spec('github.runner_group').risk(op({}), d({ allows_public_repositories: true }))
    ).toEqual(['public_exposure'])
    expect(
      spec('github.runner_group').risk(
        op({ action: 'register_runner' }),
        d({ allows_public_repositories: true })
      )
    ).toEqual([])
    expect(spec('github.pages').risk(op({ kind: 'create' }), d({}))).toEqual(['public_exposure'])
    expect(
      spec('github.repo_file').risk(op({ kind: 'create' }), d({ path: '.github/workflows/ci.yml' }))
    ).toEqual(['public_exposure'])
    expect(
      spec('github.repo_file').risk(op({ kind: 'update' }), d({ path: 'docs/CODEOWNERS' }))
    ).toEqual(['public_exposure'])
    expect(
      spec('github.repo_file').risk(op({ kind: 'update' }), d({ path: 'docs/readme.md' }))
    ).toEqual([])
  })

  it('weakening a gate is public exposure: fewer reviewers, a shorter wait, any branch, a ruleset switched off', () => {
    const prot = spec('github.environment_protection')
    const change = (field: string, from: unknown, to: unknown) =>
      op({ changes: [{ field, from, to }] })
    expect(prot.risk(change('reviewers', ['user:a', 'user:b'], ['user:a']), null)).toEqual([
      'public_exposure'
    ])
    expect(prot.risk(change('reviewers', ['user:a'], ['user:a', 'user:b']), null)).toEqual([])
    expect(prot.risk(change('wait_timer', 30, 5), null)).toEqual(['public_exposure'])
    expect(prot.risk(change('deployment_branches', 'protected', 'all'), null)).toEqual([
      'public_exposure'
    ])
    expect(prot.risk(change('wait_timer', 5, 30), null)).toEqual([])
    const rs = spec('github.ruleset')
    expect(
      rs.risk(
        change('enforcement', 'active', 'disabled'),
        desired('x', { enforcement: 'disabled' })
      )
    ).toEqual(['public_exposure'])
    expect(
      rs.risk(change('enforcement', 'disabled', 'active'), desired('x', { enforcement: 'active' }))
    ).toEqual([])
  })
})
