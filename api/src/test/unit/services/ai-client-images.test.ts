import { describe, expect, it, vi } from 'vitest'

// The OpenAI-compatible gateway wire (#2669): a base64 picture on a user turn
// rides as an image_url part with a data URL instead of being dropped.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../config.js', () => ({ config: {} }))
vi.mock('../../settings-overrides.js', () => ({ overlaySettings: async (r: unknown) => r }))

import { toOpenAi } from '../../../services/ai-client.js'

describe('toOpenAi images', () => {
  it('sends a user picture as an image_url part after the text', () => {
    const body = toOpenAi(
      {
        model: 'm',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
              { type: 'text', text: 'Rebuild this form' }
            ]
          }
        ]
      },
      'gw-model'
    ) as { messages: Array<{ role: string; content: unknown }> }
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Rebuild this form' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }
        ]
      }
    ])
  })

  it('keeps plain text turns as strings', () => {
    const body = toOpenAi(
      {
        model: 'm',
        max_tokens: 10,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
      },
      'gw-model'
    ) as { messages: Array<{ role: string; content: unknown }> }
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})
