import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TakenError = vi.hoisted(() => class TakenError extends Error {})
const logErr = vi.hoisted(() => vi.fn())
const st = vi.hoisted(() => ({
  verdict: { ok: true } as { ok: boolean; reason?: string },
  resolved: { user: null } as Record<string, unknown>,
  session: undefined as string | undefined,
  tokenOk: true,
  sessionUser: { id: 'U1', entra_oid: 'OID-1' } as Record<string, unknown>,
  ask: vi.fn(async (..._a: unknown[]) => undefined),
  upsert: vi.fn(async (..._a: unknown[]) => ({})),
  send: vi.fn(async (..._a: unknown[]) => ({ id: 'x' })),
  mark: vi.fn(async (..._a: unknown[]) => undefined),
  invoke: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ type: 'AdaptiveCard' })),
  enabled: true
}))

vi.mock('../../../config.js', () => ({
  config: { PUBLIC_URL: 'https://nivaro.test', SESSION_SECRET: 's'.repeat(40) }
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/notification-channels.js', () => ({ bustNotifyPrefsCache: vi.fn() }))
vi.mock('../../../services/app-links.js', () => ({
  linkTo: async () => 'https://nivaro.test/my-work'
}))
vi.mock('../../../services/users.js', () => ({
  getUser: async () => st.sessionUser,
  canSignIn: () => true
}))
vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: st.enabled, appId: 'app', tenantId: 'tid' })
}))
vi.mock('../../../services/teams-bot/jwt.js', () => ({
  verifyConnectorToken: async () => st.verdict
}))
vi.mock('../../../services/teams-bot/connector.js', () => ({ sendActivity: st.send }))
vi.mock('../../../services/teams-bot/ask.js', () => ({ answerInTeams: st.ask }))
vi.mock('../../../services/teams-bot/actions.js', () => ({
  handleInvoke: (...a: unknown[]) => st.invoke(...a)
}))
const inbound = vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined)
vi.mock('../../../services/teams-bot/links.js', () => ({
  resolveTeamsUser: async () => st.resolved,
  upsertLink: st.upsert,
  markLink: st.mark,
  linkForUser: async () => null,
  noteLinkInbound: (...a: unknown[]) => inbound(...a),
  signConnectToken: () => 'SIGNED',
  TeamsLinkTakenError: TakenError,
  readConnectToken: (t: string) =>
    st.tokenOk && t === 'SIGNED' ? { aadObjectId: 'oid-1', tenantId: 'tid' } : null
}))

import { teamsBotRoutes } from '../../../routes/teams-bot.js'
import { beginTrace, currentTraceCaller } from '../../../services/request-trace.js'

async function build(opts: { trace?: boolean } = {}) {
  const log = {
    level: 'info',
    error: logErr,
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    child() {
      return log
    }
  }
  const app = Fastify({ loggerInstance: log as never })
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: { userId?: string } }).session = { userId: st.session }
    // What plugins/request-trace.ts does for every /api request.
    if (opts.trace) beginTrace(req.url.split('?')[0], req as never)
  })
  await app.register(teamsBotRoutes, { prefix: '/api/teams' })
  return app
}

const base = {
  channelId: 'msteams',
  serviceUrl: 'https://smba.test/',
  from: { id: '29:x', aadObjectId: 'oid-1' },
  recipient: { id: '28:bot' },
  conversation: { id: 'conv-1', conversationType: 'personal' },
  channelData: { tenant: { id: 'tid' } }
}
const post = (app: Awaited<ReturnType<typeof build>>, body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/teams/messages',
    headers: { authorization: 'Bearer t' },
    payload: body as object
  })
const install = { ...base, type: 'conversationUpdate', membersAdded: [{ id: '28:bot' }] }
const flush = () => new Promise((r) => setTimeout(r, 10))

beforeEach(() => {
  st.verdict = { ok: true }
  st.resolved = { user: null }
  st.session = undefined
  st.tokenOk = true
  st.sessionUser = { id: 'U1', entra_oid: 'OID-1' }
  st.enabled = true
  st.invoke.mockReset().mockResolvedValue({ type: 'AdaptiveCard' })
  logErr.mockReset()
  inbound.mockReset()
  inbound.mockResolvedValue(undefined)
  for (const f of [st.ask, st.upsert, st.send, st.mark]) f.mockReset()
  st.ask.mockResolvedValue(undefined)
  st.send.mockResolvedValue({ id: 'x' })
})

