import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// ask_human (#3220): only the person asked answers, and only from their own signed-in
// session — never an agent (MCP call, API key, OAuth token, static token, View-as).

vi.mock('../../../middleware/authenticate.js', () => {
  const requireAuth = vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
      authMethod?: string
      mcpInner?: boolean
      apiKeyId?: number
    }) => {
      const who = req.headers['x-test-user'] ?? 'nobody'
      req.user = { id: who, first_name: who, last_name: null, email: `${who}@x.test` }
      req.isAdmin = who === 'admin'
      req.authMethod = req.headers['x-test-auth'] ?? 'session'
      req.mcpInner = req.headers['x-test-inner'] === '1'
      if (req.authMethod === 'api_key') req.apiKeyId = 12
    }
  )
  return { requireAuth, requireAdmin: requireAuth, authenticate: requireAuth }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
const notify = vi.hoisted(() => ({ fn: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: notify.fn }))
vi.mock('../../../services/realtime.js', () => ({ broadcastCollectionUpdate: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))

const RECIPIENT = '11111111-1111-4111-8111-111111111111'
const ASKER = '22222222-2222-4222-8222-222222222222'
const QID = '33333333-3333-4333-8333-333333333333'
const state = vi.hoisted(() => ({
  ran: [] as FakeQuery[],
  question: null as Record<string, unknown> | null,
  openCount: 0
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      state.ran.push(q)
      if (q.sql.includes('nivaro_users')) {
        if (q.method === 'first')
          return { id: RECIPIENT, status: 'active', account_kind: null, first_name: 'Rita' }
        return [{ id: RECIPIENT, first_name: 'Rita', last_name: null, email: null }]
      }
      if (q.method === 'update') return 1
      if (q.method === 'insert') return 1
      if (q.sql.includes('count(*)')) return { n: state.openCount }
      if (q.method === 'first') return state.question ? { ...state.question } : undefined
      return state.question ? [{ ...state.question }] : []
    })
  }
})

const { agentQuestionRoutes } = await import('../../../routes/agent-questions.js')
const { normalizeAsk, effectiveStatus, QuestionError } = await import(
  '../../../services/agent-questions.js'
)

async function buildApp() {
  const app = Fastify()
  await app.register(agentQuestionRoutes, { prefix: '/agent-questions' })
  await app.ready()
  return app
}

const openQuestion = (over: Record<string, unknown> = {}) => ({
  id: QID,
  asker_conn: 'k12',
  asker_name: 'Ops bot',
  asker: ASKER,
  recipient: RECIPIENT,
  question: 'Ship today?',
  choices: '["Yes","No"]',
  allow_text: false,
  collection: null,
  item: null,
  status: 'open',
  answer: null,
  answer_choice: null,
  answered_by: null,
  answered_at: null,
  answer_seen_at: null,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  created_at: new Date().toISOString(),
  updated_at: null,
  ...over
})

beforeEach(() => {
  state.ran.length = 0
  state.question = openQuestion()
  state.openCount = 0
  notify.fn.mockClear()
})

describe('normalizeAsk', () => {
  it('defaults to asking yourself, choices-only unless allow_text, 24 h expiry', () => {
    const a = normalizeAsk({ question: ' Go? ', choices: ['Yes', 'Yes', 'No'] }, ASKER)
    expect(a).toMatchObject({
      to: ASKER,
      question: 'Go?',
      choices: ['Yes', 'No'],
      allowText: false,
      minutes: 1440
    })
    expect(normalizeAsk({ question: 'Why?' }, ASKER).allowText).toBe(true)
  })
  it('refuses bad input', () => {
    expect(() => normalizeAsk({ question: '' }, ASKER)).toThrow(QuestionError)
    expect(() => normalizeAsk({ question: 'x', to: 'bob' }, ASKER)).toThrow(/user id/)
    expect(() => normalizeAsk({ question: 'x', expires_in_minutes: 1 }, ASKER)).toThrow(/5 to/)
    expect(() =>
      normalizeAsk({ question: 'x', collection: 'nivaro_users', item: '1' }, ASKER)
    ).toThrow(/collection/)
    expect(() =>
      normalizeAsk({ question: 'x', choices: Array.from({ length: 11 }, (_, i) => `c${i}`) }, ASKER)
    ).toThrow(/10/)
  })
  it('reads an open question past its expiry as expired', () => {
    expect(effectiveStatus({ status: 'open', expires_at: new Date(Date.now() - 1000) })).toBe(
      'expired'
    )
    expect(effectiveStatus({ status: 'answered', expires_at: new Date(0) })).toBe('answered')
  })
})

