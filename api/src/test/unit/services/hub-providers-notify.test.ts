import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers, Wave 2 framework (Task 13): Hub events going out through a sending resource.
// Real SQLite rows (Hub migrations up to 584), a fake sending adapter: an event fans out to the
// enabled routes that list it (Hub-wide, or the event's own app) — one message per route — and a
// slow provider never holds the flow that raised the event (sends run in the background, at most
// the send timeout, the failure lands on the route).

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
  return { db, migrationsDir: '/nowhere' }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const notify = await import('../../../services/hub/providers/notify.js')
const { hubNotify } = await import('../../../services/hub/providers/notify-hook.js')
const { ProviderError } = await import('../../../services/hub/providers/types.js')

import type { OutboundMessage, ProviderAdapter } from '../../../services/hub/providers/types.js'

const MIGRATIONS = [
  '542_hub_tables',
  '570_hub_people_owner_policy',
  '582_hub_providers',
  '584_hub_provider_bindings'
]

const ADMIN = { id: '0a1b2c3d-0000-4000-8000-000000000001', isAdmin: true }
const OWNER = { id: '0a1b2c3d-0000-4000-8000-000000000002', isAdmin: false }
const SECRET = 'test-secret-webhook-token-6612'

const sent: Array<{ resource: string; msg: OutboundMessage }> = []
let slow: Promise<void> | null = null
let rateLimited = false

const sender: ProviderAdapter = {
  key: 'fakemsg',
  label: 'Fake messages',
  connection: {
    fields: [{ key: 'token', label: 'Token', kind: 'string', secret: true }],
    hosts: () => ['hooks.fake.example'],
    describe: () => 'Fake'
  },
  types: [
    {
      key: 'fakemsg.channel',
      label: 'Channel',
      scope: 'app',
      sends: true,
      fields: [{ key: 'name', label: 'Name', kind: 'string' }],
      capabilities: {
        create: true,
        update: true,
        delete: true,
        adopt: true,
        snapshot: false,
        tag: false
      },
      reversible: true,
      refs: [],
      risk: () => []
    }
  ],
  testConnection: async () => ({ ok: true, identity: 'fake', permissions: [], missing: [] }),
  observe: async () => null,
  list: async () => ({ items: [], cursor: null }),
  plan: () => [],
  apply: async () => ({ ok: true, externalId: null, observed: null }),
  async notify(ctx, resource, msg) {
    if (resource.external_id === 'slow' && slow) await slow
    if (rateLimited)
      throw new ProviderError('RATE_LIMITED', `429 for token ${ctx.secrets.token}`, {
        retryable: true,
        status: 429
      })
    sent.push({ resource: String(resource.external_id), msg })
    return { ok: true, externalId: resource.external_id, observed: null }
  }
}

let app1: number
let app2: number
let env1: number
let connId: number

async function channel(ext: string, appId: number | null): Promise<number> {
  return (
    await store.insertResource({
      connection_id: connId,
      provider: 'fakemsg',
      type: 'fakemsg.channel',
      external_id: ext,
      name: ext,
      scope: appId == null ? 'shared' : 'app',
      app_id: appId
    })
  ).id
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  app1 = Number((await db('nivaro_hub_apps').insert({ key: 'shop', name: 'Shop' }))[0])
  app2 = Number((await db('nivaro_hub_apps').insert({ key: 'blog', name: 'Blog' }))[0])
  env1 = Number(
    (
      await db('nivaro_hub_environments').insert({
        app_id: app1,
        key: 'staging',
        position: 0,
        base_url: 'https://staging.example.com'
      })
    )[0]
  )
  await db('nivaro_hub_app_owners').insert({ app_id: app1, user_id: OWNER.id })
  connId = (
    await store.createConnection({
      provider: 'fakemsg',
      name: 'Fake',
      config: {},
      secrets: { token: SECRET }
    })
  ).id
})

afterAll(async () => {
  notify.configureNotifyForTest(null)
  await db.destroy()
})

beforeEach(async () => {
  registry.resetProvidersForTest()
  registry.registerProvider(sender)
  notify.configureNotifyForTest(null)
  sent.length = 0
  slow = null
  rateLimited = false
  await db('nivaro_hub_notify_routes').del()
  await db('nivaro_hub_resources').del()
})

