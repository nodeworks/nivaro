import { rmSync } from 'node:fs'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6 Task 9 — the shared-readiness report a dedicated app gives the Hub before a
// move (Decision 12, rulings R1/R2). Real SQLite tables for what the report counts; the feature
// switches it asks (GitLab sync, Teams bot, huddles, mail retry, Hub sign-in, extensions) are
// mocked.

const h = vi.hoisted(() => ({
  dir: '',
  db: null as unknown,
  config: {
    NODE_ENV: 'production',
    DB_CLIENT: 'pg' as string,
    DB_MARIADB: false,
    DB_HOST: 'db-host',
    DB_PORT: undefined as number | undefined,
    DB_DATABASE: 'app_db',
    OIDC_ISSUER: 'https://login.microsoftonline.com/ABC-tenant/v2.0',
    OIDC_CLIENT_ID: '',
    OIDC_CLIENT_SECRET: '',
    GRAPH_TENANT_ID: '',
    GRAPH_CLIENT_ID: '',
    GRAPH_CLIENT_SECRET: ''
  },
  trackers: async () => false as boolean,
  teams: false,
  teamsSource: null as string | null,
  mailRetry: false,
  huddle: { turn_urls: [] as string[] },
  signin: null as unknown,
  extensions: new Map<string, unknown>()
}))

