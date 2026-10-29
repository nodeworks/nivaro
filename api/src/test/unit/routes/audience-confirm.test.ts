import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #3080 — save routes hold a large / role-wide audience behind confirm_audience, log the
// confirm, and a test send goes to the saver only.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'saver-id' }
    req.isAdmin = true
  }),
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'saver-id' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../hooks/alerts.js', () => ({ evaluateAlerts: vi.fn(async () => 0) }))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async () => ({ id: 1, decision: {}, lane: null }))
}))
vi.mock('../../../services/mail.js', () => ({ sendRawMail: vi.fn(async () => undefined) }))
vi.mock('../../../services/audience-preview.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/audience-preview.js')
  return { ...real, previewConfigAudience: vi.fn() }
})
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { alertsRoutes } from '../../../routes/alerts.js'
import { rulesRoutes } from '../../../routes/rules.js'
import { logActivity } from '../../../services/activity.js'
import { bustAudienceSettingsCache } from '../../../services/audience-gate.js'
import { previewConfigAudience, summarizeAudience } from '../../../services/audience-preview.js'
import { sendRawMail } from '../../../services/mail.js'
import { notifyUser } from '../../../services/notification-channels.js'

type Row = Record<string, unknown>

/** A tiny knex stand-in: every chain method returns itself; terminal reads come from `rows`. */
function fakeDb(rows: Record<string, Row | undefined>, inserted: Row[]) {
  vi.mocked(db).mockImplementation(((table: string) => {
    const q: Record<string, unknown> = {}
    const self = () => q
    for (const m of ['where', 'whereIn', 'select', 'orderBy', 'join', 'leftJoin'])
      q[m] = vi.fn(self)
    q.first = vi.fn(async () => rows[table])
    q.update = vi.fn(async () => 1)
    q.delete = vi.fn(async () => 1)
    q.insert = vi.fn((row: Row) => {
      inserted.push({ table, ...row })
      return { returning: vi.fn(async () => [{ id: 7, ...row }]) }
    })
    q.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return q
  }) as never)
}

function preview(count: number, roles = 0) {
  return {
    preview: summarizeAudience({
      kind: 'rule',
      people: Array.from({ length: count }, (_, i) => ({ id: `u${i}`, name: `P ${i}` })),
      roles: Array.from({ length: roles }, (_, i) => ({
        id: `r${i}`,
        name: 'Managers',
        members: 5
      })),
      everyone: false,
      external: 0,
      threshold: 10,
      active: true,
      notes: []
    }),
    ids: Array.from({ length: count }, (_, i) => `u${i}`)
  }
}

const ruleBody = {
  name: 'Tell managers',
  collection: 'orders',
  trigger: 'after_create',
  actions: [{ type: 'notify', message: 'x', roles: ['Managers'] }]
}

let inserted: Row[] = []
beforeEach(() => {
  inserted = []
  bustAudienceSettingsCache()
  fakeDb({ nivaro_settings_overrides: undefined, nivaro_rules: { id: 7, ...ruleBody } }, inserted)
})
afterEach(() => vi.clearAllMocks())

async function rulesApp() {
  const app = Fastify({ logger: false })
  await app.register(rulesRoutes, { prefix: '/rules' })
  return app
}

