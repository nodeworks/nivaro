import { describe, expect, it, vi } from 'vitest'

// Pentest M-4 (2026-11-16): the User-Scope backstop missed scoped rows read
// THROUGH a view or a table-valued function, so a zone-restricted person got
// every zone's rows from `SELECT * FROM v_workflow_state`. The read set now
// resolves every identifier against sys.objects, follows views / functions /
// procedures and names what it cannot follow. The security review of the first
// cut (regex FROM/JOIN parsing) found comma joins, "quoted" names, bare
// procedure calls, `db..name`, literals hiding comment markers and CLR objects
// slipping through — each has a case below.

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
        'fn_zone',
        {
          type: 'FN',
          definition:
            'CREATE FUNCTION fn_zone(@id int) RETURNS int AS BEGIN RETURN (SELECT TOP 1 1 FROM workflows_divisions) END'
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
      ['clr_rows', { type: 'FT', definition: null }],
      ['pk_workflows', { type: 'PK', definition: null }],
      ['nivaro_users', { type: 'U', definition: null }],
      ['zoné_rows', { type: 'U', definition: null }]
    ])
)

vi.mock('../../../db/index.js', () => ({
  db: {
    raw: vi.fn(async (sql: string, binds?: string[]) => {
      if (/DB_NAME\(\)/.test(sql)) return [{ d: 'EFP' }]
      if (/sys\.schemas/.test(sql)) return [{ name: 'dbo' }, { name: 'sys' }, { name: 'rpt' }]
      if (/sys\.databases/.test(sql)) return [{ name: 'EFP' }, { name: 'master' }, { name: 'rpt' }]
      const names = JSON.parse(binds?.[0] ?? '[]') as string[]
      return names
        .map((n) => [n, objects.get(n.toLowerCase())] as const)
        .filter(([, o]) => o)
        .map(([n, o]) => ({ name: n, type: o!.type, definition: o!.definition }))
    })
  }
}))

const { readSetOf, dottedNames, tokenize } = await import('../../../services/sql-read-set.js')
const sorted = (r: { tables: string[]; opaque: string[] }) => ({
  ...r,
  tables: [...r.tables].sort()
})

describe('readSetOf', () => {
  it('follows a view to the tables behind it', async () => {
    expect(sorted(await readSetOf('SELECT * FROM v_workflow_state'))).toEqual({
      tables: ['workflows', 'workflows_divisions'],
      opaque: []
    })
  })

  it('follows nested views, table-valued and scalar functions and procedures', async () => {
    const r = await readSetOf(
      'SELECT dbo.fn_zone(1) FROM v_outer CROSS APPLY dbo.fn_rows() f; EXEC p_plain'
    )
    expect(sorted(r)).toEqual({
      tables: ['vendors', 'workflows', 'workflows_divisions'],
      opaque: []
    })
  })

  it('catches comma joins, quoted names and a bare procedure call (review findings 2 + 5)', async () => {
    expect((await readSetOf('SELECT * FROM vendors v, workflows w')).tables.sort()).toEqual([
      'vendors',
      'workflows'
    ])
    expect((await readSetOf('SELECT * FROM "v_workflow_state"')).tables.sort()).toEqual([
      'workflows',
      'workflows_divisions'
    ])
    expect((await readSetOf('p_plain')).tables.sort()).toEqual(['workflows', 'workflows_divisions'])
  })

  it('a comment marker inside a string literal hides nothing (review finding 1)', async () => {
    const r = await readSetOf("SELECT '--' AS a, * FROM vendors JOIN workflows w ON 1 = 1 /* '*/")
    expect(r.tables.sort()).toEqual(['vendors', 'workflows'])
  })

  it('names dynamic SQL, even inside a procedure it executes', async () => {
    expect((await readSetOf('EXEC dbo.p_dyn')).opaque).toEqual([
      'dynamic SQL (sp_executesql)',
      'a procedure that cannot be followed (sp_executesql)'
    ])
    expect((await readSetOf("DECLARE @s nvarchar(max) = 'x'; EXEC(@s)")).opaque).toEqual([
      'dynamic SQL (EXEC of a string)'
    ])
    expect((await readSetOf('EXEC @proc')).opaque).toEqual(['a procedure named by a variable'])
    // A return-code assignment is not a procedure named by a variable.
    expect((await readSetOf('DECLARE @rc int; EXEC @rc = p_plain')).opaque).toEqual([])
    // The words inside a literal are data, not code.
    expect((await readSetOf("SELECT 'call sp_executesql later' AS note")).opaque).toEqual([])
  })

  it('names another database, db..name, a linked server, a synonym, CLR and unreadable modules (findings 3 + 4)', async () => {
    expect((await readSetOf('SELECT * FROM OtherDb.dbo.workflows')).opaque).toEqual([
      'another database (OtherDb.dbo.workflows)'
    ])
    expect((await readSetOf('SELECT * FROM OtherDb..workflows')).opaque).toEqual([
      'another database (OtherDb..workflows)'
    ])
    expect((await readSetOf('SELECT * FROM EFP.dbo.workflows')).opaque).toEqual([])
    expect((await readSetOf('SELECT dbo.workflows.id FROM dbo.workflows')).opaque).toEqual([])
    expect((await readSetOf('SELECT * FROM srv.db.dbo.workflows')).opaque).toEqual([
      'a linked-server name (srv.db.dbo.workflows)'
    ])
    expect((await readSetOf('SELECT * FROM syn_wf')).opaque).toEqual(['a synonym (syn_wf)'])
    expect((await readSetOf('SELECT * FROM clr_rows()')).opaque).toEqual([
      'an object that cannot be followed (clr_rows, FT)'
    ])
    expect((await readSetOf('SELECT * FROM secret_view')).opaque).toEqual([
      'an encrypted or unreadable module (secret_view)'
    ])
    expect((await readSetOf("SELECT * FROM OPENQUERY(x, 'select 1')")).opaque).toEqual([
      'a remote or document read (OPENQUERY / OPENROWSET)'
    ])
  })

  it('ignores names that hold no rows: built-ins, CTEs, variables, temp tables, constraints, comments', async () => {
    const r = await readSetOf(`
      -- pulled from the old report; EXEC(@x) once lived here
      /* select * from somewhere_else /* nested */ still a comment */
      WITH recent AS (SELECT id FROM workflows)
      SELECT * FROM recent r JOIN STRING_SPLIT(@zones, ',') s ON 1 = 1
      JOIN @ids i ON i.id = r.id JOIN #tmp t ON t.id = r.id -- pk_workflows`)
    expect(r).toEqual({ tables: ['workflows'], opaque: [] })
    expect((await readSetOf('SELECT pk_workflows = 1')).opaque).toEqual([])
  })

  it('leaves system tables out of the table list', async () => {
    expect((await readSetOf('SELECT * FROM nivaro_users JOIN vendors v ON 1 = 1')).tables).toEqual([
      'vendors'
    ])
  })
})

