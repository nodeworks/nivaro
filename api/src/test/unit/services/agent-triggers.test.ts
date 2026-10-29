import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, DeliveryRow } from '../../../services/agent-trigger-delivery.js'
import type { AgentTriggerRow } from '../../../services/agent-triggers.js'
import type { FakeQuery } from '../../fake-sql.js'

// Agent triggers (#3210): config validation + masking, the signed send, the retry ladder,
// and the record context read AS the trigger's owner.

const sql = vi.hoisted(() => ({ ran: [] as FakeQuery[], updates: [] as FakeQuery[] }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      sql.ran.push(q)
      if (q.method === 'update') {
        sql.updates.push(q)
        return 1
      }
      if (q.method === 'first') return undefined
      return []
    })
  }
})
vi.mock('../../../db/pool-context.js', () => ({ runInBackgroundPool: (fn: () => unknown) => fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
const fetchMock = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../../../lib/ssrf.js', () => ({ safeFetch: (...a: unknown[]) => fetchMock.fn(...a) }))
const people = vi.hoisted(() => ({
  owner: { id: 'OWNER', status: 'active' } as Record<string, unknown> | undefined,
  readable: new Map<string, Record<string, unknown>>(),
  lastFields: undefined as string[] | undefined
}))
vi.mock('../../../services/users.js', () => ({ getUser: vi.fn(async () => people.owner) }))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (_u: unknown, _c: string, id: string, _w: unknown, fields?: string[]) => {
    people.lastFields = fields
    return people.readable.get(String(id)) ?? null
  }),
  isOutOfView: () => false
}))
vi.mock('../../../services/app-links.js', () => ({
  recordLink: vi.fn(async (c: string, id: string) => `https://app.test/${c}/${id}`)
}))
vi.mock('../../../services/mcp-config.js', () => ({
  mcpResourceUrl: () => 'https://app.test/api/mcp'
}))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))

const triggers = await import('../../../services/agent-triggers.js')
const delivery = await import('../../../services/agent-trigger-delivery.js')
const { verifyWebhookSignature } = await import('../../../services/webhook-signature.js')
const { MASK } = await import('../../../services/secret-mask.js')

const row = (over: Partial<AgentTriggerRow> = {}): AgentTriggerRow => ({
  id: 3,
  name: 'Review new POs',
  description: null,
  enabled: true,
  collection: 'purchase_orders',
  events: '["create","transition"]',
  conditions: null,
  to_states: null,
  fields: null,
  instructions: 'Check the vendor',
  url: 'https://agent.example.com/hook',
  signing_secret: 'a-long-signing-secret-123',
  headers: '{"Authorization":"Bearer abc"}',
  max_attempts: 3,
  owner: 'OWNER',
  created_by: 'ADMIN',
  last_fired_at: null,
  created_at: null,
  updated_at: null,
  ...over
})

beforeEach(() => {
  sql.ran.length = 0
  sql.updates.length = 0
  fetchMock.fn.mockReset()
  people.owner = { id: 'OWNER', status: 'active' }
  people.readable.clear()
  people.lastFields = undefined
})

describe('normalizeTriggerInput', () => {
  const base = {
    name: 'Wake',
    collection: 'orders',
    events: ['create', 'bogus', 'create'],
    url: 'https://agent.example.com/x'
  }
  it('validates a create and keeps only known events', () => {
    const out = triggers.normalizeTriggerInput(base)
    expect(out).toMatchObject({ name: 'Wake', collection: 'orders', events: '["create"]' })
    expect(out.max_attempts).toBe(5)
  })
  it('refuses plain http, credentials in the url, system tables and no events', () => {
    expect(() =>
      triggers.normalizeTriggerInput({ ...base, url: 'http://agent.example.com' })
    ).toThrow(/https/)
    expect(() =>
      triggers.normalizeTriggerInput({ ...base, url: 'https://u:p@agent.example.com' })
    ).toThrow(/header/)
    expect(() => triggers.normalizeTriggerInput({ ...base, collection: 'nivaro_users' })).toThrow(
      /system/
    )
    expect(() => triggers.normalizeTriggerInput({ ...base, events: [] })).toThrow(/event/)
    expect(() => triggers.normalizeTriggerInput({ ...base, signing_secret: 'short' })).toThrow(/16/)
    expect(() =>
      triggers.normalizeTriggerInput({ ...base, headers: { 'X-Nivaro-Signature': 'x' } })
    ).toThrow(/set by Nivaro/)
  })
  it('keeps a masked secret and masked header values on a patch', () => {
    const existing = row()
    const out = triggers.normalizeTriggerInput(
      { signing_secret: MASK, headers: { Authorization: MASK, 'X-Extra': 'v' } },
      existing
    )
    expect(out.signing_secret).toBeUndefined()
    expect(JSON.parse(String(out.headers))).toEqual({ Authorization: 'Bearer abc', 'X-Extra': 'v' })
  })
  it('refuses a condition it cannot judge', () => {
    expect(() =>
      triggers.normalizeTriggerInput({ ...base, conditions: [{ field: 'x', op: 'weird' }] })
    ).toThrow(/condition/)
  })
})

