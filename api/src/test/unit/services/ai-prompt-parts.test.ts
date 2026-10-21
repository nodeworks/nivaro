import { describe, expect, it } from 'vitest'
import {
  applyUsage,
  measureParts,
  parseParts,
  parseStored,
  serializeParts,
  splitSystem,
  sumParts
} from '../../../services/ai-prompt-parts.js'

const system = [
  'You are the data assistant. '.repeat(40),
  "\nHow this instance's data is organised (written by its administrators):\n",
  'Projects are the top level. '.repeat(10),
  '\nGlossary (business terms as this instance defines them):\n',
  'PUB: purchase budget. '.repeat(5),
  '\nReadable collections (3):\nprojects, vendors, invoices',
  '\n\nAnswered before — similar questions and the tool plans that worked.\n1. Q: how many'
].join('')

describe('prompt cost parts (#2731)', () => {
  it('cuts the system prompt at the headings the builders write', () => {
    const parts = splitSystem(system)
    expect(parts.map((p) => p.part)).toEqual([
      'system_rules',
      'data_guide',
      'glossary',
      'catalogues',
      'playbooks'
    ])
    expect(parts.reduce((n, p) => n + p.chars, 0)).toBe(system.length)
  })

  it('keeps a plain prompt as rules only', () => {
    expect(splitSystem('Just do it').map((p) => p.part)).toEqual(['system_rules'])
  })

  it('measures tools, system, history, attachments and the question in provider order', () => {
    const parts = measureParts({
      model: 'm',
      max_tokens: 10,
      system,
      tools: [{ name: 't', description: 'x'.repeat(400), input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 't', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: '1', content: 'rows' },
            { type: 'text', text: 'Documents the person attached to the question.\nabc' }
          ]
        }
      ]
    })
    const names = parts.map((p) => p.part)
    expect(names[0]).toBe('tool_definitions')
    expect(names).toContain('history')
    expect(names).toContain('attachments')
    expect(names.indexOf('system_rules')).toBeLessThan(names.indexOf('history'))
  })

  it('counts an image by its payload, not its encoded text', () => {
    const parts = measureParts({
      model: 'm',
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4000) }
            },
            { type: 'text', text: 'what is this' }
          ]
        }
      ]
    })
    const att = parts.find((p) => p.part === 'attachments')
    expect(att?.tokens).toBe(750)
  })

  it('scales to the real prompt size and marks the cached prefix', () => {
    const est = [
      { part: 'tool_definitions' as const, tokens: 100, cached: 0 },
      { part: 'system_rules' as const, tokens: 300, cached: 0 },
      { part: 'history' as const, tokens: 100, cached: 0 }
    ]
    // provider: 1000 in total (200 uncached + 800 cache read)
    const out = applyUsage(est, { input: 200, cacheRead: 800 })
    expect(out.reduce((n, p) => n + p.tokens, 0)).toBe(1000)
    expect(out[0]).toEqual({ part: 'tool_definitions', tokens: 200, cached: 200 })
    expect(out[1].cached).toBe(600)
    expect(out[2].cached).toBe(0)
  })

  it('treats the gateway prompt_tokens as already including the cached ones', () => {
    const est = [{ part: 'system_rules' as const, tokens: 500, cached: 0 }]
    const out = applyUsage(est, { input: 1000, cacheRead: 600, inputIncludesCache: true })
    expect(out[0]).toEqual({ part: 'system_rules', tokens: 1000, cached: 600 })
  })

  it('keeps the estimate when the provider reported nothing', () => {
    const est = [{ part: 'system_rules' as const, tokens: 123, cached: 0 }]
    expect(applyUsage(est, {})).toEqual(est)
  })

  it('round-trips the stored form, with and without the release', () => {
    const parts = [{ part: 'glossary' as const, tokens: 40, cached: 10 }]
    const raw = serializeParts(parts, '0.2.78')
    expect(parseStored(raw)).toEqual({ version: '0.2.78', parts })
    expect(parseParts(JSON.stringify([['glossary', 4, 1]]))).toEqual([
      { part: 'glossary', tokens: 4, cached: 1 }
    ])
    expect(parseParts('not json')).toEqual([])
    expect(parseParts(JSON.stringify([['bogus', 1, 1]]))).toEqual([])
  })

  it('sums the same part across calls', () => {
    const sum = sumParts([
      [{ part: 'history', tokens: 5, cached: 1 }],
      [{ part: 'history', tokens: 7, cached: 2 }]
    ])
    expect(sum.history).toEqual({ tokens: 12, cached: 3 })
    expect(sum.glossary).toEqual({ tokens: 0, cached: 0 })
  })
})
