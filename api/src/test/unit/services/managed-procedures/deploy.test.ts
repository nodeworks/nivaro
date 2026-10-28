import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../db/index.js', async () => ({ db: (await import('./fake-store.js')).fakeDb }))

const dialect = vi.hoisted(() => ({ mssql: true }))
vi.mock('../../../../db/dialect.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../db/dialect.js')>()
  return { ...real, isMssql: vi.fn(() => dialect.mssql) }
})

const readiness = vi.hoisted(() => ({ checks: [] as Array<Record<string, any>> }))
vi.mock('../../../../services/readiness.js', () => ({
  registerReadinessCheck: vi.fn((c: Record<string, any>) => readiness.checks.push(c))
}))

const conn = vi.hoisted(() => ({ sql: [] as string[] }))
vi.mock('../../../../services/run-long.js', () => ({
  withLongConnection: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
    fn({
      run: async (sql: string) => {
        conn.sql.push(sql)
        return sql.includes('sp_getapplock') ? [{ r: 0 }] : []
      },
      discard: () => {}
    })
  )
}))

const live = vi.hoisted(() => ({ defs: new Map<string, string>() }))
vi.mock('../../../../services/procedure-deploy.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../services/procedure-deploy.js')>()
  return {
    ...real,
    deployProcedure: vi.fn(async () => {}),
    dropProcedure: vi.fn(async () => {}),
    liveProcedureDefinition: vi.fn(
      async (_schema: string | null, name: string) => live.defs.get(name.toLowerCase()) ?? null
    ),
    liveProcedureDefinitions: vi.fn(async () => new Map(live.defs))
  }
})

import {
  deployAllAppManaged,
  deployManagedProcedure,
  managedDrift,
  registerManagedProcReadiness,
  saveAndDeployManaged
} from '../../../../services/managed-procedures/deploy.js'
import { procBodyHash } from '../../../../services/managed-procedures/normalize.js'
import { MANAGED_TABLE, VERSIONS_TABLE } from '../../../../services/managed-procedures/owners.js'
import {
  getManagedProcedure,
  ManagedProcError,
  saveManagedVersion
} from '../../../../services/managed-procedures/store.js'
import { deployProcedure, dropProcedure, sha256 } from '../../../../services/procedure-deploy.js'
import { registerReadinessCheck } from '../../../../services/readiness.js'
import { resetFakeStore, rowsOf, seedRow } from './fake-store.js'

const IMPORTS = 'nivaro_import_definitions'
const OLD = 'CREATE PROCEDURE spend_totals AS SELECT 1'
const NEW = 'CREATE OR ALTER PROCEDURE spend_totals AS SELECT 2'

function seedManaged(name: string, body: string, extra: Record<string, unknown> = {}) {
  return seedRow(MANAGED_TABLE, {
    name,
    body,
    body_hash: procBodyHash(body),
    version: 1,
    deployed_hash: null,
    deployed_at: null,
    deployed_by: null,
    description: null,
    owner: null,
    updated_at: new Date('2026-10-01T00:00:00Z'),
    updated_by: null,
    dropped_at: null,
    ...extra
  })
}

function seedImport(key: string, proc: string, body: string, extra: Record<string, unknown> = {}) {
  return seedRow(IMPORTS, {
    key,
    procedure: proc,
    procedure_body: body,
    procedure_hash: null,
    procedure_deployed_at: null,
    ...extra
  })
}

const managedRow = (name: string) =>
  rowsOf(MANAGED_TABLE).find((r) => String(r.name).toLowerCase() === name.toLowerCase())
const importRow = (key: string) => rowsOf(IMPORTS).find((r) => r.key === key)

beforeEach(() => {
  resetFakeStore()
  live.defs = new Map()
  dialect.mssql = true
  vi.mocked(deployProcedure).mockReset()
  vi.mocked(deployProcedure).mockImplementation(async () => {})
  vi.mocked(dropProcedure).mockReset()
  vi.mocked(dropProcedure).mockImplementation(async () => {})
})

