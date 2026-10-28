import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../db/index.js', async () => ({ db: (await import('./fake-store.js')).fakeDb }))

const live = vi.hoisted(() => ({ defs: new Map<string, string>() }))
vi.mock('../../../../services/procedure-deploy.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../services/procedure-deploy.js')>()
  return {
    ...real,
    liveProcedureDefinition: vi.fn(
      async (_schema: string | null, name: string) => live.defs.get(name.toLowerCase()) ?? null
    )
  }
})

import { procBodyHash } from '../../../../services/managed-procedures/normalize.js'
import { MANAGED_TABLE, VERSIONS_TABLE } from '../../../../services/managed-procedures/owners.js'
import {
  adoptLiveProcedure,
  getManagedProcedure,
  getManagedVersion,
  listManagedProcedures,
  listManagedVersions,
  ManagedProcError,
  markManagedDropped,
  putBackManaged,
  saveManagedVersion,
  stampDeployed,
  unmarkManagedDropped
} from '../../../../services/managed-procedures/store.js'
import { fakeStore, resetFakeStore, rowsOf, seedRow } from './fake-store.js'

const BODY = 'CREATE PROCEDURE spend_totals AS SELECT 1'
const BODY2 = 'CREATE PROCEDURE spend_totals AS SELECT 2'
const save = (body = BODY, extra: Record<string, unknown> = {}) =>
  saveManagedVersion({ name: 'spend_totals', body, note: 'n', userId: null, ...extra })

beforeEach(() => {
  resetFakeStore()
  live.defs = new Map()
})

