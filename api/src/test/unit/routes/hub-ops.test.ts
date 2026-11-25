import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub enhancements 10 (cross-app issues), 19 (secret rotation helper), 20 (storage health):
// services/hub/ops/* + routes/hub-ops.ts. In-memory SQLite with the real hub tables (542–568).
// Links, the agent and notifications are injected; nothing external is called.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  const admin = async (req: Parameters<typeof sign>[0]) => {
    await sign(req)
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
const activity: Array<Record<string, unknown>> = []
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (opts: Record<string, unknown>) => {
    const { req: _req, ...rest } = opts
    activity.push(rest)
    return 1
  })
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js'),
  await import('../../../db/migrations/568_hub_ops.js')
]
const { hubOpsRoutes } = await import('../../../routes/hub-ops.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')
const { hubTokenColumns } = await import('../../../services/hub/link-token.js')
const issues = await import('../../../services/hub/ops/issues.js')
const storage = await import('../../../services/hub/ops/storage.js')
const secrets = await import('../../../services/hub/ops/secrets.js')
const { readOps } = await import('../../../services/hub/ops/link-read.js')

const KEY = 'a'.repeat(64)
const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const HUB_TOKEN = 't'.repeat(48)

let app: FastifyInstance
const prev = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = KEY
  for (const m of migrations) await m.up(db)
  await db.schema.createTable('nivaro_roles', (t) => {
    t.string('id', 36)
    t.boolean('admin_access')
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id', 36)
    t.string('role', 36)
    t.string('status', 20)
    t.boolean('is_redacted')
    t.string('account_kind', 20)
  })
  await db('nivaro_roles').insert({ id: 'r-admin', admin_access: true })
  await db('nivaro_users').insert({ id: ADMIN, role: 'r-admin', status: 'active' })
  app = Fastify()
  await app.register(hubOpsRoutes, { prefix: '/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prev.HUB === undefined) delete process.env.HUB
  else process.env.HUB = prev.HUB
  if (prev.KEY === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prev.KEY
})
beforeEach(async () => {
  process.env.ENCRYPTION_KEY = KEY
  activity.length = 0
  for (const t of [
    'nivaro_hub_apps',
    'nivaro_hub_app_owners',
    'nivaro_hub_environments',
    'nivaro_hub_drivers',
    'nivaro_hub_placements',
    'nivaro_hub_shared_deployments',
    'nivaro_hub_issue_groups',
    'nivaro_hub_ops_health',
    'nivaro_hub_secrets',
    'nivaro_hub_secret_rotations',
    'nivaro_hub_secret_policies',
    'nivaro_hub_stack_settings',
    'nivaro_hub_oidc_clients',
    'nivaro_hub_oidc_keys'
  ])
    await db(t).del()
})

const inject = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string>,
  payload?: unknown
) => {
  const o: InjectOptions = { method, url, headers }
  if (payload !== undefined) o.payload = payload as InjectOptions['payload']
  return app.inject(o)
}

async function seedApp(key: string, owner?: string): Promise<{ appId: number; envId: number }> {
  const [appId] = await db('nivaro_hub_apps').insert({ key, name: key.toUpperCase() })
  if (owner) await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: owner })
  const [envId] = await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'prod',
    base_url: `https://${key}.example.com`,
    ...hubTokenColumns(HUB_TOKEN)
  })
  return { appId: Number(appId), envId: Number(envId) }
}

const SIG_A = 'a'.repeat(40)
const SIG_B = 'b'.repeat(40)
const group = (sig: string, over: Record<string, unknown> = {}) => ({
  sig,
  kind: 'server',
  title: 'Deadlock on "Jane" 123456',
  severity: 'high',
  status: 'open',
  count: 5,
  people: 2,
  release: '0.3.215',
  screen: null,
  first_seen: '2026-11-01T00:00:00.000Z',
  last_seen: '2026-11-20T00:00:00.000Z',
  issue_id: 77,
  ...over
})

