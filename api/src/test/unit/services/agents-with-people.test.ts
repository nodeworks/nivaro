import { describe, expect, it, vi } from 'vitest'

// #3210 / #3220 / #3223 — the small rules around agents: the notification's inline Answer,
// live-session question URIs, what a connected app may not write, and who may hand a task
// to which agent.

const keys = vi.hoisted(() => ({
  rows: new Map<number, Record<string, unknown>>(),
  users: new Map<string, string>()
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      if (q.sql.includes('nivaro_api_keys')) return keys.rows.get(Number(q.bindings.at(-1)))
      if (q.sql.includes('nivaro_users')) {
        if (q.method === 'first') {
          const status = keys.users.get(String(q.bindings.at(-1)))
          return status ? { status } : undefined
        }
        return [...keys.users.keys()].map((id) => ({ id, first_name: id, last_name: null }))
      }
      return []
    })
  }
})
vi.mock('../../../services/oauth-store.js', () => ({
  getGrant: vi.fn(async () => null),
  listGrants: vi.fn(async () => []),
  listAllGrants: vi.fn(async () => [])
}))

const { actionsFor } = await import('../../../services/notification-target.js')
const { recordKeyOf, subscribedTargetOf } = await import('../../../services/mcp-sessions.js')
const { oauthAudienceRefusal } = await import('../../../services/mcp-config.js')
const { resolveTaskAgent, agentLabel } = await import('../../../services/task-agents.js')

const QID = '33333333-3333-4333-8333-333333333333'

describe('question notifications', () => {
  it('offer an inline Answer for a free-text question, none for choices-only', () => {
    const text = actionsFor({ kind: 'my_work', focus: `question:${QID}` })
    expect(text).toEqual([
      expect.objectContaining({
        key: 'reply',
        label: 'Answer',
        endpoint: `/agent-questions/${QID}/answer`,
        input: expect.objectContaining({ field: 'answer' })
      })
    ])
    expect(actionsFor({ kind: 'my_work', focus: `question:${QID}:choices` })).toEqual([])
    expect(actionsFor({ kind: 'my_work' })).toEqual([])
  })
})

describe('live-session question URIs', () => {
  it('follow the questions table, case-insensitively', () => {
    expect(subscribedTargetOf(`nivaro://question/${QID.toUpperCase()}`)).toEqual({
      collection: 'nivaro_agent_questions',
      id: QID
    })
    expect(recordKeyOf(`nivaro://question/${QID}`)?.key).toBe(`nivaro_agent_questions\u0000${QID}`)
    expect(recordKeyOf('nivaro://record/orders/7')?.collection).toBe('orders')
    expect(subscribedTargetOf('nivaro://question/nope')).toBeNull()
  })
})

describe('connected apps', () => {
  const req = (method: string, url: string) =>
    ({ method, url, mcpInner: true }) as unknown as Parameters<typeof oauthAudienceRefusal>[0]
  it('never change agent triggers or answer questions; may ask and read', () => {
    expect(oauthAudienceRefusal(req('POST', '/api/agent-triggers'))).toMatch(/cannot use/)
    expect(oauthAudienceRefusal(req('PATCH', '/api/agent-triggers/3'))).toMatch(/cannot use/)
    expect(oauthAudienceRefusal(req('POST', `/api/agent-questions/${QID}/answer`))).toMatch(
      /cannot use/
    )
    expect(oauthAudienceRefusal(req('POST', '/api/agent-questions'))).toBeNull()
    expect(oauthAudienceRefusal(req('GET', `/api/agent-questions/${QID}`))).toBeNull()
    expect(oauthAudienceRefusal(req('POST', `/api/agent-questions/${QID}/cancel`))).toBeNull()
  })
})

describe('resolveTaskAgent', () => {
  it('lets a person use their own agents, an admin anyone’s', async () => {
    keys.rows.set(12, { id: 12, name: 'Ops bot', user: 'ROB', expires_at: null, is_active: true })
    keys.users.set('ROB', 'active')
    const own = await resolveTaskAgent(null, 'k12', { id: 'rob', isAdmin: false })
    expect(own).toMatchObject({ conn: 'k12', kind: 'api_key', name: 'Ops bot', user_id: 'ROB' })
    expect(agentLabel(own)).toBe("Ops bot (ROB's agent)")
    await expect(resolveTaskAgent(null, 'k12', { id: 'kim', isAdmin: false })).rejects.toThrow(
      /your own/
    )
    await expect(resolveTaskAgent(null, 'k12', { id: 'kim', isAdmin: true })).resolves.toBeTruthy()
  })
  it('refuses expired keys, bad keys and agents of inactive people', async () => {
    keys.rows.set(13, {
      id: 13,
      name: 'Old',
      user: 'ROB',
      expires_at: new Date(Date.now() - 1000),
      is_active: true
    })
    await expect(resolveTaskAgent(null, 'k13', { id: 'ROB', isAdmin: true })).rejects.toThrow(
      /does not exist/
    )
    await expect(resolveTaskAgent(null, 'x1', { id: 'ROB', isAdmin: true })).rejects.toThrow(
      /connection key/
    )
    keys.rows.set(14, { id: 14, name: 'Bot', user: 'GONE', expires_at: null, is_active: true })
    keys.users.set('GONE', 'suspended')
    await expect(resolveTaskAgent(null, 'k14', { id: 'x', isAdmin: true })).rejects.toThrow(
      /not active/
    )
  })
})
