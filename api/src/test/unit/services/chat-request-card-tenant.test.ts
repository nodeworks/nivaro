// Request id cards (#2762) in cloud mode: the 60 s memo is per tenant, and the
// process-wide kept-trace ring never describes an id inside a tenant.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tenant = vi.hoisted(() => ({ key: '' }))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => tenant.key }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://admin.example' }))
const findRequestRow = vi.fn()
vi.mock('../../../services/traffic-inspect/request.js', () => ({
  findRequestRow: (...a: unknown[]) => findRequestRow(...a),
  traceAbsence: () => null
}))
const getTrace = vi.fn()
vi.mock('../../../services/request-trace.js', () => ({
  getTrace: (...a: unknown[]) => getTrace(...a)
}))

import {
  __resetRequestCardMemo,
  requestCardFor,
  requestMemoKey
} from '../../../services/chat-request-card.js'
import type { User } from '../../../types.js'

const ME = { id: 'U1', role: 'R1' } as unknown as User
const RID = '4f3a2b1c-0000-4000-8000-00000000c21e'
const ROW = {
  method: 'GET',
  path: '/api/items/orders/1',
  route: 'GET /api/items/:collection/:id',
  status: 500,
  latency_ms: 10,
  created_at: '2026-10-21T15:00:00.000Z',
  caller: { key: 'u1', label: 'Tenant A person', kind: 'user' as const }
}

beforeEach(() => {
  __resetRequestCardMemo()
  findRequestRow.mockReset()
  getTrace.mockReset()
  tenant.key = ''
})

describe('request card memo per tenant', () => {
  it('keys the memo with the tenant', () => {
    expect(requestMemoKey(RID, 'a')).not.toBe(requestMemoKey(RID, 'b'))
  })

  it('tenant B never gets tenant A’s answer from the memo', async () => {
    tenant.key = 'tenant-a'
    findRequestRow.mockResolvedValueOnce({ row: ROW, matched_by: 'request_id' })
    expect((await requestCardFor(ME, true, RID))?.details?.person).toBe('Tenant A person')
    tenant.key = 'tenant-b'
    findRequestRow.mockResolvedValueOnce(null)
    expect(await requestCardFor(ME, true, RID)).toBeNull()
    expect(findRequestRow).toHaveBeenCalledTimes(2)
    // Tenant A still answers from its own memo entry.
    tenant.key = 'tenant-a'
    expect((await requestCardFor(ME, true, RID))?.details?.person).toBe('Tenant A person')
    expect(findRequestRow).toHaveBeenCalledTimes(2)
  })

  it('inside a tenant the process-wide trace ring is not read', async () => {
    tenant.key = 'tenant-b'
    findRequestRow.mockResolvedValue(null)
    getTrace.mockReturnValue({
      id: RID,
      method: 'GET',
      route: '/api/x',
      url: '/api/x',
      status: 200,
      user: null,
      total_ms: 5,
      ts: '2026-10-21T15:00:00.000Z'
    })
    expect(await requestCardFor(ME, true, RID)).toBeNull()
    expect(getTrace).not.toHaveBeenCalled()
  })
})
