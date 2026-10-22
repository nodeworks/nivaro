import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

/**
 * #2834 — with the identity provider unreachable, sign-in sends people back to the sign-in
 * page with `?error=provider_unavailable` (which it explains) instead of a raw 500 on a browser
 * navigation, and a refused sign-in still reads `auth_failed`. Neither path redirects to
 * /api/auth/login, so there is no loop.
 */

const { unreachable } = vi.hoisted(() => ({
  unreachable: () =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED idp'), { code: 'ECONNREFUSED' })
    })
}))

const callbackError = vi.fn<() => Error>(() => unreachable())

vi.mock('../auth/oidc.js', async (orig) => ({
  ...(await orig<typeof import('../auth/oidc.js')>()),
  oidcConfigured: () => true,
  buildLoginUrl: async () => {
    throw unreachable()
  },
  handleCallback: async () => {
    throw callbackError()
  }
}))
vi.mock('../services/error-tracking.js', () => ({ trackError: vi.fn() }))

import { authRoutes } from './auth.js'

async function build(session: Record<string, unknown>) {
  const app = Fastify()
  app.decorateRequest('session', null as never)
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: Record<string, unknown> }).session = session
  })
  await app.register(authRoutes)
  await app.ready()
  return app
}

describe('sign-in with the identity provider down (#2834)', () => {
  it('login: back to the sign-in page with a reason, not a 500', async () => {
    const app = await build({})
    const res = await app.inject({
      method: 'GET',
      url: '/login?returnTo=http%3A%2F%2Flocalhost%3A3056%2F'
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toMatch(/\/login\?error=provider_unavailable$/)
    expect(res.headers.location).not.toMatch(/\/api\/auth\/login/)
  })

  it('callback: an unreachable token endpoint is provider_unavailable, a refusal auth_failed', async () => {
    const session = () => ({
      oidcState: 's',
      codeVerifier: 'v',
      returnTo: 'http://localhost:3056/'
    })
    const down = await (await build(session())).inject({
      method: 'GET',
      url: '/callback?code=c&state=s'
    })
    expect(down.statusCode).toBe(302)
    expect(down.headers.location).toMatch(/\/login\?error=provider_unavailable$/)

    callbackError.mockImplementationOnce(() => new Error('unexpected JWT claim value encountered'))
    const refused = await (await build(session())).inject({
      method: 'GET',
      url: '/callback?code=c&state=s'
    })
    expect(refused.headers.location).toMatch(/\/login\?error=auth_failed$/)
  })
})
