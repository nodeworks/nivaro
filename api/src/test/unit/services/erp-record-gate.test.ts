import { afterEach, describe, expect, it, vi } from 'vitest'

// recordRefusal: the one record gate behind the integration routes (ERP
// submission history/attempts/retries, event replay, record integration
// summaries, mail log, record-view recap). Read = record visible to the
// caller; update = visible + updatable + not edit-locked. Admins pass.

vi.mock('../../../services/instance-guard.js', () => {
  class InstanceAccessError extends Error {
    statusCode: 403 | 404
    constructor(statusCode: 403 | 404, message: string) {
      super(message)
      this.statusCode = statusCode
    }
  }
  return { InstanceAccessError, assertInstanceAccess: vi.fn(async () => undefined) }
})
vi.mock('../../../services/edit-lock.js', () => {
  class EditLockedError extends Error {}
  return {
    EDIT_LOCKED: 'EDIT_LOCKED',
    EditLockedError,
    assertNotEditLocked: vi.fn(async () => undefined)
  }
})

import * as editLock from '../../../services/edit-lock.js'
import { recordReadable, recordRefusal } from '../../../services/erp-record-gate.js'
import { assertInstanceAccess, InstanceAccessError } from '../../../services/instance-guard.js'

const req = (isAdmin = false) =>
  ({ isAdmin, user: { id: 'u1', role: 'r1' } }) as unknown as Parameters<typeof recordRefusal>[0]

afterEach(() => vi.clearAllMocks())

describe('recordRefusal', () => {
  it('admins pass without a record read', async () => {
    expect(await recordRefusal(req(true), 'workflows', '5', 'update')).toBeNull()
    expect(assertInstanceAccess).not.toHaveBeenCalled()
  })

  it('a record outside the caller’s scope reads as missing (404)', async () => {
    vi.mocked(assertInstanceAccess).mockRejectedValueOnce(new InstanceAccessError(404, 'x'))
    expect(await recordRefusal(req(), 'workflows', '5', 'read')).toEqual({
      code: 404,
      body: { error: 'Not found' }
    })
    vi.mocked(assertInstanceAccess).mockRejectedValueOnce(new InstanceAccessError(404, 'x'))
    expect(await recordReadable(req(), 'workflows', '5')).toBe(false)
    expect(await recordReadable(req(), 'workflows', '6')).toBe(true)
  })

  it('a visible record the caller may not change answers 403 on update', async () => {
    vi.mocked(assertInstanceAccess).mockRejectedValueOnce(new InstanceAccessError(403, 'x'))
    const r = await recordRefusal(req(), 'workflows', '5', 'update')
    expect(r?.code).toBe(403)
    expect(vi.mocked(assertInstanceAccess).mock.calls[0]?.[5]).toBe('update')
  })

  it('an edit-locked record refuses an update with EDIT_LOCKED', async () => {
    vi.mocked(editLock.assertNotEditLocked).mockRejectedValueOnce(
      new editLock.EditLockedError('This record is at Finance Review')
    )
    expect(await recordRefusal(req(), 'workflows', '5', 'update')).toEqual({
      code: 403,
      body: { error: 'This record is at Finance Review', code: 'EDIT_LOCKED' }
    })
  })

  it('an in-scope reader may read; an allowed editor may update', async () => {
    expect(await recordRefusal(req(), 'workflows', '5', 'read')).toBeNull()
    expect(editLock.assertNotEditLocked).not.toHaveBeenCalled()
    expect(await recordRefusal(req(), 'workflows', '5', 'update')).toBeNull()
    expect(editLock.assertNotEditLocked).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      'workflows',
      { ids: ['5'] },
      expect.anything()
    )
  })
})
