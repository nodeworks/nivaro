import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub data care (migration 569): backups, restore drills, refreshes and rehearsals end to end
// against real SQLite rows. The database SERVER is a fake exec that keeps a set of databases and
// records every statement, so the test can prove what the Hub asks a server to do — and that it
// never restores over production or over a database it does not own.

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

vi.mock('../../../services/hub/db/databases.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    openDatabaseConnection: async (id: number) => ({
      engine: 'mssql',
      host: 'sql1',
      port: null,
      database: `db${id}`,
      user: `login${id}`,
      password: 'app-password',
      ssl_mode: null,
      trust_server_cert: false
    })
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m542 = await import('../../../db/migrations/542_hub_tables.js')
const m543 = await import('../../../db/migrations/543_hub_promotions.js')
const m544 = await import('../../../db/migrations/544_hub_databases.js')
const m552 = await import('../../../db/migrations/552_hub_shared_deployments.js')
const m553 = await import('../../../db/migrations/553_hub_moves.js')
const m569 = await import('../../../db/migrations/569_hub_data.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')
const { memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')
const { startDbBackup } = await import('../../../services/hub/data/backup.js')
const { startRestoreDrill } = await import('../../../services/hub/data/drill.js')
const { planRefresh, startRefresh, startRefreshRollback } = await import(
  '../../../services/hub/data/refresh.js'
)
const { savePolicy, emptyPolicy } = await import('../../../services/hub/data/policy.js')
const { readRun, createRun, patchRun } = await import('../../../services/hub/data/runs.js')
const { dataTick } = await import('../../../services/hub/data/schedule.js')
const { rehearsalTenantWires } = await import('../../../services/hub/data/rehearsal.js')
const { memoryDataLock, _resetDataLocksForTests } = await import(
  '../../../services/hub/data/lock.js'
)
const { allKeeps } = await import('../../../services/env-refresh/registry.js')

const KEY = 'e'.repeat(64)

// ─── the fake server ─────────────────────────────────────────────────────────────────────────
const server = {
  dbs: new Set<string>(['db1', 'db2', 'db3']),
  marks: new Map<string, string>(),
  sql: [] as string[],
  ledger: 500,
  failRestore: false
}
function resetServer() {
  server.dbs = new Set(['db1', 'db2', 'db3'])
  server.marks = new Map()
  server.sql = []
  server.ledger = 500
  server.failRestore = false
}
const name = (sql: string, re: RegExp) => re.exec(sql)?.[1] ?? ''
const exec = async (sql: string): Promise<Record<string, unknown>[]> => {
  server.sql.push(sql)
  if (sql.includes("SERVERPROPERTY('InstanceDefaultBackupPath')"))
    return [{ backup_path: 'F:\\bak', data_path: 'D:\\data', log_path: 'L:\\log' }]
  if (sql.startsWith('RESTORE FILELISTONLY'))
    return [
      { LogicalName: 'app', PhysicalName: 'D:\\data\\app.mdf', Type: 'D', FileId: 1 },
      { LogicalName: 'app_log', PhysicalName: 'L:\\log\\app.ldf', Type: 'L', FileId: 2 }
    ]
  if (sql.startsWith('RESTORE HEADERONLY')) return [{ x: 1 }]
  if (sql.includes('FROM sys.master_files'))
    return [
      { logical: 'stg', physical: 'D:\\data\\stg.mdf', type_id: 0 },
      { logical: 'stg_log', physical: 'L:\\log\\stg.ldf', type_id: 1 }
    ]
  if (sql.startsWith('SELECT name, state_desc FROM sys.databases')) {
    const n = name(sql, /name = N'([^']+)'/)
    return server.dbs.has(n) ? [{ name: n }] : []
  }
  if (sql.includes('sys.extended_properties')) {
    const n = name(sql, /FROM \[([^\]]+)\]/)
    return server.marks.has(n) ? [{ v: server.marks.get(n) }] : []
  }
  if (sql.includes('sp_addextendedproperty')) {
    server.marks.set(name(sql, /EXECUTE \[([^\]]+)\]/), name(sql, /@value = N'([^']+)'/))
    return []
  }
  if (sql.includes('RESTORE DATABASE')) {
    if (server.failRestore) throw new Error('restore failed')
    server.dbs.add(name(sql, /RESTORE DATABASE \[([^\]]+)\]/))
    return []
  }
  if (sql.includes('DROP DATABASE')) {
    server.dbs.delete(name(sql, /DROP DATABASE \[([^\]]+)\]/))
    return []
  }
  if (sql.includes('sys.partitions')) {
    const n = name(sql, /FROM \[([^\]]+)\]\.sys\.tables/)
    return ['nivaro_collections', 'nivaro_users', 'nivaro_migrations'].map((t) => ({
      sch: 'dbo',
      tbl: t,
      n: n ? 5 : 0
    }))
  }
  if (sql.includes('[nivaro_migrations]') && sql.includes('MAX(name)'))
    return [{ n: server.ledger, latest: '569_hub_data' }]
  if (sql.includes('msdb.dbo.backupset bs JOIN'))
    return [
      {
        backup_size: 1000,
        compressed_backup_size: 400,
        finish_local: '2026-11-24T01:00:00',
        server_offset_min: 0
      }
    ]
  return []
}
const opener = async <T>(_a: unknown, fn: (e: typeof exec) => Promise<T>) => fn(exec)