describe('deployManagedProcedure', () => {
  it('deploys when live differs even though deployed_hash claims it is current', async () => {
    // Promote copied the stamp: body_hash === deployed_hash, but the live proc is the old body.
    seedManaged('spend_totals', NEW, { deployed_hash: procBodyHash(NEW) })
    live.defs.set('spend_totals', OLD)
    const r = await deployManagedProcedure('spend_totals', { by: 'user:u1' })
    expect(r).toMatchObject({ name: 'spend_totals', kind: 'managed', action: 'altered' })
    expect(r.hash).toBe(procBodyHash(NEW))
    expect(deployProcedure).toHaveBeenCalledWith(
      expect.stringMatching(/^CREATE OR ALTER PROCEDURE spend_totals/),
      { schema: 'dbo', name: 'spend_totals' }
    )
    const row = managedRow('spend_totals')
    expect(row?.deployed_hash).toBe(procBodyHash(NEW))
    expect(row?.deployed_by).toBe('user:u1')
    expect(row?.deployed_at).toBeInstanceOf(Date)
  })

  it('unchanged when live matches; re-stamps a wrong deployed_hash', async () => {
    seedManaged('spend_totals', NEW, { deployed_hash: 'stale-hash' })
    // SQL Server keeps the text as written: other whitespace, CREATE instead of CREATE OR ALTER.
    live.defs.set('spend_totals', 'CREATE   PROCEDURE spend_totals\n  AS SELECT 2\n')
    const r = await deployManagedProcedure('spend_totals', { by: 'script:test' })
    expect(r.action).toBe('unchanged')
    expect(deployProcedure).not.toHaveBeenCalled()
    const row = managedRow('spend_totals')
    expect(row?.deployed_hash).toBe(procBodyHash(NEW))
    expect(row?.deployed_by).toBe('script:test')
  })

  it('unchanged with an honest stamp writes nothing', async () => {
    seedManaged('spend_totals', NEW, { deployed_hash: procBodyHash(NEW) })
    live.defs.set('spend_totals', NEW)
    expect((await deployManagedProcedure('spend_totals')).action).toBe('unchanged')
    expect(managedRow('spend_totals')?.deployed_at).toBeNull()
  })

  it('force redeploys a proc that already matches', async () => {
    seedManaged('spend_totals', NEW)
    live.defs.set('spend_totals', NEW)
    expect((await deployManagedProcedure('spend_totals', { force: true })).action).toBe('altered')
    expect(deployProcedure).toHaveBeenCalledTimes(1)
  })

  it('creates a proc that is not live', async () => {
    seedManaged('spend_totals', NEW)
    const r = await deployManagedProcedure('spend_totals')
    expect(r.action).toBe('created')
    expect(deployProcedure).toHaveBeenCalledTimes(1)
    expect(managedRow('spend_totals')?.deployed_hash).toBe(procBodyHash(NEW))
  })

  it('drops a live proc whose config row is dropped, and stamps deployed_hash null', async () => {
    seedManaged('old_report', 'CREATE OR ALTER PROCEDURE old_report AS SELECT 1', {
      deployed_hash: 'h',
      dropped_at: new Date()
    })
    live.defs.set('old_report', 'CREATE PROCEDURE old_report AS SELECT 1')
    const r = await deployManagedProcedure('old_report', { by: 'script:test' })
    expect(r).toMatchObject({ action: 'dropped', hash: null })
    expect(dropProcedure).toHaveBeenCalledWith({ schema: 'dbo', name: 'old_report' })
    expect(deployProcedure).not.toHaveBeenCalled()
    const row = managedRow('old_report')
    expect(row?.deployed_hash).toBeNull()
    expect(row?.deployed_at).toBeInstanceOf(Date)
  })

  it('a dropped row whose proc is not live is absent', async () => {
    seedManaged('old_report', 'CREATE OR ALTER PROCEDURE old_report AS SELECT 1', {
      dropped_at: new Date()
    })
    expect((await deployManagedProcedure('old_report')).action).toBe('absent')
    expect(dropProcedure).not.toHaveBeenCalled()
  })

  it('refuses a stored body whose real header names another procedure (failed, nothing deployed)', async () => {
    seedManaged(
      'spend_totals',
      '/* create procedure spend_totals */ CREATE PROCEDURE other AS SELECT 1'
    )
    const r = await deployManagedProcedure('spend_totals')
    expect(r.action).toBe('failed')
    expect(r.reason).toMatch(/another procedure|spend_totals/)
    expect(deployProcedure).not.toHaveBeenCalled()
    expect(managedRow('spend_totals')?.deployed_hash).toBeNull()
  })

  it('a managed row whose name an import owns is skipped', async () => {
    seedManaged('import_po', 'CREATE OR ALTER PROCEDURE import_po AS SELECT 1')
    seedImport('po', 'import_po', 'CREATE OR ALTER PROCEDURE import_po AS SELECT 2')
    const r = await deployManagedProcedure('import_po')
    expect(r).toMatchObject({ action: 'skipped', reason: 'import definition po owns it' })
    expect(deployProcedure).not.toHaveBeenCalled()
  })

  it('dryRun reports the action and writes nothing', async () => {
    seedManaged('spend_totals', NEW)
    live.defs.set('spend_totals', OLD)
    expect((await deployManagedProcedure('spend_totals', { dryRun: true })).action).toBe('altered')
    expect(deployProcedure).not.toHaveBeenCalled()
    expect(managedRow('spend_totals')?.deployed_hash).toBeNull()
  })

  it('a deploy error is failed with the SQL Server message, and nothing is stamped', async () => {
    seedManaged('spend_totals', NEW)
    vi.mocked(deployProcedure).mockRejectedValueOnce(new Error("Invalid object name 'nope'."))
    const r = await deployManagedProcedure('spend_totals')
    expect(r).toMatchObject({ action: 'failed', reason: "Invalid object name 'nope'." })
    expect(managedRow('spend_totals')?.deployed_hash).toBeNull()
  })

  it('404 for a name config does not own', async () => {
    await expect(deployManagedProcedure('nobody')).rejects.toMatchObject({
      status: 404,
      code: 'PROC_NOT_FOUND'
    })
  })
})