describe('notify', () => {
  it('notify fans out to enabled routes only', async () => {
    const hub = await channel('hub-wide', null)
    const shop = await channel('shop-channel', app1)
    const blog = await channel('blog-channel', app2)
    const off = await channel('switched-off', null)
    const other = await channel('incidents-only', null)
    await notify.createNotifyRoute(
      { scope: 'hub', appId: null, events: ['deploy.failed'], resourceId: hub },
      ADMIN
    )
    // An owner's route for their own app, through their app's resource.
    await notify.createNotifyRoute(
      { scope: 'app', appId: app1, events: ['deploy.failed', 'deploy.finished'], resourceId: shop },
      OWNER
    )
    await notify.createNotifyRoute(
      { scope: 'app', appId: app2, events: ['deploy.failed'], resourceId: blog },
      ADMIN
    )
    await notify.createNotifyRoute(
      { scope: 'hub', appId: null, events: ['deploy.failed'], resourceId: off, enabled: false },
      ADMIN
    )
    await notify.createNotifyRoute(
      { scope: 'hub', appId: null, events: ['incident.opened'], resourceId: other },
      ADMIN
    )

    const out = await notify.fanOut('deploy.failed', {
      envId: env1,
      detail: 'promote 0.3.217 on staging'
    })
    expect(out.every((o) => o.ok)).toBe(true)
    // One message per route: the Hub-wide one and this app's — not the other app's, not the
    // switched-off route, not a route for another event.
    expect(sent.map((s) => s.resource).sort()).toEqual(['hub-wide', 'shop-channel'])
    expect(sent[0].msg).toMatchObject({
      kind: 'text',
      title: 'Deploy failed: Shop · staging',
      severity: 'critical'
    })
    expect(sent[0].msg.body).toContain('promote 0.3.217 on staging')
    const routes = await notify.listNotifyRoutes()
    expect(routes.filter((r) => r.last_sent_at).length).toBe(2)

    // Who may make which route.
    await expect(
      notify.createNotifyRoute(
        { scope: 'hub', appId: null, events: ['deploy.failed'], resourceId: shop },
        OWNER
      )
    ).rejects.toMatchObject({ code: 'ADMIN_ONLY' })
    await expect(
      notify.createNotifyRoute(
        { scope: 'app', appId: app2, events: ['deploy.failed'], resourceId: blog },
        OWNER
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      notify.createNotifyRoute(
        { scope: 'app', appId: app1, events: ['deploy.failed'], resourceId: hub },
        OWNER
      )
    ).rejects.toMatchObject({ code: 'NOT_A_SENDER' })
    await expect(
      notify.createNotifyRoute(
        { scope: 'app', appId: app1, events: ['nope'], resourceId: shop },
        OWNER
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })

    // A provider refusal lands on the route, scrubbed of the connection's secrets.
    rateLimited = true
    const [failed] = await notify.fanOut('incident.opened', { appId: app1 })
    expect(failed).toMatchObject({ ok: false, code: 'RATE_LIMITED' })
    expect(failed.error).not.toContain(SECRET)
    const row = (await notify.listNotifyRoutes()).find((r) => r.resource_id === other)
    expect(row?.last_error).toContain('429')
    expect(row?.last_error).not.toContain(SECRET)
  })

  it('slow sender does not delay deploy finish', async () => {
    const r = await channel('slow', null)
    await notify.createNotifyRoute(
      { scope: 'hub', appId: null, events: ['deploy.finished'], resourceId: r },
      ADMIN
    )
    let release: () => void = () => {}
    slow = new Promise<void>((resolve) => {
      release = resolve
    })
    notify.configureNotifyForTest({ timeoutMs: 60 })

    // The deploy's closing code calls the hook and goes on at once.
    const t0 = performance.now()
    hubNotify('deploy.finished', { appId: app1 })
    const back = notify.notifyHub('deploy.finished', { appId: app1 })
    expect(performance.now() - t0).toBeLessThan(20)

    // In the background the send gives up after the timeout; the failure lands on the route.
    const out = await back
    expect(out).toEqual([expect.objectContaining({ ok: false, code: 'TIMEOUT' })])
    const [row] = await notify.listNotifyRoutes()
    expect(row.last_error).toMatch(/did not answer/)
    expect(row.last_error_at).not.toBeNull()
    release()

    // A Hub with no enabled route never loads the senders at all.
    await db('nivaro_hub_notify_routes').update({ enabled: false })
    sent.length = 0
    hubNotify('deploy.finished', { appId: app1 })
    await new Promise((r) => setTimeout(r, 30))
    expect(sent).toHaveLength(0)
  })
})