const channel =
  (version = '0.3.215') =>
  async () => ({
    kind: 'dedicated' as const,
    tenantId: null,
    shared: null,
    calls: [] as string[],
    async call(method: string, sub: string) {
      if (sub.endsWith('refresh-keeps')) return { version, keeps: allKeeps() }
      return { ok: true, method }
    },
    async version() {
      return version
    }
  })

const deps = () => ({
  opener,
  background: false,
  lock: memoryDataLock,
  promoteLock: memoryPromoteLock,
  channel: channel()
})

let prevKey: string | undefined
beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
  await m542.up(db)
  await m543.up(db)
  await m544.up(db)
  await m552.up(db)
  await m553.up(db)
  await m569.up(db)
  await m569.up(db) // a second run is a no-op
  await db('nivaro_hub_apps').insert({ id: 1, key: 'efp', name: 'EFP' })
  for (const [id, key, position] of [
    [1, 'development', 1],
    [2, 'staging', 2],
    [3, 'production', 3]
  ] as const)
    await db('nivaro_hub_environments').insert({
      id,
      app_id: 1,
      key,
      position,
      status: 'active',
      base_url: `https://${key}.efp.test`,
      db_ref: `hub-db:${id}`
    })
  await db('nivaro_hub_db_servers').insert({
    id: 1,
    name: 'sql1',
    engine: 'mssql',
    host: 'sql1',
    provision_mode: 'automatic',
    trust_server_cert: false,
    admin_secret: sealSecret(JSON.stringify({ user: 'hubadmin', password: 'Adm1n-secret' }))
  })
  for (const id of [1, 2, 3])
    await db('nivaro_hub_databases').insert({
      id,
      server_id: 1,
      engine: 'mssql',
      host: 'sql1',
      database_name: `db${id}`,
      status: 'ready'
    })
})
afterAll(async () => {
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
  await db.destroy()
})
beforeEach(() => {
  resetServer()
  _resetDataLocksForTests()
})

describe('migration 569', () => {
  it('creates both tables', async () => {
    expect(await db.schema.hasTable('nivaro_hub_backup_policies')).toBe(true)
    const cols = Object.keys(await db('nivaro_hub_data_runs').columnInfo())
    expect(cols).toContain('keep_secret')
    expect(cols).toContain('heartbeat_at')
  })
})