describe('link reads', () => {
  it('dedicated: hub link with the opened token, redirects refused', async () => {
    const calls: Array<{ url: string; auth: string; redirect: unknown }> = []
    const r = await readOps(
      {
        id: 1,
        app_key: 'efp',
        base_url: 'https://efp.example.com/',
        hub_token: sealSecret(HUB_TOKEN),
        shared_deployment_id: null,
        link_url: null
      },
      'files',
      {},
      {
        fetch: async (url, headers, _t, opts) => {
          calls.push({ url, auth: headers.Authorization, redirect: opts.redirect })
          return { ok: true, status: 200, body: { files: 1 } }
        }
      }
    )
    expect(r.state).toBe('ok')
    expect(calls).toEqual([
      {
        url: 'https://efp.example.com/api/hub-link/ops/files',
        auth: `Bearer ${HUB_TOKEN}`,
        redirect: 'error'
      }
    ])
  })

  it('no token = no_link (nothing called); a 404 = too_old; 401 = refused', async () => {
    const env = {
      id: 1,
      app_key: 'efp',
      base_url: 'https://efp.example.com',
      hub_token: null,
      shared_deployment_id: null,
      link_url: null
    }
    const fetch = vi.fn()
    expect((await readOps(env, 'issues', {}, { fetch })).state).toBe('no_link')
    expect(fetch).not.toHaveBeenCalled()
    const withToken = { ...env, hub_token: sealSecret(HUB_TOKEN) }
    expect(
      (
        await readOps(
          withToken,
          'issues',
          {},
          {
            fetch: async () => ({ ok: false, status: 404, body: null })
          }
        )
      ).state
    ).toBe('too_old')
    expect(
      (
        await readOps(
          withToken,
          'issues',
          {},
          {
            fetch: async () => ({ ok: false, status: 401, body: { code: 'HUB_LINK_REFUSED' } })
          }
        )
      ).state
    ).toBe('refused')
  })
})

describe('issue rollup (enhancement 10)', () => {
  it('collects per environment, folds the same signature across apps, filters by owner', async () => {
    const a = await seedApp('alpha', OWNER)
    const b = await seedApp('beta')
    const targets = await (await import('../../../services/hub/ops/link-read.js')).opsTargets()
    const bodies: Record<number, unknown> = {
      [a.envId]: { groups: [group(SIG_A), group(SIG_B, { kind: 'crash', severity: 'low' })] },
      [b.envId]: {
        groups: [group(SIG_A, { issue_id: 9, severity: 'critical', count: 2, people: 1 })]
      }
    }
    const fetch = async (url: string) => {
      const env = url.includes('alpha') ? a.envId : b.envId
      return { ok: true, status: 200, body: bodies[env] }
    }
    const out = await issues.collectIssues({ targets, deps: { fetch } })
    expect(out).toEqual({ environments: 2, read: 2, failed: 0 })

    const res = await inject('GET', '/hub/ops/issues?multi=1', asAdmin)
    expect(res.statusCode).toBe(200)
    const groups = res.json().data.groups
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      sig: SIG_A,
      apps: 2,
      environments: 2,
      occurrences: 7,
      people: 3,
      severity: 'critical',
      app_keys: ['alpha', 'beta']
    })
    // Titles are scrubbed again on the Hub.
    expect(groups[0].title).not.toContain('Jane')
    expect(groups[0].title).not.toContain('123456')

    // The owner of alpha sees alpha only.
    const mine = (await inject('GET', '/hub/ops/issues', asOwner)).json().data.groups
    expect(mine.map((g: { sig: string }) => g.sig).sort()).toEqual([SIG_A, SIG_B])
    expect(mine.find((g: { sig: string }) => g.sig === SIG_A).apps).toBe(1)

    const detail = (await inject('GET', `/hub/ops/issues/${SIG_A}`, asAdmin)).json().data
    expect(detail.map((d: { link: string }) => d.link).sort()).toEqual([
      'https://alpha.example.com/issues/77',
      'https://beta.example.com/issues/9'
    ])
    expect(
      (await inject('GET', `/hub/ops/issues/${SIG_B}`, { 'x-user': 'nobody' })).statusCode
    ).toBe(404)
  })

  it('drops groups that fail the checks; an unreadable environment keeps its last rows', async () => {
    const a = await seedApp('alpha')
    const parsed = issues.parseRollup(a.envId, {
      groups: [group('nothex'), group(SIG_A, { kind: 'weird' }), group(SIG_B)]
    })
    expect(parsed?.groups.map((g) => g.sig)).toEqual([SIG_B])

    const targets = await (await import('../../../services/hub/ops/link-read.js')).opsTargets()
    await issues.collectIssues({
      targets,
      deps: { fetch: async () => ({ ok: true, status: 200, body: { groups: [group(SIG_A)] } }) }
    })
    await issues.collectIssues({
      targets,
      deps: { fetch: async () => ({ ok: false, status: 404, body: null }) }
    })
    expect(await db('nivaro_hub_issue_groups').count({ n: '*' }).first()).toMatchObject({ n: 1 })
    const reads = (await inject('GET', '/hub/ops/issues/reads', asAdmin)).json().data
    expect(reads[0]).toMatchObject({ app_key: 'alpha', state: 'too_old' })
  })
})

