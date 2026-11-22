import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse
} from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 2): placement components API. Real SQLite with the
// migration 542 tables; drivers' tokens are sealed at rest, masked on every answer and never
// written to an activity row.

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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up543 } = await import('../../../db/migrations/543_hub_promotions.js')
const { logActivity } = await import('../../../services/activity.js')
const { hubRoutes } = await import('../../../routes/hub.js')

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const KEY = 'a'.repeat(64)
const TOKEN = 'glpat-plain-token-value'

const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }

const CONFIG = {
  api: 'https://gitlab.example.com/api/v4',
  project: 'ops/efp-deploy',
  branch: 'production',
  pin_file: '.docker/nivaro-version',
  deploy_job: 'deploy_production'
}

const fakeRedis = { get: vi.fn(), set: vi.fn(), del: vi.fn(async () => 1) }

let app: FastifyInstance
let prevHub: string | undefined
let prevKey: string | undefined

beforeAll(async () => {
  prevHub = process.env.HUB
  prevKey = process.env.ENCRYPTION_KEY
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = KEY
  await up(db)
  await up543(db)
  app = Fastify()
  app.decorate('redis', fakeRedis as never)
  await app.register(hubRoutes, { prefix: '/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})
beforeEach(async () => {
  process.env.ENCRYPTION_KEY = KEY
  await db('nivaro_hub_components').del()
  await db('nivaro_hub_environments').del()
  await db('nivaro_hub_apps').del()
  await db('nivaro_hub_placements').del()
  await db('nivaro_hub_drivers').del()
  vi.mocked(logActivity).mockClear()
  fakeRedis.del.mockClear()
})

const req = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  payload?: unknown
): Promise<LightMyRequestResponse> => {
  const opts: InjectOptions = { method, url, headers }
  if (payload !== undefined) opts.payload = payload as InjectOptions['payload']
  return app.inject(opts)
}

async function createDriver(extra: Record<string, unknown> = {}) {
  const r = await req('POST', '/hub/drivers', asAdmin, {
    kind: 'gitlab',
    name: 'EFP GitLab',
    config: CONFIG,
    secret: TOKEN,
    ...extra
  })
  expect(r.statusCode).toBe(200)
  return r.json().data as { id: number; secret: string | null }
}

async function createPlacement(driverId: number, target: Record<string, unknown> = {}) {
  const r = await req('POST', '/hub/placements', asAdmin, {
    kind: 'dedicated',
    driver_id: driverId,
    target
  })
  expect(r.statusCode).toBe(200)
  return r.json().data.id as number
}

const idOf = (r: Array<{ id: number } | number>) =>
  r.map((x) => (typeof x === 'object' ? x.id : x))[0] as number

async function createHubApp(key = 'efp') {
  const found = await db('nivaro_hub_apps').where({ key }).first('id')
  if (found) return Number(found.id)
  return idOf(
    await db('nivaro_hub_apps')
      .insert({ key, name: key.toUpperCase(), signin_mode: 'direct', extensions: '[]' })
      .returning('id')
  )
}

/** An environment row naming `placementId` (straight to the table: no route validation). */
async function createEnv(placementId: number | null, key = 'prod') {
  const appId = await createHubApp()
  return idOf(
    await db('nivaro_hub_environments')
      .insert({
        app_id: appId,
        key,
        base_url: `https://${key}.example.com`,
        hostnames: '[]',
        status: 'active',
        position: 0,
        placement_id: placementId
      })
      .returning('id')
  )
}

describe('hub components', () => {
  async function setup() {
    const d = await createDriver()
    const placementId = await createPlacement(d.id)
    const envId = await createEnv(placementId)
    return { d, placementId, envId }
  }
  const base = (driver_id: number, extra: Record<string, unknown> = {}) => ({
    name: 'web',
    kind: 'frontend',
    driver_id,
    ...extra
  })

  it('lists an implicit api component for a phase-1 placement', async () => {
    const { d, placementId } = await setup()
    const r = await req('GET', `/hub/placements/${placementId}/components`, asAdmin)
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual([
      expect.objectContaining({
        id: null,
        position: 1,
        kind: 'api',
        name: 'api',
        driver_id: d.id,
        source_branch: 'main',
        implicit: true
      })
    ])
  })

  it('creates, lists in order, patches and deletes components (logged)', async () => {
    const { d, placementId } = await setup()
    vi.mocked(logActivity).mockClear()
    const a = await req('POST', `/hub/placements/${placementId}/components`, asAdmin, {
      ...base(d.id, { name: 'api', kind: 'api' }),
      position: 2
    })
    expect(a.statusCode).toBe(200)
    const b = await req(
      'POST',
      `/hub/placements/${placementId}/components`,
      asAdmin,
      base(d.id, { position: 1, verify_url: 'https://web.example.com/version' })
    )
    expect(b.statusCode).toBe(200)
    const list = (await req('GET', `/hub/placements/${placementId}/components`, asAdmin)).json()
      .data
    expect(list.map((c: { name: string }) => c.name)).toEqual(['web', 'api'])
    expect(list[0]).toMatchObject({
      verify_field: 'version',
      source_branch: 'main'
    })

    const id = b.json().data.id
    const p = await req('PATCH', `/hub/components/${id}`, asAdmin, { source_branch: 'release' })
    expect(p.statusCode).toBe(200)
    expect(p.json().data.source_branch).toBe('release')
    expect((await req('DELETE', `/hub/components/${id}`, asAdmin)).statusCode).toBe(204)
    expect(await db('nivaro_hub_components').where({ id }).first()).toBeUndefined()
    const actions = vi.mocked(logActivity).mock.calls.map(([o]) => (o as { action: string }).action)
    expect(actions).toEqual(['create', 'create', 'update', 'delete'])
  })

  it('refuses bad kind, driver, verify url and a taken position', async () => {
    const { d, placementId } = await setup()
    const post = (extra: Record<string, unknown>) =>
      req('POST', `/hub/placements/${placementId}/components`, asAdmin, base(d.id, extra))
    expect((await post({ kind: 'worker' })).json().code).toBe('BAD_KIND')
    expect((await post({ driver_id: 99999 })).json().code).toBe('BAD_DRIVER')
    for (const v of ['ftp://x.example.com', 'not a url', 5, 'https://u:p@x.example.com'])
      expect((await post({ verify_url: v })).json().code).toBe('BAD_VERIFY_URL')
    expect((await post({ verify_url: null, position: 1 })).statusCode).toBe(200)
    const dup = await post({ position: 1 })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('POSITION_TAKEN')
  })

  it('maps a unique violation race to POSITION_TAKEN', async () => {
    const { d, placementId } = await setup()
    const first = await req(
      'POST',
      `/hub/placements/${placementId}/components`,
      asAdmin,
      base(d.id, { position: 1 })
    )
    expect(first.statusCode).toBe(200)
    const { createComponent } = await import('../../../services/hub/components.js')
    const raced = await createComponent(placementId, {
      position: 1,
      name: 'x',
      kind: 'api',
      driver_id: d.id,
      source_branch: 'main',
      target_branch: null,
      before_job: null,
      deploy_job: null,
      verify_url: null,
      verify_field: 'version'
    })
    expect(raced).toMatchObject({ ok: false, code: 'POSITION_TAKEN', status: 409 })
  })

  it('owner reads (200), cannot write (403); non-owner non-admin gets 404', async () => {
    const { d, placementId, envId } = await setup()
    const appId = (await db('nivaro_hub_environments').where({ id: envId }).first('app_id')).app_id
    await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER })
    const url = `/hub/placements/${placementId}/components`
    expect((await req('GET', url, asOwner)).statusCode).toBe(200)
    expect((await req('POST', url, asOwner, base(d.id))).statusCode).toBe(403)
    const c = await req('POST', url, asAdmin, base(d.id))
    expect(
      (await req('PATCH', `/hub/components/${c.json().data.id}`, asOwner, { name: 'z' })).statusCode
    ).toBe(403)
    expect((await req('DELETE', `/hub/components/${c.json().data.id}`, asOwner)).statusCode).toBe(
      403
    )
    const stranger = { 'x-user': 'CCCCCCCC-0000-4000-8000-000000000003' }
    expect((await req('GET', url, stranger)).statusCode).toBe(404)
    expect((await req('GET', '/hub/placements/99999/components', asAdmin)).statusCode).toBe(404)
  })

  it('deleteDriver is IN_USE when a component of an in-use placement names it', async () => {
    const { placementId } = await setup()
    const other = await createDriver({ name: 'Other' })
    const c = await req(
      'POST',
      `/hub/placements/${placementId}/components`,
      asAdmin,
      base(other.id)
    )
    expect(c.statusCode).toBe(200)
    const r = await req('DELETE', `/hub/drivers/${other.id}`, asAdmin)
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('IN_USE')
    await req('DELETE', `/hub/components/${c.json().data.id}`, asAdmin)
    expect((await req('DELETE', `/hub/drivers/${other.id}`, asAdmin)).statusCode).toBe(204)
  })

  it('PATCH environment hub_managed toggles, is logged, admin only', async () => {
    const { envId } = await setup()
    const on = await req('PATCH', `/hub/environments/${envId}`, asAdmin, { hub_managed: true })
    expect(on.statusCode).toBe(200)
    expect(on.json().data.hub_managed).toBe(true)
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'nivaro_hub_environments',
        changed_fields: ['hub_managed']
      })
    )
    expect(
      (await req('PATCH', `/hub/environments/${envId}`, asOwner, { hub_managed: false })).statusCode
    ).toBe(403)
    expect(
      (await req('PATCH', `/hub/environments/${envId}`, asAdmin, { hub_managed: 'yes' })).json()
        .code
    ).toBe('BAD_HUB_MANAGED')
    const off = await req('PATCH', `/hub/environments/${envId}`, asAdmin, { hub_managed: false })
    expect(off.json().data.hub_managed).toBe(false)
  })

  it('PATCH accepts { position } alone; a taken position answers POSITION_TAKEN; apps/:id shows hub_managed', async () => {
    const { d, placementId, envId } = await setup()
    const url = `/hub/placements/${placementId}/components`
    const a = (await req('POST', url, asAdmin, base(d.id, { position: 1 }))).json().data
    const b = (await req('POST', url, asAdmin, base(d.id, { name: 'b', position: 2 }))).json().data
    const taken = await req('PATCH', `/hub/components/${a.id}`, asAdmin, { position: 2 })
    expect(taken.json().code).toBe('POSITION_TAKEN')
    const moved = await req('PATCH', `/hub/components/${b.id}`, asAdmin, { position: 5 })
    expect(moved.statusCode).toBe(200)
    expect(moved.json().data).toMatchObject({ position: 5, name: 'b' })
    const appId = (await db('nivaro_hub_environments').where({ id: envId }).first('app_id')).app_id
    const got = await req('GET', `/hub/apps/${appId}`, asAdmin)
    expect(got.json().data.environments[0].hub_managed).toBe(false)
  })

  it('an owner of either app sharing a placement may GET its components', async () => {
    const { placementId } = await setup()
    const app2 = idOf(
      await db('nivaro_hub_apps')
        .insert({ key: 'two', name: 'TWO', signin_mode: 'direct', extensions: '[]' })
        .returning('id')
    )
    await db('nivaro_hub_environments').insert({
      app_id: app2,
      key: 'prod',
      base_url: 'https://two.example.com',
      hostnames: '[]',
      status: 'active',
      position: 0,
      placement_id: placementId
    })
    const o2 = 'DDDDDDDD-0000-4000-8000-000000000004'
    await db('nivaro_hub_app_owners').insert({ app_id: app2, user_id: o2 })
    const url = `/hub/placements/${placementId}/components`
    expect((await req('GET', url, { 'x-user': o2 })).statusCode).toBe(200)
    const app1 = (await db('nivaro_hub_apps').where({ key: 'efp' }).first('id')).id
    await db('nivaro_hub_app_owners').insert({ app_id: app1, user_id: OWNER })
    expect((await req('GET', url, asOwner)).statusCode).toBe(200)
  })

  it('releasing or deleting a placement removes its components', async () => {
    const { d, placementId, envId } = await setup()
    await req('POST', `/hub/placements/${placementId}/components`, asAdmin, base(d.id))
    await req('PATCH', `/hub/environments/${envId}`, asAdmin, { placement_id: null })
    expect(await db('nivaro_hub_placements').where({ id: placementId }).first()).toBeUndefined()
    expect(await db('nivaro_hub_components').where({ placement_id: placementId })).toHaveLength(0)
    const p2 = await createPlacement(d.id)
    await req('POST', `/hub/placements/${p2}/components`, asAdmin, base(d.id))
    expect((await req('DELETE', `/hub/placements/${p2}`, asAdmin)).statusCode).toBe(204)
    expect(await db('nivaro_hub_components').where({ placement_id: p2 })).toHaveLength(0)
  })

  it('an explicit null source_branch or verify_field is refused; omitted gets the default', async () => {
    const { d, placementId } = await setup()
    const post = (extra: Record<string, unknown>) =>
      req('POST', `/hub/placements/${placementId}/components`, asAdmin, base(d.id, extra))
    expect((await post({ source_branch: null })).json().code).toBe('BAD_BRANCH')
    expect((await post({ verify_field: null })).json().code).toBe('BAD_VERIFY_FIELD')
    expect((await post({})).json().data).toMatchObject({
      source_branch: 'main',
      verify_field: 'version'
    })
  })
})

