import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub enhancements 10 + 20, app side: GET /api/hub-link/ops/{issues,files}. In-memory SQLite with
// the issue log and files tables. Bearer only; scrubbed titles, counts and ids — never a stack,
// a person or a file name.

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

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { hubOpsLinkRoutes } = await import('../../../routes/hub-ops-link.js')
const { hubSafeTitle, issueRollup, issueSignature, filesUsage } = await import(
  '../../../services/hub-link/ops-report.js'
)

const TOKEN = 'h'.repeat(40)
const PERSON_A = 'AAAAAAAA-0000-4000-8000-000000000001'
const PERSON_B = 'BBBBBBBB-0000-4000-8000-000000000002'
const saved = { HUB_TOKEN: process.env.HUB_TOKEN, CLOUD: process.env.CLOUD_META_DB_URL }
let app: FastifyInstance | null = null

const crashDetails = (release: string) =>
  [
    'Route: /collections/:id',
    `Crash: app=admin;release=${release};kind=error;sig=abc;family=fam1`,
    'TypeError: x.find is not a function',
    '    at Grid (assets/Grid.js:1:2)'
  ].join('\n')

beforeAll(async () => {
  await db.schema.createTable('nivaro_issues', (t) => {
    t.increments('id')
    t.string('title', 500)
    t.string('source', 20)
    t.string('status', 20)
    t.string('severity', 20)
    t.string('fingerprint', 64)
    t.integer('occurrence_count')
    t.text('details')
    t.string('raised_by', 36)
    t.datetime('created_at')
    t.datetime('last_seen_at')
  })
  await db.schema.createTable('nivaro_issue_occurrences', (t) => {
    t.increments('id')
    t.integer('issue')
    t.string('user_id', 36)
    t.string('build', 64)
  })
  await db.schema.createTable('nivaro_files', (t) => {
    t.string('id', 36)
    t.string('storage', 100)
    t.string('filename_download', 255)
    t.bigInteger('filesize')
  })
  const now = new Date()
  await db('nivaro_issues').insert([
    {
      id: 1,
      title:
        '[server] /api/items/workflows: Workflow 372787 for "Jane Smith" jane@example.com failed',
      source: 'server',
      status: 'open',
      severity: 'high',
      fingerprint: 'f'.repeat(64),
      occurrence_count: 4,
      details: 'Error: boom\n    at secret (/app/x.js:1:1)',
      raised_by: null,
      created_at: now,
      last_seen_at: now
    },
    {
      id: 2,
      title: '/collections/:id: x.find is not a function',
      source: 'client',
      status: 'acknowledged',
      severity: 'high',
      fingerprint: 'c'.repeat(64),
      occurrence_count: 3,
      details: crashDetails('0.3.215'),
      raised_by: PERSON_A,
      created_at: now,
      last_seen_at: now
    },
    {
      id: 3,
      title: 'Please fix the budget page for Bob',
      source: 'manual',
      status: 'open',
      severity: 'low',
      fingerprint: null,
      occurrence_count: 1,
      details: null,
      raised_by: PERSON_A,
      created_at: now,
      last_seen_at: now
    },
    {
      id: 4,
      title: '[server] old',
      source: 'server',
      status: 'resolved',
      severity: 'low',
      fingerprint: 'e'.repeat(64),
      occurrence_count: 1,
      details: null,
      raised_by: null,
      created_at: new Date(Date.now() - 200 * 86_400_000),
      last_seen_at: new Date(Date.now() - 200 * 86_400_000)
    },
    {
      // The same crash family in the previous release: folds into issue 2's group.
      id: 5,
      title: '/collections/:id: x.find is not a function',
      source: 'client',
      status: 'resolved',
      severity: 'critical',
      fingerprint: 'd'.repeat(64),
      occurrence_count: 2,
      details: crashDetails('0.3.214'),
      raised_by: null,
      created_at: new Date(Date.now() - 5 * 86_400_000),
      last_seen_at: new Date(Date.now() - 2 * 86_400_000)
    }
  ])
  await db('nivaro_issue_occurrences').insert([
    { issue: 2, user_id: PERSON_A, build: '0.3.215' },
    { issue: 5, user_id: PERSON_A, build: '0.3.214' },
    { issue: 2, user_id: PERSON_B, build: '0.3.215' },
    { issue: 1, user_id: PERSON_B, build: '0.3.214' }
  ])
  await db('nivaro_files').insert([
    { id: 'a', storage: 'local', filename_download: 'payroll.xlsx', filesize: 1000 },
    { id: 'b', storage: 'local', filename_download: 'x.pdf', filesize: 500 },
    { id: 'c', storage: 's3', filename_download: 'y.pdf', filesize: 2000 }
  ])
})

afterAll(async () => {
  await db.destroy()
})

afterEach(async () => {
  await app?.close()
  app = null
  if (saved.HUB_TOKEN === undefined) delete process.env.HUB_TOKEN
  else process.env.HUB_TOKEN = saved.HUB_TOKEN
  if (saved.CLOUD === undefined) delete process.env.CLOUD_META_DB_URL
  else process.env.CLOUD_META_DB_URL = saved.CLOUD
})

async function build(): Promise<FastifyInstance> {
  process.env.HUB_TOKEN = TOKEN
  delete process.env.CLOUD_META_DB_URL
  const a = Fastify()
  await a.register(hubOpsLinkRoutes, { prefix: '/api/hub-link' })
  await a.ready()
  app = a
  return a
}