describe('POST /agent-questions', () => {
  it('stores the question and notifies the person with an open-My-Work target', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/agent-questions',
      headers: { 'x-test-user': ASKER, 'x-test-auth': 'api_key' },
      payload: { to: RECIPIENT, question: 'Ship today?', choices: ['Yes', 'No'] }
    })
    expect(res.statusCode).toBe(201)
    const insert = state.ran.find((q) => q.method === 'insert')!
    expect(insert.sql).toContain('nivaro_agent_questions')
    expect(insert.bindings).toContain('k12')
    expect(notify.fn).toHaveBeenCalledTimes(1)
    const opts = (
      notify.fn.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>]
    )[2]
    expect(opts).toMatchObject({ category: 'mentions', always_inbox: true })
    expect((opts.target as { focus: string }).focus).toMatch(/^question:.+:choices$/)
    await app.close()
  })

  it('refuses a connection that already has too many open questions', async () => {
    state.openCount = 25
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/agent-questions',
      headers: { 'x-test-user': ASKER, 'x-test-auth': 'api_key' },
      payload: { to: RECIPIENT, question: 'Again?' }
    })
    expect(res.statusCode).toBe(429)
    expect(res.json().code).toBe('TOO_MANY_QUESTIONS')
    await app.close()
  })
})

describe('POST /agent-questions/:id/answer', () => {
  const answer = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    buildApp().then(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: `/agent-questions/${QID}/answer`,
        headers,
        payload
      })
      await app.close()
      return res
    })

  it('refuses every agent credential, even the recipient’s own', async () => {
    for (const auth of ['api_key', 'oauth', 'token', 'masquerade']) {
      const res = await answer({ 'x-test-user': RECIPIENT, 'x-test-auth': auth }, { choice: 'Yes' })
      expect(res.statusCode, auth).toBe(403)
      expect(res.json().code).toBe('HUMAN_ONLY')
    }
    const inner = await answer({ 'x-test-user': RECIPIENT, 'x-test-inner': '1' }, { choice: 'Yes' })
    expect(inner.statusCode).toBe(403)
  })

  it('lets only the recipient answer; the asker is refused, a stranger sees nothing', async () => {
    expect((await answer({ 'x-test-user': ASKER }, { choice: 'Yes' })).statusCode).toBe(403)
    expect((await answer({ 'x-test-user': 'stranger' }, { choice: 'Yes' })).statusCode).toBe(404)
  })

  it('checks the answer against the choices', async () => {
    expect((await answer({ 'x-test-user': RECIPIENT }, { choice: 'Maybe' })).statusCode).toBe(400)
    expect((await answer({ 'x-test-user': RECIPIENT }, { answer: 'free text' })).statusCode).toBe(
      400
    )
    const ok = await answer({ 'x-test-user': RECIPIENT }, { choice: 'Yes' })
    expect(ok.statusCode).toBe(200)
    const update = state.ran.find((q) => q.method === 'update')!
    expect(update.bindings).toContain('answered')
    expect(update.bindings).toContain('Yes')
  })

  it('refuses an expired question', async () => {
    state.question = openQuestion({ expires_at: new Date(Date.now() - 1000).toISOString() })
    const res = await answer({ 'x-test-user': RECIPIENT }, { choice: 'Yes' })
    expect(res.statusCode).toBe(409)
  })
})

describe('GET /agent-questions/:id', () => {
  it('shows the question to its parties only', async () => {
    const app = await buildApp()
    const mine = await app.inject({
      url: `/agent-questions/${QID}`,
      headers: { 'x-test-user': ASKER, 'x-test-auth': 'api_key' }
    })
    expect(mine.statusCode).toBe(200)
    expect(mine.json().data).toMatchObject({ id: QID, status: 'open', choices: ['Yes', 'No'] })
    expect(mine.json().data.connection).toBe('k12')
    const theirs = await app.inject({
      url: `/agent-questions/${QID}`,
      headers: { 'x-test-user': RECIPIENT }
    })
    expect(theirs.json().data.connection).toBeUndefined()
    const stranger = await app.inject({
      url: `/agent-questions/${QID}`,
      headers: { 'x-test-user': 'stranger' }
    })
    expect(stranger.statusCode).toBe(404)
    await app.close()
  })
})