describe('database backup', () => {
  it('backs up copy-only, verifies, records the file and prunes past the retention', async () => {
    await savePolicy({ ...emptyPolicy(2), db_keep_count: 2 }, null)
    for (const n of [1, 2]) {
      const id = await createRun({ kind: 'db_backup', environmentId: 2, steps: [], status: 'done' })
      await patchRun(id, { artifact: { file: `F:\\bak\\old${n}.bak` } })
    }
    const id = await startDbBackup(2, { by: null }, deps())
    const run = await readRun(id)
    expect(run?.status).toBe('done')
    expect(String(run?.artifact?.file)).toMatch(
      /^F:\\bak\\nivaro_hub_efp_staging_backup_\d+_\d+\.bak$/
    )
    expect(run?.artifact?.size_bytes).toBe(1000)
    expect(
      server.sql.some((s) => s.startsWith('BACKUP DATABASE [db2]') && s.includes('COPY_ONLY'))
    ).toBe(true)
    expect(server.sql.some((s) => s.startsWith('RESTORE VERIFYONLY'))).toBe(true)
    // keep 2: this one and old2 stay, old1 goes
    const deletes = server.sql.filter((s) => s.includes('xp_delete_file'))
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toContain('old1.bak')
  })

  it('refuses a second run on the same environment while one holds it', async () => {
    const token = await memoryDataLock.take(2)
    await expect(startDbBackup(2, { by: null }, deps())).rejects.toMatchObject({
      code: 'DATA_BUSY'
    })
    await memoryDataLock.release(2, token as string)
  })
})

describe('restore drill', () => {
  it('restores the newest backup into its own scratch copy, checks it and drops it', async () => {
    const id = await startRestoreDrill(2, { by: null }, deps())
    const run = await readRun(id)
    expect(run?.status).toBe('done')
    const scratch = `nivaro_hub_scratch_d${id}`
    expect(
      server.sql.some(
        (s) => s.startsWith(`RESTORE DATABASE [${scratch}]`) && !s.includes('REPLACE')
      )
    ).toBe(true)
    expect(server.dbs.has(scratch)).toBe(false)
    expect(run?.result?.restore_ms).toBeTypeOf('number')
    expect(run?.steps.find((s) => s.key === 'checkdb')?.state).toBe('skipped')
  })

  it('fails on a copy without a ledger and still drops the copy', async () => {
    server.ledger = 0
    const id = await startRestoreDrill(2, { by: null }, deps())
    const run = await readRun(id)
    expect(run?.status).toBe('failed')
    expect(run?.steps.find((s) => s.key === 'checks')?.state).toBe('failed')
    expect(server.dbs.has(`nivaro_hub_scratch_d${id}`)).toBe(false)
  })

  it('never drops a database under its name that another run marked', async () => {
    const next = Number((await db('nivaro_hub_data_runs').max('id as m').first())?.m ?? 0) + 1
    const name = `nivaro_hub_scratch_d${next}`
    server.dbs.add(name)
    server.marks.set(name, '999')
    const id = await startRestoreDrill(2, { by: null }, deps())
    expect(id).toBe(next)
    expect((await readRun(id))?.status).toBe('failed')
    expect(server.dbs.has(name)).toBe(true)
  })
})