describe('stack components (phase 4)', () => {
  async function createDocker() {
    const r = await req('POST', '/hub/drivers', asAdmin, {
      kind: 'docker',
      name: 'Swarm',
      config: {
        agent_url: 'https://agent.example.com',
        dns_mode: 'manual',
        edge_target: 'edge.example.com'
      },
      secret: 'agent-token'
    })
    expect(r.statusCode).toBe(200)
    return r.json().data.id as number
  }
  const post = (placementId: number, body: Record<string, unknown>) =>
    req('POST', `/hub/placements/${placementId}/components`, asAdmin, body)

  it('the implicit component of a docker placement is the stack', async () => {
    const docker = await createDocker()
    const placementId = await createPlacement(docker, { stack: 'efp-prod' })
    const r = await req('GET', `/hub/placements/${placementId}/components`, asAdmin)
    expect(r.json().data).toEqual([
      expect.objectContaining({
        id: null,
        position: 1,
        kind: 'stack',
        name: 'stack',
        driver_id: docker,
        implicit: true
      })
    ])
  })

  it('a stack component on its docker placement is stored without GitLab fields', async () => {
    const docker = await createDocker()
    const placementId = await createPlacement(docker, { stack: 'efp-prod' })
    const r = await post(placementId, {
      name: 'nivaro',
      kind: 'stack',
      driver_id: docker,
      target_branch: 'production',
      deploy_job: 'deploy'
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({
      kind: 'stack',
      position: 1,
      target_branch: null,
      deploy_job: null,
      before_job: null
    })
    const list = (await req('GET', `/hub/placements/${placementId}/components`, asAdmin)).json()
      .data
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'stack', name: 'nivaro' })
    // PATCH of the stored stack itself is not a "second component".
    const id = r.json().data.id
    const p = await req('PATCH', `/hub/components/${id}`, asAdmin, { name: 'renamed' })
    expect(p.statusCode).toBe(200)
  })

  it('stack on gitlab, or api/frontend on docker → 400 KIND_DRIVER_MISMATCH', async () => {
    const g = await createDriver()
    const docker = await createDocker()
    const gp = await createPlacement(g.id)
    const dp = await createPlacement(docker, { stack: 'efp-prod' })
    const a = await post(gp, { name: 's', kind: 'stack', driver_id: g.id })
    expect([a.statusCode, a.json().code]).toEqual([400, 'KIND_DRIVER_MISMATCH'])
    for (const kind of ['api', 'frontend']) {
      const b = await post(dp, { name: 'x', kind, driver_id: docker })
      expect([kind, b.statusCode, b.json().code]).toEqual([kind, 400, 'KIND_DRIVER_MISMATCH'])
    }
    expect(await db('nivaro_hub_components').count({ n: '*' }).first()).toMatchObject({ n: 0 })
  })

  it('a second component on a docker placement → 409 ONE_STACK', async () => {
    const docker = await createDocker()
    const dp = await createPlacement(docker, { stack: 'efp-prod' })
    expect((await post(dp, { name: 'one', kind: 'stack', driver_id: docker })).statusCode).toBe(200)
    const two = await post(dp, { name: 'two', kind: 'stack', driver_id: docker })
    expect([two.statusCode, two.json().code]).toEqual([409, 'ONE_STACK'])
  })

  it("a stack on another docker driver than its placement's → 400 BAD_DRIVER", async () => {
    const docker = await createDocker()
    const other = await createDocker()
    const dp = await createPlacement(docker, { stack: 'efp-prod' })
    const r = await post(dp, { name: 's', kind: 'stack', driver_id: other })
    expect([r.statusCode, r.json().code]).toEqual([400, 'BAD_DRIVER'])
    expect((await post(dp, { name: 's', kind: 'stack', driver_id: docker })).statusCode).toBe(200)
  })

  it('PATCH placement: gitlab with components → docker driver → 400 MIXED_DRIVER_KINDS', async () => {
    const g = await createDriver()
    const docker = await createDocker()
    const gp = await createPlacement(g.id)
    expect((await post(gp, { name: 'api', kind: 'api', driver_id: g.id })).statusCode).toBe(200)
    expect((await post(gp, { name: 'web', kind: 'frontend', driver_id: g.id })).statusCode).toBe(
      200
    )
    const r = await req('PATCH', `/hub/placements/${gp}`, asAdmin, {
      driver_id: docker,
      target: { stack: 'efp-prod' }
    })
    expect([r.statusCode, r.json().code]).toEqual([400, 'MIXED_DRIVER_KINDS'])
    expect((await db('nivaro_hub_placements').where({ id: gp }).first()).driver_id).toBe(g.id)
  })

  it('PATCH placement: docker with a stored stack → gitlab driver → 400 MIXED_DRIVER_KINDS', async () => {
    const g = await createDriver()
    const docker = await createDocker()
    const dp = await createPlacement(docker, { stack: 'efp-prod' })
    expect((await post(dp, { name: 's', kind: 'stack', driver_id: docker })).statusCode).toBe(200)
    const r = await req('PATCH', `/hub/placements/${dp}`, asAdmin, {
      driver_id: g.id,
      target: { branch: 'production' }
    })
    expect([r.statusCode, r.json().code]).toEqual([400, 'MIXED_DRIVER_KINDS'])
    expect((await db('nivaro_hub_placements').where({ id: dp }).first()).driver_id).toBe(docker)
  })

  it('PATCH placement with no stored components may change kind; a stored stack follows a docker move', async () => {
    const g = await createDriver()
    const docker = await createDocker()
    const other = await createDocker()
    const gp = await createPlacement(g.id)
    const ok = await req('PATCH', `/hub/placements/${gp}`, asAdmin, {
      driver_id: docker,
      target: { stack: 'efp-prod' }
    })
    expect(ok.statusCode).toBe(200)
    expect((await post(gp, { name: 's', kind: 'stack', driver_id: docker })).statusCode).toBe(200)
    const moved = await req('PATCH', `/hub/placements/${gp}`, asAdmin, { driver_id: other })
    expect(moved.statusCode).toBe(200)
    const comp = await db('nivaro_hub_components').where({ placement_id: gp }).first()
    expect(comp.driver_id).toBe(other)
  })

  it('target.stack on a gitlab placement, target.branch on a docker one → 400 BAD_TARGET', async () => {
    const g = await createDriver()
    const docker = await createDocker()
    const a = await req('POST', '/hub/placements', asAdmin, {
      kind: 'dedicated',
      driver_id: g.id,
      target: { stack: 'efp-prod' }
    })
    expect([a.statusCode, a.json().code]).toEqual([400, 'BAD_TARGET'])
    const b = await req('POST', '/hub/placements', asAdmin, {
      kind: 'dedicated',
      driver_id: docker,
      target: { branch: 'production' }
    })
    expect([b.statusCode, b.json().code]).toEqual([400, 'BAD_TARGET'])
    const gp = await createPlacement(g.id, { branch: 'production' })
    const c = await req('PATCH', `/hub/placements/${gp}`, asAdmin, {
      target: { branch: 'production', stack: 'efp-prod' }
    })
    expect([c.statusCode, c.json().code]).toEqual([400, 'BAD_TARGET'])
    // Moving to docker while keeping the stored branch target is refused as well.
    const d = await req('PATCH', `/hub/placements/${gp}`, asAdmin, { driver_id: docker })
    expect([d.statusCode, d.json().code]).toEqual([400, 'BAD_TARGET'])
  })

  it('gitlab and docker drivers on one placement → 400 MIXED_DRIVER_KINDS', async () => {
    const g = await createDriver()
    const docker = await createDocker()
    // A GitLab placement: a stack on the docker driver would mix kinds.
    const gp = await createPlacement(g.id)
    expect((await post(gp, { name: 'api', kind: 'api', driver_id: g.id })).statusCode).toBe(200)
    const mixed = await post(gp, { name: 's', kind: 'stack', driver_id: docker })
    expect([mixed.statusCode, mixed.json().code]).toEqual([400, 'MIXED_DRIVER_KINDS'])
    // A Docker placement: an api on a GitLab driver mixes too.
    const dp = await createPlacement(docker, { stack: 'efp-prod' })
    const mixed2 = await post(dp, { name: 'api', kind: 'api', driver_id: g.id })
    expect([mixed2.statusCode, mixed2.json().code]).toEqual([400, 'MIXED_DRIVER_KINDS'])
    // PATCH moving a stored api onto the docker driver as a stack mixes as well.
    const apiId = (await db('nivaro_hub_components').where({ placement_id: gp }).first('id')).id
    const p = await req('PATCH', `/hub/components/${apiId}`, asAdmin, {
      kind: 'stack',
      driver_id: docker
    })
    expect([p.statusCode, p.json().code]).toEqual([400, 'MIXED_DRIVER_KINDS'])
  })
})
