import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'

// #2471 — model routing by difficulty: the pure rules + the one-shot path.

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

import { currentAiCallMeta } from '../../../services/ai-call-meta.js'
import { costOf } from '../../../services/ai-log.js'
import { preserveQuality } from '../../../services/ai-quality.js'
import {
  cheapModelFor,
  isValidJsonReply,
  normalizeRouting,
  type RoutingCallRow,
  routedCreate,
  routingSavings,
  saysCannotAnswer
} from '../../../services/ai-routing.js'

const msg = (text: string): Anthropic.Message =>
  ({
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'x',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  }) as unknown as Anthropic.Message

function fakeClient(replies: string[], seen: Array<{ model: string; meta: unknown }>) {
  return {
    messages: {
      create: async (p: { model: string }) => {
        seen.push({ model: p.model, meta: currentAiCallMeta() })
        return msg(replies.shift() ?? '')
      }
    }
  } as unknown as Anthropic
}

describe('routing config', () => {
  it('keeps only known features and a model id', () => {
    expect(normalizeRouting({ features: ['chat', 'nope', 'chat'], cheap_model: ' h ' })).toEqual({
      features: ['chat'],
      cheap_model: 'h'
    })
    expect(normalizeRouting('junk')).toEqual({ features: [], cheap_model: null })
  })
  it('is off unless the feature is on and the cheap model differs from the main one', () => {
    const r = { features: ['chat'], cheap_model: 'small' }
    expect(cheapModelFor(r, 'chat', 'big')).toBe('small')
    expect(cheapModelFor(r, 'review', 'big')).toBeNull()
    expect(cheapModelFor(r, 'chat', 'small')).toBeNull()
    expect(cheapModelFor(null, 'chat', 'big')).toBeNull()
  })
})

describe('escalation signals', () => {
  it('spots a model that says it cannot answer', () => {
    expect(saysCannotAnswer("I can't answer that from the data I can see.")).toBe(true)
    expect(saysCannotAnswer("I don't have enough information to say.")).toBe(true)
    expect(saysCannotAnswer('I could not determine which zone you mean.')).toBe(true)
    expect(saysCannotAnswer('I couldn’t find the data for that.')).toBe(true)
    // none found is an answer
    expect(saysCannotAnswer('I could not find any open requests for that vendor.')).toBe(false)
    expect(saysCannotAnswer('')).toBe(true)
    expect(saysCannotAnswer('There are **42** open requests, most in Zone 3.')).toBe(false)
  })
  it('only reads the opening of a long answer', () => {
    const long = `There are 12 overdue invoices.${' Detail.'.repeat(80)} I could not find the PO for one.`
    expect(saysCannotAnswer(long)).toBe(false)
  })
  it('checks JSON where JSON is expected', () => {
    expect(isValidJsonReply('Here: [{"a":1}]', 'array')).toBe(true)
    expect(isValidJsonReply('[]', 'array')).toBe(true)
    expect(isValidJsonReply('Looks fine to me.', 'array')).toBe(false)
    expect(isValidJsonReply('[{"a":1},]', 'array')).toBe(false)
    expect(isValidJsonReply('{"ok":true}', 'object')).toBe(true)
  })
})

describe('routedCreate', () => {
  const params = { max_tokens: 10, messages: [{ role: 'user' as const, content: 'q' }] }

  it('is the plain main call without routing', async () => {
    const seen: Array<{ model: string; meta: unknown }> = []
    const r = await routedCreate({
      main: { client: fakeClient(['[]'], seen), model: 'big' },
      cheap: null,
      params
    })
    expect(r.routing).toBeNull()
    expect(seen).toEqual([{ model: 'big', meta: null }])
  })

  it('keeps a good cheap reply and tags the call', async () => {
    const seen: Array<{ model: string; meta: unknown }> = []
    const r = await routedCreate({
      main: { client: fakeClient([], seen), model: 'big' },
      cheap: { client: fakeClient(['[{"message":"x"}]'], seen), model: 'small' },
      params,
      expectJson: 'array'
    })
    expect(r.routing).toEqual({ tier: 'cheap', model: 'small' })
    expect(seen).toHaveLength(1)
    expect(seen[0].meta).toEqual({
      routing: { tier: 'cheap', main_model: 'big', cheap_model: 'small' }
    })
  })

  it('moves up when the reply is not the JSON asked for', async () => {
    const seen: Array<{ model: string; meta: unknown }> = []
    const r = await routedCreate({
      main: { client: fakeClient(['[]'], seen), model: 'big' },
      cheap: { client: fakeClient(['All good!'], seen), model: 'small' },
      params,
      expectJson: 'array'
    })
    expect(r.routing).toEqual({ tier: 'main', model: 'big', reason: 'invalid_json' })
    expect(seen.map((s) => s.model)).toEqual(['small', 'big'])
    expect((seen[1].meta as { routing: { rerun: boolean } }).routing.rerun).toBe(true)
  })

  it('moves up when the small model cannot answer', async () => {
    const seen: Array<{ model: string; meta: unknown }> = []
    const r = await routedCreate({
      main: { client: fakeClient(['A summary.'], seen), model: 'big' },
      cheap: { client: fakeClient(["I'm unable to summarize this."], seen), model: 'small' },
      params
    })
    expect(r.routing?.reason).toBe('cannot_answer')
  })

  it('"Try harder" goes straight to the main model', async () => {
    const seen: Array<{ model: string; meta: unknown }> = []
    await routedCreate({
      main: { client: fakeClient(['ok'], seen), model: 'big' },
      cheap: { client: fakeClient(['x'], seen), model: 'small' },
      params,
      tryHarder: { retryOf: 'req-1' }
    })
    expect(seen.map((s) => s.model)).toEqual(['big'])
    expect((seen[0].meta as { routing: unknown }).routing).toMatchObject({
      tier: 'main',
      reason: 'try_harder',
      retry_of: 'req-1'
    })
  })
})

