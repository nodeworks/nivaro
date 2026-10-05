import { describe, expect, it } from 'vitest'
import { applyTransformers } from '../../../../services/db-tuning/rewrites/index.js'
import { junctionExists } from '../../../../services/db-tuning/rewrites/junction-exists.js'
import { lastSuccessGrouped } from '../../../../services/db-tuning/rewrites/last-success-grouped.js'
import { tempTableGuard } from '../../../../services/db-tuning/rewrites/temp-table-guard.js'

const FANOUT = `CREATE PROCEDURE dbo.spend_by_zone @Zones NVARCHAR(MAX) = NULL AS
BEGIN
  SELECT p.id, SUM(i.amount) AS total
  FROM projects p
  JOIN invoices i ON i.project = p.id
  LEFT JOIN project_zones_junction pz ON pz.project_id = p.id
  WHERE (@Zones IS NULL OR pz.zone_id IN (SELECT value FROM STRING_SPLIT(@Zones, ',')))
  GROUP BY p.id
END`

const FANOUT_EXISTS = `CREATE PROCEDURE dbo.spend_by_zone @Zones NVARCHAR(MAX) = NULL AS
BEGIN
  SELECT p.id, SUM(i.amount) AS total
  FROM projects p
  JOIN invoices i ON i.project = p.id
  WHERE (@Zones IS NULL OR EXISTS (SELECT 1 FROM project_zones_junction pz WHERE pz.project_id = p.id AND pz.zone_id IN (SELECT value FROM STRING_SPLIT(@Zones, ','))))
  GROUP BY p.id
END`

