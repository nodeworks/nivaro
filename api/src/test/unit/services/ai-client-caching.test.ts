import { describe, expect, it, vi } from 'vitest'

// Prompt caching marks the STABLE prefix of an AI call — system prompt, tool
// definitions, the conversation so far — with cache_control so a tool loop or
// a chat re-reads it from the provider's cache. These pin the marker
// placement (three markers, under the provider's cap of four), the size gate
// (a short call gets no markers at all), and that a caller's own marker is
// never overwritten.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../config.js', () => ({ config: {} }))
vi.mock('../../settings-overrides.js', () => ({ overlaySettings: async (r: unknown) => r }))

import { withPromptCaching } from '../../../services/ai-client.js'

const EPHEMERAL = { type: 'ephemeral' }
const long = 'x'.repeat(6000) // ≈1,500 tokens, over the size gate

describe('withPromptCaching', () => {
  it('leaves a short call untouched', () => {
    const params = {
      model: 'm',
      max_tokens: 5,
      system: 'short',
      messages: [{ role: 'user' as const, content: 'hi' }]
    }
    expect(withPromptCaching(params)).toBe(params)
  })

  it('marks a string system prompt as one cached block', () => {
    const out = withPromptCaching({
      model: 'm',
      max_tokens: 5,
      system: long,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(out.system).toEqual([{ type: 'text', text: long, cache_control: EPHEMERAL }])
    // one turn = no conversation marker
    expect(out.messages[0].content).toBe('hi')
  })

  it('marks the last system block and the last tool definition', () => {
    const out = withPromptCaching({
      model: 'm',
      max_tokens: 5,
      system: [
        { type: 'text', text: 'a' },
        { type: 'text', text: long }
      ],
      tools: [
        { name: 't1', input_schema: { type: 'object' } },
        { name: 't2', input_schema: { type: 'object' } }
      ],
      messages: [{ role: 'user', content: 'hi' }]
    })
    const sys = out.system as Array<{ cache_control?: unknown }>
    expect(sys[0].cache_control).toBeUndefined()
    expect(sys[1].cache_control).toEqual(EPHEMERAL)
    const tools = out.tools as Array<{ cache_control?: unknown }>
    expect(tools[0].cache_control).toBeUndefined()
    expect(tools[1].cache_control).toEqual(EPHEMERAL)
  })

  it('marks the newest message once a conversation is under way', () => {
    const out = withPromptCaching({
      model: 'm',
      max_tokens: 5,
      system: long,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'r' }] }
      ]
    })
    const last = out.messages[2].content as Array<{ cache_control?: unknown }>
    expect(last[0].cache_control).toEqual(EPHEMERAL)
    // earlier turns untouched
    expect(out.messages[0].content).toBe('q')
  })

  it('keeps a marker the caller already set', () => {
    const mine = { type: 'ephemeral' as const }
    const out = withPromptCaching({
      model: 'm',
      max_tokens: 5,
      system: [{ type: 'text', text: long, cache_control: mine }],
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect((out.system as Array<{ cache_control?: unknown }>)[0].cache_control).toBe(mine)
  })

  it('never emits an empty text block', () => {
    const out = withPromptCaching({
      model: 'm',
      max_tokens: 5,
      system: '',
      messages: [
        { role: 'user', content: long },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: '' }
      ]
    })
    expect(out.system).toBe('')
    expect(out.messages[2].content).toBe('')
  })
})
