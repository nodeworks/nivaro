import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// GET /ai-settings/:collection — record pages (efp-new) read review_enabled to
// decide whether to offer "Review with AI". It was admin-only, so non-admins
// got 403 ADMIN_ONLY and never saw the button. Non-admins now get exactly
// { review_enabled } — no rules, hints, thresholds or other switches.

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = vi.fn(
    async (
      req: {
        headers: Record<string, string | undefined>
        user?: unknown
        isAdmin?: boolean
      },
      _reply?: unknown
    ) => {
      const who = req.headers['x-test-user']
      if (!who)
        throw Object.assign(new Error('Unauthorized'), { statusCode: 401, code: 'NOT_SIGNED_IN' })
      req.user =
        who === 'scoped-admin'
          ? { id: who, api_key_scopes: [{ collection: 'po', actions: ['read'] }] }
          : { id: who }
      req.isAdmin = who === 'admin' || who === 'scoped-admin'
    }
  )
  return {
    authenticate,
    requireAdmin: vi.fn(async (req: { isAdmin?: boolean }, reply: unknown) => {
      await authenticate(req as never, reply as never)
      if (!req.isAdmin)
        throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
    })
  }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../hooks/ai-validation.js', () => ({
  AI_SETTINGS_DEFAULTS: { validation_enabled: false, review_enabled: false },
  invalidateAiSettingsCache: vi.fn()
}))
vi.mock('../../../hooks/aggregate-caps.js', () => ({ isSumCapRule: () => false }))

const ROW = {
  collection: 'po',
  validation_enabled: 1,
  review_enabled: 1,
  validation_mode: 'hard',
  validation_rules: '["Never approve over budget"]',
  duplicate_detection_enabled: 1,
  duplicate_threshold: 0.9,
  document_autofill: 1,
  autofill_hints: 'secret-ish prompt text',
  autofill_keyed_hints: null,
  autofill_thresholds: null
}
const firstCalls: unknown[][] = []
vi.mock('../../../db/index.js', () => ({
  db: (_table: string) => {
    let where: Record<string, unknown> = {}
    const b = {
      where: (w: Record<string, unknown>) => {
        where = w
        return b
      },
      first: async (...cols: unknown[]) => {
        firstCalls.push(cols)
        return where.collection === 'po' ? { ...ROW } : undefined
      }
    }
    return b
  }
}))

import { aiSettingsRoutes } from '../../../routes/ai-settings.js'

async function buildApp() {
  const app = Fastify()
  await app.register(aiSettingsRoutes, { prefix: '/ai-settings' })
  await app.ready()
  return app
}

describe('GET /ai-settings/:collection', () => {
  it('gives a non-admin review_enabled and nothing else', async () => {
    const app = await buildApp()
    firstCalls.length = 0
    const res = await app.inject({ url: '/ai-settings/po', headers: { 'x-test-user': 'u1' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { review_enabled: true } })
    // Only the one column is even read.
    expect(firstCalls).toEqual([['review_enabled']])
    const off = await app.inject({ url: '/ai-settings/other', headers: { 'x-test-user': 'u1' } })
    expect(off.json()).toEqual({ data: { review_enabled: false } })
    await app.close()
  })

  it('answers system tables with review off for non-admins', async () => {
    const app = await buildApp()
    const res = await app.inject({
      url: '/ai-settings/nivaro_users',
      headers: { 'x-test-user': 'u1' }
    })
    expect(res.json()).toEqual({ data: { review_enabled: false } })
    await app.close()
  })

  it('gives admins the whole row', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/ai-settings/po', headers: { 'x-test-user': 'admin' } })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.review_enabled).toBe(true)
    expect(data.validation_mode).toBe('hard')
    expect(data.autofill_hints).toBe('secret-ish prompt text')
    await app.close()
  })

  it('treats an admin key limited to named collections as a non-admin', async () => {
    const app = await buildApp()
    const res = await app.inject({
      url: '/ai-settings/po',
      headers: { 'x-test-user': 'scoped-admin' }
    })
    expect(res.json()).toEqual({ data: { review_enabled: true } })
    await app.close()
  })

  it('refuses a caller who is not signed in', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/ai-settings/po' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('keeps PATCH admin-only', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/ai-settings/po',
      headers: { 'x-test-user': 'u1' },
      payload: { review_enabled: false }
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