describe('junction-exists', () => {
  it('turns a filter-only LEFT JOIN into EXISTS and keeps the NULL escape', () => {
    const r = junctionExists.apply(FANOUT)
    expect(r).not.toBeNull()
    expect(r!.body).not.toMatch(/LEFT JOIN project_zones_junction/)
    expect(r!.body).toMatch(
      /EXISTS \(SELECT 1 FROM project_zones_junction pz WHERE pz\.project_id = p\.id AND pz\.zone_id IN \(SELECT value FROM STRING_SPLIT\(@Zones, ','\)\)\)/
    )
    expect(r!.body).toMatch(/@Zones IS NULL OR EXISTS/)
    expect(r!.notes[0]).toMatch(/project_zones_junction pz was filter-only/)
  })
  it('leaves a join alone when its alias is in the SELECT list', () => {
    const body = FANOUT.replace('SELECT p.id,', 'SELECT p.id, pz.zone_id,').replace(
      'GROUP BY p.id',
      'GROUP BY p.id, pz.zone_id'
    )
    expect(junctionExists.apply(body)).toBeNull()
  })
  it('turns a filter-only INNER JOIN with no predicate into an existence gate', () => {
    const body = `SELECT po.id, po.amount FROM purchase_orders po
JOIN workflow_po_junction j ON j.purchase_order = po.id
WHERE po.amount > 0`
    const r = junctionExists.apply(body)
    expect(r!.body).toMatch(
      /WHERE po\.amount > 0 AND EXISTS \(SELECT 1 FROM workflow_po_junction j WHERE j\.purchase_order = po\.id\)/
    )
  })
  it('returns null when a predicate on the alias also names another alias', () => {
    const body = FANOUT.replace('pz.zone_id IN', 'pz.zone_id = i.zone OR pz.zone_id IN')
    expect(junctionExists.apply(body)).toBeNull()
  })

  // shapes that must decline
  it('declines when the alias is only in the GROUP BY', () => {
    expect(
      junctionExists.apply(FANOUT.replace('GROUP BY p.id', 'GROUP BY p.id, pz.zone_id'))
    ).toBeNull()
  })
  it('declines when another join hangs off the alias', () => {
    const body = FANOUT.replace('  WHERE', '  LEFT JOIN zones z ON z.id = pz.zone_id\n  WHERE')
    expect(junctionExists.apply(body)).toBeNull()
  })
  it('declines a LEFT JOIN predicate that is true on the missing row (IS NULL)', () => {
    const body = FANOUT.replace(/WHERE .*\n/, 'WHERE pz.zone_id IS NULL\n')
    expect(junctionExists.apply(body)).toBeNull()
  })
  it('declines two predicates on the alias (they must hold on the same junction row)', () => {
    const body = FANOUT.replace(/WHERE (.*)\n/, "WHERE $1 AND pz.kind = 'primary'\n")
    expect(junctionExists.apply(body)).toBeNull()
  })
  it('declines a WHERE with a top-level OR', () => {
    const body = FANOUT.replace(/WHERE (.*)\n/, 'WHERE p.closed = 1 OR $1\n')
    expect(junctionExists.apply(body)).toBeNull()
  })
  it('declines when the FROM has a RIGHT JOIN or the SELECT list has a bare *', () => {
    expect(
      junctionExists.apply(FANOUT.replace('JOIN invoices i', 'RIGHT JOIN invoices i'))
    ).toBeNull()
    expect(
      junctionExists.apply(FANOUT.replace('SELECT p.id, SUM(i.amount) AS total', 'SELECT *'))
    ).toBeNull()
  })
  it('declines a LEFT JOIN no predicate filters on (removing it is not a filter rewrite)', () => {
    const body = `SELECT po.id FROM purchase_orders po
LEFT JOIN workflow_po_junction j ON j.purchase_order = po.id
WHERE po.amount > 0`
    expect(junctionExists.apply(body)).toBeNull()
  })
  it('never appends a gate to a WHERE that belongs to the next statement', () => {
    const body = `SELECT po.id FROM purchase_orders po
JOIN workflow_po_junction j ON j.purchase_order = po.id;
SELECT x.id FROM other_table x WHERE x.id > 0`
    expect(junctionExists.apply(body)).toBeNull()
  })
  it('keeps the INNER join existence requirement when the predicate has a NULL escape', () => {
    const body = `SELECT po.id FROM purchase_orders po
JOIN workflow_po_junction j ON j.purchase_order = po.id
WHERE po.amount > 0 AND (@Wf IS NULL OR j.workflow = @Wf)`
    const r = junctionExists.apply(body)
    expect(r!.body).toMatch(
      /AND EXISTS \(SELECT 1 FROM workflow_po_junction j WHERE j\.purchase_order = po\.id AND \(@Wf IS NULL OR j\.workflow = @Wf\)\)/
    )
    expect(r!.body).not.toMatch(/@Wf IS NULL OR EXISTS/)
  })
  it('is not fooled by alias text inside strings and comments', () => {
    const label = (b: string) =>
      b.replace('SELECT p.id,', "SELECT p.id, 'pz.zone_id' AS label, -- pz.zone_id\n  ")
    expect(junctionExists.apply(label(FANOUT))?.body).toBe(label(FANOUT_EXISTS))
    expect(
      junctionExists.apply(
        '-- LEFT JOIN project_zones_junction pz ON pz.project_id = p.id WHERE pz.zone_id = 1\nSELECT 1'
      )
    ).toBeNull()
  })

  it('rewrites FANOUT to exactly this body', () => {
    expect(junctionExists.apply(FANOUT)?.body).toBe(FANOUT_EXISTS)
  })
  it('rewrites the INNER gate to exactly this body', () => {
    const body = `SELECT po.id, po.amount FROM purchase_orders po
JOIN workflow_po_junction j ON j.purchase_order = po.id
WHERE po.amount > 0`
    expect(junctionExists.apply(body)?.body).toBe(`SELECT po.id, po.amount FROM purchase_orders po
WHERE po.amount > 0 AND EXISTS (SELECT 1 FROM workflow_po_junction j WHERE j.purchase_order = po.id)`)
  })

  // review round 1, finding 1: NULL <> ALL (empty set) is TRUE — not NULL-rejecting
  it('declines a quantified comparison (ALL / ANY / SOME), bare or behind an escape', () => {
    const base = `SELECT p.id FROM projects p LEFT JOIN pz_j pz ON pz.project_id = p.id WHERE `
    expect(
      junctionExists.apply(`${base}pz.zone_id <> ALL (SELECT value FROM STRING_SPLIT(@Excl, ','))`)
    ).toBeNull()
    expect(
      junctionExists.apply(
        `${base}(@E IS NULL OR pz.z > ANY (SELECT value FROM STRING_SPLIT(@E, ',')))`
      )
    ).toBeNull()
    expect(junctionExists.apply(`${base}pz.z = SOME (SELECT 1)`)).toBeNull()
  })

  // review round 1, finding 2: an unqualified junction column in a nested owner rebinds outward
  it('declines a nested owner that names any column unqualified', () => {
    expect(
      junctionExists.apply(
        'SELECT o.id FROM orders o WHERE o.pid IN (SELECT p.id FROM projects p JOIN pz_j pz ON pz.project_id = p.id WHERE zone_id = 5)'
      )
    ).toBeNull()
    expect(
      junctionExists.apply(
        'SELECT o.id FROM orders o WHERE o.pid IN (SELECT p.id FROM projects p LEFT JOIN pz_j pz ON pz.project_id = p.id WHERE pz.zone_id = 5 AND is_primary = 1)'
      )
    ).toBeNull()
    expect(
      junctionExists.apply(
        'SELECT o.id, (SELECT COUNT(*) FROM projects p JOIN pz_j pz ON pz.project_id = p.id WHERE p.owner = o.id AND is_primary = 1) AS n FROM orders o'
      )
    ).toBeNull()
  })
  it('rewrites a nested owner whose columns are all qualified, and a derived-table body', () => {
    expect(
      junctionExists.apply(
        'SELECT o.id FROM orders o WHERE o.pid IN (SELECT p.id FROM projects p JOIN pz_j pz ON pz.project_id = p.id WHERE p.active = 1)'
      )?.body
    ).toBe(
      'SELECT o.id FROM orders o WHERE o.pid IN (SELECT p.id FROM projects p WHERE p.active = 1 AND EXISTS (SELECT 1 FROM pz_j pz WHERE pz.project_id = p.id))'
    )
    expect(
      junctionExists.apply(
        'SELECT d.id FROM (SELECT p.id FROM projects p JOIN pz_j pz ON pz.project_id = p.id WHERE active = 1) d'
      )?.body
    ).toBe(
      'SELECT d.id FROM (SELECT p.id FROM projects p WHERE active = 1 AND EXISTS (SELECT 1 FROM pz_j pz WHERE pz.project_id = p.id)) d'
    )
  })
})

