import { describe, expect, it } from 'vitest'
import { parseAiModels, withModelFallback } from '../../../services/ai-client.js'

describe('parseAiModels (#754)', () => {
  it('reads the map and folds the legacy columns in as fallbacks', () => {
    expect(
      parseAiModels({
        ai_models: JSON.stringify({
          chat: 'claude-4-6-sonnet',
          embed: 'text-embedding-3-large',
          junk: 'x'
        }),
        ai_gateway_model: 'claude-4-5-haiku',
        ai_gateway_chat_model: 'old-chat',
        ai_gateway_extract_model: 'old-extract'
      })
    ).toEqual({
      chat: 'claude-4-6-sonnet',
      embed: 'text-embedding-3-large',
      default: 'claude-4-5-haiku',
      extract: 'old-extract'
    })
  })
  it('tolerates a broken map', () => {
    expect(parseAiModels({ ai_models: '{not json', ai_gateway_model: 'm' })).toEqual({
      default: 'm'
    })
  })
})

describe('withModelFallback (#761)', () => {
  const clientRefusing = (msg: string) =>
    ({ messages: { create: async () => Promise.reject(new Error(msg)) } }) as never
  const clientAnswering = (model: string) =>
    ({ messages: { create: async () => ({ model, content: [] }) } }) as never

  it('falls through a refused model id to the next in the chain', async () => {
    const built: string[] = []
    const client = withModelFallback(['retired-model', 'claude-4-6-sonnet'], (m) => {
      built.push(m)
      return m === 'retired-model'
        ? clientRefusing('AI gateway 404: model retired-model not found')
        : clientAnswering(m)
    })
    const res = await client.messages.create({ model: 'x', max_tokens: 1, messages: [] })
    expect(res.model).toBe('claude-4-6-sonnet')
    expect(built).toEqual(['retired-model', 'claude-4-6-sonnet'])
  })

  it('never retries a refusal that is not about the model', async () => {
    const built: string[] = []
    const client = withModelFallback(['a', 'b'], (m) => {
      built.push(m)
      return clientRefusing('AI gateway 500: upstream timeout')
    })
    await expect(
      client.messages.create({ model: 'x', max_tokens: 1, messages: [] })
    ).rejects.toThrow(/500/)
    expect(built).toEqual(['a'])
  })
})