describe('issue rollup: counts and single flight (review M4)', () => {
  it('a signature sent twice by one app is one row: counted once per environment', async () => {
    const a = await seedApp('alpha')
    const parsed = issues.parseRollup(a.envId, {
      groups: [
        group(SIG_A, { count: 2, people: 3, severity: 'low' }),
        group(SIG_A, { count: 4, people: 1, severity: 'critical' })
      ]
    })
    expect(parsed?.groups).toHaveLength(1)
    expect(parsed?.groups[0]).toMatchObject({ occurrences: 6, people: 3, severity: 'critical' })
    await issues.storeIssueGroups(a.envId, parsed?.groups ?? [])
    const g = (await inject('GET', '/hub/ops/issues', asAdmin)).json().data.groups[0]
    expect(g).toMatchObject({ environments: 1, apps: 1, occurrences: 6 })
  })

  it('the unique index refuses a second row for one (environment, signature)', async () => {
    const a = await seedApp('alpha')
    const [row] = issues.parseRollup(a.envId, { groups: [group(SIG_A)] })?.groups ?? []
    await issues.storeIssueGroups(a.envId, [row])
    await expect(db('nivaro_hub_issue_groups').insert({ ...row })).rejects.toThrow()
  })

  it('one collection at a time: Read now answers 409 while a run holds the lease', async () => {
    const { claimOpsLease, releaseOpsLease } = await import(
      '../../../services/hub/ops/health-row.js'
    )
    expect(await claimOpsLease()).toBe(true)
    expect(await claimOpsLease()).toBe(false)
    const busy = await inject('POST', '/hub/ops/collect', asAdmin, {})
    expect(busy.statusCode).toBe(409)
    expect(busy.json().code).toBe('COLLECT_RUNNING')
    // A dead run's lease is taken over once stale.
    expect(await claimOpsLease(new Date(Date.now() + 11 * 60_000))).toBe(true)
    await releaseOpsLease()
    expect(await claimOpsLease()).toBe(true)
    await releaseOpsLease()
  })
})