describe('saveManagedVersion', () => {
  it('creates version 1 with a CREATE OR ALTER body', async () => {
    const r = await save()
    expect(r).toMatchObject({ version: 1, unchanged: false, previous: null })
    expect(r.procedure.body).toMatch(/^CREATE OR ALTER PROCEDURE spend_totals/)
    expect(r.procedure.body_hash).toBe(procBodyHash(BODY))
    expect(r.procedure).toMatchObject({
      name: 'spend_totals',
      version: 1,
      deployed_hash: null,
      dropped_at: null
    })
    expect(r.procedure.updated_at).toBeInstanceOf(Date)
    const versions = rowsOf(VERSIONS_TABLE)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      procedure_id: r.procedure.id,
      version: 1,
      body: r.procedure.body,
      body_hash: r.procedure.body_hash,
      note: 'n',
      created_by: null
    })
  })

  it('keeps a header that already says CREATE OR ALTER byte-identical', async () => {
    const body = 'create or alter proc spend_totals as select 1'
    const r = await save(body)
    expect(r.procedure.body).toBe(body)
  })

  it('a whitespace-only change is unchanged and writes no version', async () => {
    await save()
    const r = await save('CREATE   PROCEDURE  spend_totals\n  AS\tSELECT 1  ')
    expect(r).toMatchObject({ version: 1, unchanged: true })
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(1)
    expect(rowsOf(MANAGED_TABLE)[0].version).toBe(1)
  })

  it('a real change bumps the version and returns the previous row', async () => {
    const first = await save()
    const r = await save(BODY2, { userId: 'u1', description: 'Totals', owner: 'efp-ops' })
    expect(r).toMatchObject({ version: 2, unchanged: false })
    expect(r.previous).toMatchObject({ id: first.procedure.id, version: 1 })
    expect(r.procedure).toMatchObject({
      id: first.procedure.id,
      version: 2,
      body_hash: procBodyHash(BODY2),
      updated_by: 'u1',
      description: 'Totals',
      owner: 'efp-ops'
    })
    expect(rowsOf(VERSIONS_TABLE).map((v) => v.version)).toEqual([1, 2])
  })

  it('leaves description and owner alone when not given', async () => {
    await save(BODY, { description: 'Totals', owner: 'efp-ops' })
    const r = await save(BODY2)
    expect(r.procedure).toMatchObject({ description: 'Totals', owner: 'efp-ops' })
  })

  it('an unchanged body with a new owner or description updates them without a new version (R1)', async () => {
    await save(BODY, { description: 'Totals', owner: null })
    const r = await save(BODY, { owner: 'efp-ops', description: 'Spend totals', userId: 'u2' })
    expect(r).toMatchObject({ version: 1, unchanged: true })
    expect(r.procedure).toMatchObject({
      owner: 'efp-ops',
      description: 'Spend totals',
      updated_by: 'u2'
    })
    expect(rowsOf(MANAGED_TABLE)[0]).toMatchObject({ owner: 'efp-ops', version: 1 })
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(1)
  })

  it('an unchanged body with the same owner and description writes nothing', async () => {
    await save(BODY, { owner: 'efp-ops' })
    const before = { ...rowsOf(MANAGED_TABLE)[0] }
    const r = await save(BODY, { owner: 'efp-ops', userId: 'u2' })
    expect(r.unchanged).toBe(true)
    expect(rowsOf(MANAGED_TABLE)[0]).toEqual(before)
  })

  it('a stale base version is 409 PROC_STALE even when the hash matches (R3)', async () => {
    const first = await save("CREATE PROCEDURE spend_totals AS SELECT 'open'")
    // A case-only edit: same body_hash, new version.
    const second = await save("CREATE PROCEDURE spend_totals AS SELECT 'OPEN'", {
      baseHash: first.procedure.body_hash,
      baseVersion: 1
    })
    expect(second).toMatchObject({ version: 2, unchanged: false })
    expect(second.procedure.body_hash).toBe(first.procedure.body_hash)
    await expect(
      save("CREATE PROCEDURE spend_totals AS SELECT 'Open'", {
        baseHash: first.procedure.body_hash,
        baseVersion: 1
      })
    ).rejects.toMatchObject({ status: 409, code: 'PROC_STALE', extra: { current: { version: 2 } } })
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(2)
    await expect(
      save("CREATE PROCEDURE spend_totals AS SELECT 'Open'", { baseVersion: 2 })
    ).resolves.toMatchObject({ version: 3 })
  })

  it('refuses an invalid name (400 PROC_NAME_INVALID)', async () => {
    await expect(
      saveManagedVersion({ name: 'dbo.x', body: BODY, note: 'n', userId: null })
    ).rejects.toMatchObject({ status: 400, code: 'PROC_NAME_INVALID' })
    await expect(
      saveManagedVersion({ name: 'a'.repeat(129), body: BODY, note: 'n', userId: null })
    ).rejects.toMatchObject({ status: 400, code: 'PROC_NAME_INVALID' })
  })

  it('refuses a decoy header naming another procedure (400 PROC_HEADER_MISMATCH)', async () => {
    await expect(
      saveManagedVersion({
        name: 'Foo',
        body: '/* create procedure Foo */\nCREATE PROCEDURE Bar AS SELECT 1',
        note: 'n',
        userId: null
      })
    ).rejects.toMatchObject({ status: 400, code: 'PROC_HEADER_MISMATCH' })
    expect(rowsOf(MANAGED_TABLE)).toHaveLength(0)
  })

  it('refuses an import-owned name (409 APP_MANAGED) even when a managed row exists', async () => {
    seedRow('nivaro_import_definitions', {
      key: 'invoices',
      procedure: 'import_invoices',
      procedure_body: 'CREATE OR ALTER PROCEDURE import_invoices AS SELECT 1'
    })
    seedRow(MANAGED_TABLE, {
      name: 'import_invoices',
      body: 'x',
      body_hash: 'h',
      version: 1,
      dropped_at: null
    })
    const err = await saveManagedVersion({
      name: 'IMPORT_INVOICES',
      body: 'CREATE PROCEDURE import_invoices AS SELECT 2',
      note: 'n',
      userId: null
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ManagedProcError)
    expect(err).toMatchObject({
      status: 409,
      code: 'APP_MANAGED',
      extra: { definition: 'invoices' }
    })
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(0)
  })

  it('refuses a stale base hash (409 PROC_STALE)', async () => {
    const first = await save()
    await expect(save(BODY2, { baseHash: 'x' })).rejects.toMatchObject({
      status: 409,
      code: 'PROC_STALE',
      extra: { current: { body_hash: first.procedure.body_hash, version: 1 } }
    })
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(1)
    // The current hash passes.
    await expect(save(BODY2, { baseHash: first.procedure.body_hash })).resolves.toMatchObject({
      version: 2
    })
  })

  it('a null base hash means "new": stale when a row exists', async () => {
    await expect(save(BODY, { baseHash: null })).resolves.toMatchObject({ version: 1 })
    await expect(save(BODY2, { baseHash: null })).rejects.toMatchObject({
      status: 409,
      code: 'PROC_STALE'
    })
  })

  it('a save that lost a race to another writer is 409 PROC_STALE and writes nothing', async () => {
    await save()
    fakeStore.beforeUpdate = (table) => {
      if (table !== MANAGED_TABLE) return
      fakeStore.beforeUpdate = null
      // Another writer saved version 2 between our read and our update.
      Object.assign(rowsOf(MANAGED_TABLE)[0], { version: 2, body_hash: 'other' })
    }
    await expect(save(BODY2)).rejects.toMatchObject({ status: 409, code: 'PROC_STALE' })
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(1)
  })

  it('two first saves of one name: the second is 409 PROC_STALE', async () => {
    // Both read "no row", both insert: the unique name refuses the second insert.
    const first = save()
    const second = save(BODY2)
    const results = await Promise.allSettled([first, second])
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ status: 409, code: 'PROC_STALE' })
    expect(rowsOf(MANAGED_TABLE).filter((r) => r.name === 'spend_totals')).toHaveLength(1)
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(1)
  })

  it('saving a dropped proc clears dropped_at (Undo of a drop)', async () => {
    await save()
    await save(BODY2)
    const dropped = await markManagedDropped('spend_totals', 'u1')
    expect(dropped.dropped_at).toBeInstanceOf(Date)
    // The same body as the current version still counts: the save revives the row.
    const r = await save(BODY2)
    expect(r).toMatchObject({ version: 3, unchanged: false })
    expect(r.procedure.dropped_at).toBeNull()
    expect(r.previous?.dropped_at).toBeInstanceOf(Date)
    expect(rowsOf(MANAGED_TABLE)).toHaveLength(1)
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(3)
  })
})

