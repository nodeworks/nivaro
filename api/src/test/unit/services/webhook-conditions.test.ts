import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/ssrf.js', () => ({ assertSafeUrl: vi.fn() }))
vi.mock('../../../services/pipeline-subject.js', () => ({
  resolvePipelineSubject: async (collection: string, itemId: string) => ({ collection, itemId })
}))

const { matchWebhookConditions, parseWebhookConditions } = await import(
  '../../../services/webhook-dispatch.js'
)

describe('webhook conditions', () => {
  it('reads stored JSON and drops what is not a condition', () => {
    expect(
      parseWebhookConditions(
        JSON.stringify([
          { field: 'status', op: 'eq', value: 'open' },
          { field: '', op: 'eq', value: 'x' },
          { field: 'amount', op: 'drop table', value: 1 },
          'nonsense'
        ])
      )
    ).toEqual([{ field: 'status', op: 'eq', value: 'open' }])
    expect(parseWebhookConditions(null)).toEqual([])
    expect(parseWebhookConditions('not json')).toEqual([])
  })

  it('fires for every record when there are no conditions', async () => {
    expect((await matchWebhookConditions([], 'orders', { id: 1 }, 'update')).matches).toBe(true)
  })

  it('needs every condition to hold', async () => {
    const rules = parseWebhookConditions([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'amount', op: 'gte', value: 1000 }
    ])
    const hit = await matchWebhookConditions(
      rules,
      'orders',
      { id: 1, status: 'open', amount: 2500 },
      'update'
    )
    expect(hit.matches).toBe(true)
    const miss = await matchWebhookConditions(
      rules,
      'orders',
      { id: 2, status: 'open', amount: 10 },
      'update'
    )
    expect(miss.matches).toBe(false)
    expect(miss.rules.map((r) => r.pass)).toEqual([true, false])
    expect(miss.rules[1].actual).toBe(10)
  })

  it('reads emptiness and lists', async () => {
    const rules = parseWebhookConditions([
      { field: 'vendor', op: 'nnull' },
      { field: 'region', op: 'in', value: 'east, west' }
    ])
    expect(
      (
        await matchWebhookConditions(
          rules,
          'orders',
          { id: 1, vendor: 4, region: 'west' },
          'create'
        )
      ).matches
    ).toBe(true)
    expect(
      (
        await matchWebhookConditions(
          rules,
          'orders',
          { id: 1, vendor: null, region: 'west' },
          'create'
        )
      ).matches
    ).toBe(false)
  })

  it('judges a deleted record on its snapshot', async () => {
    const rules = parseWebhookConditions([{ field: 'status', op: 'eq', value: 'open' }])
    expect(
      (await matchWebhookConditions(rules, 'orders', { id: 9, status: 'open' }, 'delete')).matches
    ).toBe(true)
  })
})