describe('maskTrigger', () => {
  it('never shows the secret or header values', () => {
    const m = triggers.maskTrigger(row())
    expect(m.signing_secret).toBe(MASK)
    expect(m.headers).toEqual({ Authorization: MASK })
    expect(JSON.stringify(m)).not.toContain('Bearer abc')
    expect(JSON.stringify(m)).not.toContain('a-long-signing-secret')
  })
})

describe('sendSigned', () => {
  it('signs <timestamp>.<body> the way inbound webhook flows verify it', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    const now = Date.UTC(2026, 9, 29, 12)
    const out = await delivery.sendSigned({
      url: 'https://agent.example.com/hook',
      body: '{"a":1}',
      secret: 'a-long-signing-secret-123',
      headers: { Authorization: 'Bearer abc' },
      deliveryKey: 'K1',
      event: 'create',
      triggerId: 3,
      attempt: 2,
      fetchImpl: fetchImpl as never,
      nowMs: now
    })
    expect(out).toMatchObject({ ok: true, status: 200 })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>]
    const h = init.headers as Record<string, string>
    expect(init.redirect).toBe('manual')
    expect(h['x-nivaro-delivery']).toBe('K1')
    expect(h['x-nivaro-attempt']).toBe('2')
    expect(h.Authorization).toBe('Bearer abc')
    expect(
      verifyWebhookSignature({
        secret: 'a-long-signing-secret-123',
        rawBody: '{"a":1}',
        signature: h['x-nivaro-signature'],
        timestamp: h['x-nivaro-timestamp'],
        nowMs: now
      })
    ).toEqual({ ok: true })
  })
  it('treats a redirect as a failure and a thrown fetch as no answer', async () => {
    const redirect = await delivery.sendSigned({
      url: 'https://a.example.com',
      body: '{}',
      secret: null,
      headers: {},
      deliveryKey: 'K',
      event: 'create',
      triggerId: 1,
      attempt: 1,
      fetchImpl: (async () => new Response('', { status: 302 })) as never
    })
    expect(redirect).toMatchObject({ ok: false, status: 302 })
    expect(redirect.error).toMatch(/redirect/)
    const down = await delivery.sendSigned({
      url: 'https://a.example.com',
      body: '{}',
      secret: null,
      headers: {},
      deliveryKey: 'K',
      event: 'create',
      triggerId: 1,
      attempt: 1,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as never
    })
    expect(down).toMatchObject({ ok: false, status: null, error: 'ECONNREFUSED' })
  })
})

