import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A Teams/mail Approve link used to approve on GET — any link scanner that
// prefetched it decided for the approver. GET now only asks; the page's
// button POSTs the decision.

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../routes/approvals.js', () => ({
  applyApprovalDecision: vi.fn(async () => ({ ok: true }))
}))
vi.mock('../../../db/index.js', () => {
  const first = vi.fn(async () => ({ id: 'u-1', role: null, status: 'active' }))
  return { db: vi.fn(() => ({ where: () => ({ first }) })) }
})

import { applyApprovalDecision } from '../../../routes/approvals.js'
import { messageActionsRoutes, signActionToken } from '../../../routes/message-actions.js'

const token = signActionToken({
  action_id: 'approve',
  kind: 'approval',
  ref_id: '42',
  user: 'u-1',
  collection: 'workflows',
  item: '372789'
})

async function app() {
  const a = Fastify({ logger: false })
  await a.register(messageActionsRoutes)
  return a
}

afterEach(() => vi.clearAllMocks())

describe('GET /callback (decision link)', () => {
  it('shows a confirm page and decides nothing (a prefetching scanner)', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: `/callback?token=${encodeURIComponent(token)}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<form method="post"')
    expect(applyApprovalDecision).not.toHaveBeenCalled()
  })
})

describe('POST /callback (the confirm button)', () => {
  it('applies the decision from the posted form', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(token)}`
    })
    expect(res.statusCode).toBe(200)
    expect(applyApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 42, decision: 'approved' })
    )
  })

  it('refuses a forged token', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(`${token.split('.')[0]}.AAAA`)}`
    })
    expect(res.statusCode).toBe(401)
    expect(applyApprovalDecision).not.toHaveBeenCalled()
  })
})
