import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6 Task 9 fix round 1 (review Minor 7): a warning check that throws is left
// out of the report, so a wrong column name would hide it. These checks run over tables made by
// the REAL migrations (149 push subscriptions, 154 session recordings, 313 directory sync, 407
// help videos, 554 the app's own directory app registration), with only the base tables they
// reference stubbed.

const h = vi.hoisted(() => ({ dir: '', db: null as unknown }))

vi.mock('../../../db/index.js', async () => {
  if (h.db) return { db: h.db }
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  h.dir = mkdtempSync(join(tmpdir(), 'hub-readiness-migrated-'))
  h.db = knex({
    client: 'better-sqlite3',
    connection: { filename: join(h.dir, 'app.sqlite') },
    useNullAsDefault: true,
    pool: { min: 1, max: 2, afterCreate: sqliteAfterCreate }
  })
  return { db: h.db }
})
vi.mock('../../../config.js', () => ({
  config: {
    NODE_ENV: 'production',
    DB_CLIENT: 'pg',
    DB_MARIADB: false,
    OIDC_ISSUER: '',
    GRAPH_TENANT_ID: 'graph-tenant',
    GRAPH_CLIENT_ID: 'graph-client',
    GRAPH_CLIENT_SECRET: 'graph-secret'
  }
}))
vi.mock('../../../services/trackers/feature.js', () => ({ trackersEnabled: async () => false }))
vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: false })
}))
vi.mock('../../../services/mail-retry-state.js', () => ({ mailRetryEnabled: () => false }))
vi.mock('../../../services/huddle-settings.js', () => ({
  getHuddleSettings: async () => ({ turn_urls: [] }),
  sfuConfigured: () => false
}))
vi.mock('../../../services/hub-signin/config.js', () => ({ hubSigninConfig: () => null }))
vi.mock('../../../extensions/loader.js', () => ({ extensionRegistry: new Map() }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { computeSharedReadiness } = await import('../../../services/hub-link/shared-readiness.js')
const MIGRATIONS = [
  '149_push_subscriptions',
  '154_session_recordings',
  '313_directory_sync',
  '407_help_videos',
  '554_directory_graph_app'
]

beforeAll(async () => {
  // Base tables the four migrations reference or alter (000_base_schema makes them for real).
  await db.schema.createTable('nivaro_users', (t) => t.uuid('id').primary())
  await db.schema.createTable('nivaro_roles', (t) => t.uuid('id').primary())
  await db.schema.createTable('nivaro_files', (t) => {
    t.uuid('id').primary()
    t.integer('filesize')
    t.string('storage_provider')
    t.string('storage')
    t.string('filename_disk')
  })
  await db.schema.createTable('nivaro_settings', (t) => {
    t.integer('id').primary()
    t.string('smtp_host')
  })
  for (const name of MIGRATIONS) {
    const m = (await import(`../../../db/migrations/${name}.ts`)) as {
      up: (k: Knex) => Promise<void>
    }
    await m.up(db)
  }
})

afterAll(async () => {
  await db.destroy()
  if (h.dir) rmSync(h.dir, { recursive: true, force: true })
})

describe('warnings over the real migrated columns', () => {
  it('env directory and relay credentials, session replays, help videos and queued renders are seen', async () => {
    process.env.MOBILE_PUSH_RELAY_KEY = 'relay-key'
    const user = randomUUID()
    const file = randomUUID()
    const video = randomUUID()
    await db('nivaro_users').insert({ id: user })
    await db('nivaro_files').insert({
      id: file,
      filesize: 10,
      storage_provider: 'local',
      storage: 'local',
      filename_disk: 'a.bin'
    })
    // P6-31: a saved-settings S3 object is counted per provider.
    await db('nivaro_files').insert({
      id: randomUUID(),
      filesize: 5,
      storage_provider: 's3',
      storage: 's3',
      filename_disk: 'b.bin'
    })
    await db('nivaro_settings').insert({ id: 1, directory_sync_enabled: true })
    await db('nivaro_push_subscriptions').insert({
      user,
      endpoint: 'relay:device-1',
      endpoint_hash: 'h1',
      keys_p256dh: '-',
      keys_auth: '-'
    })
    await db('nivaro_session_recordings').insert({ id: randomUUID(), user, started_at: new Date() })
    const now = new Date()
    await db('nivaro_help_videos').insert({ id: video, created_at: now, updated_at: now })
    await db('nivaro_help_video_versions').insert({
      id: randomUUID(),
      video_id: video,
      version: 1,
      source_file: file,
      edits: '{}',
      edits_hash: 'x',
      render_status: 'queued',
      created_at: now
    })

    const r = await computeSharedReadiness()
    delete process.env.MOBILE_PUSH_RELAY_KEY
    const codes = Object.fromEntries(r.codes.map((c) => [c.code, c]))
    // Directory sync and phone push run per app on a shared deployment now: only the server's own
    // credentials they use today are warned about.
    expect(codes.DIRECTORY_SYNC).toBeUndefined()
    expect(codes.PHONE_PUSH).toBeUndefined()
    expect(codes.DIRECTORY_ENV_CREDENTIALS?.level).toBe('warning')
    expect(codes.PUSH_RELAY_ENV?.level).toBe('warning')
    expect(JSON.stringify(r)).not.toMatch(/graph-secret|relay-key/)
    expect(codes.SESSION_REPLAYS?.detail).toBe('1 session replay stays behind')
    expect(codes.HELP_VIDEO_RENDERS?.level).toBe('warning')
    expect(r.busy.renders).toBe(1)
    expect(r.files).toEqual({ count: 2, bytes: 15, local: 1, objects: { s3: 1 } })
  })
})