describe('POST /api/teams/messages', () => {
  it('401 without a token', async () => {
    st.verdict = { ok: false, reason: 'missing' }
    const r = await post(await build(), { ...base, type: 'message', id: 'a' })
    expect(r.statusCode).toBe(401)
    expect(r.json()).toEqual({ error: 'Unauthorized' })
  })

  it('401 for another tenant', async () => {
    st.verdict = { ok: false, reason: 'tenant' }
    const r = await post(await build(), { ...base, type: 'message', id: 'a' })
    expect(r.statusCode).toBe(401)
  })

  it('a failing inbound stamp still answers the message', async () => {
    st.resolved = { user: { id: 'U1', first_name: 'Rob' }, link: { conversation_id: 'conv-1' } }
    inbound.mockImplementation(() => {
      throw new TypeError('boom')
    })
    const app = await build()
    expect(
      (await post(app, { ...base, type: 'message', id: 'f1', text: 'how many?' })).statusCode
    ).toBe(200)
    inbound.mockImplementation(async () => {
      throw new Error('db down')
    })
    await post(app, { ...base, type: 'message', id: 'f2', text: 'how many?' })
    await flush()
    expect(st.ask).toHaveBeenCalledTimes(2)
  })

  it('returns 200 before the answer resolves', async () => {
    st.resolved = { user: { id: 'U1', first_name: 'Rob' }, link: { conversation_id: 'conv-1' } }
    st.ask.mockImplementation(() => new Promise(() => {}))
    const r = await post(await build(), { ...base, type: 'message', id: 'slow', text: 'how many?' })
    expect(r.statusCode).toBe(200)
    await flush()
    expect(st.ask).toHaveBeenCalledTimes(1)
  })

  it('processes one activity id once', async () => {
    st.resolved = { user: { id: 'U1' }, link: { conversation_id: 'conv-1' } }
    const app = await build()
    const body = { ...base, type: 'message', id: 'dup-1', text: '<at>Nivaro</at> how many?' }
    await post(app, body)
    await post(app, body)
    await flush()
    expect(st.ask).toHaveBeenCalledTimes(1)
  })

  it('the same activity id in another conversation is a different message', async () => {
    st.resolved = { user: { id: 'U1' }, link: { conversation_id: 'conv-1' } }
    const app = await build()
    await post(app, { ...base, type: 'message', id: 'same', text: 'hi' })
    await post(app, {
      ...base,
      type: 'message',
      id: 'same',
      text: 'hi',
      conversation: { id: 'conv-2', conversationType: 'personal' }
    })
    await flush()
    expect(st.ask).toHaveBeenCalledTimes(2)
  })

  it('strips only the bot mention, so @efp help is the help command', async () => {
    st.resolved = { user: { id: 'U1' }, link: { conversation_id: 'conv-1' } }
    await post(await build(), {
      ...base,
      type: 'message',
      id: 'help-1',
      text: '<at>efp</at>&nbsp;help',
      entities: [
        { type: 'mention', mentioned: { id: '28:bot', name: 'efp' }, text: '<at>efp</at>' }
      ]
    })
    await flush()
    expect(st.ask).not.toHaveBeenCalled()
    expect(JSON.stringify(st.send.mock.calls[0])).toContain('Ask me anything about your records')
  })

  it('a background failure tells the person something went wrong', async () => {
    st.resolved = { user: { id: 'U1' }, link: { conversation_id: 'conv-1' } }
    st.ask.mockRejectedValue(new Error('boom'))
    await post(await build(), { ...base, type: 'message', id: 'fail-1', text: 'how many?' })
    await flush()
    expect(logErr).toHaveBeenCalled()
    expect(JSON.stringify(st.send.mock.calls.at(-1))).toContain(
      'Something went wrong answering that. Try again in a minute.'
    )
  })

  it('a failure to send the apology is swallowed', async () => {
    st.resolved = { user: { id: 'U1' }, link: { conversation_id: 'conv-1' } }
    st.ask.mockRejectedValue(new Error('boom'))
    st.send.mockRejectedValue(new Error('down'))
    const r = await post(await build(), { ...base, type: 'message', id: 'fail-2', text: 'q' })
    await flush()
    expect(r.statusCode).toBe(200)
  })

  it('install by a matched user stores the link', async () => {
    st.resolved = { user: { id: 'U1', first_name: 'Rob' }, link: null }
    const r = await post(await build(), install)
    expect(r.statusCode).toBe(200)
    expect(st.upsert).toHaveBeenCalledWith(
      'U1',
      expect.objectContaining({
        aadObjectId: 'oid-1',
        conversationId: 'conv-1',
        linkedBy: 'entra_oid'
      })
    )
    expect(JSON.stringify(st.send.mock.calls[0])).toContain('Hi Rob.')
  })

  it('install by an unmatched user gets the Connect card', async () => {
    await post(await build(), install)
    expect(st.upsert).not.toHaveBeenCalled()
    expect(JSON.stringify(st.send.mock.calls[0])).toContain('/api/teams/connect?t=SIGNED')
  })

  it('uninstall marks the link', async () => {
    await post(await build(), { ...base, type: 'installationUpdate', action: 'remove' })
    expect(st.mark).toHaveBeenCalledWith('oid-1', 'uninstalled')
  })

  it('an invoke is attributed to Teams in the activity log (auth_method teams)', async () => {
    let seen: unknown = null
    st.invoke.mockImplementation(async () => {
      // logActivity's callerColumns() reads exactly this when no req is handed in.
      seen = currentTraceCaller()
      return { type: 'AdaptiveCard' }
    })
    const r = await post(await build({ trace: true }), {
      ...base,
      type: 'invoke',
      name: 'adaptiveCard/action',
      value: { action: { data: {} } }
    })
    expect(r.statusCode).toBe(200)
    expect(seen).toEqual({ auth: 'teams', apiKeyId: null })
  })

  it('background message handling is attributed to Teams too', async () => {
    st.resolved = { user: { id: 'U1' }, link: { conversation_id: 'conv-1' } }
    let seen: unknown = null
    st.ask.mockImplementation(async () => {
      seen = currentTraceCaller()
    })
    await post(await build({ trace: true }), { ...base, type: 'message', id: 'tag-1', text: 'q' })
    await flush()
    expect(st.ask).toHaveBeenCalledTimes(1)
    expect(seen).toEqual({ auth: 'teams', apiKeyId: null })
  })

  it('removing the bot from a team leaves the personal link alone', async () => {
    await post(await build(), {
      ...base,
      type: 'installationUpdate',
      action: 'remove',
      conversation: { id: 'team-1', conversationType: 'channel' }
    })
    expect(st.mark).not.toHaveBeenCalled()
  })
})

