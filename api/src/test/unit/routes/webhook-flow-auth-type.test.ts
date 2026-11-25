import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Webhook flows fail CLOSED on an auth type the route does not know (review lifecycle M1): a
// cloned flow whose auth_type read "{{fill in on the new app}}" used to fall through to the flow
// with no authentication at all.

vi.mock('../../../middleware/authenticate.js', () => ({ requireAdmin: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
const h = vi.hoisted(() => ({
  executeFlow: vi.fn(async () => ({ ok: true })),
  options: {} as Record<string, unknown>
}))
vi.mock('../../../services/flow-executor.js', () => ({ executeFlow: h.executeFlow }))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn(() => c)
    c.first = vi.fn(async () => ({
      id: 'F1',
      name: 'Hook',
      trigger: 'webhook',
      status: 'active',
      trigger_options: JSON.stringify(h.options)
    }))
    return c
  })
}))

import { registerJsonBodyParser } from '../../../lib/json-body.js'
import { webhookFlowRoute } from '../../../routes/flows.js'

async function call(options: Record<string, unknown>, headers: Record<string, string> = {}) {
  h.options = options
  const a = Fastify({ logger: false })
  registerJsonBodyParser(a)
  await a.register(webhookFlowRoute, { prefix: '/api/flows' })
  await a.ready()
  const res = await a.inject({
    method: 'POST',
    url: '/api/flows/webhook/F1',
    headers: { 'content-type': 'application/json', ...headers },
    payload: '{"x":1}'
  })
  await a.close()
  return res
}

beforeEach(() => h.executeFlow.mockClear())

describe('webhook flow auth types', () => {
  it('refuses an auth type it does not know, even with a secret set', async () => {
    for (const auth_type of ['{{fill in on the new app}}', 'basic', 'Bearer', 'hmac']) {
      const res = await call({ auth_type, secret: 'something' })
      expect(res.statusCode, auth_type).toBe(500)
      expect(res.json().error).toBe('Webhook misconfigured')
    }
    expect(h.executeFlow).not.toHaveBeenCalled()
  })

  it('still runs a bearer flow with the right token, and none / no auth type as before', async () => {
    expect(
      (await call({ auth_type: 'bearer', secret: 'tok-1' }, { authorization: 'Bearer tok-1' }))
        .statusCode
    ).toBe(200)
    expect(
      (await call({ auth_type: 'bearer', secret: 'tok-1' }, { authorization: 'Bearer no' }))
        .statusCode
    ).toBe(401)
    expect((await call({ auth_type: 'none' })).statusCode).toBe(200)
    expect((await call({})).statusCode).toBe(200)
  })
})