describe('storage health (enhancement 20)', () => {
  async function dockerDriver() {
    const [id] = await db('nivaro_hub_drivers').insert({
      kind: 'docker',
      name: 'swarm-a',
      config: JSON.stringify({ agent_url: 'https://agent.example.com:8443' }),
      secret: sealSecret('x'.repeat(40))
    })
    return Number(id)
  }
  const health = (pct: number) =>
    ({
      api: 1,
      storage: {
        configured: true,
        kind: 'nfs',
        state: 'ok',
        total_bytes: 1000,
        free_bytes: 1000 - pct * 10,
        used_bytes: pct * 10,
        used_pct: pct,
        tree: { bytes: 900, files: 12, complete: true, walked_at: '2026-11-24T00:00:00Z' }
      }
    }) as never

  it('levels at 80 / 90 %, notifies admins + owners once per level, re-arms below 80 %', async () => {
    const driverId = await dockerDriver()
    const { appId, envId } = await seedApp('alpha', OWNER)
    const [placementId] = await db('nivaro_hub_placements').insert({
      kind: 'dedicated',
      driver_id: driverId
    })
    await db('nivaro_hub_environments').where({ id: envId }).update({ placement_id: placementId })
    expect(await storage.appIdsOnDriver(driverId)).toEqual([appId])

    const sent: Array<{ ids: string[]; subject: string }> = []
    const notify = async (ids: string[], n: { subject: string }) => {
      sent.push({ ids, subject: n.subject })
      return ids.length
    }
    const driver = (await (
      await import('../../../services/hub/drivers.js')
    ).getDriver(driverId)) as never
    const run = (pct: number) =>
      storage.checkDriverStorage(driver, { health: async () => health(pct), notify })

    expect((await run(50))?.level).toBe('ok')
    expect((await run(85))?.level).toBe('warn')
    expect((await run(86))?.level).toBe('warn')
    expect((await run(95))?.level).toBe('critical')
    expect(sent.map((s) => s.subject)).toEqual([
      'Storage filling up on swarm-a',
      'The storage your app runs on is filling up',
      'Storage almost full on swarm-a',
      'The storage your app runs on is almost full'
    ])
    // Admins get the driver; owners never see its name (the overview hides drivers from them).
    expect(sent[0].ids).toEqual([ADMIN])
    expect(sent[1].ids).toEqual([OWNER])
    await run(40)
    await run(85)
    expect(sent).toHaveLength(6)

    const row = (await inject('GET', `/hub/drivers/${driverId}/storage`, asAdmin)).json().data
    expect(row).toMatchObject({ state: 'ok', level: 'warn', kind: 'nfs', files: 12 })
    expect((await inject('GET', `/hub/drivers/${driverId}/storage`, asOwner)).statusCode).toBe(403)
  })

  it('an older agent and an unreachable one are states, never text', async () => {
    const driverId = await dockerDriver()
    const driver = (await (
      await import('../../../services/hub/drivers.js')
    ).getDriver(driverId)) as never
    const old = await storage.checkDriverStorage(driver, {
      health: async () => ({ api: 1 }) as never,
      notify: async () => 0
    })
    expect(old?.state).toBe('agent_too_old')
    const down = await storage.checkDriverStorage(driver, {
      health: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1')
      },
      notify: async () => 0
    })
    expect(down).toMatchObject({ state: 'agent_unreachable', error: 'AGENT_UNREACHABLE' })
  })

  it('files usage per environment keeps the previous reading for growth; owners see their own', async () => {
    await seedApp('alpha', OWNER)
    await seedApp('beta')
    const targets = await (await import('../../../services/hub/ops/link-read.js')).opsTargets()
    let bytes = 100
    const fetch = async () => ({ ok: true, status: 200, body: { files: 3, bytes } })
    await storage.collectFilesUsage({ targets, deps: { fetch } })
    bytes = 250
    await storage.collectFilesUsage({ targets, deps: { fetch } })
    const admin = (await inject('GET', '/hub/ops/storage', asAdmin)).json().data
    expect(admin.environments).toHaveLength(2)
    expect(admin.environments[0]).toMatchObject({ files: 3, bytes: 250, prev_bytes: 100 })
    const owner = (await inject('GET', '/hub/ops/storage', asOwner)).json().data
    expect(owner.drivers).toEqual([])
    expect(owner.environments.map((e: { app_key: string }) => e.app_key)).toEqual(['alpha'])
  })
})

