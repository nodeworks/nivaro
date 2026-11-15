import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  badgeWatchFor,
  createBadgeBatcher,
  forgetPickerBadgeRules,
  knownNoBadges,
  MAX_IDS
} from './picker-badges'

afterEach(() => forgetPickerBadgeRules())

describe('picker badge batcher', () => {
  it('merges asks from several pickers into one request per collection', async () => {
    const request = vi.fn(async (_c: string, ids: string[]) => ({
      data: Object.fromEntries(
        ids.map((id) => [id, [{ key: 'closed', label: 'Closed', tone: 'neutral' as const }]])
      ),
      meta: { rules: 2, watch: ['is_active', '$state'] }
    }))
    const b = createBadgeBatcher(request, 5)
    const [a, c] = await Promise.all([b.load('vendors', ['1', '2']), b.load('vendors', ['2', '3'])])
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][1].sort()).toEqual(['1', '2', '3'])
    expect(Object.keys(a)).toEqual(['1', '2'])
    expect(Object.keys(c)).toEqual(['2', '3'])
    expect(badgeWatchFor('vendors')).toEqual(['is_active', '$state'])
  })

  it('a collection without rules is not asked again', async () => {
    const request = vi.fn(async () => ({ data: {}, meta: { rules: 0, watch: [] } }))
    const b = createBadgeBatcher(request, 1)
    await b.load('notes', ['1'])
    expect(knownNoBadges('notes')).toBe(true)
    await b.load('notes', ['2'])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('splits more than MAX_IDS into several requests', async () => {
    const request = vi.fn(async () => ({ data: {}, meta: { rules: 1, watch: [] } }))
    const b = createBadgeBatcher(request, 1)
    await b.load(
      'orders',
      Array.from({ length: MAX_IDS + 5 }, (_, i) => String(i))
    )
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('a failed read shows no badges', async () => {
    const b = createBadgeBatcher(async () => {
      throw new Error('500')
    }, 1)
    expect(await b.load('orders', ['1'])).toEqual({})
  })
})
