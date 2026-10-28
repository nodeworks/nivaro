import { describe, expect, it } from 'vitest'
import {
  configWriteTargets,
  isConfigWrite,
  movesConfigEpoch,
  runPersonalConfigWrite
} from '../../../db/config-epoch.js'

describe('isConfigWrite — only what a statement WRITES counts (2026-10-28)', () => {
  it('ignores a write to another table that only reads a watched one', () => {
    expect(
      isConfigWrite(
        'update w set [state_label] = s.[label] from [workflows] w join [nivaro_workflow_states] s on s.[id] = w.[state]'
      )
    ).toBe(false)
    expect(
      isConfigWrite(
        'insert into [nivaro_activity] ([action]) select [key] from [nivaro_workflow_states] where [id] = @p0'
      )
    ).toBe(false)
    expect(
      isConfigWrite(
        'delete a from [nivaro_integration_signal_rows] as a join [nivaro_workflow_states] s on s.id = a.state'
      )
    ).toBe(false)
  })

  it('ignores a report batch that builds and updates #temp tables over a watched table', () => {
    const batch = `IF OBJECT_ID('tempdb..#s') IS NOT NULL DROP TABLE #s;
      CREATE TABLE #s (id INT, k NVARCHAR(100));
      CREATE CLUSTERED INDEX ix_s ON #s (id);
      INSERT INTO #s SELECT id, [key] FROM nivaro_workflow_states;
      UPDATE #s SET k = UPPER(k);
      DELETE FROM #s WHERE k IS NULL;
      SELECT * FROM #s; DROP TABLE #s;`
    expect(isConfigWrite(batch)).toBe(false)
    expect(isConfigWrite('SET NOCOUNT ON; SELECT [key] FROM [nivaro_workflow_states]')).toBe(false)
    expect(
      isConfigWrite('DECLARE @t TABLE (id INT); INSERT INTO @t SELECT id FROM nivaro_fields')
    ).toBe(false)
    // A literal that merely contains SQL is not a statement.
    expect(
      isConfigWrite("insert into [orders] ([note]) values ('update nivaro_fields set x = 1')")
    ).toBe(false)
  })

  it('still counts writes to a watched table in any shape', () => {
    expect(
      isConfigWrite('update s set [label] = @p0 from [nivaro_workflow_states] s where s.[id] = @p1')
    ).toBe(true)
    expect(
      isConfigWrite('delete s from [dbo].[nivaro_workflow_states] as s where s.id = @p0')
    ).toBe(true)
    expect(
      isConfigWrite(
        'merge [nivaro_fields] as t using (select 1 as id) as s on t.id = s.id when matched then update set t.note = 1;'
      )
    ).toBe(true)
    expect(isConfigWrite('update top (10) [nivaro_relations] set [x] = 1')).toBe(true)
    expect(
      isConfigWrite(
        'select top(0) [t].* into #out from [nivaro_fields] as t left join #out on 0=1; insert into [nivaro_fields] ([a]) output inserted.* into #out values (@p0); select * from #out; drop table #out;'
      )
    ).toBe(true)
    // Dynamic SQL keeps the cautious rule.
    expect(isConfigWrite("EXEC('update nivaro_fields set note = 1')")).toBe(true)
  })

  it('counts real schema changes, also mid-batch, but not #temp DDL', () => {
    expect(isConfigWrite('IF 1 = 1 ALTER TABLE orders ADD note nvarchar(50)')).toBe(true)
    expect(isConfigWrite('CREATE OR ALTER PROCEDURE p AS SELECT 1')).toBe(true)
    expect(isConfigWrite("EXEC sp_rename 'orders.a', 'b', 'COLUMN'")).toBe(true)
    expect(isConfigWrite('CREATE INDEX ix_orders ON orders (a)')).toBe(true)
    expect(isConfigWrite('CREATE TABLE #c (id INT); INSERT INTO #c VALUES (1)')).toBe(false)
  })

  it('falls back to "names a watched table" when the target is a CTE', () => {
    const sql = 'with x as (select * from nivaro_fields where id = 1) update x set note = 1'
    expect(configWriteTargets(sql)).toBeNull()
    expect(isConfigWrite(sql)).toBe(true)
  })

  it('names the tables a statement writes', () => {
    expect(
      configWriteTargets(
        'update [nivaro_fields] set a = 1; insert into [orders] select * from [nivaro_relations]'
      )
    ).toEqual(['nivaro_fields'])
  })
})

describe("movesConfigEpoch — a person's own preference write", () => {
  it('does not move the epoch inside runPersonalConfigWrite for the named table only', async () => {
    const own = 'update [nivaro_user_scopes] set [values] = @p0 where [id] = @p1'
    expect(movesConfigEpoch(own)).toBe(true)
    await runPersonalConfigWrite(['nivaro_user_scopes'], async () => {
      expect(movesConfigEpoch(own)).toBe(false)
      expect(movesConfigEpoch('insert into [nivaro_user_scopes] ([user]) values (@p0)')).toBe(false)
      expect(movesConfigEpoch('update [nivaro_fields] set [note] = @p0')).toBe(true)
      expect(
        movesConfigEpoch('update [nivaro_user_scopes] set a = 1; update [nivaro_roles] set b = 2')
      ).toBe(true)
      expect(movesConfigEpoch('ALTER TABLE nivaro_user_scopes ADD x INT')).toBe(true)
    })
    expect(movesConfigEpoch(own)).toBe(true)
  })
})

describe('isConfigWrite', () => {
  it('counts a write to a watched table', () => {
    expect(isConfigWrite('update [nivaro_fields] set [note] = @p0 where [id] = @p1')).toBe(true)
    expect(isConfigWrite('insert into [nivaro_user_scopes] ([user]) values (@p0)')).toBe(true)
    expect(isConfigWrite('delete from [nivaro_pipeline_owner_group_users] where [id] = @p0')).toBe(
      true
    )
    expect(isConfigWrite('ALTER TABLE orders ADD note nvarchar(50)')).toBe(true)
  })

  it('leaves reads and record writes alone', () => {
    expect(isConfigWrite('select * from [nivaro_fields] where [collection] = @p0')).toBe(false)
    expect(isConfigWrite('update [orders] set [total] = @p0 where [id] = @p1')).toBe(false)
    expect(isConfigWrite('insert into [nivaro_activity] ([action]) values (@p0)')).toBe(false)
    expect(isConfigWrite('update [nivaro_workflow_instances] set [current_state] = @p0')).toBe(
      false
    )
    expect(isConfigWrite('')).toBe(false)
  })

  it('never counts its own bookkeeping', () => {
    expect(isConfigWrite('update [nivaro_cache_epochs] set [epoch] = epoch + 1')).toBe(false)
  })

  it('does not match a longer table name that contains a watched one', () => {
    expect(isConfigWrite('insert into [nivaro_rules_log] ([id]) values (@p0)')).toBe(false)
    expect(isConfigWrite('update [nivaro_fields_archive] set [a] = 1')).toBe(false)
  })
})