describe('deployAllAppManaged', () => {
  it('never drops a live proc that has no config row', async () => {
    live.defs.set('legacy_unknown', 'CREATE PROCEDURE legacy_unknown AS SELECT 1')
    seedManaged('old_report', 'CREATE OR ALTER PROCEDURE old_report AS SELECT 1', {
      dropped_at: new Date()
    })
    live.defs.set('old_report', 'CREATE PROCEDURE old_report AS SELECT 1')
    const { results, failed } = await deployAllAppManaged({ execute: true, by: 'script:test' })
    expect(dropProcedure).not.toHaveBeenCalledWith({ schema: 'dbo', name: 'legacy_unknown' })
    expect(dropProcedure).toHaveBeenCalledTimes(1)
    expect(dropProcedure).toHaveBeenCalledWith({ schema: 'dbo', name: 'old_report' })
    expect(results.find((r) => r.name === 'legacy_unknown')).toBeUndefined()
    expect(failed).toBe(0)
  })

  it('import kind: deploys the trimmed body and stamps procedure_hash / procedure_deployed_at', async () => {
    const body = '\n  CREATE OR ALTER PROCEDURE import_x AS SELECT 1  \n'
    seedImport('x', 'import_x', body)
    const { results } = await deployAllAppManaged({ execute: true, by: 'script:test' })
    expect(results).toEqual([
      expect.objectContaining({ name: 'import_x', kind: 'import', action: 'created' })
    ])
    expect(deployProcedure).toHaveBeenCalledWith(body.trim(), { schema: 'dbo', name: 'import_x' })
    expect(importRow('x')?.procedure_hash).toBe(sha256(body.trim()))
    expect(importRow('x')?.procedure_deployed_at).toBeInstanceOf(Date)
  })

  it('import kind: live matching the body is unchanged (by the live text, not procedure_hash)', async () => {
    const body = 'CREATE OR ALTER PROCEDURE import_x AS SELECT 1'
    seedImport('x', 'import_x', body, { procedure_hash: sha256(body) })
    live.defs.set('import_x', 'CREATE PROCEDURE import_x AS SELECT 0')
    seedImport('y', 'import_y', 'CREATE OR ALTER PROCEDURE import_y AS SELECT 1')
    live.defs.set('import_y', 'CREATE PROCEDURE import_y AS SELECT 1')
    const { results } = await deployAllAppManaged({ execute: true, by: 'script:test' })
    expect(results.find((r) => r.name === 'import_x')?.action).toBe('altered')
    expect(results.find((r) => r.name === 'import_y')?.action).toBe('unchanged')
    expect(deployProcedure).toHaveBeenCalledTimes(1)
  })

  it('import kind: a decoy comment does not pass the header check (the old script regex did)', async () => {
    seedImport(
      'x',
      'import_x',
      '-- create or alter procedure import_x\nCREATE OR ALTER PROCEDURE other AS SELECT 1'
    )
    const { results, failed } = await deployAllAppManaged({ execute: true, by: 'script:test' })
    expect(results.find((r) => r.name === 'import_x')).toMatchObject({
      kind: 'import',
      action: 'skipped'
    })
    expect(results.find((r) => r.name === 'import_x')?.reason).toMatch(/import_x/)
    expect(deployProcedure).not.toHaveBeenCalled()
    expect(importRow('x')?.procedure_hash).toBeNull()
    expect(failed).toBe(0)
  })

  it('a managed row colliding with an import body is skipped, the import is deployed', async () => {
    const importBody = 'CREATE OR ALTER PROCEDURE import_po AS SELECT 2'
    seedImport('po', 'import_po', importBody)
    seedManaged('IMPORT_PO', 'CREATE OR ALTER PROCEDURE IMPORT_PO AS SELECT 1', {
      dropped_at: new Date()
    })
    live.defs.set('import_po', 'CREATE PROCEDURE import_po AS SELECT 0')
    const { results } = await deployAllAppManaged({ execute: true, by: 'script:test' })
    expect(results.find((r) => r.kind === 'managed')).toMatchObject({
      action: 'skipped',
      reason: 'import definition po owns it'
    })
    expect(results.find((r) => r.kind === 'import')).toMatchObject({ action: 'altered' })
    expect(deployProcedure).toHaveBeenCalledTimes(1)
    expect(deployProcedure).toHaveBeenCalledWith(importBody, { schema: 'dbo', name: 'import_po' })
    expect(dropProcedure).not.toHaveBeenCalled()
  })

  it('execute:false writes and deploys nothing but reports would-be actions', async () => {
    seedManaged('spend_totals', NEW)
    live.defs.set('spend_totals', OLD)
    seedManaged('new_proc', 'CREATE OR ALTER PROCEDURE new_proc AS SELECT 1', {
      deployed_hash: 'wrong'
    })
    seedManaged('same_proc', 'CREATE OR ALTER PROCEDURE same_proc AS SELECT 1', {
      deployed_hash: 'wrong'
    })
    live.defs.set('same_proc', 'CREATE PROCEDURE same_proc AS SELECT 1')
    seedManaged('old_report', 'CREATE OR ALTER PROCEDURE old_report AS SELECT 1', {
      dropped_at: new Date()
    })
    live.defs.set('old_report', 'CREATE PROCEDURE old_report AS SELECT 1')
    seedImport('x', 'import_x', 'CREATE OR ALTER PROCEDURE import_x AS SELECT 1')
    const before = JSON.stringify([rowsOf(MANAGED_TABLE), rowsOf(IMPORTS)])

    const { results, failed } = await deployAllAppManaged({ execute: false, by: 'script:test' })
    const action = (n: string) => results.find((r) => r.name === n)?.action
    expect(action('spend_totals')).toBe('altered')
    expect(action('new_proc')).toBe('created')
    expect(action('same_proc')).toBe('unchanged')
    expect(action('old_report')).toBe('dropped')
    expect(action('import_x')).toBe('created')
    expect(failed).toBe(0)
    expect(deployProcedure).not.toHaveBeenCalled()
    expect(dropProcedure).not.toHaveBeenCalled()
    expect(JSON.stringify([rowsOf(MANAGED_TABLE), rowsOf(IMPORTS)])).toBe(before)
  })

  it('one failure does not stop the rest; failed counts it', async () => {
    seedManaged('a_proc', 'CREATE OR ALTER PROCEDURE a_proc AS SELECT 1')
    seedManaged('b_proc', 'CREATE OR ALTER PROCEDURE b_proc AS SELECT 1')
    seedImport('x', 'import_x', 'CREATE OR ALTER PROCEDURE import_x AS SELECT 1')
    vi.mocked(deployProcedure).mockImplementation(async (_d, t) => {
      if (t.name === 'import_x') throw new Error('Import boom')
      if (t.name === 'a_proc') throw new Error('Managed boom')
    })
    const { results, failed } = await deployAllAppManaged({ execute: true, by: 'script:test' })
    expect(failed).toBe(2)
    expect(results.find((r) => r.name === 'import_x')).toMatchObject({
      action: 'failed',
      reason: 'Import boom'
    })
    expect(results.find((r) => r.name === 'a_proc')).toMatchObject({
      action: 'failed',
      reason: 'Managed boom'
    })
    expect(results.find((r) => r.name === 'b_proc')?.action).toBe('created')
    expect(managedRow('a_proc')?.deployed_hash).toBeNull()
    expect(managedRow('b_proc')?.deployed_hash).not.toBeNull()
    expect(importRow('x')?.procedure_hash).toBeNull()
  })

  it('only limits the run to the named procedures (case-insensitive)', async () => {
    seedManaged('a_proc', 'CREATE OR ALTER PROCEDURE a_proc AS SELECT 1')
    seedManaged('b_proc', 'CREATE OR ALTER PROCEDURE b_proc AS SELECT 1')
    seedImport('x', 'import_x', 'CREATE OR ALTER PROCEDURE import_x AS SELECT 1')
    const { results } = await deployAllAppManaged({
      execute: true,
      only: ['B_PROC'],
      by: 'script:test'
    })
    expect(results.map((r) => r.name)).toEqual(['b_proc'])
  })
})

