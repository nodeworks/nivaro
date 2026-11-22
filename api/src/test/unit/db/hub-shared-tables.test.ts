import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { up as up542 } from '../../../db/migrations/542_hub_tables.js'
import { up as up543 } from '../../../db/migrations/543_hub_promotions.js'
import { up as up552 } from '../../../db/migrations/552_hub_shared_deployments.js'
import { up as up553 } from '../../../db/migrations/553_hub_moves.js'
import { sqliteAfterCreate, sqliteCompat } from '../../../db/sqlite.js'
import { isRedactedColumn } from '../../../services/secret-columns.js'
import { sensitiveColumns } from '../../../services/system-collections.js'

// Nivaro Hub phase 6, Task 1: shared deployments, shared deploys and moves (552–553). Guarded,
// additive, no foreign keys; existing deploy rows keep the new links null.

sqliteCompat()

const SHARED_COLS = [
  'id',
  'key',
  'name',
  'mode',
  'driver_id',
  'stack',
  'version_pin',
  'extensions',
  'extension_pins',
  'host_pattern',
  'link_url',
  'pool_budget',
  'status',
  'settings',
  'secrets',
  'token',
  'token_lookup',
  'prev_token',
  'prev_token_lookup',
  'prev_token_until',
  'last_seen_at',
  'created_by',
  'created_at',
  'updated_at'
]
const SHARED_DEPLOY_COLS = [
  'id',
  'shared_deployment_id',
  'kind',
  'version',
  'from_version',
  'status',
  'step',
  'error',
  'plan',
  'job_run_id',
  'started_by',
  'started_at',
  'finished_at',
  'heartbeat_at'
]
const MOVE_COLS = [
  'id',
  'app_id',
  'environment_id',
  'from_placement_id',
  'to_placement_id',
  'kind',
  'routing',
  'status',
  'step',
  'steps',
  'plan',
  'plan_hash',
  'files',
  'checklist',
  'error',
  'placed_at',
  'prior_status',
  'job_run_id',
  'started_by',
  'started_at',
  'finished_at',
  'heartbeat_at'
]

describe('migrations 552/553: hub shared deployments and moves', () => {
  let db: Knex
  beforeAll(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
    })
    await up542(db)
    await up543(db)
  })
  afterAll(async () => {
    await db.destroy()
  })

  it('keeps an existing deploy row unlinked', async () => {
    await db('nivaro_hub_deploys').insert({
      app_id: 1,
      environment_id: 1,
      kind: 'promote',
      version: '0.3.1',
      status: 'success'
    })
    await up552(db)
    await up553(db)
    const row = await db('nivaro_hub_deploys').first()
    expect(row.shared_deploy_id).toBeNull()
    expect(row.move_id).toBeNull()
  })

  it('creates every table and column, and a second run is a no-op', async () => {
    await up552(db)
    await up553(db)
    const cols = async (t: string) => Object.keys(await db(t).columnInfo())
    expect((await cols('nivaro_hub_shared_deployments')).sort()).toEqual([...SHARED_COLS].sort())
    expect((await cols('nivaro_hub_shared_deploys')).sort()).toEqual([...SHARED_DEPLOY_COLS].sort())
    expect((await cols('nivaro_hub_moves')).sort()).toEqual([...MOVE_COLS].sort())
    expect(await db.schema.hasColumn('nivaro_hub_placements', 'shared_deployment_id')).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_environments', 'encryption_key')).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_environments', 'encryption_key_fp')).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_deploys', 'shared_deploy_id')).toBe(true)
    expect(await db.schema.hasColumn('nivaro_hub_deploys', 'move_id')).toBe(true)
  })

  it('applies defaults and refuses a duplicate key', async () => {
    const row = { key: 'shared-a', name: 'Shared A', link_url: 'https://a.example.com' }
    await db('nivaro_hub_shared_deployments').insert(row)
    await expect(
      db('nivaro_hub_shared_deployments').insert({ ...row, name: 'Other' })
    ).rejects.toThrow()
    const r = await db('nivaro_hub_shared_deployments').first()
    expect(r.mode).toBe('registered')
    expect(r.status).toBe('new')
    expect(Number(r.pool_budget)).toBe(60)
  })

  it('stores a shared deploy and a move with their defaults', async () => {
    await db('nivaro_hub_shared_deploys').insert({
      shared_deployment_id: 1,
      kind: 'upgrade',
      version: '0.3.2'
    })
    expect((await db('nivaro_hub_shared_deploys').first()).status).toBe('planned')
    await db('nivaro_hub_moves').insert({
      app_id: 1,
      environment_id: 1,
      from_placement_id: 1,
      to_placement_id: 2,
      kind: 'to_shared',
      routing: 'automatic',
      steps: '[]'
    })
    expect((await db('nivaro_hub_moves').first()).status).toBe('planned')
  })

  it('indexes moves by target and source placement with status (B2 listing)', async () => {
    const idx = (await db.raw("PRAGMA index_list('nivaro_hub_moves')")) as Array<{ name: string }>
    const names = idx.map((i) => i.name)
    expect(names).toContain('ix_nivaro_hub_moves_to')
    expect(names).toContain('ix_nivaro_hub_moves_from')
    const cols = async (n: string) =>
      ((await db.raw(`PRAGMA index_info('${n}')`)) as Array<{ name: string }>).map((c) => c.name)
    expect(await cols('ix_nivaro_hub_moves_to')).toEqual(['to_placement_id', 'status'])
    expect(await cols('ix_nivaro_hub_moves_from')).toEqual(['from_placement_id', 'status'])
  })

  it('allows the phase-6 deploy kinds (preflight R8)', async () => {
    for (const kind of ['move', 'shared'])
      await db('nivaro_hub_deploys').insert({
        app_id: 1,
        environment_id: 1,
        kind,
        version: '0.3.1',
        status: 'running'
      })
    expect(await db('nivaro_hub_deploys').whereIn('kind', ['move', 'shared'])).toHaveLength(2)
  })

  it('classifies the sealed columns', () => {
    const shared = sensitiveColumns('nivaro_hub_shared_deployments')
    for (const c of ['token', 'token_lookup', 'prev_token', 'prev_token_lookup', 'secrets'])
      expect(shared).toContain(c)
    const envs = sensitiveColumns('nivaro_hub_environments')
    expect(envs).toContain('encryption_key')
    expect(envs).toContain('encryption_key_fp')
    for (const c of ['token', 'token_lookup', 'prev_token', 'prev_token_lookup', 'secrets'])
      expect(isRedactedColumn('nivaro_hub_shared_deployments', c)).toBe(true)
    expect(isRedactedColumn('nivaro_hub_environments', 'encryption_key')).toBe(true)
    expect(isRedactedColumn('nivaro_hub_environments', 'encryption_key_fp')).toBe(true)
  })
})
