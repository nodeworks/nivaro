import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import {
  branchConversation,
  clearVisibilityCache,
  messagesForViewer,
  WITHHELD_META
} from '../../../services/ai-conversations.js'
import { hashToolResult } from '../../../services/ai-result-hash.js'

// Branch + delete must never unblock the earlier-answers chain (#1809).

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001' // owner, wide access
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002' // share recipient
const bob = { id: BOB } as never
const rows = { data: [{ id: 1 }] }

const msg = (
  id: number,
  role: 'user' | 'assistant',
  author: string,
  over: Record<string, unknown> = {}
) => ({
  id,
  conversation_id: 'src',
  role,
  author,
  content: `content-${id}`,
  trace: null as string | null,
  proposals: null,
  meta: null as string | null,
  created_at: new Date(0),
  ...over
})

// A1 used a tool that is never replayable → hidden from Bob, no replay needed.
const SECRET = 'SALARY: Ann 120k, Bo 95k'
const thread = [
  msg(1, 'user', ALICE, { content: 'list salaries' }),
  msg(2, 'assistant', ALICE, {
    content: SECRET,
    trace: JSON.stringify([{ tool: 'propose_action', input: {}, summary: 'x', result_hash: 'h' }]),
    meta: '{"request_id":"r1"}'
  }),
  msg(3, 'user', BOB, { content: 'and my own question' }),
  msg(4, 'assistant', BOB, { content: 'my own answer', trace: '[]' }),
  msg(5, 'user', ALICE, { content: 'put that in a list' })
]

function mockDb(listRows: unknown[]) {
  const inserted: Array<Record<string, unknown>> = []
  ;(db as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['where', 'whereIn', 'orderBy', 'select', 'whereNotNull']) chain[m] = self
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(table === 'nivaro_ai_conversation_messages' ? listRows : []).then(res, rej)
    chain.catch = async () => []
    chain.insert = async (row: Record<string, unknown>) => {
      if (table === 'nivaro_ai_conversation_messages') inserted.push(row)
      return [1]
    }
    chain.update = async () => 1
    chain.first = async () => null
    return chain
  })
  return inserted
}

describe('a share recipient branches a thread', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearVisibilityCache()
  })

  it('copies no hidden content or trace — hidden answers become tombstones', async () => {
    const inserted = mockDb(thread)
    const source = { id: 'src', owner: ALICE, title: 'list salaries' } as never
    const branch = await branchConversation(bob, source, '5', 'put that in a table')
    expect(branch).not.toBeNull()
    expect(inserted).toHaveLength(4) // everything before message 5
    const all = JSON.stringify(inserted)
    expect(all).not.toContain('SALARY')
    expect(all).not.toContain('propose_action')
    const a1 = inserted[1]
    expect(a1).toMatchObject({ role: 'assistant', author: ALICE, content: '', trace: null })
    expect(a1.meta).toBe(WITHHELD_META)
    // What Bob could read is copied as it was.
    expect(inserted[0]).toMatchObject({ content: 'list salaries' })
    expect(inserted[3]).toMatchObject({ author: BOB, content: 'my own answer' })
  })
})

describe('a tombstone stays a hidden turn', () => {
  beforeEach(() => clearVisibilityCache())
  const clean = [{ tool: 'aggregate', input: {}, summary: 'x', result_hash: hashToolResult(rows) }]
  const replay = async () => ({ result: rows })

  it('deleting the hidden answer (→ tombstone) keeps the later quoting answer hidden', async () => {
    const view = await messagesForViewer(
      bob,
      [
        msg(1, 'user', ALICE),
        msg(2, 'assistant', ALICE, { content: '', trace: null, meta: WITHHELD_META }),
        msg(3, 'user', ALICE),
        msg(4, 'assistant', ALICE, {
          content: `as a list: ${SECRET}`,
          trace: JSON.stringify(clean)
        })
      ] as never,
      replay
    )
    expect(view.map((m) => m.visible)).toEqual([true, false, true, false])
    expect(JSON.stringify(view)).not.toContain('SALARY')
  })

  it('a tombstone is hidden even from its own author, and blocks later answers', async () => {
    const alice = { id: ALICE } as never
    const view = await messagesForViewer(
      alice,
      [
        msg(1, 'user', BOB),
        msg(2, 'assistant', ALICE, { content: '', meta: WITHHELD_META }),
        msg(3, 'user', BOB),
        msg(4, 'assistant', BOB, { content: 'x', trace: JSON.stringify(clean) })
      ] as never,
      replay
    )
    expect(view.map((m) => m.visible)).toEqual([true, false, true, false])
  })
})

describe('DELETE /ai/conversations/:id/messages/:mid', () => {
  it('the owner deleting someone else’s message leaves a tombstone; own messages are deleted', async () => {
    vi.resetModules()
    const calls: string[] = []
    const CONV = '11111111-2222-4333-8444-555555555555'
    vi.doMock('../../../middleware/authenticate.js', () => ({
      authenticate: async (req: { user?: unknown }) => {
        req.user = { id: BOB }
      }
    }))
    vi.doMock('../../../services/ai-conversations.js', async (orig) => ({
      ...(await orig<typeof import('../../../services/ai-conversations.js')>()),
      getConversation: vi.fn(async () => ({ id: CONV, owner: BOB })),
      conversationAccess: vi.fn(async () => 'owner'),
      listMessages: vi.fn(async () => [
        msg(2, 'assistant', ALICE, { content: SECRET }),
        msg(4, 'assistant', BOB)
      ]),
      deleteMessage: vi.fn(async (_c: string, m: string) => {
        calls.push(`delete:${m}`)
      }),
      tombstoneMessage: vi.fn(async (_c: string, m: string) => {
        calls.push(`tombstone:${m}`)
      })
    }))
    const { aiConversationRoutes } = await import('../../../routes/ai-conversations.js')
    const a = Fastify()
    await a.register(aiConversationRoutes, { prefix: '/api/ai/conversations' })
    const other = await a.inject({
      method: 'DELETE',
      url: `/api/ai/conversations/${CONV}/messages/2`
    })
    const own = await a.inject({
      method: 'DELETE',
      url: `/api/ai/conversations/${CONV}/messages/4`
    })
    expect(other.json()).toEqual({ data: { deleted: true, withheld: true } })
    expect(own.json()).toEqual({ data: { deleted: true } })
    expect(calls).toEqual(['tombstone:2', 'delete:4'])
  })
})
