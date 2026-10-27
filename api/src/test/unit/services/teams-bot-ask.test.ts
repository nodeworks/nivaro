import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Ask AI from Teams (spec §6.3/§6.4): as the asker, with the channel's readers as the audience,
// and a private path when not every reader may see the answer.

const h = vi.hoisted(() => ({
  answer: vi.fn(),
  send: vi.fn(async (..._a: unknown[]) => ({ id: 'sent' })),
  paged: vi.fn(),
  createConv: vi.fn(async (..._a: unknown[]) => 'a:new-dm'),
  resolve: vi.fn(),
  link: null as null | Record<string, unknown>,
  upsert: vi.fn(async (..._a: unknown[]) => ({})),
  log: vi.fn(async (..._a: unknown[]) => 1)
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../config.js', () => ({
  config: { PUBLIC_URL: 'https://nivaro.test', SESSION_SECRET: 's'.repeat(40) }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: h.log }))
vi.mock('../../../services/app-links.js', () => ({
  linkTo: async (kind: string, p: { q?: string }) =>
    `https://nivaro.test/${kind}?q=${encodeURIComponent(String(p.q ?? ''))}`
}))
vi.mock('../../../services/chat-bot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/chat-bot.js')>()),
  answerAssistantQuestion: h.answer
}))
vi.mock('../../../services/chat-bot-audience.js', () => ({ AUDIENCE_CAP: 20, REPLAY_BUDGET: 48 }))
vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: true, appId: 'app', appSecret: 'x', tenantId: 'tid' })
}))
vi.mock('../../../services/teams-bot/connector.js', () => ({
  sendActivity: h.send,
  getPagedMembers: h.paged,
  createPersonalConversation: h.createConv
}))
vi.mock('../../../services/teams-bot/links.js', () => ({
  resolveTeamsUser: h.resolve,
  linkForUser: async () => h.link,
  upsertLink: h.upsert,
  markLink: vi.fn(),
  noteLinkInbound: async () => {},
  readConnectToken: () => null,
  signConnectToken: () => 'SIGNED',
  TeamsLinkTakenError: class extends Error {}
}))
// Only the route test below needs these.
vi.mock('../../../services/notification-channels.js', () => ({ bustNotifyPrefsCache: vi.fn() }))
vi.mock('../../../services/users.js', () => ({ getUser: vi.fn(), canSignIn: () => true }))
vi.mock('../../../services/teams-bot/jwt.js', () => ({
  verifyConnectorToken: async () => ({ ok: true })
}))
vi.mock('../../../services/teams-bot/actions.js', () => ({ handleInvoke: vi.fn() }))

import { teamsBotRoutes } from '../../../routes/teams-bot.js'
import { messageText } from '../../../services/teams-bot/activity.js'
import { answerInTeams } from '../../../services/teams-bot/ask.js'
import type { User } from '../../../types.js'

const ASKER = { id: 'U-ASKER', email: 'asker@example.com', first_name: 'Ana' } as unknown as User
const app = { log: { warn: vi.fn(), error: vi.fn() } } as unknown as FastifyInstance

const dm = {
  type: 'message',
  id: 'm1',
  serviceUrl: 'https://smba.test/',
  from: { id: '29:asker', aadObjectId: 'oid-asker' },
  recipient: { id: '28:bot', name: 'efp' },
  conversation: { id: 'a:dm-1', conversationType: 'personal' },
  channelData: { tenant: { id: 'tid' } },
  text: 'how many open requests?'
}
const channel = {
  ...dm,
  id: 'm2',
  conversation: { id: '19:chan@thread.tacv2;messageid=m2', conversationType: 'channel' },
  channelData: {
    tenant: { id: 'tid' },
    team: { id: '19:team@thread.tacv2', name: 'Facilities' },
    channel: { id: '19:chan@thread.tacv2', name: 'Ops', membershipType: 'standard' }
  },
  text: '<at>efp</at> how many open requests?',
  entities: [{ type: 'mention', mentioned: { id: '28:bot', name: 'efp' }, text: '<at>efp</at>' }]
}

const members = (...oids: Array<string | null>) => ({
  members: oids.map((o, i) => ({ id: `29:m${i}`, aadObjectId: o, name: `M${i}` })),
  truncated: false
})
/** Maps oid-<name> to user U-<NAME>; anything else is unmatched. */
function resolveBy(known: string[]) {
  h.resolve.mockImplementation(async (oid: string) =>
    known.includes(oid)
      ? { user: { id: `U-${oid.slice(4).toUpperCase()}` }, link: null }
      : { user: null, reason: 'not_found' }
  )
}
const sentCards = () =>
  h.send.mock.calls
    .map(([, conv, act]) => ({ conv, act: act as Record<string, unknown> }))
    .filter((c) => c.act.type !== 'typing')
const cardText = (act: Record<string, unknown>) => JSON.stringify(act.attachments)