describe('readSetOf — security review rounds 2 + 3 (2026-11-16)', () => {
  it('a procedure that is not an object here (system, extended, another DB) is opaque', async () => {
    expect(
      (await readSetOf("EXEC sp_cursoropen @c OUTPUT, N'SELECT * FROM workflows'")).opaque
    ).toEqual([
      'dynamic SQL (a system procedure that runs a string)',
      'a procedure that cannot be followed (sp_cursoropen)'
    ])
    expect((await readSetOf('EXEC xp_anything 1')).opaque).toEqual([
      'a procedure that cannot be followed (xp_anything)'
    ])
    expect((await readSetOf('p_nowhere @x = 1')).opaque).toEqual([
      'a procedure that cannot be followed (p_nowhere)'
    ])
    expect((await readSetOf('EXEC p_plain')).opaque).toEqual([])
  })

  it('EXEC of a variable with no space before it (review round 4)', async () => {
    expect((await readSetOf('EXEC@proc')).opaque).toContain('a procedure named by a variable')
    expect((await readSetOf('EXECUTE@rc=@p')).opaque).toContain('a procedure named by a variable')
  })

  it('EXEC of a variable, also after a return-code assignment', async () => {
    expect((await readSetOf('DECLARE @rc int, @p sysname; EXEC @rc = @p')).opaque).toContain(
      'a procedure named by a variable'
    )
  })

  it('names inside string literals count toward the read set', async () => {
    expect((await readSetOf("SELECT 'workflows' AS t, 1 FROM vendors")).tables.sort()).toEqual([
      'vendors',
      'workflows'
    ])
  })

  it('reads Unicode identifiers whole', async () => {
    expect((await readSetOf('SELECT * FROM zoné_rows')).tables).toEqual(['zoné_rows'])
  })

  it('a three-part name naming another database is opaque even when a schema shares its name', async () => {
    expect((await readSetOf('SELECT * FROM rpt.dbo.workflows')).opaque).toEqual([
      'another database (rpt.dbo.workflows)'
    ])
  })
})

describe('tokenize / dottedNames', () => {
  it('reads bracketed, quoted and empty-part names', () => {
    expect(
      dottedNames(tokenize('SELECT * FROM [dbo].[v x] JOIN "a".b ON 1=1 JOIN c..d w'))
    ).toEqual([
      ['dbo', 'v x'],
      ['a', 'b'],
      ['c', '', 'd']
    ])
  })
})