describe('secret rotation helper (enhancement 19)', () => {
  it('inventories without values; a changed sealed value is a detected rotation', async () => {
    const { envId } = await seedApp('alpha')
    await db('nivaro_hub_drivers').insert({
      kind: 'gitlab',
      name: 'gl',
      config: '{}',
      secret: sealSecret('glpat-secret-value-123')
    })
    const sealedStack = sealSecret(
      JSON.stringify({
        SESSION_SECRET: sealSecret('s'.repeat(64)),
        REDIS_URL: sealSecret('redis://x')
      })
    )
    await db('nivaro_hub_stack_settings').insert({ environment_id: envId, secrets: sealedStack })

    await secrets.scanSecrets()
    const res = await inject('GET', '/hub/secrets', asAdmin)
    expect(res.statusCode).toBe(200)
    const text = res.body
    expect(text).not.toContain(HUB_TOKEN)
    expect(text).not.toContain('glpat-secret-value-123')
    expect(text).not.toContain('enc:')
    const refs = res
      .json()
      .data.items.map((i: { ref: string }) => i.ref)
      .sort()
    expect(refs).toEqual(
      [
        `hub_token:${envId}`,
        'driver_token:1',
        `stack_secret:${envId}:REDIS_URL`,
        `stack_secret:${envId}:SESSION_SECRET`
      ]
        .map((r) => (r === 'driver_token:1' ? expect.stringMatching(/^driver_token:\d+$/) : r))
        .sort()
    )
    expect((await inject('GET', '/hub/secrets', asOwner)).statusCode).toBe(403)

    // The token is replaced where it lives: the scan sees a rotation, a check is set.
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update(hubTokenColumns('n'.repeat(48)))
    const marked = await inject('POST', '/hub/secrets/rotated', asAdmin, {
      ref: `hub_token:${envId}`
    })
    expect(marked.statusCode).toBe(200)
    const row = await db('nivaro_hub_secrets')
      .where({ ref: `hub_token:${envId}` })
      .first()
    expect(row).toMatchObject({ rotated_via: 'helper', check_state: 'pending' })
    expect(String(row.rotated_by).toUpperCase()).toBe(ADMIN)
    expect(
      (await inject('POST', '/hub/secrets/rotated', asAdmin, { ref: `hub_token:${envId}` }))
        .statusCode
    ).toBe(409)
    expect(await db('nivaro_hub_secret_rotations').count({ n: '*' }).first()).toMatchObject({
      n: 1
    })
  })

  it('due dates, policies and one reminder per due date', async () => {
    const now = new Date('2026-11-24T12:00:00Z')
    const base = new Date('2026-06-01T00:00:00Z')
    expect(secrets.dueOf(base, { every_days: 180, remind_days: 14 }, 'hub_token', now).due).toBe(
      'due_soon'
    )
    expect(secrets.dueOf(base, { every_days: 100, remind_days: 14 }, 'hub_token', now).due).toBe(
      'overdue'
    )
    expect(secrets.dueOf(base, { every_days: null, remind_days: 14 }, 'hub_token', now).due).toBe(
      'no_schedule'
    )
    expect(secrets.dueOf(base, { every_days: 10, remind_days: 1 }, 'app_key', now).due).toBe(
      'never'
    )

    const bad = await inject('PUT', '/hub/secrets/policies/app_key', asAdmin, { every_days: 90 })
    expect(bad.json().code).toBe('NEVER_ROTATED')
    const bad2 = await inject('PUT', '/hub/secrets/policies/hub_token', asAdmin, {
      every_days: 10,
      remind_days: 20
    })
    expect(bad2.json().code).toBe('BAD_REMIND')
    const ok = await inject('PUT', '/hub/secrets/policies/hub_token', asAdmin, {
      every_days: 30,
      remind_days: 7
    })
    expect(ok.json().data).toMatchObject({ every_days: 30, remind_days: 7, saved: true })
    expect(activity.some((a) => a.action === 'hub-secret-policy')).toBe(true)

    const { envId } = await seedApp('alpha')
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update({ created_at: new Date('2026-10-01T00:00:00Z') })
    await secrets.scanSecrets({ now: new Date('2026-10-01T00:00:00Z') })
    const sent: string[] = []
    const notify = async (_ids: string[], n: { subject: string }) => {
      sent.push(n.subject)
      return 1
    }
    expect(await secrets.sendReminders(now, { notify })).toBe(1)
    expect(await secrets.sendReminders(now, { notify })).toBe(0)
    expect(sent).toEqual(['1 Hub secret due for rotation (1 overdue)'])
    expect(
      (
        await db('nivaro_hub_secrets')
          .where({ ref: `hub_token:${envId}` })
          .first()
      ).reminded_for
    ).toBe('2026-10-31')
  })

  it('runs the readiness check when due and tells admins when it fails', async () => {
    const { envId } = await seedApp('alpha')
    await secrets.scanSecrets()
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update(hubTokenColumns('m'.repeat(48)))
    const at = new Date()
    await secrets.scanSecrets({ now: at })
    const later = new Date(at.getTime() + secrets.CHECK_DELAY_MS + 1000)
    const sent: string[] = []
    const out = await secrets.runDueChecks(later, {
      envStatus: async () => ({ state: 'link_refused', error: 'HUB_LINK_REFUSED' }),
      notify: async (_ids, n) => {
        sent.push(n.subject)
        return 1
      }
    })
    expect(out).toEqual({ ran: 1, failed: 1 })
    expect(sent).toEqual(['Check failed after rotating a hub token'])
    const hist = await db('nivaro_hub_secret_rotations')
      .where({ ref: `hub_token:${envId}` })
      .first()
    expect(hist).toMatchObject({ via: 'detected', check_state: 'failed' })
  })

  it('rotate here: only a Docker environment’s hub token, confirmed; not a Docker env = 409', async () => {
    const { envId } = await seedApp('alpha')
    const notHelper = await inject('POST', '/hub/secrets/rotate', asAdmin, {
      ref: 'driver_token:1'
    })
    expect(notHelper.json().code).toBe('NOT_HELPER_ROTATED')
    const noConfirm = await inject('POST', '/hub/secrets/rotate', asAdmin, {
      ref: `hub_token:${envId}`
    })
    expect(noConfirm.json().code).toBe('CONFIRM_REQUIRED')
    const before = (await db('nivaro_hub_environments').where({ id: envId }).first()).hub_token
    const res = await inject('POST', '/hub/secrets/rotate', asAdmin, {
      ref: `hub_token:${envId}`,
      confirm: 'prod'
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('NOT_DOCKER')
    expect((await db('nivaro_hub_environments').where({ id: envId }).first()).hub_token).toBe(
      before
    )
  })

  async function dockerEnv() {
    const { envId } = await seedApp('alpha')
    const [driverId] = await db('nivaro_hub_drivers').insert({
      kind: 'docker',
      name: 'swarm',
      config: JSON.stringify({ agent_url: 'https://agent.example.com' }),
      secret: sealSecret('y'.repeat(40))
    })
    const [placementId] = await db('nivaro_hub_placements').insert({
      kind: 'dedicated',
      driver_id: driverId,
      target: JSON.stringify({ stack: 'alpha-prod' })
    })
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update({ placement_id: placementId, version_pin: '0.3.215' })
    await secrets.scanSecrets()
    return envId
  }
  const envRow = (envId: number) => db('nivaro_hub_environments').where({ id: envId }).first()
  const freeLock = async <T>(_e: number, work: () => Promise<T>) => ({
    held: true as const,
    value: await work()
  })

  it('rotates under the lock: new token, the old one kept 24 h, recorded as the person’s', async () => {
    const envId = await dockerEnv()
    const before = await envRow(envId)
    const ok = await secrets.rotateHubToken(
      envId,
      { id: ADMIN },
      { lock: freeLock, apply: async () => ({ deployId: 5, jobRunId: null }) }
    )
    expect(ok).toEqual({ deploy_id: 5, job_run_id: null })
    const after = await envRow(envId)
    expect(after.hub_token).not.toBe(before.hub_token)
    expect(after.hub_token_prev).toBe(before.hub_token)
    expect(after.hub_token_prev_lookup).toBe(before.hub_token_lookup)
    expect(new Date(after.hub_token_prev_until).getTime()).toBeGreaterThan(Date.now())
    const row = await db('nivaro_hub_secrets')
      .where({ ref: `hub_token:${envId}` })
      .first()
    expect(row).toMatchObject({ rotated_via: 'helper', check_state: 'pending' })

    // The app may still present the old token during the grace: the Hub accepts it.
    const { environmentForLinkToken } = await import('../../../services/hub/link-token.js')
    expect((await environmentForLinkToken(HUB_TOKEN))?.environment_id).toBe(envId)
    // The Hub's own read falls back to the old token on a refusal.
    const urls: string[] = []
    const auths: string[] = []
    const r = await readOps(
      (await (await import('../../../services/hub/ops/link-read.js')).opsTargets([envId]))[0],
      'files',
      {},
      {
        fetch: async (url, headers) => {
          urls.push(url)
          auths.push(headers.Authorization)
          return headers.Authorization === `Bearer ${HUB_TOKEN}`
            ? { ok: true, status: 200, body: { files: 1, bytes: 1 } }
            : { ok: false, status: 401, body: { code: 'HUB_LINK_REFUSED' } }
        }
      }
    )
    expect(r.state).toBe('ok')
    expect(auths).toHaveLength(2)
    expect(auths[1]).toBe(`Bearer ${HUB_TOKEN}`)

    // The check proves the NEW token, then the grace ends.
    await db('nivaro_hub_secrets')
      .where({ ref: `hub_token:${envId}` })
      .update({ check_due_at: new Date(Date.now() - 1000) })
    const checked = await secrets.runDueChecks(new Date(), {
      envStatus: async () => ({ state: 'ok' }),
      notify: async () => 0
    })
    expect(checked).toEqual({ ran: 1, failed: 0 })
    expect((await envRow(envId)).hub_token_prev).toBeNull()
    expect(await environmentForLinkToken(HUB_TOKEN)).toBeNull()
  })

  it('refuses while another holder has the lock or a deploy is planned/running', async () => {
    const envId = await dockerEnv()
    const before = await envRow(envId)
    await expect(
      secrets.rotateHubToken(
        envId,
        { id: ADMIN },
        { lock: async () => ({ held: false as const, holder: null }) }
      )
    ).rejects.toMatchObject({ code: 'ENV_BUSY' })
    await db('nivaro_hub_deploys').insert({
      app_id: 1,
      environment_id: envId,
      kind: 'promote',
      version: '0.3.215',
      status: 'running'
    })
    await expect(
      secrets.rotateHubToken(envId, { id: ADMIN }, { lock: freeLock })
    ).rejects.toMatchObject({ code: 'DEPLOY_RUNNING' })
    expect((await envRow(envId)).hub_token).toBe(before.hub_token)
    await db('nivaro_hub_deploys').del()
  })

  it('Apply now refused: the old token comes back only while the new one is still stored', async () => {
    const envId = await dockerEnv()
    const before = await envRow(envId)
    await expect(
      secrets.rotateHubToken(
        envId,
        { id: ADMIN },
        {
          lock: freeLock,
          apply: async () => {
            throw Object.assign(new Error('busy'), { code: 'ENV_LOCKED' })
          }
        }
      )
    ).rejects.toThrow('busy')
    const undone = await envRow(envId)
    expect(undone.hub_token).toBe(before.hub_token)
    expect(undone.hub_token_lookup).toBe(before.hub_token_lookup)
    expect(undone.hub_token_prev).toBeNull()
    expect(activity.some((a) => a.action === 'hub-secret-rotate-undone')).toBe(true)
    // The fingerprint is the old one again: the next scan sees no rotation.
    expect((await secrets.scanSecrets()).rotated).toEqual([])
    const hist = await db('nivaro_hub_secret_rotations').orderBy('id', 'desc').first()
    expect(hist.check_state).toBe('undone')

    // A deploy that started meanwhile may carry the new token: it is kept.
    await expect(
      secrets.rotateHubToken(
        envId,
        { id: ADMIN },
        {
          lock: freeLock,
          apply: async () => {
            await db('nivaro_hub_deploys').insert({
              app_id: 1,
              environment_id: envId,
              kind: 'promote',
              version: '0.3.215',
              status: 'running'
            })
            throw Object.assign(new Error('busy'), { code: 'ENV_LOCKED' })
          }
        }
      )
    ).rejects.toThrow('busy')
    const kept = await envRow(envId)
    expect(kept.hub_token).not.toBe(before.hub_token)
    expect(kept.hub_token_prev).toBe(before.hub_token)
    expect(activity.some((a) => a.action === 'hub-secret-rotate-kept')).toBe(true)
    await db('nivaro_hub_deploys').del()
  })

  it('two scans at once record one rotation', async () => {
    const { envId } = await seedApp('alpha')
    await secrets.scanSecrets()
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update(hubTokenColumns('z'.repeat(48)))
    const [a, b] = await Promise.all([secrets.scanSecrets(), secrets.scanSecrets()])
    expect(a.rotated.length + b.rotated.length).toBe(1)
    expect(await db('nivaro_hub_secret_rotations').count({ n: '*' }).first()).toMatchObject({
      n: 1
    })
  })

  it('a value stored unsealed is never hashed as it is', () => {
    const fp = secrets.fingerprintOf('plain-password')
    expect(fp).not.toContain(
      createHash('sha256').update('plain-password').digest('hex').slice(0, 12)
    )
    expect(fp.startsWith('u')).toBe(true)
  })
})
