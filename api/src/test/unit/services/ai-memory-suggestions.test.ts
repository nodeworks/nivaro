import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1845 memory suggestions + #1897 admin clear — the service side.

const store = vi.hoisted(() => ({
  users: new Map<string, { id: string; preferences: string | null }>(),
  updates: [] as Array<{ id: string; preferences: string }>
}))

vi.mock('../../../db/index.js', () => ({
  db: (_table: string) => {
    let id = ''
    const b = {
      where: (w: { id: string }) => {
        id = w.id
        return b
      },
      first: async () => store.users.get(id),
      update: async (patch: { preferences: string }) => {
        store.updates.push({ id, preferences: patch.preferences })
        const row = store.users.get(id)
        if (row) row.preferences = patch.preferences
        return 1
      }
    }
    return b
  }
}))

// The loop's data tools are not under test — a stub set keeps ai-chat's
// imports (items, permissions, …) out of this file.
const executed = vi.hoisted(() => ({ tools: [] as string[] }))
vi.mock('../../../services/ai-chat.js', () => ({
  CHAT_TOOLS: [{ name: 'query_items', description: 'q', input_schema: { type: 'object' } }],
  MAX_ROUNDS: 12,
  buildWrapUpMessages: () => [],
  executeChatTool: async (_u: unknown, tool: string) => {
    executed.tools.push(tool)
    return { result: { data: [{ id: 1 }] }, summary: '1 row(s)' }
  }
}))

import { runChatLoop } from '../../../services/ai-chat-loop.js'
import {
  AI_MEMORY_MAX_NOTES,
  type AiMemoryNote,
  addSuggestedNote,
  forgetMemory,
  offerMemorySuggestion,
  SUGGEST_MEMORY_TOOL_NAME,
  suggestionsFrom
} from '../../../services/ai-memory.js'

const ASKER = 'aaaaaaaa-0000-4000-8000-000000000001'
const note = (text: string, id = text): AiMemoryNote => ({
  id,
  text,
  at: '2026-10-01T00:00:00.000Z'
})

function seed(id: string, notes: AiMemoryNote[] | null, extra: Record<string, unknown> = {}) {
  store.users.set(id, {
    id,
    preferences: JSON.stringify(notes ? { ...extra, ai_memory: notes } : extra)
  })
}

beforeEach(() => {
  store.users.clear()
  store.updates.length = 0
  executed.tools.length = 0
})

describe('offerMemorySuggestion (#1845)', () => {
  it('offers a cleaned note and tells the model nothing was saved', () => {
    const r = offerMemorySuggestion({ text: '  By my zone I mean\nZone 3. ' }, [], [])
    expect(r.suggestion).toEqual({ text: 'By my zone I mean Zone 3' })
    expect(r.reply).toMatch(/Nothing is saved unless they click/)
  })

  it('skips empty, too long, already-remembered, repeated and full', () => {
    expect(offerMemorySuggestion({ text: ' ' }, [], []).suggestion).toBeNull()
    expect(offerMemorySuggestion({ text: 'x'.repeat(301) }, [], []).suggestion).toBeNull()
    expect(
      offerMemorySuggestion({ text: 'amounts in THOUSANDS' }, [note('Amounts in thousands')], [])
        .suggestion
    ).toBeNull()
    expect(
      offerMemorySuggestion({ text: 'Zone 3' }, [], [{ text: 'zone 3' }]).suggestion
    ).toBeNull()
    expect(
      offerMemorySuggestion({ text: 'c' }, [], [{ text: 'a' }, { text: 'b' }]).suggestion
    ).toBeNull()
    const full = Array.from({ length: AI_MEMORY_MAX_NOTES }, (_, i) => note(`n${i}`))
    expect(offerMemorySuggestion({ text: 'new' }, full, []).suggestion).toBeNull()
  })

  it('suggestionsFrom keeps at most two clean offers', () => {
    expect(
      suggestionsFrom([{ text: ' a ' }, { text: '' }, null, { text: 'b' }, { text: 'c' }])
    ).toEqual([{ text: 'a' }])
    expect(suggestionsFrom([{ text: 'a' }, { text: 'b' }, { text: 'c' }])).toHaveLength(2)
    expect(suggestionsFrom('nope')).toEqual([])
  })
})

function fakeClient(rounds: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ tools: Array<{ name: string }> }> = []
  let i = 0
  return {
    calls,
    client: {
      messages: {
        create: async (params: { tools: Array<{ name: string }> }) => {
          calls.push({ tools: params.tools })
          const content = rounds[i++] ?? [{ type: 'text', text: 'done' }]
          return {
            content,
            stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
          }
        }
      }
    } as never
  }
}

