import { describe, expect, it, vi } from 'vitest'

// The OpenAI-compatible gateway wire (#2669): a base64 picture on a user turn
// rides as an image_url part with a data URL instead of being dropped; a
// gateway model that refuses pictures gets one retry without them (or, for a
// call that needs them, a clear error).

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../config.js', () => ({ config: {} }))
vi.mock('../../settings-overrides.js', () => ({ overlaySettings: async (r: unknown) => r }))

import {
  AiImagesUnsupportedError,
  GatewayHttpError,
  IMAGES_REQUIRED,
  imageFallbacksSinceBoot,
  isImageRefusal,
  toOpenAi,
  withImageFallback
} from '../../../services/ai-client.js'

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

describe('gateway image fallback', () => {
  const withPicture = {
    model: 'm',
    max_tokens: 10,
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'QUJD' }
          },
          { type: 'text' as const, text: 'Read this' }
        ]
      }
    ]
  }

  it('retries once without the pictures when the gateway refuses image parts, logging once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = imageFallbacksSinceBoot()
    const run = vi.fn(async (images: boolean) => {
      if (images) throw new GatewayHttpError(400, 'Image input is not supported by this model')
      return 'ok'
    })
    expect(await withImageFallback(withPicture, run)).toBe('ok')
    expect(run.mock.calls.map((c) => c[0])).toEqual([true, false])
    expect(await withImageFallback(withPicture, run)).toBe('ok')
    expect(imageFallbacksSinceBoot() - before).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    // the retry body carries the old text form
    const body = toOpenAi(withPicture, 'gw', false, { images: false }) as {
      messages: Array<{ content: unknown }>
    }
    expect(body.messages[0].content).toBe('[image omitted]\nRead this')
    warn.mockRestore()
  })

  it('fails with a clear message when the call requires its pictures', async () => {
    const run = vi.fn(async () => {
      throw new GatewayHttpError(422, 'unsupported content type image_url')
    })
    await expect(
      withImageFallback({ ...withPicture, [IMAGES_REQUIRED]: true } as never, run)
    ).rejects.toBeInstanceOf(AiImagesUnsupportedError)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('leaves other refusals and calls without pictures alone', async () => {
    const other = vi.fn(async () => {
      throw new GatewayHttpError(400, 'max_tokens too large')
    })
    await expect(withImageFallback(withPicture, other)).rejects.toThrow('AI gateway 400')
    expect(other).toHaveBeenCalledTimes(1)
    const plain = vi.fn(async () => {
      throw new GatewayHttpError(400, 'image refused')
    })
    await expect(
      withImageFallback(
        { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] },
        plain
      )
    ).rejects.toThrow('AI gateway 400')
    expect(plain).toHaveBeenCalledTimes(1)
    expect(isImageRefusal(500, 'image')).toBe(false)
  })
})