describe('saveAndDeployManaged', () => {
  it('saves a new version and deploys it', async () => {
    await saveManagedVersion({ name: 'spend_totals', body: OLD, note: 'v1', userId: null })
    live.defs.set('spend_totals', OLD)
    const r = await saveAndDeployManaged({
      name: 'spend_totals',
      body: NEW,
      note: 'v2',
      userId: null,
      by: 'user:u1'
    })
    expect(r).toMatchObject({ version: 2, unchanged: false })
    expect(r.deployed.action).toBe('altered')
    expect(managedRow('spend_totals')?.deployed_hash).toBe(procBodyHash(NEW))
  })

  it('saveAndDeployManaged puts config back when the deploy fails', async () => {
    await saveManagedVersion({ name: 'spend_totals', body: OLD, note: 'v1', userId: null })
    live.defs.set('spend_totals', OLD)
    vi.mocked(deployProcedure).mockRejectedValueOnce(new Error("Incorrect syntax near 'SELEC'."))
    const err = await saveAndDeployManaged({
      name: 'spend_totals',
      body: 'CREATE PROCEDURE spend_totals AS SELEC 2',
      note: 'bad',
      userId: null,
      by: 'user:u1'
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ManagedProcError)
    expect(err).toMatchObject({ status: 400, code: 'DEPLOY_FAILED' })
    expect(err.message).toContain("Incorrect syntax near 'SELEC'.")
    const p = await getManagedProcedure('spend_totals')
    expect(p?.version).toBe(1)
    expect(p?.body_hash).toBe(procBodyHash(OLD))
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(1)
  })

  it('a first save whose deploy fails leaves no config row', async () => {
    vi.mocked(deployProcedure).mockRejectedValueOnce(new Error('nope'))
    await expect(
      saveAndDeployManaged({
        name: 'fresh',
        body: 'CREATE PROCEDURE fresh AS SELECT 1',
        note: 'n',
        userId: null,
        by: 'user:u1'
      })
    ).rejects.toMatchObject({ code: 'DEPLOY_FAILED' })
    expect(await getManagedProcedure('fresh')).toBeNull()
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(0)
  })
})

describe('managedDrift', () => {
  it('managedDrift reports drifted / not-deployed / dropped-but-live / conflict', async () => {
    seedManaged('in_sync', 'CREATE OR ALTER PROCEDURE in_sync AS SELECT 1')
    live.defs.set('in_sync', 'CREATE PROCEDURE in_sync AS SELECT 1')
    seedManaged('drifted', 'CREATE OR ALTER PROCEDURE drifted AS SELECT 1', {
      deployed_hash: procBodyHash('CREATE OR ALTER PROCEDURE drifted AS SELECT 1')
    })
    live.defs.set('drifted', 'CREATE PROCEDURE drifted AS SELECT 99')
    seedManaged('not_deployed', 'CREATE OR ALTER PROCEDURE not_deployed AS SELECT 1')
    seedManaged('dropped_live', 'CREATE OR ALTER PROCEDURE dropped_live AS SELECT 1', {
      dropped_at: new Date()
    })
    live.defs.set('dropped_live', 'CREATE PROCEDURE dropped_live AS SELECT 1')
    seedManaged('dropped_gone', 'CREATE OR ALTER PROCEDURE dropped_gone AS SELECT 1', {
      dropped_at: new Date()
    })
    seedManaged('import_po', 'CREATE OR ALTER PROCEDURE import_po AS SELECT 1')
    seedImport('po', 'import_po', 'CREATE OR ALTER PROCEDURE import_po AS SELECT 2')
    live.defs.set('import_po', 'CREATE PROCEDURE import_po AS SELECT 2')
    seedImport('q', 'import_q', 'CREATE OR ALTER PROCEDURE import_q AS SELECT 2')
    live.defs.set('import_q', 'CREATE PROCEDURE import_q AS SELECT 1')
    live.defs.set('legacy_unknown', 'CREATE PROCEDURE legacy_unknown AS SELECT 1')

    const drift = await managedDrift()
    const status = (name: string, kind: string) =>
      drift.find((d) => d.name === name && d.kind === kind)?.status
    expect(status('in_sync', 'managed')).toBe('in-sync')
    expect(status('drifted', 'managed')).toBe('drifted')
    expect(status('not_deployed', 'managed')).toBe('not-deployed')
    expect(status('dropped_live', 'managed')).toBe('dropped-but-live')
    expect(status('dropped_gone', 'managed')).toBe('dropped')
    expect(status('import_po', 'managed')).toBe('conflict')
    expect(status('import_po', 'import')).toBe('in-sync')
    expect(status('import_q', 'import')).toBe('drifted')
    expect(drift.find((d) => d.name === 'import_po' && d.kind === 'import')?.key).toBe('po')
    expect(typeof drift.find((d) => d.name === 'in_sync')?.id).toBe('number')
    expect(drift.find((d) => d.name === 'legacy_unknown')).toBeUndefined()
  })
})

describe('registerManagedProcReadiness', () => {
  it('registers one check, once', async () => {
    registerManagedProcReadiness()
    registerManagedProcReadiness()
    expect(registerReadinessCheck).toHaveBeenCalledTimes(1)
    expect(readiness.checks[0]).toMatchObject({
      id: 'managed-proc-drift',
      label: 'App-managed procedures match their config',
      group: 'Data'
    })
  })

  const run = () => readiness.checks[0].run() as Promise<Record<string, any>>

  it('skips off SQL Server and with no app-managed procedures', async () => {
    registerManagedProcReadiness()
    expect((await run()).status).toBe('skip')
    seedManaged('in_sync', 'CREATE OR ALTER PROCEDURE in_sync AS SELECT 1')
    dialect.mssql = false
    expect((await run()).status).toBe('skip')
  })

  it('passes when every procedure matches its config', async () => {
    registerManagedProcReadiness()
    seedManaged('in_sync', 'CREATE OR ALTER PROCEDURE in_sync AS SELECT 1')
    live.defs.set('in_sync', 'CREATE PROCEDURE in_sync AS SELECT 1')
    seedManaged('dropped_gone', 'CREATE OR ALTER PROCEDURE dropped_gone AS SELECT 1', {
      dropped_at: new Date()
    })
    expect(await run()).toMatchObject({
      status: 'pass',
      detail: '2 procedures match their config'
    })
  })

  it('warns with up to 10 blockers', async () => {
    registerManagedProcReadiness()
    for (let i = 0; i < 12; i++) {
      seedManaged(
        `p${String(i).padStart(2, '0')}`,
        `CREATE OR ALTER PROCEDURE p${String(i).padStart(2, '0')} AS SELECT 1`
      )
    }
    seedManaged('in_sync', 'CREATE OR ALTER PROCEDURE in_sync AS SELECT 1')
    live.defs.set('in_sync', 'CREATE PROCEDURE in_sync AS SELECT 1')
    const r = await run()
    expect(r.status).toBe('warn')
    expect(r.blockers).toHaveLength(10)
    expect(r.blockers[0]).toBe('p00: not-deployed')
    expect(r.blockers).not.toContain('in_sync: in-sync')
  })
})

describe('dropProcedure', () => {
  const realDrop = async () =>
    (
      await vi.importActual<typeof import('../../../../services/procedure-deploy.js')>(
        '../../../../services/procedure-deploy.js'
      )
    ).dropProcedure

  it('drops [dbo].[name] IF EXISTS under the procedure lock', async () => {
    conn.sql = []
    await (await realDrop())({ schema: null, name: 'old_report' })
    const i = conn.sql.findIndex((s) => s.includes('sp_getapplock'))
    const d = conn.sql.indexOf('DROP PROCEDURE IF EXISTS [dbo].[old_report]')
    const r = conn.sql.findIndex((s) => s.includes('sp_releaseapplock'))
    expect(i).toBeGreaterThanOrEqual(0)
    expect(d).toBeGreaterThan(i)
    expect(r).toBeGreaterThan(d)
  })

  it('refuses a name outside NAME_RE or another schema, before any SQL', async () => {
    conn.sql = []
    const drop = await realDrop()
    await expect(drop({ schema: 'dbo', name: 'x]; DROP TABLE t; --' })).rejects.toThrow(/dbo/)
    await expect(drop({ schema: 'sales', name: 'old_report' })).rejects.toThrow(/dbo/)
    expect(conn.sql).toEqual([])
  })
})