describe('runChatLoop + suggest_memory (#1845)', () => {
  const rounds = () => [
    [
      { type: 'tool_use', id: 't1', name: 'query_items', input: { collection: 'zones' } },
      {
        type: 'tool_use',
        id: 't2',
        name: SUGGEST_MEMORY_TOOL_NAME,
        input: { text: 'By my zone I mean Zone 3' }
      }
    ],
    [{ type: 'text', text: 'Zone 3 has 4 open requests.' }]
  ]

  it('collects the offer, keeps it out of the trace, and SAVES NOTHING', async () => {
    seed(ASKER, null)
    const { client, calls } = fakeClient(rounds())
    const r = await runChatLoop({
      client,
      model: 'm',
      system: 's',
      user: { id: ASKER } as never,
      convo: [{ role: 'user', content: 'how many open in my zone?' }],
      memorySuggestions: { existing: [] }
    })
    expect(r.text).toBe('Zone 3 has 4 open requests.')
    expect(r.memorySuggestions).toEqual([{ text: 'By my zone I mean Zone 3' }])
    expect(r.trace.map((t) => t.tool)).toEqual(['query_items'])
    expect(executed.tools).toEqual(['query_items'])
    expect(calls[0].tools.map((t) => t.name)).toContain(SUGGEST_MEMORY_TOOL_NAME)
    // The suggestion alone never writes the person's preferences.
    expect(store.updates).toEqual([])
  })

  it('without the opt-in the tool is not offered to the model at all', async () => {
    const { client, calls } = fakeClient([[{ type: 'text', text: 'hi' }]])
    const r = await runChatLoop({
      client,
      model: 'm',
      system: 's',
      user: { id: ASKER } as never,
      convo: [{ role: 'user', content: 'hi' }]
    })
    expect(calls[0].tools.map((t) => t.name)).not.toContain(SUGGEST_MEMORY_TOOL_NAME)
    expect(r.memorySuggestions).toEqual([])
  })
})

describe('addSuggestedNote — the click (#1845)', () => {
  it('writes the caller’s own notes, keeping their other preferences', async () => {
    seed(ASKER, [note('a')], { theme: 'dark' })
    const r = await addSuggestedNote(ASKER, 'By my zone I mean Zone 3')
    expect('note' in r && r.duplicate).toBe(false)
    expect(store.updates).toHaveLength(1)
    expect(store.updates[0].id).toBe(ASKER)
    const prefs = JSON.parse(store.updates[0].preferences)
    expect(prefs.theme).toBe('dark')
    expect(prefs.ai_memory.map((n: AiMemoryNote) => n.text)).toEqual([
      'a',
      'By my zone I mean Zone 3'
    ])
  })

  it('a duplicate is not written twice; a full list is refused, never trimmed', async () => {
    seed(ASKER, [note('Zone 3')])
    const dup = await addSuggestedNote(ASKER, 'zone 3')
    expect('note' in dup && dup.duplicate).toBe(true)
    seed(
      ASKER,
      Array.from({ length: AI_MEMORY_MAX_NOTES }, (_, i) => note(`n${i}`))
    )
    const full = await addSuggestedNote(ASKER, 'one more')
    expect(full).toMatchObject({ status: 409 })
    expect(await addSuggestedNote(ASKER, '   ')).toMatchObject({ status: 400 })
    expect(store.updates).toEqual([])
  })
})

describe('forgetMemory — the admin clear (#1897)', () => {
  const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'

  it('removes one note, then all, and only removes', async () => {
    seed(OTHER, [note('a', 'n1'), note('b', 'n2')], { theme: 'dark' })
    expect(await forgetMemory(OTHER, 'n1')).toEqual({ removed: 1, remaining: 1 })
    expect(JSON.parse(store.users.get(OTHER)!.preferences!).ai_memory).toEqual([note('b', 'n2')])
    expect(await forgetMemory(OTHER, 'nope')).toEqual({ removed: 0, remaining: 1 })
    expect(await forgetMemory(OTHER)).toEqual({ removed: 1, remaining: 0 })
    const prefs = JSON.parse(store.users.get(OTHER)!.preferences!)
    expect(prefs).toEqual({ theme: 'dark' })
  })

  it('no such account → null', async () => {
    expect(await forgetMemory('cccccccc-0000-4000-8000-000000000003')).toBeNull()
  })
})
