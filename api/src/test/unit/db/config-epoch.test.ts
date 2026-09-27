import { describe, expect, it } from 'vitest'
import { isConfigWrite } from '../../../db/config-epoch.js'

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