describe('rules save — audience confirm', () => {
  it('409 AUDIENCE_CONFIRM_REQUIRED without the flag, nothing stored', async () => {
    vi.mocked(previewConfigAudience).mockResolvedValue(preview(3, 1))
    const app = await rulesApp()
    const res = await app.inject({ method: 'POST', url: '/rules', payload: ruleBody })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.code).toBe('AUDIENCE_CONFIRM_REQUIRED')
    expect(body.audience.count).toBe(3)
    expect(body.audience.includes_roles[0].name).toBe('Managers')
    expect(inserted.filter((r) => r.table === 'nivaro_rules')).toHaveLength(0)
  })

  it('saves with confirm_audience and logs audience-confirm (counts only)', async () => {
    vi.mocked(previewConfigAudience).mockResolvedValue(preview(14))
    const app = await rulesApp()
    const res = await app.inject({
      method: 'POST',
      url: '/rules',
      payload: { ...ruleBody, confirm_audience: true }
    })
    expect(res.statusCode).toBe(201)
    expect(inserted.filter((r) => r.table === 'nivaro_rules')).toHaveLength(1)
    expect(inserted[0]).not.toHaveProperty('confirm_audience')
    const call = vi
      .mocked(logActivity)
      .mock.calls.find(([o]) => (o as { action: string }).action === 'audience-confirm')
    expect(call).toBeTruthy()
    const opts = call![0] as { collection: string; item: string; comment: string }
    expect(opts.collection).toBe('nivaro_rules')
    expect(opts.item).toBe('7')
    expect(JSON.parse(opts.comment)).toEqual({
      kind: 'rule',
      count: 14,
      roles: false,
      everyone: false
    })
  })

  it('a small audience saves straight through and logs no confirm', async () => {
    vi.mocked(previewConfigAudience).mockResolvedValue(preview(4))
    const app = await rulesApp()
    const res = await app.inject({ method: 'POST', url: '/rules', payload: ruleBody })
    expect(res.statusCode).toBe(201)
    expect(
      vi
        .mocked(logActivity)
        .mock.calls.some(([o]) => (o as { action: string }).action === 'audience-confirm')
    ).toBe(false)
  })

  it('PATCH that reaches the same people again does not ask', async () => {
    vi.mocked(previewConfigAudience).mockResolvedValue(preview(20))
    const app = await rulesApp()
    const res = await app.inject({ method: 'PATCH', url: '/rules/7', payload: { name: 'Renamed' } })
    expect(res.statusCode).toBe(200)
  })

  it('PATCH that adds people asks first', async () => {
    vi.mocked(previewConfigAudience)
      .mockResolvedValueOnce(preview(20)) // after
      .mockResolvedValueOnce(preview(5)) // before
    const app = await rulesApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/rules/7',
      payload: { actions: ruleBody.actions }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('AUDIENCE_CONFIRM_REQUIRED')
  })

  it('honours the instance threshold from the audience_confirm override key', async () => {
    fakeDb(
      {
        nivaro_settings_overrides: {
          id: 1,
          data: JSON.stringify({ audience_confirm: { threshold: 50 } })
        },
        nivaro_rules: { id: 7, ...ruleBody }
      },
      inserted
    )
    vi.mocked(previewConfigAudience).mockImplementation(async (_k, _d, threshold) => {
      expect(threshold).toBe(50)
      return preview(4)
    })
    const app = await rulesApp()
    const res = await app.inject({ method: 'POST', url: '/rules', payload: ruleBody })
    expect(res.statusCode).toBe(201)
    expect(previewConfigAudience).toHaveBeenCalled()
  })
})

describe('alert test send — the saver only', () => {
  it('notifies and emails the caller and nobody else', async () => {
    fakeDb({ nivaro_users: { id: 'saver-id', email: 'saver@example.com' } }, inserted)
    const app = Fastify({ logger: false })
    await app.register(alertsRoutes, { prefix: '/alerts' })
    const res = await app.inject({
      method: 'POST',
      url: '/alerts/definitions/test-send',
      payload: {
        name: 'Big order',
        collection: 'orders',
        field: 'total',
        operator: 'gt',
        threshold: 1000,
        email: true
      }
    })
    expect(res.statusCode).toBe(200)
    expect(notifyUser).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyUser).mock.calls[0][1]).toBe('saver-id')
    expect(sendRawMail).toHaveBeenCalledTimes(1)
    expect((vi.mocked(sendRawMail).mock.calls[0][0] as { to: string }).to).toBe('saver@example.com')
    expect(res.json().data.results).toEqual({ inapp: 'sent', email: 'sent' })
  })
})
