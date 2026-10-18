// tm-actions routes: telling affected people (#2274), detector settings (#2223), lenses (#2229).
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const audience = vi.hoisted(() => ({ ids: [] as string[], calls: [] as unknown[] }))
const activity = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))

vi.mock('../../services/traffic-actions/blast-radius.js', async (orig) => ({
  ...(await orig<typeof import('../../services/traffic-actions/blast-radius.js')>()),
  affectedPeople: async (...args: unknown[]) => {
    audience.calls.push(args)
    return audience.ids
  }
}))
vi.mock('../../services/activity.js', () => ({
  logActivity: async (opts: Record<string, unknown>) => {
    activity.calls.push(opts)
    return 1
  }
}))

import {
  registerExtensionLens,
  resetExtensionLenses
} from '../../services/traffic-actions/ext-lenses.js'
import { setDetectorSettingsForTest } from '../../services/traffic-detectors.js'
import { TELL_MAX_PEOPLE, tmActionsRoutes } from './tm-actions.js'

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001'
const sent: Array<Record<string, unknown>> = []

async function app(): Promise<FastifyInstance> {
  const a = Fastify()
  a.addHook('preHandler', async (req) => {
    ;(req as unknown as { user: unknown }).user = { id: ADMIN, first_name: 'Ann' }
  })
  await a.register(
    async (f) =>
      tmActionsRoutes(f, {
        send: async (_req, body) => {
          sent.push(body)
          return { status: 201, body: { data: { id: 55, delivered: 2 } } }
        }
      }),
    { prefix: '/traffic-map' }
  )
  await a.ready()
  return a
}

beforeEach(() => {
  audience.ids = []
  audience.calls = []
  activity.calls = []
  sent.length = 0
})
afterEach(() => {
  resetExtensionLenses()
  setDetectorSettingsForTest(null)
})

describe('POST /tell-affected', () => {
  it('needs a node and a message, and somebody to tell', async () => {
    const a = await app()
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/traffic-map/tell-affected',
          payload: { node: 'k1', message: 'x' }
        })
      ).statusCode
    ).toBe(400)
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/traffic-map/tell-affected',
          payload: { node: 'items/orders' }
        })
      ).json().code
    ).toBe('TELL_MESSAGE')
    const r = await a.inject({
      method: 'POST',
      url: '/traffic-map/tell-affected',
      payload: { node: 'items/orders', message: 'Hi' }
    })
    expect(r.json().code).toBe('TELL_NOBODY')
    expect(sent).toHaveLength(0)
  })

  it('refuses an audience past the cap', async () => {
    audience.ids = Array.from({ length: TELL_MAX_PEOPLE + 1 }, (_, i) => `u${i}`)
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/traffic-map/tell-affected',
      payload: { node: 'items/orders', message: 'Hi' }
    })
    expect(r.json().code).toBe('TELL_TOO_MANY')
    expect(sent).toHaveLength(0)
  })

  it('sends to the server-worked-out audience only, banner lifting itself, and logs it', async () => {
    audience.ids = ['P1', 'P2']
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/traffic-map/tell-affected',
      payload: {
        node: 'items/orders',
        screens: ['admin /collections/:c'],
        subject: 'Orders slow',
        message: 'We are on it',
        user_ids: ['SOMEONE-ELSE'],
        audience: { roles: ['everyone'] }
      }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toEqual({ announcement: 55, recipients: 2, delivered: 2 })
    expect(sent).toHaveLength(1)
    expect(sent[0].audience).toEqual({ user_ids: ['P1', 'P2'] })
    expect(sent[0].channels).toEqual(['message', 'banner'])
    expect(typeof sent[0].ends_at).toBe('string')
    // the sender is excluded and the screens reach the audience query
    const [node, screens, exclude] = audience.calls[0] as [{ key: string }, unknown[], string]
    expect(node.key).toBe('items/orders')
    expect(screens).toEqual([{ app: 'admin', route: '/collections/:c' }])
    expect(exclude).toBe(ADMIN)
    expect(activity.calls.map((c) => c.action)).toEqual(['traffic-map-tell-affected'])
  })

  it('can send to the inbox only', async () => {
    audience.ids = ['P1']
    const a = await app()
    await a.inject({
      method: 'POST',
      url: '/traffic-map/tell-affected',
      payload: { node: 'ext:4', message: 'x', banner: false }
    })
    expect(sent[0].channels).toEqual(['message'])
    expect(sent[0].ends_at).toBeUndefined()
  })
})

describe('detector settings', () => {
  it('validates and saves this instance’s settings with an activity row', async () => {
    const a = await app()
    expect(
      (await a.inject({ method: 'PUT', url: '/traffic-map/detectors', payload: { settings: [] } }))
        .statusCode
    ).toBe(400)
    const r = await a.inject({
      method: 'PUT',
      url: '/traffic-map/detectors',
      payload: { settings: { retry_storms: { enabled: false }, fanout: { limit: 120 } } }
    })
    expect(r.statusCode).toBe(200)
    const body = r.json().data
    expect(body.settings.retry_storms.enabled).toBe(false)
    expect(body.settings.fanout.limit).toBe(120)
    expect(body.changed).toEqual(['Fan-out calls in one page load 120 calls', 'Retry storms off'])
    expect(activity.calls[0].action).toBe('traffic-map-detectors-update')
    const g = (await a.inject({ method: 'GET', url: '/traffic-map/detectors' })).json().data
    expect(g.detectors.map((d: { id: string }) => d.id)).toContain('correlations')
  })
})

describe('extension lenses', () => {
  it('lists lenses and serves their data', async () => {
    registerExtensionLens('wh', {
      id: 'orders',
      label: 'Orders',
      read: () => ({ badges: [{ node: 'items/orders', text: '4 late', tone: 'warn' }] })
    })
    const a = await app()
    const list = (await a.inject({ method: 'GET', url: '/traffic-map/ext-lenses' })).json().data
      .lenses
    expect(list.map((l: { key: string }) => l.key)).toEqual(['wh:orders'])
    const d = (
      await a.inject({ method: 'GET', url: '/traffic-map/ext-lenses/wh:orders?window=300' })
    ).json().data
    expect(d.badges).toEqual([{ node: 'items/orders', text: '4 late', tone: 'warn' }])
    expect(
      (await a.inject({ method: 'GET', url: '/traffic-map/ext-lenses/wh:nope' })).statusCode
    ).toBe(404)
  })
})