describe('refresh', () => {
  it('refuses production as a target and copying upwards', async () => {
    const p = await planRefresh(3, { source_env_id: 2 }, deps())
    expect(p.blocked).toBe(true)
    expect(p.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['production_target', 'not_lower'])
    )
    await expect(
      startRefresh(3, { source_env_id: 2, plan_hash: p.plan_hash, confirm: 'db3' }, null, deps())
    ).rejects.toMatchObject({ code: 'PLAN_BLOCKED' })
    expect(server.sql.some((s) => s.includes('RESTORE DATABASE [db3]'))).toBe(false)
  })

  it('refuses two versions', async () => {
    const d = deps()
    let n = 0
    d.channel = async () => ({
      ...(await channel()()),
      version: async () => (n++ % 2 ? '0.3.214' : '0.3.215')
    })
    const p = await planRefresh(2, { source_env_id: 3 }, d)
    expect(p.checks.map((c) => c.id)).toContain('version_mismatch')
  })

  it('copies production over staging with a typed confirm, keeps a rollback point, and rolls back', async () => {
    const p = await planRefresh(2, { source_env_id: 3 }, deps())
    expect(p.blocked).toBe(false)
    expect(p.confirm).toBe('db2')
    expect(p.keeps_from).toBe('app')
    await expect(
      startRefresh(2, { source_env_id: 3, plan_hash: p.plan_hash, confirm: 'db3' }, null, deps())
    ).rejects.toMatchObject({ code: 'CONFIRM_MISMATCH' })
    await expect(
      startRefresh(2, { source_env_id: 3, plan_hash: 'x', confirm: 'db2' }, null, deps())
    ).rejects.toMatchObject({ code: 'PLAN_CHANGED' })
    const id = await startRefresh(
      2,
      { source_env_id: 3, plan_hash: p.plan_hash, confirm: 'db2' },
      null,
      deps()
    )
    const run = await readRun(id)
    expect(run?.status).toBe('done')
    expect(run?.holds_keep_set).toBe(true)
    expect(run?.expires_at).toBeTruthy()
    const restores = server.sql.filter((s) => s.includes('RESTORE DATABASE ['))
    expect(restores).toHaveLength(1)
    expect(restores[0]).toContain('RESTORE DATABASE [db2]')
    expect(restores[0]).toContain('REPLACE')
    expect(
      server.sql.some((s) => s.startsWith('BACKUP DATABASE [db3]') && s.includes('COPY_ONLY'))
    ).toBe(true)
    expect(
      server.sql.some(
        (s) => s.includes('ALTER USER [login2]') || s.includes('CREATE USER [login2]')
      )
    ).toBe(true)
    expect(server.sql.some((s) => s.includes('DROP USER [login3]'))).toBe(true)
    // never anything over production
    expect(server.sql.some((s) => /RESTORE DATABASE \[db3\]/.test(s))).toBe(false)

    await expect(startRefreshRollback(id, { confirm: 'nope' }, null, deps())).rejects.toMatchObject(
      {
        code: 'CONFIRM_MISMATCH'
      }
    )
    server.sql = []
    const rb = await startRefreshRollback(id, { confirm: 'db2' }, null, deps())
    expect((await readRun(rb))?.status).toBe('done')
    expect(server.sql.find((s) => s.includes('RESTORE DATABASE [db2]'))).toContain(
      String(run?.artifact?.rollback_file)
    )
    await expect(startRefreshRollback(id, { confirm: 'db2' }, null, deps())).rejects.toMatchObject({
      code: 'NO_ROLLBACK'
    })
  })
})

describe('schedule tick', () => {
  it('marks a stale refresh interrupted, a stale drill failed, and starts due runs', async () => {
    const old = new Date(Date.now() - 10 * 60_000)
    const r1 = await createRun({ kind: 'refresh', environmentId: 1, steps: [] })
    const r2 = await createRun({ kind: 'restore_drill', environmentId: 1, steps: [] })
    await db('nivaro_hub_data_runs').whereIn('id', [r1, r2]).update({ heartbeat_at: old })
    await savePolicy({ ...emptyPolicy(1), db_enabled: true, db_schedule: '0 * * * *' }, null)
    await db('nivaro_hub_backup_policies')
      .where({ environment_id: 1 })
      .update({ updated_at: new Date(Date.now() - 3 * 3600_000) })
    const started: number[] = []
    const r = await dataTick({
      opener,
      start: {
        db_backup: async (env) => {
          started.push(env)
          return 77
        }
      }
    })
    expect(r.healed).toEqual(expect.arrayContaining([r1, r2]))
    expect((await readRun(r1))?.status).toBe('interrupted')
    expect((await readRun(r2))?.status).toBe('failed')
    expect(started).toEqual([1])
  })
})

describe('rehearsal tenants', () => {
  it('lists a running rehearsal on its deployment only, in maintenance, on the copy', async () => {
    const id = await createRun({ kind: 'rehearsal', environmentId: 2, steps: [] })
    await patchRun(id, {
      artifact: {
        listed: true,
        shared_id: 4,
        env_id: 2,
        database_id: 2,
        app_key: 'efp',
        scratch: `nivaro_hub_scratch_r${id}`
      }
    })
    const wires = await rehearsalTenantWires(4)
    expect(wires).toHaveLength(1)
    expect(wires[0]).toMatchObject({
      id: `rh-${id}`,
      status: 'maintenance',
      hostnames: [`rh-${id}.rehearsal.invalid`]
    })
    expect(wires[0].db.connection).toContain(`nivaro_hub_scratch_r${id}`)
    expect(await rehearsalTenantWires(5)).toEqual([])
    await patchRun(id, { status: 'done' })
    expect(await rehearsalTenantWires(4)).toEqual([])
  })
})