describe('temp-table-guard', () => {
  it('adds a guard before the first build of each unguarded temp table', () => {
    const r = tempTableGuard.apply('CREATE PROC x AS\nSELECT 1 AS a INTO #b;\nSELECT * FROM #b')
    expect(r!.body).toMatch(
      /IF OBJECT_ID\('tempdb\.\.#b'\) IS NOT NULL DROP TABLE #b;\nSELECT 1 AS a INTO #b;/
    )
  })
  it('is a no-op when every temp table is guarded', () => {
    expect(
      tempTableGuard.apply(
        "CREATE PROC x AS\nIF OBJECT_ID('tempdb..#b') IS NOT NULL DROP TABLE #b;\nSELECT 1 AS a INTO #b"
      )
    ).toBeNull()
  })

  it('treats DROP TABLE IF EXISTS as a guard', () => {
    expect(
      tempTableGuard.apply('CREATE PROC x AS\nDROP TABLE IF EXISTS #b;\nSELECT 1 AS a INTO #b')
    ).toBeNull()
  })
  it('guards the CREATE TABLE of an INSERT-EXEC wrapper, once', () => {
    const r = tempTableGuard.apply(
      'CREATE PROC x AS\nBEGIN\n  CREATE TABLE #r (id INT);\n  INSERT INTO #r EXEC dbo.inner_proc;\n  SELECT * FROM #r\nEND'
    )
    expect(r!.body).toMatch(
      /\n {2}IF OBJECT_ID\('tempdb\.\.#r'\) IS NOT NULL DROP TABLE #r;\n {2}CREATE TABLE #r/
    )
    expect(r!.body.match(/DROP TABLE #r/g)).toHaveLength(1)
    expect(r!.notes).toHaveLength(1)
  })
  it("never drops a table INSERT-EXEC fills but the body did not create (the caller's)", () => {
    expect(tempTableGuard.apply('CREATE PROC x AS\nINSERT INTO #r EXEC dbo.inner_proc;')).toBeNull()
  })
  it('declines a build that is the lone body of an IF / ELSE / WHILE', () => {
    expect(tempTableGuard.apply('CREATE PROC x AS\nIF @a = 1\n  SELECT 1 AS a INTO #b')).toBeNull()
    expect(
      tempTableGuard.apply('CREATE PROC x AS\nIF @a = 1 SET @c = 2 ELSE SELECT 1 AS a INTO #b')
    ).toBeNull()
    expect(
      tempTableGuard.apply('CREATE PROC x AS\nWHILE @i < 3 CREATE TABLE #b (a INT)')
    ).toBeNull()
  })
  it('guards inside a BEGIN block and after a complete IF statement', () => {
    const r = tempTableGuard.apply('CREATE PROC x AS\nIF @a = 1 SET @c = 2\nSELECT 1 AS a INTO #b')
    expect(r!.body).toMatch(
      /SET @c = 2\nIF OBJECT_ID\('tempdb\.\.#b'\) IS NOT NULL DROP TABLE #b;\nSELECT/
    )
  })
  it('declines a build that a CTE prefixes', () => {
    expect(
      tempTableGuard.apply('CREATE PROC x AS\n;WITH c AS (SELECT 1 AS a)\nSELECT a INTO #b FROM c')
    ).toBeNull()
  })
  it('skips global temp tables and builds inside strings or comments', () => {
    expect(tempTableGuard.apply('CREATE PROC x AS\nSELECT 1 AS a INTO ##g')).toBeNull()
    expect(tempTableGuard.apply("CREATE PROC x AS\nEXEC('SELECT 1 AS a INTO #b')")).toBeNull()
    expect(tempTableGuard.apply('CREATE PROC x AS\n-- SELECT 1 AS a INTO #b\nSELECT 1')).toBeNull()
  })
  it('guards to exactly this body', () => {
    expect(
      tempTableGuard.apply('CREATE PROC x AS\nSELECT 1 AS a INTO #b;\nSELECT * FROM #b')?.body
    ).toBe(
      "CREATE PROC x AS\nIF OBJECT_ID('tempdb..#b') IS NOT NULL DROP TABLE #b;\nSELECT 1 AS a INTO #b;\nSELECT * FROM #b"
    )
  })
  // review round 1, finding 3: the guard would reset what the build reads
  it('declines a build that reads @@ROWCOUNT / @@ERROR / ROWCOUNT_BIG()', () => {
    expect(
      tempTableGuard.apply('CREATE PROC x AS\nUPDATE t SET a = 1\nSELECT @@ROWCOUNT AS n INTO #c')
    ).toBeNull()
    expect(
      tempTableGuard.apply('CREATE PROC x AS\nUPDATE t SET a = 1\nSELECT @@ERROR AS e INTO #e')
    ).toBeNull()
    expect(
      tempTableGuard.apply(
        'CREATE PROC x AS\nUPDATE t SET a = 1\nSELECT ROWCOUNT_BIG() AS n INTO #c'
      )
    ).toBeNull()
  })
  it('puts the guard inline when the build starts mid-line', () => {
    const r = tempTableGuard.apply('CREATE PROC x AS\nSET NOCOUNT ON; SELECT 1 AS a INTO #b')
    expect(r!.body).toBe(
      "CREATE PROC x AS\nSET NOCOUNT ON; IF OBJECT_ID('tempdb..#b') IS NOT NULL DROP TABLE #b; SELECT 1 AS a INTO #b"
    )
  })
})

describe('last-success-grouped', () => {
  const body = `CREATE PROC p AS
SELECT l.id FROM outbound_log l
WHERE l.api_id IN (2) AND l.id > ISNULL((SELECT MAX(s.id) FROM outbound_log s WHERE s.api_id = l.api_id AND s.ok = 1), 0)`
  it('hoists the correlated MAX into a grouped temp table joined once', () => {
    const r = lastSuccessGrouped.apply(body)
    expect(r!.body).toMatch(
      /SELECT api_id, MAX\(id\) AS max_id INTO #ls_1 FROM outbound_log WHERE ok = 1 GROUP BY api_id;/
    )
    expect(r!.body).toMatch(/LEFT JOIN #ls_1 ls_1 ON ls_1\.api_id = l\.api_id/)
    expect(r!.body).toMatch(/l\.id > ISNULL\(ls_1\.max_id, 0\)/)
  })
  it('leaves a body without the shape alone', () => {
    expect(lastSuccessGrouped.apply('SELECT 1')).toBeNull()
  })

  it('hoists to exactly this body', () => {
    expect(lastSuccessGrouped.apply(body)?.body).toBe(`CREATE PROC p AS
IF OBJECT_ID('tempdb..#ls_1') IS NOT NULL DROP TABLE #ls_1;
SELECT api_id, MAX(id) AS max_id INTO #ls_1 FROM outbound_log WHERE ok = 1 GROUP BY api_id;
SELECT l.id FROM outbound_log l
LEFT JOIN #ls_1 ls_1 ON ls_1.api_id = l.api_id
WHERE l.api_id IN (2) AND l.id > ISNULL(ls_1.max_id, 0)`)
  })
  // review round 1, finding 3: the hoist would become the statement @@ROWCOUNT reads
  it('declines a statement that reads @@ROWCOUNT / @@ERROR', () => {
    expect(
      lastSuccessGrouped.apply(body.replace('SELECT l.id', 'SELECT l.id, @@ROWCOUNT AS prev'))
    ).toBeNull()
    expect(
      lastSuccessGrouped.apply(body.replace('SELECT l.id', 'SELECT l.id, @@ERROR AS prev'))
    ).toBeNull()
  })
  // review round 1, finding 4: the subquery's own tail would fold into the hoist
  it('declines a subquery with its own GROUP BY / HAVING / ORDER BY', () => {
    for (const tail of [
      ' GROUP BY s.api_id',
      ' HAVING COUNT(*) > 1',
      ' ORDER BY s.id OFFSET 0 ROWS'
    ])
      expect(lastSuccessGrouped.apply(body.replace('s.ok = 1)', `s.ok = 1${tail})`))).toBeNull()
  })
  it('guards its own temp table so a re-run on the connection cannot collide', () => {
    const r = lastSuccessGrouped.apply(body)
    expect(r!.body).toMatch(
      /IF OBJECT_ID\('tempdb\.\.#ls_1'\) IS NOT NULL DROP TABLE #ls_1;\nSELECT api_id, MAX/
    )
  })
  it('accepts the correlation written outer-first', () => {
    const r = lastSuccessGrouped.apply(body.replace('s.api_id = l.api_id', 'l.api_id = s.api_id'))
    expect(r!.body).toMatch(/LEFT JOIN #ls_1 ls_1 ON ls_1\.api_id = l\.api_id/)
  })
  it('picks a free temp name when #ls_1 is taken', () => {
    const r = lastSuccessGrouped.apply(
      body.replace('CREATE PROC p AS\n', 'CREATE PROC p AS\nSELECT 1 AS a INTO #ls_1;\n')
    )
    expect(r!.body).toMatch(/INTO #ls_2 FROM outbound_log/)
  })
  it('declines a second correlation hidden in the constant predicate', () => {
    expect(
      lastSuccessGrouped.apply(body.replace('s.ok = 1', 's.ok = 1 AND s.batch = l.batch'))
    ).toBeNull()
  })
  it('declines a correlation that is not an equality, or names a third alias', () => {
    expect(
      lastSuccessGrouped.apply(body.replace('s.api_id = l.api_id', 's.api_id < l.api_id'))
    ).toBeNull()
    expect(lastSuccessGrouped.apply(body.replace('s.ok = 1', 's.ok = x.flag'))).toBeNull()
  })
  it('declines when MAX is over a different alias than the correlated table', () => {
    expect(lastSuccessGrouped.apply(body.replace('MAX(s.id)', 'MAX(l.id)'))).toBeNull()
  })
  it('declines a top-level OR inside the subquery (the correlation would not hold for it)', () => {
    expect(
      lastSuccessGrouped.apply(body.replace('s.ok = 1', 's.ok = 1 OR s.forced = 1'))
    ).toBeNull()
  })
  it('declines a statement that is the lone body of an IF', () => {
    expect(
      lastSuccessGrouped.apply(
        body.replace('CREATE PROC p AS\n', 'CREATE PROC p AS\nIF @run = 1\n')
      )
    ).toBeNull()
  })
  it('declines SELECT * and unqualified uses of the key column (the join would change them)', () => {
    expect(lastSuccessGrouped.apply(body.replace('SELECT l.id', 'SELECT *'))).toBeNull()
    expect(lastSuccessGrouped.apply(body.replace('l.api_id IN (2)', 'api_id IN (2)'))).toBeNull()
  })
  it('declines the subquery when its outer alias is not the first FROM table', () => {
    expect(
      lastSuccessGrouped.apply(
        body.replace('FROM outbound_log l', 'FROM apis a JOIN outbound_log l ON l.api_id = a.id')
      )
    ).toBeNull()
  })
})

describe('applyTransformers', () => {
  it('stacks the guard onto the junction rewrite and lists what applied', () => {
    const r = applyTransformers(
      `${FANOUT.replace('SELECT p.id, SUM', 'SELECT p.id INTO #x FROM projects p; SELECT p.id, SUM')}`
    )
    expect(r?.applied).toEqual(expect.arrayContaining(['junction-exists', 'temp-table-guard']))
  })
  it('is null when nothing applies', () => expect(applyTransformers('SELECT 1')).toBeNull())
  it('skips the transformers named in exclude', () => {
    const body = FANOUT.replace(
      'SELECT p.id, SUM',
      'SELECT p.id INTO #x FROM projects p; SELECT p.id, SUM'
    )
    const r = applyTransformers(body, { exclude: ['temp-table-guard'] })
    expect(r?.applied).toEqual(['junction-exists'])
    expect(r!.body).not.toMatch(/DROP TABLE #x/)
    expect(
      applyTransformers('CREATE PROC x AS\nSELECT 1 AS a INTO #b', {
        exclude: ['temp-table-guard']
      })
    ).toBeNull()
  })

  it('does not double-guard the temp table the last-success hoist already guards', () => {
    const r = applyTransformers(`CREATE PROC p AS
SELECT l.id FROM outbound_log l
WHERE l.id > ISNULL((SELECT MAX(s.id) FROM outbound_log s WHERE s.api_id = l.api_id AND s.ok = 1), 0)`)
    expect(r?.applied).toEqual(['last-success-grouped'])
    expect(r!.body.match(/DROP TABLE #ls_1/g)).toHaveLength(1)
  })
})
