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

  await db.schema.createTable('nivaro_tracker_connections', (t) => {
    t.increments('id')
    t.string('provider', 20)
    t.string('base_url', 500)
    t.boolean('is_active')
    t.text('token').nullable()
    t.string('webhook_secret_hash').nullable()
  })
  await db('nivaro_tracker_connections').insert({
    provider: 'gitlab',
    base_url: 'https://gitlab.corp.example.com/group/project',
    is_active: false,
    token: 'sealed:glpat-secret',
    webhook_secret_hash: 'abc123hash'
  })
  // Completed days (NOW = 2026-11-25 15:00 UTC → the window is 11-11 … 11-24):
  //  11-24: 12 people on /hub/fleet; 2 + 5 people on single workflow ids (masked into one
  //         screen); 6 people on a slug page; rage clicks naming a person and widget rows
  //         (never counted); 11-20: 3 people (under the floor); 11-12: 2 more people (only in
  //         the long window — their difference must never show). Today: 9 people (never counted).
  const rows: Array<Record<string, unknown>> = []
  const at = (d: string) => new Date(`${d}T10:00:00Z`)
  for (let i = 1; i <= 12; i++)
    rows.push({ route: '/hub/fleet', kind: 'route', user: user(i), created_at: at('2026-11-24') })
  for (let i = 1; i <= 2; i++)
    rows.push({
      route: '/collections/workflows/123',
      kind: 'route',
      user: user(i),
      created_at: at('2026-11-24')
    })
  for (let i = 1; i <= 5; i++)
    rows.push({
      route: `/collections/workflows/${100 + i}`,
      kind: 'route',
      user: user(i),
      created_at: at('2026-11-24')
    })
  for (let i = 1; i <= 6; i++)
    rows.push({
      route: '/p/quarterly-plan-rob',
      kind: 'load',
      user: user(i),
      created_at: at('2026-11-24')
    })
  for (let i = 1; i <= 6; i++) {
    rows.push({
      route: "/hub/fleet :: button 'Rob Lee'",
      kind: 'rage',
      user: user(i),
      created_at: at('2026-11-24')
    })
    rows.push({
      route: 'widget:kpi@aaaaaaaa-0000-4000-8000-000000000999',
      kind: 'widget',
      user: user(i),
      created_at: at('2026-11-24')
    })
  }
  for (let i = 13; i <= 15; i++)
    rows.push({ route: '/hub', kind: 'load', user: user(i), created_at: at('2026-11-20') })
  for (let i = 16; i <= 17; i++)
    rows.push({ route: '/hub', kind: 'load', user: user(i), created_at: at('2026-11-12') })
  for (let i = 20; i <= 28; i++)
    rows.push({
      route: '/hub/fleet',
      kind: 'route',
      user: user(i),
      created_at: new Date('2026-11-25T09:00:00Z')
    })
  rows.push({ route: '/login', kind: 'load', user: null, created_at: at('2026-11-24') })
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
  it('counts completed days only, rounded down to 5; a day under the floor has no figures', async () => {
    const r = await usageReport({ now: NOW })
    expect(r.available).toBe(true)
    expect(r.floor).toBe(5)
    expect(r.days).toBe(14)
    expect(r.daily).toHaveLength(14)
    expect(r.daily[0].day).toBe('2026-11-11')
    expect(r.daily[13]).toEqual({ day: '2026-11-24', people: 10, views: 25, under_floor: false })
    expect(r.daily.find((d) => d.day === '2026-11-20')).toEqual({
      day: '2026-11-20',
      people: null,
      views: null,
      under_floor: true
    })
    expect(r.daily.find((d) => d.day === '2026-11-25')).toBeUndefined()
    expect(r.people_window).toBe(15)
    expect(r.accounts).toBe(10)
  })

  it('never lets two windows subtract into a handful of people', async () => {
    const r = await usageReport({ now: NOW })
    // 17 people in 14 days, 15 in the last 7: the 2 seen only in the first week stay hidden.
    expect(r.people_7d).toBeNull()
    const nums = [
      r.people_window,
      r.people_7d,
      r.accounts,
      ...r.daily.flatMap((d) => [d.people, d.views]),
      ...r.screens.flatMap((x) => [x.people, x.views])
    ].filter((n): n is number => n != null)
    for (const n of nums) expect(n % 5).toBe(0)
    if (r.people_window != null && r.people_7d != null) {
      const d = r.people_window - r.people_7d
      expect(d === 0 || d >= 5).toBe(true)
    }
  })

  it('answers the same all day: today and a different `days` never change it', async () => {
    const first = await usageReport({ now: NOW })
    await db('nivaro_rum_events').insert(
      Array.from({ length: 4 }, (_, i) => ({
        route: '/hub/secrets',
        kind: 'route',
        user: user(40 + i),
        created_at: new Date('2026-11-25T16:00:00Z')
      }))
    )
    const later = await usageReport({ days: 3, now: new Date('2026-11-25T23:59:00Z') })
    expect(later).toEqual(first)
  })

  it('counts page views per masked screen, never element text, widgets, slugs or ids', async () => {
    const r = await usageReport({ now: NOW })
    expect(r.screens).toEqual([
      { route: '/hub/fleet', people: 10, views: 10 },
      { route: '/collections/workflows/:id', people: 5, views: 5 },
      { route: '/hub', people: 5, views: 5 },
      { route: '/p/:id', people: 5, views: 5 }
    ])
    const text = JSON.stringify(r)
    expect(text).not.toMatch(/aaaaaaaa|@x\.com|\/123|Rob Lee|quarterly|widget|::/)
  })

  it('never goes below a floor of 5, and a higher floor hides more', async () => {
    expect((await usageReport({ floor: 1, now: NOW })).floor).toBe(5)
    const high = await usageReport({ floor: 9, now: NOW })
    expect(high.daily[13]).toMatchObject({ people: 10, under_floor: false })
    expect(high.screens.map((x) => x.route)).toEqual(['/hub/fleet'])
    expect(high.screens_hidden).toBe(3)
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
      {
        kind: 'tracker',
        target: 'gitlab.corp.example.com',
        label: 'gitlab',
        count: null,
        enabled: false
      },
      { kind: 'extension', target: 'efp-ops', label: '2.1.0', count: null, enabled: true }
    ])
    const text = JSON.stringify(r)
    expect(text).not.toMatch(/hunter2|svc|token=|fscm|sig=|mailer|\/a\b|pw|glpat|abc123hash|\/group/)
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
    // The window is fixed whatever the caller asks for.
    expect(ok.json().days).toBe(14)
    const deps = await app.inject({
      url: '/hub-link/ops/dependencies',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(deps.statusCode).toBe(200)
    expect(deps.json().dependencies.length).toBeGreaterThan(0)
  })
})
