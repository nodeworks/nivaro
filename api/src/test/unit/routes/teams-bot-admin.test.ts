import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ admin: false, cfg: {} as Record<string, unknown> }))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown }) => {
    if (!h.admin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    req.user = { id: 'admin-1' }
  }
}))
vi.mock('../../../config.js', () => ({
  config: { PUBLIC_URL: 'https://n.example.com', ADMIN_URL: 'https://n.example.com' }
}))
vi.mock('../../../db/index.js', () => {
  const q: Record<string, unknown> = {}
  const chain = () =>
    new Proxy(q, {
      get: (_t, p) =>
        p === 'then'
          ? undefined
          : p === 'first'
            ? async () => ({ n: 2, at: null, last_error: null, environment_label: 'Staging' })
            : () => chain()
    })
  return { db: () => chain() }
})
vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({
    enabled: true,
    appId: 'app',
    appSecret: 's',
    tenantId: 't',
    appType: 'MultiTenant',
    source: 'env',
    ...h.cfg
  }),
  configuredAppId: async () => 'app'
}))
vi.mock('../../../services/app-links.js', () => ({ linkTo: async () => '' }))
vi.mock('../../../services/notification-channels.js', () => ({ bustNotifyPrefsCache: () => {} }))
vi.mock('../../../services/teams-bot/actions.js', () => ({ handleInvoke: async () => ({}) }))
vi.mock('../../../services/teams-bot/activity.js', () => ({ messageText: () => '' }))
vi.mock('../../../services/teams-bot/ask.js', () => ({ answerInTeams: async () => {} }))
vi.mock('../../../services/teams-bot/connect-card.js', () => ({ connectCard: () => ({}) }))
vi.mock('../../../services/teams-bot/jwt.js', () => ({ verifyConnectorToken: async () => ({}) }))
vi.mock('../../../services/teams-bot/links.js', () => ({
  markLink: async () => {},
  noteLinkInbound: async () => {},
  readConnectToken: () => null,
  resolveTeamsUser: async () => ({}),
  TeamsLinkTakenError: class extends Error {},
  upsertLink: async () => ({})
}))
vi.mock('../../../services/teams-bot/send.js', () => ({ deliverTeams: async () => 'sent' }))
vi.mock('../../../services/users.js', () => ({ canSignIn: () => true, getUser: async () => null }))
vi.mock('../../../services/teams-bot/connector.js', () => ({ sendActivity: async () => ({}) }))

import { teamsBotRoutes } from '../../../routes/teams-bot.js'

async function app() {
  const a = Fastify()
  a.setErrorHandler((err: { statusCode?: number; message: string }, _req, reply) =>
    reply.code(err.statusCode ?? 500).send({ error: err.message })
  )
  await a.register(teamsBotRoutes, { prefix: '/teams' })
  return a
}

beforeEach(() => {
  h.admin = false
  delete process.env.CLOUD_META_DB_URL
})
afterEach(() => {
  delete process.env.CLOUD_META_DB_URL
})

describe('teams admin routes', () => {
  it('status, test and package refuse non-admins', async () => {
    const a = await app()
    for (const [method, url] of [
      ['GET', '/teams/status'],
      ['POST', '/teams/test'],
      ['GET', '/teams/package']
    ] as const)
      expect((await a.inject({ method, url })).statusCode).toBe(403)
  })

  it('status answers an admin; package is a zip attachment', async () => {
    h.admin = true
    const a = await app()
    const s = await a.inject({ method: 'GET', url: '/teams/status' })
    expect(s.statusCode).toBe(200)
    expect(s.json()).toMatchObject({ enabled: true, app_type: 'MultiTenant', linked: 2 })
    const p = await a.inject({ method: 'GET', url: '/teams/package' })
    expect(p.statusCode).toBe(200)
    expect(p.headers['content-type']).toBe('application/zip')
    expect(p.headers['content-disposition']).toBe('attachment; filename="nivaro-teams-staging.zip"')
    const t = await a.inject({ method: 'POST', url: '/teams/test' })
    expect(t.json()).toMatchObject({ outcome: 'sent' })
  })

  it('all three are 404 in cloud mode', async () => {
    h.admin = true
    process.env.CLOUD_META_DB_URL = 'mssql://x'
    const a = await app()
    for (const [method, url] of [
      ['GET', '/teams/status'],
      ['POST', '/teams/test'],
      ['GET', '/teams/package']
    ] as const)
      expect((await a.inject({ method, url })).statusCode).toBe(404)
  })
})
