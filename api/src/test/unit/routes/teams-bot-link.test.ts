import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  signedIn: true,
  link: null as null | { aad_object_id: string },
  marked: [] as unknown[][],
  asked: [] as string[]
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async () => {},
  requireAuth: async (req: { user?: unknown }) => {
    if (!h.signedIn) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id: 'user-1' }
  }
}))
vi.mock('../../../config.js', () => ({
  config: { PUBLIC_URL: 'https://n.example.com', ADMIN_URL: 'https://n.example.com' }
}))
vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: true }),
  configuredAppId: async () => 'app',
  teamsBotSetup: async () => null
}))
vi.mock('../../../services/app-links.js', () => ({ linkTo: async () => '' }))
vi.mock('../../../services/notification-channels.js', () => ({ bustNotifyPrefsCache: () => {} }))
vi.mock('../../../services/teams-bot/actions.js', () => ({ handleInvoke: async () => ({}) }))
vi.mock('../../../services/teams-bot/activity.js', () => ({ messageText: () => '' }))
vi.mock('../../../services/teams-bot/ask.js', () => ({ answerInTeams: async () => {} }))
vi.mock('../../../services/teams-bot/connect-card.js', () => ({ connectCard: () => ({}) }))
vi.mock('../../../services/teams-bot/jwt.js', () => ({ verifyConnectorToken: async () => ({}) }))
vi.mock('../../../services/teams-bot/links.js', () => ({
  linkForUser: async (id: string) => {
    h.asked.push(id)
    return h.link
  },
  markLink: async (...a: unknown[]) => {
    h.marked.push(a)
  },
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
  h.signedIn = true
  h.link = null
  h.marked = []
  h.asked = []
})

describe('DELETE /teams/link', () => {
  it('needs a sign-in', async () => {
    h.signedIn = false
    expect((await (await app()).inject({ method: 'DELETE', url: '/teams/link' })).statusCode).toBe(
      401
    )
  })

  it('404 when the caller has no link, and marks nothing', async () => {
    const r = await (await app()).inject({ method: 'DELETE', url: '/teams/link' })
    expect(r.statusCode).toBe(404)
    expect(h.marked).toHaveLength(0)
  })

  it("unlinks only the caller's own link", async () => {
    h.link = { aad_object_id: 'oid-1' }
    const r = await (await app()).inject({
      method: 'DELETE',
      url: '/teams/link',
      payload: { user_id: 'someone-else' }
    })
    expect(r.statusCode).toBe(200)
    expect(h.asked).toEqual(['user-1'])
    expect(h.marked).toEqual([['oid-1', 'unlinked']])
  })
})