describe('retry ladder', () => {
  it('backs off and stops retrying on a final 4xx', () => {
    expect(delivery.backoffMs(1)).toBe(30_000)
    expect(delivery.backoffMs(2)).toBe(120_000)
    expect(delivery.backoffMs(99)).toBe(21_600_000)
    expect(delivery.retryable(null)).toBe(true)
    expect(delivery.retryable(503)).toBe(true)
    expect(delivery.retryable(429)).toBe(true)
    expect(delivery.retryable(400)).toBe(false)
    expect(delivery.retryable(401)).toBe(false)
  })

  const claimed = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
    id: 11,
    trigger_id: 3,
    delivery_key: 'K11',
    event: 'create',
    collection: 'purchase_orders',
    item: '5',
    status: 'sending',
    attempts: 0,
    max_attempts: 3,
    next_attempt_at: null,
    claimed_at: null,
    last_status_code: null,
    last_error: null,
    latency_ms: null,
    request_body: '{"x":1}',
    response_body: null,
    delivered_at: null,
    created_at: null,
    updated_at: null,
    ...over
  })

  it('schedules a retry on a 503 and gives up (dead) at the last attempt', async () => {
    fetchMock.fn.mockResolvedValue(new Response('busy', { status: 503 }))
    const first = await delivery.attemptClaimed(claimed(), row())
    expect(first.status).toBe('retrying')
    expect(first.attempts).toBe(1)
    expect(first.next_attempt_at).toBeInstanceOf(Date)
    const last = await delivery.attemptClaimed(claimed({ attempts: 2 }), row())
    expect(last.status).toBe('dead')
    expect(last.attempts).toBe(3)
  })

  it('is dead at once on a 401, delivered on a 2xx', async () => {
    fetchMock.fn.mockResolvedValueOnce(new Response('no', { status: 401 }))
    expect((await delivery.attemptClaimed(claimed(), row())).status).toBe('dead')
    fetchMock.fn.mockResolvedValueOnce(new Response('ok', { status: 202 }))
    const ok = await delivery.attemptClaimed(claimed(), row())
    expect(ok.status).toBe('delivered')
    expect(ok.delivered_at).toBeInstanceOf(Date)
  })

  it('drops a delivery whose trigger was turned off', async () => {
    const out = await delivery.attemptClaimed(claimed(), row({ enabled: false }))
    expect(out.status).toBe('discarded')
    expect(fetchMock.fn).not.toHaveBeenCalled()
  })
})

describe('matching and context', () => {
  const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({
    collection: 'purchase_orders',
    item: '5',
    event: 'transition',
    transition: { to_state: { key: 'review', label: 'Review' } },
    ...over
  })

  it('a state filter passes only the listed states', async () => {
    const t = row({ to_states: '["review"]' })
    expect(await delivery.eventMatches(t, ev())).toBe(true)
    expect(await delivery.eventMatches(t, ev({ transition: { to_state: { key: 'done' } } }))).toBe(
      false
    )
    expect(await delivery.eventMatches(t, ev({ event: 'create', transition: null }))).toBe(true)
  })

  it('reads the record as the owner, with only the fields asked for', async () => {
    people.readable.set('5', { id: 5, vendor: 'Acme', total: 10 })
    const built = await delivery.buildWakeBody(row({ fields: '["vendor"]' }), ev(), 'KEY')
    expect(people.lastFields).toEqual(['id', 'vendor'])
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.body).toMatchObject({
      type: 'nivaro.agent_trigger',
      delivery_id: 'KEY',
      trigger: { id: 3, name: 'Review new POs' },
      instructions: 'Check the vendor',
      event: 'transition',
      record: { id: 5, vendor: 'Acme' },
      link: 'https://app.test/purchase_orders/5',
      mcp_url: 'https://app.test/api/mcp',
      transition: { to_state: { key: 'review', label: 'Review' } }
    })
  })

  it('never sends a record the owner cannot read, or for an inactive owner', async () => {
    const hidden = await delivery.buildWakeBody(row(), ev(), 'K')
    expect(hidden).toEqual({ ok: false, reason: 'The trigger owner cannot read this record' })
    people.readable.set('5', { id: 5 })
    people.owner = { id: 'OWNER', status: 'suspended' }
    const off = await delivery.buildWakeBody(row(), ev(), 'K')
    expect(off.ok).toBe(false)
  })

  it('records a skipped delivery instead of sending when the owner cannot read', async () => {
    const out = await delivery.queueWakeUp(row(), ev())
    expect(out.skipped).toMatch(/cannot read/)
    expect(fetchMock.fn).not.toHaveBeenCalled()
    const insert = sql.ran.find((q) => q.method === 'insert')!
    expect(insert.sql).toContain('nivaro_agent_trigger_deliveries')
    expect(insert.bindings).toContain('skipped')
  })
})

describe('loop guard', () => {
  it('pauses a trigger that keeps waking for the same record', () => {
    const t0 = 1_000_000
    for (let i = 0; i < delivery.BURST_MAX; i++)
      expect(delivery.overBurst(99, 'r1', t0 + i)).toBe(false)
    expect(delivery.overBurst(99, 'r1', t0 + 10)).toBe(true)
    // Another record, and the same one after the window, are fine.
    expect(delivery.overBurst(99, 'r2', t0 + 10)).toBe(false)
    expect(delivery.overBurst(99, 'r1', t0 + delivery.BURST_WINDOW_MS + 20)).toBe(false)
  })
})