vi.mock('../../../db/index.js', async () => {
  if (h.db) return { db: h.db }
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  h.dir = mkdtempSync(join(tmpdir(), 'hub-shared-readiness-'))
  h.db = knex({
    client: 'better-sqlite3',
    connection: { filename: join(h.dir, 'app.sqlite') },
    useNullAsDefault: true,
    pool: { min: 1, max: 2, afterCreate: sqliteAfterCreate }
  })
  return { db: h.db }
})
vi.mock('../../../config.js', () => ({ config: h.config }))
vi.mock('../../../services/trackers/feature.js', () => ({
  trackersEnabled: () => h.trackers()
}))
vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: h.teams, source: h.teamsSource })
}))
vi.mock('../../../services/mail-retry-state.js', () => ({ mailRetryEnabled: () => h.mailRetry }))
vi.mock('../../../services/huddle-settings.js', () => ({
  getHuddleSettings: async () => h.huddle,
  sfuConfigured: () => false
}))
vi.mock('../../../services/hub-signin/config.js', () => ({ hubSigninConfig: () => h.signin }))
vi.mock('../../../extensions/loader.js', () => ({ extensionRegistry: h.extensions }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { computeSharedReadiness, SHARED_READINESS_BLOCKERS, oidcIdentity } = await import(
  '../../../services/hub-link/shared-readiness.js'
)
const { keyFingerprint } = await import('../../../services/app-key-fingerprint.js')

const SECRET = 'Quarterly-payroll-SECRET-7731'
const KEY = 'ab'.repeat(32)
const saved = { ...process.env }

beforeAll(async () => {
  await db.schema.createTable('nivaro_import_definitions', (t) => {
    t.string('key')
    t.string('label')
    t.boolean('is_active')
  })
  for (const name of ['nivaro_scheduled_reports', 'nivaro_retention_policies'])
    await db.schema.createTable(name, (t) => {
      t.increments('id')
      t.string('name')
      t.boolean('is_active')
      t.string('cron_schedule')
    })
  await db.schema.createTable('nivaro_flows', (t) => {
    t.string('id')
    t.string('name')
    t.string('status')
    t.string('trigger')
  })
  await db.schema.createTable('nivaro_flow_operations', (t) => {
    t.string('id')
    t.string('flow')
    t.string('type')
    t.text('options')
  })
  await db.schema.createTable('nivaro_files', (t) => {
    t.string('id')
    t.string('title')
    t.integer('filesize')
    t.string('storage_provider')
  })
  await db.schema.createTable('nivaro_settings', (t) => {
    t.integer('id')
    t.string('smtp_host')
    t.boolean('directory_sync_enabled')
    t.string('directory_graph_tenant_id')
    t.string('directory_graph_client_id')
    t.text('directory_graph_client_secret')
  })
  await db.schema.createTable('nivaro_push_subscriptions', (t) => {
    t.increments('id')
    t.string('endpoint')
  })
  await db.schema.createTable('nivaro_session_recordings', (t) => {
    t.increments('id')
    t.string('page')
  })
})

afterAll(async () => {
  await db.destroy()
  if (h.dir) rmSync(h.dir, { recursive: true, force: true })
})

beforeEach(async () => {
  for (const t of [
    'nivaro_import_definitions',
    'nivaro_scheduled_reports',
    'nivaro_retention_policies',
    'nivaro_flows',
    'nivaro_flow_operations',
    'nivaro_files',
    'nivaro_settings',
    'nivaro_push_subscriptions',
    'nivaro_session_recordings'
  ])
    await db(t).del()
  await db('nivaro_settings').insert({ id: 1, smtp_host: null, directory_sync_enabled: false })
  h.config.DB_CLIENT = 'pg'
  h.trackers = async () => false
  h.teams = false
  h.teamsSource = null
  for (const k of [
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'GRAPH_TENANT_ID',
    'GRAPH_CLIENT_ID',
    'GRAPH_CLIENT_SECRET'
  ] as const)
    h.config[k] = ''
  h.config.OIDC_ISSUER = 'https://login.microsoftonline.com/ABC-tenant/v2.0'
  h.mailRetry = false
  h.huddle = { turn_urls: [] }
  h.signin = null
  h.extensions.clear()
  process.env = { ...saved }
  delete process.env.STORAGE_PROVIDER
  delete process.env.SMTP_HOST
  delete process.env.MOBILE_PUSH_RELAY_KEY
  process.env.ENCRYPTION_KEY = KEY
})

const codeOf = (r: Awaited<ReturnType<typeof computeSharedReadiness>>, code: string) =>
  r.codes.find((c) => c.code === code)

describe('computeSharedReadiness', () => {
  it('a plain app reports no codes, its key fingerprint and its sign-in issuer', async () => {
    const r = await computeSharedReadiness()
    expect(r.codes).toEqual([])
    expect(r.key_fp).toBe(keyFingerprint(KEY))
    expect(r.oidc).toEqual({ issuer_host: 'login.microsoftonline.com', tenant: 'abc-tenant' })
    expect(r.signin_hub).toBe(false)
    expect(r.busy).toEqual({ imports: 0, exports: 0, renders: 0 })
    expect(typeof r.version).toBe('string')
  })

  it('never sends the key itself; a malformed key has no fingerprint', async () => {
    const r = await computeSharedReadiness()
    expect(JSON.stringify(r)).not.toContain(KEY)
    process.env.ENCRYPTION_KEY = 'short'
    expect((await computeSharedReadiness()).key_fp).toBeNull()
  })

  it('staged imports and row schedules run per app on a shared deployment: no longer reported', async () => {
    await db('nivaro_import_definitions').insert({ key: 'po', label: SECRET, is_active: true })
    await db('nivaro_scheduled_reports').insert({
      name: SECRET,
      is_active: true,
      cron_schedule: '0 9 * * 1'
    })
    await db('nivaro_flows').insert({ id: 'f1', name: 'f', status: 'active', trigger: 'schedule' })
    const r = await computeSharedReadiness()
    expect(codeOf(r, 'STAGED_IMPORTS')).toBeUndefined()
    expect(codeOf(r, 'ROW_SCHEDULES')).toBeUndefined()
    expect([...SHARED_READINESS_BLOCKERS]).toEqual([
      'ISSUE_TRACKERS',
      'EXEC_SCRIPT_FLOWS',
      'SQLITE',
      'ENV_OBJECT_STORAGE'
    ])
  })

  it('an active flow with a script step → EXEC_SCRIPT_FLOWS; an inactive one does not count', async () => {
    await db('nivaro_flows').insert([
      { id: 'a', name: 'a', status: 'active', trigger: 'manual' },
      { id: 'b', name: 'b', status: 'inactive', trigger: 'manual' }
    ])
    await db('nivaro_flow_operations').insert([
      { id: 'o1', flow: 'a', type: 'exec-script', options: SECRET },
      { id: 'o2', flow: 'a', type: 'exec-script', options: '' },
      { id: 'o3', flow: 'b', type: 'exec-script', options: '' }
    ])
    const r = await computeSharedReadiness()
    expect(codeOf(r, 'EXEC_SCRIPT_FLOWS')).toMatchObject({
      level: 'blocker',
      detail: '1 active flow runs a script step'
    })
  })

  it('DB_CLIENT=sqlite → blocker SQLITE and no database identity', async () => {
    h.config.DB_CLIENT = 'sqlite'
    const r = await computeSharedReadiness()
    expect(codeOf(r, 'SQLITE')?.level).toBe('blocker')
    expect(r.db_identity).toBeNull()
  })

  it('env object storage → blocker ENV_OBJECT_STORAGE (ruling R1)', async () => {
    process.env.STORAGE_PROVIDER = 's3'
    const r = await computeSharedReadiness()
    expect(codeOf(r, 'ENV_OBJECT_STORAGE')?.level).toBe('blocker')
    expect(SHARED_READINESS_BLOCKERS).toContain('ENV_OBJECT_STORAGE')
  })

  it('GitLab sync on with a connection → ISSUE_TRACKERS; an unreadable blocker says so', async () => {
    h.trackers = async () => {
      throw new Error('settings table locked')
    }
    const r = await computeSharedReadiness()
    expect(codeOf(r, 'ISSUE_TRACKERS')).toEqual({
      code: 'ISSUE_TRACKERS',
      level: 'blocker',
      detail: 'Could not be checked.'
    })
    expect(JSON.stringify(r)).not.toContain('locked')
  })

  it('warnings: env SMTP, huddle TURN, replays; mail retry, Teams bot, directory sync and phones run per app now', async () => {
    process.env.SMTP_HOST = 'smtp.internal'
    h.mailRetry = true
    h.teams = true
    h.teamsSource = 'settings'
    h.huddle = { turn_urls: ['turn:a', 'turn:b'] }
    await db('nivaro_settings').update({ directory_sync_enabled: true })
    await db('nivaro_push_subscriptions').insert({ endpoint: 'relay:dev-1' })
    await db('nivaro_session_recordings').insert([{ page: SECRET }, { page: 'b' }])
    const r = await computeSharedReadiness()
    for (const code of ['ENV_SMTP', 'HUDDLE_TURN', 'SESSION_REPLAYS'])
      expect(codeOf(r, code)?.level, code).toBe('warning')
    for (const code of ['MAIL_RETRY', 'TEAMS_BOT', 'DIRECTORY_SYNC', 'PHONE_PUSH'])
      expect(codeOf(r, code), code).toBeUndefined()
    // Nothing set by the server environment here: no env-credential warnings either.
    for (const code of ['DIRECTORY_ENV_CREDENTIALS', 'TEAMS_BOT_ENV_CREDENTIALS', 'PUSH_RELAY_ENV'])
      expect(codeOf(r, code), code).toBeUndefined()
    expect(codeOf(r, 'SESSION_REPLAYS')?.detail).toBe('2 session replays stay behind')
    expect(codeOf(r, 'HUDDLE_TURN')?.detail).toContain('2 TURN servers')
    expect(JSON.stringify(r)).not.toContain('smtp.internal')
    // SMTP saved in Settings travels with the database: no warning.
    await db('nivaro_settings').update({ smtp_host: 'smtp.saved' })
    expect(codeOf(await computeSharedReadiness(), 'ENV_SMTP')).toBeUndefined()
  })

  it('directory sync with the server env app registration and none saved → DIRECTORY_ENV_CREDENTIALS', async () => {
    const DETAIL =
      "This app reads the directory with the server's Microsoft app; save its own app registration in Settings before the move"
    h.config.GRAPH_TENANT_ID = 'graph-tenant'
    h.config.GRAPH_CLIENT_ID = 'graph-client'
    h.config.GRAPH_CLIENT_SECRET = SECRET
    // Sync off: nothing reads the directory on a schedule.
    expect(codeOf(await computeSharedReadiness(), 'DIRECTORY_ENV_CREDENTIALS')).toBeUndefined()
    await db('nivaro_settings').update({ directory_sync_enabled: true })
    const r = await computeSharedReadiness()
    expect(codeOf(r, 'DIRECTORY_ENV_CREDENTIALS')).toEqual({
      code: 'DIRECTORY_ENV_CREDENTIALS',
      level: 'warning',
      detail: DETAIL
    })
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(JSON.stringify(r)).not.toContain('graph-client')
    // The OIDC sign-in app is the fallback the directory uses when GRAPH_* is not set.
    h.config.GRAPH_TENANT_ID = ''
    h.config.GRAPH_CLIENT_ID = ''
    h.config.GRAPH_CLIENT_SECRET = ''
    h.config.OIDC_CLIENT_ID = 'oidc-client'
    h.config.OIDC_CLIENT_SECRET = 'oidc-secret'
    expect(codeOf(await computeSharedReadiness(), 'DIRECTORY_ENV_CREDENTIALS')?.detail).toBe(DETAIL)
    // A complete saved registration travels with the database: no warning.
    await db('nivaro_settings').update({
      directory_graph_tenant_id: 't',
      directory_graph_client_id: 'c',
      directory_graph_client_secret: 'enc:v1:sealed'
    })
    expect(codeOf(await computeSharedReadiness(), 'DIRECTORY_ENV_CREDENTIALS')).toBeUndefined()
    // No env registration at all: the directory does not work today either.
    await db('nivaro_settings').update({
      directory_graph_tenant_id: null,
      directory_graph_client_id: null,
      directory_graph_client_secret: null
    })
    h.config.OIDC_CLIENT_ID = ''
    h.config.OIDC_CLIENT_SECRET = ''
    expect(codeOf(await computeSharedReadiness(), 'DIRECTORY_ENV_CREDENTIALS')).toBeUndefined()
  })

  it('a Teams bot from an env family or the sign-in app → TEAMS_BOT_ENV_CREDENTIALS; one saved in Settings → none', async () => {
    const DETAIL =
      "This app's bot is set by the server environment; save the bot in Settings before the move"
    h.teams = true
    for (const source of ['env', 'sign_in_app']) {
      h.teamsSource = source
      expect(codeOf(await computeSharedReadiness(), 'TEAMS_BOT_ENV_CREDENTIALS'), source).toEqual({
        code: 'TEAMS_BOT_ENV_CREDENTIALS',
        level: 'warning',
        detail: DETAIL
      })
    }
    h.teamsSource = 'settings'
    expect(codeOf(await computeSharedReadiness(), 'TEAMS_BOT_ENV_CREDENTIALS')).toBeUndefined()
    h.teams = false
    h.teamsSource = 'env'
    expect(codeOf(await computeSharedReadiness(), 'TEAMS_BOT_ENV_CREDENTIALS')).toBeUndefined()
  })

  it("phones on the relay with the server's env relay key → PUSH_RELAY_ENV", async () => {
    const DETAIL =
      "Phones get alerts through the server's relay key; connect this app's own relay in Settings after the move"
    process.env.MOBILE_PUSH_RELAY_KEY = SECRET
    // No phones: nothing to lose. A phone on the app's own Expo build is sent to Expo directly.
    expect(codeOf(await computeSharedReadiness(), 'PUSH_RELAY_ENV')).toBeUndefined()
    await db('nivaro_push_subscriptions').insert({ endpoint: 'expo:ExponentPushToken[x]' })
    expect(codeOf(await computeSharedReadiness(), 'PUSH_RELAY_ENV')).toBeUndefined()
    await db('nivaro_push_subscriptions').insert({ endpoint: 'relay:dev-1' })
    const r = await computeSharedReadiness()
    expect(codeOf(r, 'PUSH_RELAY_ENV')).toEqual({
      code: 'PUSH_RELAY_ENV',
      level: 'warning',
      detail: DETAIL
    })
    expect(JSON.stringify(r)).not.toContain(SECRET)
    // A key stored in the app's settings travels with the database.
    delete process.env.MOBILE_PUSH_RELAY_KEY
    expect(codeOf(await computeSharedReadiness(), 'PUSH_RELAY_ENV')).toBeUndefined()
  })

  it('counts files (local ones apart) and lists loaded extensions with their version', async () => {
    await db('nivaro_files').insert([
      { id: '1', title: SECRET, filesize: 100, storage_provider: null },
      { id: '2', title: 'b', filesize: 50, storage_provider: 'local' },
      { id: '3', title: 'c', filesize: 7, storage_provider: 's3' }
    ])
    h.extensions.set('efp-ops', { status: 'loaded', enabled: true, manifest: { version: '1.2.0' } })
    h.extensions.set('broken', { status: 'error', enabled: true })
    h.signin = { hubUrl: 'https://hub.test' }
    const r = await computeSharedReadiness()
    // No `storage` column (a table from before it): no saved-settings objects (P6-31).
    expect(r.files).toEqual({ count: 3, bytes: 157, local: 2, objects: {} })
    expect(r.extensions).toEqual({ 'efp-ops': '1.2.0' })
    expect(r.signin_hub).toBe(true)
  })

  it('the report never contains a record field value', async () => {
    await db('nivaro_import_definitions').insert({ key: 'k', label: SECRET, is_active: true })
    await db('nivaro_scheduled_reports').insert({
      name: SECRET,
      is_active: true,
      cron_schedule: '* * * * *'
    })
    await db('nivaro_files').insert({ id: '1', title: SECRET, filesize: 1, storage_provider: null })
    await db('nivaro_session_recordings').insert({ page: SECRET })
    const r = await computeSharedReadiness()
    expect(r.codes.length).toBeGreaterThan(0)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })
})

describe('oidcIdentity', () => {
  it('host plus the Entra tenant; no tenant for a versioned path; null for nothing', () => {
    expect(oidcIdentity('https://login.microsoftonline.com/T1/v2.0')).toEqual({
      issuer_host: 'login.microsoftonline.com',
      tenant: 't1'
    })
    expect(oidcIdentity('https://idp.example.test/v2')).toEqual({
      issuer_host: 'idp.example.test',
      tenant: null
    })
    expect(oidcIdentity('')).toBeNull()
    expect(oidcIdentity('not a url')).toBeNull()
  })
})
