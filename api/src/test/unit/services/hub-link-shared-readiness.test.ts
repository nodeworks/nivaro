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
    OIDC_ISSUER: 'https://login.microsoftonline.com/ABC-tenant/v2.0'
  },
  trackers: async () => false as boolean,
  teams: false,
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
  getTeamsBotConfig: async () => ({ enabled: h.teams })
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
    'nivaro_session_recordings'
  ])
    await db(t).del()
  await db('nivaro_settings').insert({ id: 1, smtp_host: null, directory_sync_enabled: false })
  h.config.DB_CLIENT = 'pg'
  h.trackers = async () => false
  h.teams = false
  h.mailRetry = false
  h.huddle = { turn_urls: [] }
  h.signin = null
  h.extensions.clear()
  process.env = { ...saved }
  delete process.env.STORAGE_PROVIDER
  delete process.env.SMTP_HOST
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

  it('an active import definition → blocker STAGED_IMPORTS', async () => {
    await db('nivaro_import_definitions').insert([
      { key: 'po', label: SECRET, is_active: true },
      { key: 'old', label: 'x', is_active: false }
    ])
    const r = await computeSharedReadiness()
    expect(codeOf(r, 'STAGED_IMPORTS')).toEqual({
      code: 'STAGED_IMPORTS',
      level: 'blocker',
      detail: '1 import definition uses staged imports'
    })
  })

  it('scheduled reports and a retention policy → ROW_SCHEDULES with counts, names never sent', async () => {
    await db('nivaro_scheduled_reports').insert([
      { name: SECRET, is_active: true, cron_schedule: '0 9 * * 1' },
      { name: 'b', is_active: true, cron_schedule: '0 9 * * 2' },
      { name: 'c', is_active: true, cron_schedule: '0 9 * * 3' },
      { name: 'off', is_active: false, cron_schedule: '0 9 * * 4' },
      { name: 'manual', is_active: true, cron_schedule: '' }
    ])
    await db('nivaro_retention_policies').insert({
      name: 'r',
      is_active: true,
      cron_schedule: '0 2 * * *'
    })
    await db('nivaro_flows').insert({
      id: 'f1',
      name: SECRET,
      status: 'active',
      trigger: 'schedule'
    })
    const r = await computeSharedReadiness()
    expect(codeOf(r, 'ROW_SCHEDULES')).toEqual({
      code: 'ROW_SCHEDULES',
      level: 'blocker',
      detail: '3 scheduled reports, 1 retention policy, 1 scheduled flow'
    })
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

  it('warnings: env SMTP, mail retry, Teams bot, huddle TURN, directory sync, replays', async () => {
    process.env.SMTP_HOST = 'smtp.internal'
    h.mailRetry = true
    h.teams = true
    h.huddle = { turn_urls: ['turn:a', 'turn:b'] }
    await db('nivaro_settings').update({ directory_sync_enabled: true })
    await db('nivaro_session_recordings').insert([{ page: SECRET }, { page: 'b' }])
    const r = await computeSharedReadiness()
    for (const code of [
      'ENV_SMTP',
      'MAIL_RETRY',
      'TEAMS_BOT',
      'HUDDLE_TURN',
      'DIRECTORY_SYNC',
      'SESSION_REPLAYS'
    ])
      expect(codeOf(r, code)?.level, code).toBe('warning')
    expect(codeOf(r, 'SESSION_REPLAYS')?.detail).toBe('2 session replays stay behind')
    // E2E B M1: the move plan shows "<title>: <detail>" ("Automatic mail retry is off on a shared
    // deployment: …"), so the detail says what this app does today, never "… is on".
    expect(codeOf(r, 'MAIL_RETRY')?.detail).toBe('This app retries failed mail automatically today')
    expect(codeOf(r, 'TEAMS_BOT')?.detail).toBe('This app answers in Teams through its bot today')
    expect(codeOf(r, 'DIRECTORY_SYNC')?.detail).toBe(
      'This app syncs people from the directory today'
    )
    expect(codeOf(r, 'HUDDLE_TURN')?.detail).toContain('2 TURN servers')
    expect(JSON.stringify(r)).not.toContain('smtp.internal')
    // SMTP saved in Settings travels with the database: no warning.
    await db('nivaro_settings').update({ smtp_host: 'smtp.saved' })
    expect(codeOf(await computeSharedReadiness(), 'ENV_SMTP')).toBeUndefined()
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
