import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pentest M-4 (2026-11-16): the User-Scope backstop missed scoped rows read
// THROUGH a view or a table-valued function, so a zone-restricted person got
// every zone's rows from `SELECT * FROM v_workflow_state`. The read set now
// follows views / functions / procedures and names what it cannot follow.

const objects = vi.hoisted(
  () =>
    new Map<string, { type: string; definition: string | null }>([
      ['workflows', { type: 'U', definition: null }],
      ['workflows_divisions', { type: 'U', definition: null }],
      ['vendors', { type: 'U', definition: null }],
      [
        'v_workflow_state',
        {
          type: 'V',
          definition:
            'CREATE VIEW v_workflow_state AS SELECT w.id FROM dbo.workflows w JOIN workflows_divisions d ON d.workflows_id = w.id'
        }
      ],
      [
        'v_outer',
        { type: 'V', definition: 'CREATE VIEW v_outer AS SELECT * FROM v_workflow_state' }
      ],
      [
        'fn_rows',
        {
          type: 'IF',
          definition:
            'CREATE FUNCTION fn_rows() RETURNS TABLE AS RETURN SELECT * FROM [dbo].[vendors]'
        }
      ],
      [
        'p_dyn',
        {
          type: 'P',
          definition: "CREATE PROC p_dyn AS EXEC sp_executesql N'SELECT * FROM workflows'"
        }
      ],
      ['p_plain', { type: 'P', definition: 'CREATE PROC p_plain AS SELECT * FROM v_outer' }],
      ['secret_view', { type: 'V', definition: null }],
      ['syn_wf', { type: 'SN', definition: null }],
      ['nivaro_users', { type: 'U', definition: null }]
    ])
)

vi.mock('../../../db/index.js', () => ({
  db: {
    raw: vi.fn(async (sql: string, binds?: string[]) => {
      if (/DB_NAME\(\)/.test(sql)) return [{ d: 'EFP' }]
      return (binds ?? [])
        .map((n) => [n, objects.get(n.toLowerCase())] as const)
        .filter(([, o]) => o)
        .map(([n, o]) => ({ name: n, type: o!.type, definition: o!.definition }))
    })
  }
}))

const { readSetOf, namesIn } = await import('../../../services/sql-read-set.js')

describe('readSetOf', () => {
  beforeEach(() => vi.clearAllMocks())

  it('follows a view to the tables behind it', async () => {
    expect(await readSetOf('SELECT * FROM v_workflow_state')).toEqual({
      tables: ['workflows', 'workflows_divisions'],
      opaque: []
    })
  })

  it('follows nested views, table-valued functions and procedures', async () => {
    const r = await readSetOf('SELECT * FROM v_outer CROSS APPLY dbo.fn_rows() f; EXEC p_plain')
    expect(r.tables.sort()).toEqual(['vendors', 'workflows', 'workflows_divisions'])
    expect(r.opaque).toEqual([])
  })

  it('names dynamic SQL, even inside a procedure it executes', async () => {
    expect((await readSetOf('EXEC dbo.p_dyn')).opaque).toEqual(['dynamic SQL (sp_executesql)'])
    expect((await readSetOf("DECLARE @s nvarchar(max) = 'x'; EXEC(@s)")).opaque).toEqual([
      'dynamic SQL (EXEC of a string)'
    ])
    expect((await readSetOf('EXEC @proc')).opaque).toEqual(['a procedure named by a variable'])
  })

  it('names another database, a linked server, a synonym and an unreadable module', async () => {
    expect((await readSetOf('SELECT * FROM OtherDb.dbo.workflows')).opaque).toEqual([
      'another database (OtherDb.workflows)'
    ])
    expect((await readSetOf('SELECT * FROM EFP.dbo.workflows')).opaque).toEqual([])
    expect((await readSetOf('SELECT * FROM srv.db.dbo.workflows')).opaque).toEqual([
      'a linked-server name (workflows)'
    ])
    expect((await readSetOf('SELECT * FROM syn_wf')).opaque).toEqual(['a synonym (syn_wf)'])
    expect((await readSetOf('SELECT * FROM secret_view')).opaque).toEqual([
      'an encrypted or unreadable module (secret_view)'
    ])
    expect((await readSetOf("SELECT * FROM OPENQUERY(x, 'select 1')")).opaque).toEqual([
      'a remote read (OPENQUERY / OPENROWSET)'
    ])
  })

  it('ignores names that hold no rows here: built-ins, CTEs, table variables, temp tables, comments', async () => {
    const r = await readSetOf(`
      -- pulled from the old report; EXEC(@x) once lived here
      /* select * from somewhere_else */
      WITH recent AS (SELECT id FROM workflows)
      SELECT * FROM recent r JOIN STRING_SPLIT(@zones, ',') s ON 1 = 1
      JOIN @ids i ON i.id = r.id JOIN #tmp t ON t.id = r.id`)
    expect(r).toEqual({ tables: ['workflows'], opaque: [] })
  })

  it('leaves system tables out of the table list', async () => {
    expect((await readSetOf('SELECT * FROM nivaro_users JOIN vendors v ON 1 = 1')).tables).toEqual([
      'vendors'
    ])
  })
})

describe('namesIn', () => {
  it('reads bracketed and dotted names', () => {
    expect(namesIn('SELECT * FROM [dbo].[v_x] JOIN EFP.dbo.y ON 1=1')).toEqual([
      { name: 'v_x' },
      { name: 'y', database: 'EFP' }
    ])
  })
})
