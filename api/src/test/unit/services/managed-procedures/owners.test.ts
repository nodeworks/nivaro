import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

/** A db stand-in answering the two owner tables (plus the cross-database raw reads). */
const fake = vi.hoisted(() => {
  const state = {
    tables: new Set<string>(),
    imports: [] as Row[],
    managed: [] as Row[],
    raw: [] as Array<{ sql: string; bindings: unknown[] }>,
    /** OBJECT_ID answers by the three-part name asked. */
    objectIds: new Map<string, number | null>()
  }
  function chain(table: string) {
    const rows = () =>
      table === 'nivaro_import_definitions'
        ? state.imports.filter((r) => r.procedure_body != null && r.procedure != null)
        : state.managed
    const q: any = {
      whereNotNull: () => q,
      select: () => q,
      // biome-ignore lint/suspicious/noThenProperty: a knex query builder is thenable
      then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows()).then(res, rej)
    }
    return q
  }
  const db: any = (table: string) => chain(table)
  db.schema = { hasTable: async (t: string) => state.tables.has(t) }
  db.raw = async (sql: string, bindings: unknown[] = []) => {
    state.raw.push({ sql, bindings })
    if (/OBJECT_ID/i.test(sql)) return [{ oid: state.objectIds.get(String(bindings[0])) ?? null }]
    if (/nivaro_import_definitions/.test(sql)) {
      return state.imports.filter((r) => r.procedure_body != null && r.procedure != null)
    }
    if (/nivaro_managed_procedures/.test(sql)) return state.managed
    return []
  }
  return { state, db }
})

vi.mock('../../../../db/index.js', () => ({ db: fake.db }))

import {
  appManagedProcedures,
  MANAGED_TABLE,
  managedImportCollisions,
  procedureOwner,
  VERSIONS_TABLE
} from '../../../../services/managed-procedures/owners.js'

beforeEach(() => {
  fake.state.tables = new Set(['nivaro_import_definitions', 'nivaro_managed_procedures'])
  fake.state.imports = [
    { key: 'invoices', procedure: 'import_invoices', procedure_body: 'CREATE PROC x AS SELECT 1' },
    { key: 'no_body', procedure: 'import_no_body', procedure_body: null }
  ]
  fake.state.managed = [{ id: 3, name: 'Spend_Totals', dropped_at: null }]
  fake.state.raw = []
  fake.state.objectIds = new Map()
})

describe('appManagedProcedures', () => {
  it('names its tables', () => {
    expect(MANAGED_TABLE).toBe('nivaro_managed_procedures')
    expect(VERSIONS_TABLE).toBe('nivaro_managed_procedure_versions')
  })

  it('unions import bodies and managed rows, keys lowercased', async () => {
    const m = await appManagedProcedures()
    expect(m.get('import_invoices')).toEqual({
      kind: 'import',
      key: 'invoices',
      name: 'import_invoices'
    })
    expect(m.get('spend_totals')).toEqual({
      kind: 'managed',
      id: 3,
      name: 'Spend_Totals',
      dropped: false
    })
    // An import definition without a body owns nothing.
    expect(m.has('import_no_body')).toBe(false)
    expect(m.size).toBe(2)
  })

  it('import wins when both claim a name', async () => {
    fake.state.managed.push({ id: 9, name: 'Import_Invoices', dropped_at: null })
    expect((await appManagedProcedures()).get('import_invoices')?.kind).toBe('import')
    expect(await managedImportCollisions()).toEqual(['import_invoices'])
  })

  it('no collision when the names differ', async () => {
    expect(await managedImportCollisions()).toEqual([])
  })

  it('a dropped managed row is still owned (writers must skip it too)', async () => {
    fake.state.managed.push({ id: 4, name: 'old_proc', dropped_at: new Date('2026-10-01') })
    expect(await procedureOwner('old_proc')).toMatchObject({ kind: 'managed', dropped: true })
    expect(await procedureOwner('OLD_PROC')).toMatchObject({ kind: 'managed', id: 4 })
    expect(await procedureOwner('nobody')).toBeNull()
  })

  it('missing tables answer an empty map, never throw', async () => {
    fake.state.tables = new Set()
    const m = await appManagedProcedures()
    expect(m.size).toBe(0)
    expect(await procedureOwner('import_invoices')).toBeNull()
    expect(await managedImportCollisions()).toEqual([])
  })

  it('a missing managed table still answers the import owners', async () => {
    fake.state.tables = new Set(['nivaro_import_definitions'])
    const m = await appManagedProcedures()
    expect([...m.keys()]).toEqual(['import_invoices'])
  })

  it('refuses a database name that is not a plain identifier', async () => {
    await expect(appManagedProcedures({ database: 'EFP];DROP' })).rejects.toThrow()
    await expect(appManagedProcedures({ database: '' })).rejects.toThrow()
    expect(fake.state.raw).toEqual([])
  })

  it('reads another database by three-part name, guarded by OBJECT_ID', async () => {
    fake.state.objectIds.set('[EFP_Development].dbo.nivaro_import_definitions', 101)
    fake.state.objectIds.set('[EFP_Development].dbo.nivaro_managed_procedures', 102)
    const m = await appManagedProcedures({ database: 'EFP_Development' })
    expect(m.get('import_invoices')?.kind).toBe('import')
    expect(m.get('spend_totals')?.kind).toBe('managed')
    const reads = fake.state.raw.filter((r) => !/OBJECT_ID/i.test(r.sql)).map((r) => r.sql)
    expect(reads.length).toBe(2)
    for (const sql of reads) expect(sql).toContain('[EFP_Development].dbo.')
  })

  it('another database without the tables contributes nothing', async () => {
    const m = await appManagedProcedures({ database: 'Other_DB' })
    expect(m.size).toBe(0)
    expect(fake.state.raw.every((r) => /OBJECT_ID/i.test(r.sql))).toBe(true)
  })
})
