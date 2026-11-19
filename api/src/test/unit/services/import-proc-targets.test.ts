import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import {
  procedureNameOf,
  procedureWritesOf,
  procedureWrittenCollections
} from '../../../services/import-proc-targets.js'

// rt-fix C / M2: a procedure-backed import announces every registered table it writes.

const IMPORT_PO = `CREATE PROCEDURE dbo.import_po AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @t TABLE (id int);
  INSERT INTO #stage (a) SELECT a FROM stg_po;
  MERGE INTO dbo.purchase_orders AS t
  USING #stage AS s ON t.po_number = s.po_number
  WHEN MATCHED THEN UPDATE SET t.amount = s.amount
  WHEN NOT MATCHED THEN INSERT (po_number) VALUES (s.po_number);
  UPDATE p SET p.total = x.total FROM [projects] p JOIN #totals x ON x.id = p.id;
  DELETE FROM purchase_order_lines WHERE po IS NULL;
  INSERT INTO nivaro_raw_writes (collection) VALUES ('other');
  -- a comment: UPDATE workflows SET x = 1
  EXEC dbo.recalc_po_totals @full = 1;
  EXEC sp_executesql N'UPDATE workflows SET y = 2';
END`

describe('procedureWritesOf', () => {
  it('finds MERGE / aliased UPDATE / DELETE targets, skips temps, table variables, comments and Nivaro tables', () => {
    const w = procedureWritesOf(IMPORT_PO)
    expect([...w.tables].sort()).toEqual(
      ['purchase_order_lines', 'purchase_orders', 'projects'].sort()
    )
    expect([...w.calls]).toEqual(['recalc_po_totals'])
    expect(w.announced.names.has('other')).toBe(true)
  })
})

describe('procedureNameOf', () => {
  it('takes the name off what the definition EXECs', () => {
    expect(procedureNameOf('dbo.import_po @x = 1')).toBe('dbo.import_po')
    expect(procedureNameOf('[dbo].[import po]')).toBe('[dbo].[import po]')
    expect(procedureNameOf('  ')).toBeNull()
  })
})

describe('procedureWrittenCollections', () => {
  afterEach(() => vi.clearAllMocks())

  it('follows called procedures, keeps registered collections, drops what a procedure announces itself', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((() => ({
      select: async () => [
        { collection: 'purchase_orders' },
        { collection: 'projects' },
        { collection: 'workflows' },
        { collection: 'invoices' }
      ]
    })) as never)
    const defs: Record<string, string> = {
      'dbo.import_po': IMPORT_PO,
      recalc_po_totals: `CREATE PROCEDURE recalc_po_totals AS
        UPDATE invoices SET po_total = 1;
        UPDATE workflows SET amount = 2;
        EXEC dbo.nivaro_announce_writes @Collection = N'workflows', @Ids = NULL;`
    }
    const got = await procedureWrittenCollections(
      'dbo.import_po',
      null,
      async (n) => defs[n] ?? null
    )
    // purchase_order_lines is not registered; workflows announces itself
    expect(got).toEqual(['invoices', 'projects', 'purchase_orders'])
  })

  it('falls back to the stored body when the database has no definition', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((() => ({
      select: async () => [{ collection: 'projects' }]
    })) as never)
    const got = await procedureWrittenCollections(
      'import_projects',
      'CREATE PROCEDURE import_projects AS UPDATE projects SET a = 1',
      async () => null
    )
    expect(got).toEqual(['projects'])
  })

  it('never loops on a procedure that calls itself', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((() => ({
      select: async () => [{ collection: 'projects' }]
    })) as never)
    const read = vi.fn(async () => 'CREATE PROCEDURE p AS UPDATE projects SET a = 1; EXEC p;')
    expect(await procedureWrittenCollections('p', null, read)).toEqual(['projects'])
    expect(read).toHaveBeenCalledTimes(1)
  })
})
