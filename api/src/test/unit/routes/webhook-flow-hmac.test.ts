import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Webhook flow HMAC (security audit 2026-10-27 + review follow-up): the signature is checked
// against exactly the bytes the handler consumes, for every content type the route accepts.

vi.mock('../../../middleware/authenticate.js', () => ({ requireAdmin: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
const flow = vi.hoisted(() => ({
  executeFlow: vi.fn(async (_o: { payload: unknown }) => ({ ok: true }))
}))
vi.mock('../../../services/flow-executor.js', () => flow)
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn(() => c)
    c.first = vi.fn(async () => ({
      id: 'F1',
      name: 'Hook',
      trigger: 'webhook',
      status: 'active',
      trigger_options: JSON.stringify({ auth_type: 'hmac-sha256', secret: 'whsec' })
    }))
    return c
  })
}))

import { registerJsonBodyParser } from '../../../lib/json-body.js'
import { webhookFlowRoute } from '../../../routes/flows.js'
import { signWebhookBody } from '../../../services/webhook-signature.js'

async function app() {
  const a = Fastify({ logger: false })
  registerJsonBodyParser(a) // as server.ts does at the root
  await a.register(webhookFlowRoute, { prefix: '/api/flows' })
  await a.ready()
  return a
}

const post = (
  a: Awaited<ReturnType<typeof app>>,
  payload: string,
  contentType: string,
  signature: string
) =>
  a.inject({
    method: 'POST',
    url: '/api/flows/webhook/F1',
    headers: { 'content-type': contentType, 'x-signature-256': signature },
    payload
  })

beforeEach(() => flow.executeFlow.mockClear())

describe('webhook flow HMAC over the raw body', () => {
  it('accepts JSON signed over its exact bytes and hands the flow the parsed body', async () => {
    const a = await app()
    const raw = '{ "event":  "paid", "__proto__": {"x": 1} }'
    const res = await post(a, raw, 'application/json', signWebhookBody('whsec', raw))
    expect(res.statusCode).toBe(200)
    const payload = flow.executeFlow.mock.calls[0]?.[0]?.payload as Record<string, unknown>
    expect(payload.event).toBe('paid')
    expect(Object.hasOwn(payload, '__proto__')).toBe(false)
    await a.close()
  })

  it('refuses JSON signed over a re-serialisation', async () => {
    const a = await app()
    const raw = '{ "event":  "paid" }'
    const res = await post(a, raw, 'application/json', signWebhookBody('whsec', '{"event":"paid"}'))
    expect(res.statusCode).toBe(401)
    expect(flow.executeFlow).not.toHaveBeenCalled()
    await a.close()
  })

  it('verifies a non-JSON body against its own bytes, never against ""', async () => {
    const a = await app()
    const raw = 'event=paid&amount=10'
    const type = 'application/x-www-form-urlencoded'
    expect((await post(a, raw, type, signWebhookBody('whsec', ''))).statusCode).toBe(401)
    expect((await post(a, raw, type, signWebhookBody('whsec', raw))).statusCode).toBe(200)
    expect(flow.executeFlow.mock.calls[0]?.[0]?.payload).toBe(raw)
    await a.close()
  })
})