describe('GET /api/teams/connect', () => {
  const get = (app: Awaited<ReturnType<typeof build>>, t = 'SIGNED') =>
    app.inject({ method: 'GET', url: `/api/teams/connect?t=${t}` })

  it('connect without a session redirects to login with returnTo', async () => {
    const r = await get(await build())
    expect(r.statusCode).toBe(302)
    expect(r.headers.location).toContain('https://nivaro.test/api/auth/login?returnTo=')
    expect(decodeURIComponent(String(r.headers.location))).toContain('/api/teams/connect?t=SIGNED')
  })

  it('links the signed-in matching account', async () => {
    st.session = 'U1'
    const r = await get(await build())
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('Teams connected. You can close this tab.')
    expect(st.upsert).toHaveBeenCalledWith('U1', expect.objectContaining({ linkedBy: 'sign_in' }))
  })

  it('refuses a different Microsoft account', async () => {
    st.session = 'U1'
    st.sessionUser = { id: 'U1', entra_oid: 'OTHER' }
    const r = await get(await build())
    expect(r.statusCode).toBe(403)
    expect(st.upsert).not.toHaveBeenCalled()
  })

  it('an oid held by another user is a 403 page', async () => {
    st.session = 'U1'
    st.upsert.mockRejectedValue(new TakenError('x'))
    const r = await get(await build())
    expect(r.statusCode).toBe(403)
    expect(r.body).toContain('already linked')
  })

  it('any other failure is a 500 page and is logged', async () => {
    st.session = 'U1'
    st.upsert.mockRejectedValue(new Error('timeout'))
    const r = await get(await build())
    expect(r.statusCode).toBe(500)
    expect(r.body).toContain('Something went wrong linking Teams')
    expect(logErr).toHaveBeenCalled()
  })

  it('needs a Microsoft sign-in and a live token', async () => {
    st.session = 'U1'
    st.sessionUser = { id: 'U1', entra_oid: null }
    expect((await get(await build())).statusCode).toBe(400)
    expect((await get(await build(), 'BAD')).statusCode).toBe(400)
  })

  it('404 while the bot is off', async () => {
    st.enabled = false
    st.session = 'U1'
    const r = await get(await build())
    expect(r.statusCode).toBe(404)
    expect(st.upsert).not.toHaveBeenCalled()
  })

  it('404 in cloud mode', async () => {
    process.env.CLOUD_META_DB_URL = 'x'
    st.session = 'U1'
    try {
      const r = await get(await build())
      expect(r.statusCode).toBe(404)
      expect(st.upsert).not.toHaveBeenCalled()
    } finally {
      delete process.env.CLOUD_META_DB_URL
    }
  })
})
