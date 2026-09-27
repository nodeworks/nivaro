import { describe, expect, it, vi } from 'vitest'
import { isOwnerWrite, onOwnersChanged, ownersChanged } from '../../../db/owner-signal.js'

describe('isOwnerWrite', () => {
  it('counts a state move, a manual owner and an owner group change', () => {
    expect(
      isOwnerWrite('update [nivaro_workflow_instances] set [current_state] = @p0 where [id] = @p1')
    ).toBe(true)
    expect(
      isOwnerWrite('insert into [nivaro_pipeline_instance_owners] ([user]) values (@p0)')
    ).toBe(true)
    expect(isOwnerWrite('delete from [nivaro_pipeline_owner_group_users] where [id] = @p0')).toBe(
      true
    )
  })

  it('counts a user write only when it changes who can act', () => {
    expect(isOwnerWrite('update [nivaro_users] set [last_access] = @p0 where [id] = @p1')).toBe(
      false
    )
    expect(
      isOwnerWrite(
        "update [nivaro_users] set [last_access] = @p0 where [id] = @p1 and [status] = 'active'"
      )
    ).toBe(false)
    expect(
      isOwnerWrite('update [nivaro_users] set [is_out_of_office] = @p0 where [id] = @p1')
    ).toBe(true)
    expect(isOwnerWrite('update [nivaro_users] set [delegate_id] = @p0 where [id] = @p1')).toBe(
      true
    )
    expect(isOwnerWrite('update [nivaro_users] set [status] = @p0 where [id] = @p1')).toBe(true)
  })

  it('leaves reads and other writes alone', () => {
    expect(isOwnerWrite('select * from [nivaro_workflow_instances] where [id] = @p0')).toBe(false)
    expect(isOwnerWrite('update [orders] set [status] = @p0')).toBe(false)
    expect(isOwnerWrite('insert into [nivaro_workflow_history] ([instance]) values (@p0)')).toBe(
      false
    )
  })
})

describe('ownersChanged', () => {
  it('calls every listener and survives one that throws', () => {
    const a = vi.fn(() => {
      throw new Error('no')
    })
    const b = vi.fn()
    const offA = onOwnersChanged(a)
    const offB = onOwnersChanged(b)
    ownersChanged()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    offB()
    ownersChanged()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