describe('adoptLiveProcedure', () => {
  it('adopt stores the live text and stamps deployed_hash = body_hash', async () => {
    live.defs.set('spend_totals', BODY)
    const r = await adoptLiveProcedure('spend_totals', {
      userId: 'u1',
      by: 'user:u1',
      owner: 'efp-ops'
    })
    expect(r).toMatchObject({ version: 1, unchanged: false })
    expect(r.procedure.body).toMatch(/^CREATE OR ALTER PROCEDURE spend_totals AS SELECT 1$/)
    expect(r.procedure).toMatchObject({
      deployed_hash: procBodyHash(BODY),
      deployed_by: 'user:u1',
      owner: 'efp-ops',
      updated_by: 'u1'
    })
    expect(r.procedure.deployed_at).toBeInstanceOf(Date)
    expect(rowsOf(VERSIONS_TABLE)[0].note).toBe('Adopted from the live database')
  })

  it('adopting again with the same live text is unchanged but still stamps', async () => {
    live.defs.set('spend_totals', BODY)
    await adoptLiveProcedure('spend_totals', { userId: null, by: 'script:a', note: 'first' })
    const r = await adoptLiveProcedure('spend_totals', { userId: null, by: 'script:b' })
    expect(r).toMatchObject({ version: 1, unchanged: true })
    expect(r.procedure.deployed_by).toBe('script:b')
    expect(rowsOf(VERSIONS_TABLE).map((v) => v.note)).toEqual(['first'])
  })

  it('adopt of a proc that is not live is 404', async () => {
    await expect(
      adoptLiveProcedure('spend_totals', { userId: null, by: 'user:u1' })
    ).rejects.toMatchObject({ status: 404, code: 'PROC_NOT_FOUND' })
    expect(rowsOf(MANAGED_TABLE)).toHaveLength(0)
  })

  it('adopt of an import-owned proc is 409 APP_MANAGED', async () => {
    seedRow('nivaro_import_definitions', {
      key: 'invoices',
      procedure: 'import_invoices',
      procedure_body: 'CREATE OR ALTER PROCEDURE import_invoices AS SELECT 1'
    })
    live.defs.set('import_invoices', 'CREATE PROCEDURE import_invoices AS SELECT 1')
    await expect(
      adoptLiveProcedure('import_invoices', { userId: null, by: 'user:u1' })
    ).rejects.toMatchObject({ status: 409, code: 'APP_MANAGED', extra: { definition: 'invoices' } })
  })

  it('adopt of an invalid name is 400 before any read', async () => {
    await expect(
      adoptLiveProcedure('x;drop', { userId: null, by: 'user:u1' })
    ).rejects.toMatchObject({ status: 400, code: 'PROC_NAME_INVALID' })
  })
})

describe('markManagedDropped', () => {
  it('is 404 when there is no row', async () => {
    await expect(markManagedDropped('spend_totals', null)).rejects.toMatchObject({
      status: 404,
      code: 'PROC_NOT_FOUND'
    })
  })

  it('sets dropped_at and keeps body and versions', async () => {
    const s = await save()
    const d = await markManagedDropped('SPEND_TOTALS', 'u1')
    expect(d).toMatchObject({
      id: s.procedure.id,
      body: s.procedure.body,
      version: 1,
      updated_by: 'u1'
    })
    expect(d.dropped_at).toBeInstanceOf(Date)
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(1)
  })
})