describe('ops report', () => {
  it('hubSafeTitle drops emails, quoted values and long numbers', () => {
    const t = hubSafeTitle('Workflow 372787 for "Jane Smith" jane@example.com failed')
    expect(t).not.toContain('372787')
    expect(t).not.toContain('Jane')
    expect(t).not.toContain('jane@example.com')
    expect(t).toContain('Workflow #')
  })

  it('the SQL Server duplicate-key message keeps no value', () => {
    const t = hubSafeTitle(
      "[server] /api/items/users: Cannot insert duplicate key row in object 'dbo.users' with unique index 'ux_users_email'. The duplicate key value is (Smith, Jane)."
    )
    expect(t).toBe(
      "/api/items/users: Cannot insert duplicate key row in object 'dbo.users' with unique index 'ux_users_email'. The duplicate key value is (…)."
    )
  })

  it('an extension title loses its name, its record number, ids and key=value data', () => {
    const t = hubSafeTitle(
      '[server] /api/efp/push: MDSi push failed for CM26-79704 (Jane Smith) order=PO-1182 user 3f2a9c1e-1b2c-4d5e-8f90-123456789abc by Jane Smith'
    )
    expect(t).not.toMatch(/Jane|Smith|79704|1182|3f2a9c1e/)
    expect(t).toContain('/api/efp/push: MDSi push failed for CM26-# (…)')
    expect(t).toContain('order=…')
  })

  it('a route carrying an email, a record id or a GUID is scrubbed too', () => {
    expect(hubSafeTitle('[server] /api/users/jane.smith@example.com: boom')).not.toContain('jane')
    expect(hubSafeTitle('[server] /api/items/workflows/372787: boom')).toBe(
      '/api/items/workflows/#: boom'
    )
    expect(
      hubSafeTitle('[server] /api/users/3f2a9c1e-1b2c-4d5e-8f90-123456789abc/roles: boom')
    ).not.toContain('3f2a9c1e')
    expect(hubSafeTitle('[server] /api/items/:collection/:id: boom')).toBe(
      '/api/items/:collection/:id: boom'
    )
  })

  it('code words stay readable', () => {
    expect(hubSafeTitle("/x: Cannot read properties of undefined (reading 'find')")).toBe(
      "/x: Cannot read properties of undefined (reading 'find')"
    )
  })

  it('the same server fingerprint in two apps is one signature; a crash folds across releases', () => {
    const a = issueSignature({ source: 'server', fingerprint: 'F'.repeat(64) })
    const b = issueSignature({ source: 'server', fingerprint: 'f'.repeat(64) })
    expect(a).toEqual(b)
    expect(a.sig).toMatch(/^[a-f0-9]{40}$/)
    const c1 = issueSignature({ source: 'client', details: crashDetails('0.3.214') })
    const c2 = issueSignature({ source: 'client', details: crashDetails('0.3.215') })
    expect(c1.sig).toBe(c2.sig)
    expect(c1.kind).toBe('crash')
  })

  it('rolls up server + client issues of the window; never manual issues, stacks or people', async () => {
    const r = await issueRollup({ days: 30 })
    expect(r.groups.map((g) => g.issue_id).sort()).toEqual([1, 2])
    const crash = r.groups.find((g) => g.issue_id === 2)
    // Issues 2 and 5 are one crash family: one group, hits summed, each person once, the
    // highest severity, open while any row is, the newest row's release and id.
    expect(crash).toMatchObject({
      kind: 'crash',
      count: 5,
      severity: 'critical',
      people: 2,
      release: '0.3.215',
      screen: '/collections/:id',
      status: 'acknowledged'
    })
    const server = r.groups.find((g) => g.issue_id === 1)
    expect(server).toMatchObject({ kind: 'server', people: 1, release: '0.3.214', screen: null })
    const text = JSON.stringify(r)
    expect(text).not.toContain('jane@example.com')
    expect(text).not.toContain('secret')
    expect(text).not.toContain(PERSON_A)
    expect(text).not.toContain('Bob')
  })

  it('files usage: counts and bytes per storage, no names', async () => {
    const f = await filesUsage()
    expect(f).toMatchObject({ files: 3, bytes: 3500 })
    expect(f.by_storage).toEqual([
      { storage: 's3', files: 1, bytes: 2000 },
      { storage: 'local', files: 2, bytes: 1500 }
    ])
    expect(JSON.stringify(f)).not.toContain('payroll')
  })
})

describe('GET /api/hub-link/ops/*', () => {
  it('refuses without the bearer', async () => {
    const a = await build()
    const res = await a.inject({ method: 'GET', url: '/api/hub-link/ops/issues' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('HUB_LINK_REFUSED')
  })

  it('answers the rollup and the files usage with the bearer, no-store', async () => {
    const a = await build()
    const auth = { authorization: `Bearer ${TOKEN}` }
    const issues = await a.inject({
      method: 'GET',
      url: '/api/hub-link/ops/issues?days=7',
      headers: auth
    })
    expect(issues.statusCode).toBe(200)
    expect(issues.headers['cache-control']).toBe('no-store')
    expect(issues.json().window_days).toBe(7)
    const files = await a.inject({ method: 'GET', url: '/api/hub-link/ops/files', headers: auth })
    expect(files.json().files).toBe(3)
  })

  it('is not mounted without HUB_TOKEN', async () => {
    delete process.env.HUB_TOKEN
    const a = Fastify()
    await a.register(hubOpsLinkRoutes, { prefix: '/api/hub-link' })
    await a.ready()
    app = a
    const res = await a.inject({ method: 'GET', url: '/api/hub-link/ops/files' })
    expect(res.statusCode).toBe(404)
  })
})