describe('routingSavings', () => {
  const MAIN = 'claude-sonnet-4-5'
  const CHEAP = 'claude-haiku-4-5'
  const row = (
    request_id: string,
    tier: 'cheap' | 'main',
    extra: Record<string, unknown> = {}
  ): RoutingCallRow => {
    const model = tier === 'cheap' ? CHEAP : MAIN
    const usage = { input: 10_000, cached: 0, output: 500 }
    return {
      request_id,
      model,
      cost_usd: costOf(model, usage),
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: 0,
      meta: JSON.stringify({
        routing: { tier, main_model: MAIN, cheap_model: CHEAP, ...extra }
      })
    }
  }
  const cheapCost = costOf(CHEAP, { input: 10_000, output: 500 }) as number
  const mainCost = costOf(MAIN, { input: 10_000, output: 500 }) as number

  it('counts what an answer by the small model saved', () => {
    const s = routingSavings([row('a', 'cheap'), row('a', 'cheap')])
    expect(s.routed).toBe(1)
    expect(s.answered_cheap).toBe(1)
    expect(s.saved_usd).toBeCloseTo(2 * (mainCost - cheapCost), 6)
  })

  it('a rerun throws the cheap calls away', () => {
    const s = routingSavings([
      row('b', 'cheap'),
      row('b', 'main', { reason: 'cannot_answer', rerun: true })
    ])
    expect(s.escalated).toEqual({ cannot_answer: 1 })
    expect(s.saved_usd).toBeCloseTo(-cheapCost, 6)
    expect(s.main_cost_usd).toBeCloseTo(mainCost, 6)
  })

  it('a mid-answer move up keeps the cheap rounds it used', () => {
    const s = routingSavings([row('c', 'cheap'), row('c', 'main', { reason: 'tool_error' })])
    expect(s.escalated).toEqual({ tool_error: 1 })
    expect(s.saved_usd).toBeCloseTo(mainCost - cheapCost, 6)
  })

  it('"Try harder" makes the quick answer it replaced a loss', () => {
    const s = routingSavings([
      row('d', 'cheap'),
      row('e', 'main', { reason: 'try_harder', retry_of: 'd' })
    ])
    expect(s.try_harder).toBe(1)
    expect(s.saved_usd).toBeCloseTo(-cheapCost, 6)
  })

  it('ignores calls that were not routed', () => {
    expect(
      routingSavings([{ ...row('f', 'cheap'), meta: '{"tool_payload":{}}' }]).cheap_calls
    ).toBe(0)
  })
})

describe('preserveQuality (Settings save keeps the hidden blocks)', () => {
  const stored = JSON.stringify({ chat: 'a', _quality: { routing: { features: ['chat'] } } })
  it('keeps _quality when the page saves a model map', () => {
    expect(JSON.parse(preserveQuality(JSON.stringify({ chat: 'b' }), stored) as string)).toEqual({
      chat: 'b',
      _quality: { routing: { features: ['chat'] } }
    })
  })
  it('keeps _quality when the map is cleared', () => {
    expect(JSON.parse(preserveQuality(null, stored) as string)).toEqual({
      _quality: { routing: { features: ['chat'] } }
    })
    expect(preserveQuality(null, null)).toBeNull()
  })
})
