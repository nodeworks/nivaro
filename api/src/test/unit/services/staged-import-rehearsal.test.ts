import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { scanProcedureBody } from '../../../services/staged-import-rehearsal.js'

// #717 — the rehearsal counts what a procedure writes and refuses the ones a
// rollback cannot undo. The scan is the static half of that decision.
describe('scanProcedureBody', () => {
  it('finds write targets, including alias deletes, and ignores temp tables', () => {
    const s = scanProcedureBody(`
      CREATE PROCEDURE import_x AS BEGIN
        INSERT INTO #work SELECT * FROM staging_x
        MERGE dbo.purchase_orders AS t USING #work AS s ON t.id = s.id
          WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id);
        UPDATE [line_items] SET amount = 0
        DELETE li FROM line_items_extra li JOIN #work w ON w.id = li.id
        TRUNCATE TABLE staging_x
      END`)
    for (const t of ['purchase_orders', 'line_items', 'line_items_extra', 'staging_x']) {
      assert.ok(s.targets.includes(t), t)
    }
    assert.ok(!s.targets.some((t) => t.startsWith('#') || t === 'work'))
  })
  it('counts balanced transactions and sees nested EXEC calls', () => {
    const s = scanProcedureBody(`BEGIN TRY BEGIN TRAN; EXEC dbo.forecast_status; COMMIT TRANSACTION;
      END TRY BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK; THROW; END CATCH`)
    assert.equal(s.begins, 1)
    assert.equal(s.commits, 1)
    assert.deepEqual(s.calls, ['forecast_status'])
  })
  it('flags work outside the database and dynamic SQL', () => {
    assert.ok(scanProcedureBody("EXEC msdb.dbo.sp_send_dbmail @recipients = 'x'").external)
    assert.ok(scanProcedureBody('SELECT * FROM [srv].[db].[dbo].[t]').external)
    assert.ok(scanProcedureBody('EXEC sp_executesql @sql').dynamic)
    assert.ok(!scanProcedureBody('EXEC sp_executesql @sql').calls.includes('sp_executesql'))
  })
  it('ignores keywords inside comments and strings', () => {
    const s = scanProcedureBody(`-- COMMIT
      /* INSERT INTO fake_table */ SELECT 'COMMIT TRAN' AS note`)
    assert.equal(s.commits, 0)
    assert.equal(s.targets.length, 0)
  })
})
