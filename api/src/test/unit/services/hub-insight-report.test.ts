import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub insight, app side: the usage counts and the dependency list a Hub reads over its link, on
// a real SQLite. Nothing under the privacy floor (≥ 5 people) leaves the app; never a person, a
// record, a raw URL, a path or a credential. The link routes answer only with the bearer.

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
vi.mock('../../../version.js', () => ({ NIVARO_VERSION: '0.3.215' }))
vi.mock('../../../services/mail.js', () => ({
  getSmtpConfig: vi.fn(async () => ({
    host: 'smtp.office365.com',
    user: 'mailer@x.com',
    pass: 'pw'
  }))
}))
vi.mock('../../../extensions/loader.js', () => ({
  extensionRegistry: new Map([
    ['efp-ops', { id: 'efp-ops', status: 'loaded', enabled: true, manifest: { version: '2.1.0' } }],
    ['broken', { id: 'broken', status: 'error', enabled: true }]
  ])
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { usageReport, dependencyReport } = await import(
  '../../../services/hub-link/insight-report.js'
)

const TOKEN = 't'.repeat(40)
const NOW = new Date('2026-11-25T15:00:00Z')
const user = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`
let app: FastifyInstance
let prevToken: string | undefined

beforeAll(async () => {
  prevToken = process.env.HUB_TOKEN
  process.env.HUB_TOKEN = TOKEN
  await db.schema.createTable('nivaro_rum_events', (t) => {
    t.increments('id')
    t.string('route', 300)
    t.string('kind', 20)
    t.uuid('user').nullable()
    t.dateTime('created_at')
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id')
    t.string('email').nullable()
    t.string('status')
    t.string('account_kind').nullable()
  })
  await db.schema.createTable('nivaro_external_apis', (t) => {
    t.increments('id')
    t.string('name')
    t.string('base_url', 1000)
    t.boolean('enabled')
    t.text('instance_overrides').nullable()
    t.text('auth_config').nullable()
  })
  await db.schema.createTable('nivaro_webhooks', (t) => {
    t.increments('id')
    t.string('name')
    t.string('url', 2000)
    t.boolean('enabled')
    t.string('secret').nullable()
  })

  // Yesterday: 8 people on the fleet screen; 2 people on a rare screen. Today: 3 people.
  const rows: Array<Record<string, unknown>> = []
  const yesterday = new Date('2026-11-24T10:00:00Z')
  for (let i = 1; i <= 8; i++)
    rows.push({ route: '/hub/fleet', kind: 'route', user: user(i), created_at: yesterday })
  for (let i = 1; i <= 2; i++)
    rows.push({
      route: '/collections/workflows/123',
      kind: 'route',
      user: user(i),
      created_at: yesterday
    })
  for (let i = 1; i <= 3; i++)
    rows.push({
      route: '/hub',
      kind: 'load',
      user: user(i),
      created_at: new Date('2026-11-25T09:00:00Z')
    })
  rows.push({ route: '/login', kind: 'load', user: null, created_at: yesterday })
  await db('nivaro_rum_events').insert(rows)
  await db('nivaro_users').insert([
    ...Array.from({ length: 12 }, (_, i) => ({
      id: user(i + 1),
      email: `p${i}@x.com`,
      status: 'active'
    })),
    { id: user(99), email: 'bot@x.com', status: 'active', account_kind: 'service' }
  ])
  await db('nivaro_external_apis').insert([
    {
      name: 'Fusion',
      base_url: 'https://svc:hunter2@fusion.oracle.example.com/fscm/rest?token=abc',
      enabled: true,
      auth_config: '{"password":"hunter2"}'
    },
    { name: 'Broken', base_url: '::not a url', enabled: false }
  ])
  await db('nivaro_webhooks').insert([
    { name: 'a', url: 'https://hooks.example.com/a?sig=1', enabled: true, secret: 's1' },
    { name: 'b', url: 'https://hooks.example.com/b', enabled: false, secret: 's2' }
  ])

  const { hubInsightLinkRoutes } = await import('../../../routes/hub-insight-link.js')
  app = Fastify()
  await app.register(hubInsightLinkRoutes, { prefix: '/hub-link' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevToken === undefined) delete process.env.HUB_TOKEN
  else process.env.HUB_TOKEN = prevToken
})

describe('usageReport', () => {
  it('counts people per day; a day under the floor carries no figures', async () => {
    const r = await usageReport({ days: 3, now: NOW })
    expect(r.available).toBe(true)
    expect(r.floor).toBe(5)
    expect(r.daily).toEqual([
      { day: '2026-11-23', people: 0, views: 0, under_floor: false },
      { day: '2026-11-24', people: 8, views: 10, under_floor: false },
      { day: '2026-11-25', people: null, views: null, under_floor: true }
    ])
    expect(r.people_window).toBe(8)
    expect(r.accounts).toBe(12)
  })

  it('lists only screens enough people opened, and never names anyone', async () => {
    const r = await usageReport({ days: 3, now: NOW })
    expect(r.screens).toEqual([{ route: '/hub/fleet', people: 8, views: 8 }])
    expect(r.screens_hidden).toBe(2)
    const text = JSON.stringify(r)
    expect(text).not.toMatch(/aaaaaaaa|@x\.com|\/123/)
  })

  it('never goes below a floor of 5, and a higher floor hides more', async () => {
    expect((await usageReport({ days: 3, floor: 1, now: NOW })).floor).toBe(5)
    const high = await usageReport({ days: 3, floor: 9, now: NOW })
    expect(high.daily[1]).toMatchObject({ people: null, under_floor: true })
    expect(high.screens).toEqual([])
    expect(high.accounts).toBe(12)
  })
})

describe('dependencyReport', () => {
  it('names hosts and extension ids only — never a path, query, user or secret', async () => {
    const r = await dependencyReport({
      oidcIssuer: () => 'https://login.microsoftonline.com/tid/v2.0'
    })
    expect(r.dependencies).toEqual([
      {
        kind: 'partner_api',
        target: 'fusion.oracle.example.com',
        label: 'Fusion',
        count: null,
        enabled: true
      },
      { kind: 'webhook', target: 'hooks.example.com', label: null, count: 2, enabled: true },
      {
        kind: 'mail',
        target: 'smtp.office365.com',
        label: 'Mail relay',
        count: null,
        enabled: true
      },
      {
        kind: 'signin',
        target: 'login.microsoftonline.com',
        label: 'Sign-in',
        count: null,
        enabled: true
      },
      { kind: 'extension', target: 'efp-ops', label: '2.1.0', count: null, enabled: true }
    ])
    const text = JSON.stringify(r)
    expect(text).not.toMatch(/hunter2|svc|token=|fscm|sig=|mailer|\/a\b|pw/)
  })
})

describe('the hub link routes', () => {
  it('refuse without the bearer and answer with it', async () => {
    expect((await app.inject({ url: '/hub-link/ops/usage' })).statusCode).toBe(401)
    const bad = await app.inject({
      url: '/hub-link/ops/dependencies',
      headers: { authorization: 'Bearer wrong' }
    })
    expect(bad.statusCode).toBe(401)
    const ok = await app.inject({
      url: '/hub-link/ops/usage?days=2&floor=5',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['cache-control']).toBe('no-store')
    expect(ok.json().days).toBe(2)
    const deps = await app.inject({
      url: '/hub-link/ops/dependencies',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(deps.statusCode).toBe(200)
    expect(deps.json().dependencies.length).toBeGreaterThan(0)
  })
})