describe('unmarkManagedDropped', () => {
  it('puts a row back as it was before the drop (its drop did not run)', async () => {
    const s = await save()
    const d = await markManagedDropped('spend_totals', 'u1')
    expect(await unmarkManagedDropped(s.procedure)).toBe(true)
    expect(rowsOf(MANAGED_TABLE)[0]).toMatchObject({
      dropped_at: null,
      updated_by: s.procedure.updated_by,
      version: d.version
    })
  })

  it('does nothing when a later save moved the row on', async () => {
    const s = await save()
    await markManagedDropped('spend_totals', 'u1')
    await save(BODY2)
    expect(await unmarkManagedDropped(s.procedure)).toBe(false)
    expect(rowsOf(MANAGED_TABLE)[0]).toMatchObject({ version: 2, dropped_at: null })
  })
})

describe('reads', () => {
  it('get / list / versions', async () => {
    expect(await getManagedProcedure('spend_totals')).toBeNull()
    expect(await listManagedVersions('spend_totals')).toEqual([])
    await save(BODY, { note: 'one' })
    await save(BODY2, { note: 'two', userId: 'u1' })
    seedRow(MANAGED_TABLE, { name: 'alpha', body: 'b', body_hash: 'h', version: 1 })

    expect((await getManagedProcedure('Spend_Totals'))?.version).toBe(2)
    expect((await listManagedProcedures()).map((p) => p.name)).toEqual(['alpha', 'spend_totals'])

    const versions = await listManagedVersions('spend_totals')
    expect(versions.map((v) => [v.version, v.note, v.created_by])).toEqual([
      [2, 'two', 'u1'],
      [1, 'one', null]
    ])
    expect(versions[0]).not.toHaveProperty('body')
    expect(await getManagedVersion('spend_totals', 1)).toMatchObject({
      version: 1,
      body: 'CREATE OR ALTER PROCEDURE spend_totals AS SELECT 1',
      note: 'one'
    })
    expect(await getManagedVersion('spend_totals', 9)).toBeNull()
    expect(await getManagedVersion('nope', 1)).toBeNull()
  })

  it('listManagedProcedures is empty on a database without the table', async () => {
    fakeStore.tables.delete(MANAGED_TABLE)
    expect(await listManagedProcedures()).toEqual([])
  })
})

describe('stampDeployed', () => {
  it('stamps hash, time and actor (null hash for a drop)', async () => {
    const s = await save()
    await stampDeployed(s.procedure.id, null, 'script:proc-deploy')
    const p = await getManagedProcedure('spend_totals')
    expect(p).toMatchObject({ deployed_hash: null, deployed_by: 'script:proc-deploy' })
    expect(p?.deployed_at).toBeInstanceOf(Date)
  })
})

describe('putBackManaged', () => {
  it('putBackManaged restores the previous row and deletes the new version', async () => {
    const first = await save(BODY, { description: 'd1' })
    await stampDeployed(first.procedure.id, first.procedure.body_hash, 'user:u1')
    const before = await getManagedProcedure('spend_totals')
    const r = await save(BODY2, { description: 'd2', userId: 'u2' })
    await putBackManaged(r.previous, r.procedure.id, r.version)
    expect(await getManagedProcedure('spend_totals')).toEqual(before)
    expect(rowsOf(VERSIONS_TABLE).map((v) => v.version)).toEqual([1])
  })

  it('putBackManaged of a first save deletes the row and its version', async () => {
    const r = await save()
    await putBackManaged(r.previous, r.procedure.id, r.version)
    expect(rowsOf(MANAGED_TABLE)).toHaveLength(0)
    expect(rowsOf(VERSIONS_TABLE)).toHaveLength(0)
  })

  it('putBackManaged restores a dropped row it revived', async () => {
    await save()
    await markManagedDropped('spend_totals', null)
    const r = await save()
    await putBackManaged(r.previous, r.procedure.id, r.version)
    const p = await getManagedProcedure('spend_totals')
    expect(p?.dropped_at).toBeInstanceOf(Date)
    expect(p?.version).toBe(1)
  })

  it('does nothing when a later save moved the row on', async () => {
    await save()
    const r = await save(BODY2)
    await save('CREATE PROCEDURE spend_totals AS SELECT 3')
    await putBackManaged(r.previous, r.procedure.id, r.version)
    expect((await getManagedProcedure('spend_totals'))?.version).toBe(3)
    expect(rowsOf(VERSIONS_TABLE).map((v) => v.version)).toEqual([1, 2, 3])
  })
})
