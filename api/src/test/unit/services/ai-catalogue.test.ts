import { describe, expect, it } from 'vitest'
import {
  configuredModelIds,
  idsFromListBody,
  looksLikeChatModel
} from '../../../services/ai-catalogue.js'
import { DEFAULT_QUALITY } from '../../../services/ai-quality.js'

describe('model catalogue watch (#2732)', () => {
  it('reads ids from an OpenAI-shaped, Anthropic-shaped or bare list', () => {
    expect(idsFromListBody({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] })).toEqual(['a', 'b'])
    expect(idsFromListBody(['x', { id: 'y' }, 3, {}])).toEqual(['x', 'y'])
    expect(idsFromListBody({ error: 'no' })).toEqual([])
  })

  it('leaves embedding and audio models out of the automatic trial', () => {
    expect(looksLikeChatModel('claude-5-sonnet')).toBe(true)
    expect(looksLikeChatModel('text-embedding-3-large')).toBe(false)
    expect(looksLikeChatModel('whisper-2')).toBe(false)
  })

  it('collects every id the settings name', () => {
    const ids = configuredModelIds(
      {
        ai_model: 'm-default',
        ai_models: JSON.stringify({ chat: 'm-chat', default: 'm-default' }),
        ai_gateway_model: 'm-gw'
      },
      {
        ...DEFAULT_QUALITY,
        fallback_model: 'm-fb',
        budgets: {
          enabled: true,
          caps: [
            {
              id: '1',
              who: 'everyone',
              who_id: null,
              feature: null,
              pooled: false,
              daily_usd: 1,
              cheaper_model: 'm-cheap'
            }
          ]
        }
      }
    )
    expect(new Set(ids)).toEqual(new Set(['m-default', 'm-chat', 'm-gw', 'm-fb', 'm-cheap']))
  })
})

describe('catalogue rows (#2732)', () => {
  it('treats the first check as the starting list, then reports new and retired ids', async () => {
    const { vi } = await import('vitest')
    const store = new Map<string, { status: string }>()
    const table = () => {
      let id: string | null = null
      const chain: Record<string, unknown> = {
        select: async () => [...store].map(([model_id, v]) => ({ model_id, status: v.status })),
        insert: async (row: { model_id: string; status: string }) => {
          store.set(row.model_id, { status: row.status })
        },
        where: (w: { model_id: string }) => {
          id = w.model_id
          return chain
        },
        update: async (patch: { status?: string }) => {
          const cur = store.get(id as string)
          if (cur && patch.status) cur.status = patch.status
        }
      }
      return chain
    }
    vi.resetModules()
    vi.doMock('../../../db/index.js', () => ({ db: () => table() }))
    const { recordCatalogue } = await import('../../../services/ai-catalogue.js')
    const now = new Date()
    const first = await recordCatalogue(
      new Map([
        ['a', true],
        ['b', true]
      ]),
      'list',
      now,
      { fullList: true }
    )
    expect(first).toEqual({ newIds: [], retiredIds: [], baseline: true })
    const second = await recordCatalogue(
      new Map([
        ['a', true],
        ['c', true]
      ]),
      'list',
      now,
      { fullList: true }
    )
    expect(second.newIds).toEqual(['c'])
    expect(second.retiredIds).toEqual(['b'])
    expect(store.get('b')?.status).toBe('retired')
    vi.doUnmock('../../../db/index.js')
  })
})
