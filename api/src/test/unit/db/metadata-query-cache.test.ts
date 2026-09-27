import { describe, expect, it } from 'vitest'
import { isCacheableRead, isInvalidatingWrite } from '../../../db/metadata-query-cache.js'

describe('metadata query cache — what is cached', () => {
  it('caches a read of an allow-listed table', () => {
    expect(
      isCacheableRead(
        'select [many_collection], [many_field] from [nivaro_relations] where [one_collection] = @p0'
      )
    ).toBe(true)
    expect(isCacheableRead('select top (@p0) * from [nivaro_roles] where [id] = @p1')).toBe(true)
    expect(
      isCacheableRead('SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @p0')
    ).toBe(true)
    expect(isCacheableRead('select * from [dbo].[nivaro_fields] where [collection] = @p0')).toBe(
      true
    )
  })

  it('never caches a business table, alone or joined', () => {
    expect(isCacheableRead('select top (@p0) [name] from [workflows] where [id] = @p1')).toBe(false)
    expect(
      isCacheableRead(
        'select [f].* from [nivaro_fields] as [f] inner join [workflows] as [w] on [w].[id] = [f].[id]'
      )
    ).toBe(false)
    expect(
      isCacheableRead(
        'select * from [nivaro_fields] where [collection] in (select [name] from [projects])'
      )
    ).toBe(false)
  })

  it('never caches tables that change at run time', () => {
    expect(isCacheableRead('select * from [nivaro_policies] where [role] = @p0')).toBe(false)
    expect(isCacheableRead('select * from [nivaro_users] where [id] = @p0')).toBe(false)
    expect(isCacheableRead('select * from [nivaro_settings]')).toBe(false)
    expect(isCacheableRead('select * from [nivaro_queue_sources] where [queue_id] = @p0')).toBe(
      false
    )
  })

  it('never caches anything that is not a single plain read', () => {
    expect(isCacheableRead('select @@rowcount')).toBe(false)
    expect(isCacheableRead('update [nivaro_fields] set [label] = @p0;select @@rowcount')).toBe(
      false
    )
    expect(isCacheableRead('select * into #t from [nivaro_fields]')).toBe(false)
    expect(isCacheableRead('select * from [nivaro_fields]; drop table [x]')).toBe(false)
    expect(isCacheableRead('with c as (select 1 as a) select * from c')).toBe(false)
  })
})

describe('metadata query cache — what clears it', () => {
  it('clears on any write naming an allow-listed table', () => {
    expect(isInvalidatingWrite('update [nivaro_fields] set [label] = @p0 where [id] = @p1')).toBe(
      true
    )
    expect(
      isInvalidatingWrite('insert into [nivaro_relations] ([many_collection]) values (@p0)')
    ).toBe(true)
    expect(
      isInvalidatingWrite('delete from [nivaro_layout_field_assignments] where [layout_id] = @p0')
    ).toBe(true)
    expect(
      isInvalidatingWrite('UPDATE f SET f.hidden = 1 FROM nivaro_fields f WHERE f.id = 1')
    ).toBe(true)
  })

  it('clears on schema changes, which move the column lists', () => {
    expect(isInvalidatingWrite('ALTER TABLE [workflows] ADD [x] int NULL')).toBe(true)
    expect(isInvalidatingWrite('create table [t] ([id] int)')).toBe(true)
    expect(isInvalidatingWrite("EXEC sp_rename 'a.b', 'c', 'COLUMN'")).toBe(true)
  })

  it('leaves the cache alone for reads and for writes to business tables', () => {
    expect(isInvalidatingWrite('select * from [nivaro_fields]')).toBe(false)
    expect(
      isInvalidatingWrite('update [workflows] set [name] = @p0 where [id] = @p1;select @@rowcount')
    ).toBe(false)
    expect(isInvalidatingWrite('insert into [nivaro_activity] ([action]) values (@p0)')).toBe(false)
  })
})
