import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  row: undefined as { id: number; detail: string | null } | undefined,
  updates: [] as unknown[]
}))

vi.mock('../../../db/index.js', () => ({
  db: () => ({
    where: () => ({
      first: async () => state.row,
      update: async (v: unknown) => {
        state.updates.push(v)
      }
    })
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

import { logActivity } from '../../../services/activity.js'
import { acknowledgeNotification } from '../../../services/notification-ack.js'

const app = {} as never
const user = { id: 'u1' } as never

beforeEach(() => {
  state.row = undefined
  state.updates = []
  vi.mocked(logActivity).mockClear()
})

describe('acknowledgeNotification', () => {
  it('not your notification -> 404', async () => {
    const r = await acknowledgeNotification(app, user, 5)
    expect(r).toEqual({ status: 404, body: { error: 'Not found' } })
    expect(state.updates).toHaveLength(0)
  })

  it('refuses a notification that did not ask for acknowledgement', async () => {
    state.row = { id: 5, detail: JSON.stringify({}) }
    const r = await acknowledgeNotification(app, user, 5)
    expect(r.status).toBe(400)
  })

  it('already acknowledged -> same answer, nothing written', async () => {
    const at = '2026-10-01T10:00:00.000Z'
    state.row = { id: 5, detail: JSON.stringify({ ack_required: true, ack_at: at }) }
    const r = await acknowledgeNotification(app, user, 5)
    expect(r).toEqual({
      status: 200,
      body: { data: { id: 5, ack: { required: true, at, by: 'u1' } } }
    })
    expect(state.updates).toHaveLength(0)
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('success stamps the row, marks it read and logs', async () => {
    state.row = { id: 5, detail: JSON.stringify({ ack_required: true }) }
    const r = await acknowledgeNotification(app, user, 5)
    expect(r.status).toBe(200)
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0]).toMatchObject({ status: 'read' })
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'notification-acknowledge', item: '5' })
    )
  })
})