beforeEach(() => {
  for (const f of [h.answer, h.send, h.paged, h.createConv, h.resolve, h.upsert, h.log])
    f.mockReset()
  h.send.mockResolvedValue({ id: 'sent' })
  h.createConv.mockResolvedValue('a:new-dm')
  h.upsert.mockResolvedValue({})
  h.link = null
  h.answer.mockResolvedValue({ text: 'There are 4.', verdict: 'room', stopped: false })
})

describe('messageText', () => {
  it('drops only the bot mention and keeps other mentions as names', () => {
    expect(
      messageText({
        recipient: { id: '28:bot' },
        text: '<at>efp</at>&nbsp;how many does <at>Sam</at> have',
        entities: [
          { type: 'mention', mentioned: { id: '28:bot', name: 'efp' }, text: '<at>efp</at>' },
          { type: 'mention', mentioned: { id: '29:sam', name: 'Sam Lee' }, text: '<at>Sam</at>' }
        ]
      })
    ).toBe('how many does Sam have')
  })
})

describe('answerInTeams', () => {
  it('DM answers as the asker with an alone audience', async () => {
    await answerInTeams(app, dm, ASKER)
    expect(h.answer).toHaveBeenCalledTimes(1)
    const [, who, question, opts] = h.answer.mock.calls[0]
    expect(who).toBe(ASKER)
    expect(question).toBe('how many open requests?')
    expect(opts.verify.audience).toEqual({ kind: 'people', ids: [] })
    expect(opts.verify.room).toBe('teams:a:dm-1')
    expect(opts.record).toBeNull()
    expect(h.paged).not.toHaveBeenCalled()
    // Typing first, then one answer card with Continue in Nivaro.
    expect((h.send.mock.calls[0][2] as { type: string }).type).toBe('typing')
    const cards = sentCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].conv).toBe('a:dm-1')
    expect(cardText(cards[0].act)).toContain('There are 4.')
    expect(cardText(cards[0].act)).toContain('Continue in Nivaro')
    expect(cardText(cards[0].act)).toContain(
      'https://nivaro.test/ask?q=how%20many%20open%20requests%3F'
    )
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'teams-ask',
        user: 'U-ASKER',
        comment: 'teams chat · asked by asker@example.com'
      })
    )
    // The question never reaches the log row.
    expect(JSON.stringify(h.log.mock.calls)).not.toContain('open requests')
  })

  it('caps a long answer at 3,500 characters and strips followups blocks', async () => {
    h.answer.mockResolvedValue({
      text: `${'x'.repeat(5000)}\n\`\`\`followups\nmore?\n\`\`\``,
      verdict: 'room',
      stopped: false
    })
    await answerInTeams(app, dm, ASKER)
    const body = (
      sentCards()[0].act.attachments as Array<{ content: { body: Array<{ text: string }> } }>
    )[0].content.body[0].text
    expect(body).toHaveLength(3500)
    expect(body.endsWith('…')).toBe(true)
    expect(body).not.toContain('followups')
  })

  it('channel with all members matched uses a people audience', async () => {
    h.paged.mockResolvedValue(members('oid-asker', 'oid-kim', 'oid-sam'))
    resolveBy(['oid-asker', 'oid-kim', 'oid-sam'])
    await answerInTeams(app, channel, ASKER)
    // The TEAM's roster, capped at AUDIENCE_CAP + 1.
    expect(h.paged).toHaveBeenCalledWith('https://smba.test/', '19:team@thread.tacv2', 21)
    const [, , question, opts] = h.answer.mock.calls[0]
    expect(question).toBe('how many open requests?')
    expect(opts.verify.audience).toEqual({ kind: 'people', ids: ['U-KIM', 'U-SAM'] })
    expect(opts.verify.room).toBe('teams:19:chan@thread.tacv2;messageid=m2')
    const cards = sentCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].conv).toBe('19:chan@thread.tacv2;messageid=m2')
    expect(cards[0].act.replyToId).toBe('m2')
    expect(cardText(cards[0].act)).toContain('There are 4.')
  })

  it('an unmatched channel member makes the audience open', async () => {
    h.paged.mockResolvedValue(members('oid-asker', 'oid-kim', 'oid-stranger'))
    resolveBy(['oid-asker', 'oid-kim'])
    await answerInTeams(app, channel, ASKER)
    expect(h.answer.mock.calls[0][3].verify.audience).toEqual({ kind: 'open' })
  })

  it('a member without an Entra id, a roster too big or a roster error is open too', async () => {
    resolveBy(['oid-asker', 'oid-kim'])
    h.paged.mockResolvedValueOnce(members('oid-asker', null))
    await answerInTeams(app, channel, ASKER)
    h.paged.mockResolvedValueOnce({ ...members('oid-asker', 'oid-kim'), truncated: true })
    await answerInTeams(app, channel, ASKER)
    h.paged.mockRejectedValueOnce(new Error('403'))
    await answerInTeams(app, channel, ASKER)
    expect(h.answer.mock.calls.map((c) => c[3].verify.audience)).toEqual([
      { kind: 'open' },
      { kind: 'open' },
      { kind: 'open' }
    ])
  })

  it('empty roster is open', async () => {
    h.paged.mockResolvedValue({ members: [], truncated: false })
    await answerInTeams(app, channel, ASKER)
    expect(h.answer.mock.calls[0][3].verify.audience).toEqual({ kind: 'open' })
  })

  it('roster without the asker is open', async () => {
    h.paged.mockResolvedValue(members('oid-kim', 'oid-sam'))
    resolveBy(['oid-asker', 'oid-kim', 'oid-sam'])
    await answerInTeams(app, channel, ASKER)
    expect(h.answer.mock.calls[0][3].verify.audience).toEqual({ kind: 'open' })
  })

  it('a shared or private channel is open', async () => {
    h.paged.mockResolvedValue(members('oid-asker', 'oid-kim'))
    resolveBy(['oid-asker', 'oid-kim'])
    for (const membershipType of ['shared', 'private', undefined]) {
      await answerInTeams(
        app,
        {
          ...channel,
          channelData: {
            ...channel.channelData,
            channel: { id: '19:chan@thread.tacv2', name: 'Ops', membershipType }
          }
        },
        ASKER
      )
    }
    expect(h.answer.mock.calls.map((c) => c[3].verify.audience)).toEqual([
      { kind: 'open' },
      { kind: 'open' },
      { kind: 'open' }
    ])
    // Not even asked for: the team roster says nothing about these channels.
    expect(h.paged).not.toHaveBeenCalled()
  })

  it('private verdict posts the pointer in the thread and the answer in the DM', async () => {
    h.paged.mockResolvedValue(members('oid-asker', 'oid-kim'))
    resolveBy(['oid-asker', 'oid-kim'])
    h.answer.mockResolvedValue({ text: 'Budget is $1.2M.', verdict: 'private', stopped: false })
    await answerInTeams(app, channel, ASKER)

    // No stored 1:1 chat: one is opened with the Teams member id, and stored.
    expect(h.createConv).toHaveBeenCalledWith(
      'https://smba.test/',
      expect.objectContaining({ appId: 'app' }),
      '29:asker'
    )
    expect(h.upsert).toHaveBeenCalledWith(
      'U-ASKER',
      expect.objectContaining({
        aadObjectId: 'oid-asker',
        conversationId: 'a:new-dm',
        serviceUrl: 'https://smba.test/'
      })
    )
    const cards = sentCards()
    const toDm = cards.filter((c) => c.conv === 'a:new-dm')
    const inThread = cards.filter((c) => c.conv === '19:chan@thread.tacv2;messageid=m2')
    expect(toDm).toHaveLength(1)
    expect(cardText(toDm[0].act)).toContain('Budget is $1.2M.')
    expect(cardText(toDm[0].act)).toContain('#Ops in Facilities')
    expect(inThread).toHaveLength(1)
    expect(cardText(inThread[0].act)).toContain('Sent you the answer privately.')
    expect(cardText(inThread[0].act)).not.toContain('1.2M')
    expect(inThread[0].act.replyToId).toBe('m2')
    expect(h.log.mock.calls[0][0]).toMatchObject({
      action: 'teams-ask',
      comment: 'teams channel #Ops in Facilities · asked by asker@example.com · answered privately'
    })
  })

  it('a stored 1:1 chat is used for a private answer', async () => {
    h.link = {
      conversation_id: 'a:stored',
      service_url: 'https://smba.stored/',
      linked_by: 'sign_in'
    }
    h.paged.mockResolvedValue(members('oid-asker', 'oid-kim'))
    resolveBy(['oid-asker', 'oid-kim'])
    h.answer.mockResolvedValue({ text: 'Secret.', verdict: 'private', stopped: false })
    await answerInTeams(app, channel, ASKER)
    expect(h.createConv).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith('https://smba.stored/', 'a:stored', expect.anything())
  })
})

describe('the messages route', () => {
  async function build() {
    const a = Fastify()
    await a.register(teamsBotRoutes, { prefix: '/api/teams' })
    return a
  }

  it('unlinked asker gets Connect, no answer', async () => {
    h.resolve.mockResolvedValue({ user: null, reason: 'not_found' })
    const a = await build()
    const r = await a.inject({
      method: 'POST',
      url: '/api/teams/messages',
      headers: { authorization: 'Bearer t' },
      payload: { ...channel, id: 'unlinked-1' }
    })
    expect(r.statusCode).toBe(200)
    await new Promise((res) => setTimeout(res, 20))
    expect(h.answer).not.toHaveBeenCalled()
    const cards = sentCards()
    expect(cards).toHaveLength(1)
    expect(cardText(cards[0].act)).toContain('Connect to Nivaro')
    expect(cardText(cards[0].act)).toContain('/api/teams/connect?t=SIGNED')
  })
})
