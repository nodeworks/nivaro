import { afterEach, describe, expect, it, vi } from 'vitest'

const update = vi.fn()
vi.mock('../../../db/index.js', () => {
  const db = vi.fn(() => ({
    where: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue({ id: 1, project: null }),
    update
  }))
  return { db }
})
const updateOne = vi.fn()
vi.mock('../../../services/items.js', () => ({ updateOne }))
vi.mock('../../../services/rollups.js', () => ({ recalcAffectedRollups: vi.fn() }))

import { updateAsAction } from '../../../services/action-writes.js'

const writer = { id: 'u1' } as never

afterEach(() => vi.clearAllMocks())

describe('updateAsAction — a deliberate refusal is never slipped in raw', () => {
  it('an error marked refuseRaw (a business rule said no) fails the write, no raw retry', async () => {
    updateOne.mockRejectedValueOnce(
      Object.assign(new Error('This project already has a CAR'), {
        statusCode: 422,
        refuseRaw: true
      })
    )
    const path = await updateAsAction(writer, 'workflows', 1, { project: 42 }, 'link')
    expect(path).toBe('failed')
    expect(update).not.toHaveBeenCalled()
  })

  it('any other refusal keeps the raw fallback transitions rely on (edit lock, validation)', async () => {
    updateOne.mockRejectedValueOnce(Object.assign(new Error('locked'), { statusCode: 403 }))
    update.mockResolvedValueOnce(1)
    const path = await updateAsAction(writer, 'workflows', 1, { project: 42 }, 'link')
    expect(path).toBe('raw')
    expect(update).toHaveBeenCalledWith({ project: 42 })
  })
})
