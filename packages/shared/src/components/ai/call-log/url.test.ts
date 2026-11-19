import { describe, expect, it } from 'vitest'
import { bucketRange, pctOf, resultLabel, resultOf, usd } from './format'
import { activeChips, apiFilter, clearFilters, toggleIn } from './url'

describe('call-log url state', () => {
  it('turns the window into hours, keeps a custom range, passes the filters', () => {
    expect(apiFilter(new URLSearchParams('window=24h&feature=chat')).toString()).toBe(
      'hours=24&feature=chat'
    )
    expect(apiFilter(new URLSearchParams('')).get('hours')).toBe('168')
    const custom = apiFilter(
      new URLSearchParams('window=custom&from=2026-11-01T00:00:00.000Z&to=2026-11-02T00:00:00.000Z')
    )
    expect(custom.get('hours')).toBeNull()
    expect(custom.get('from')).toBe('2026-11-01T00:00:00.000Z')
    // Open call, sort and page are not filters.
    expect(apiFilter(new URLSearchParams('call=3&sort=-cost&page=2')).toString()).toBe('hours=168')
  })

  it('toggles one value of a list and goes back to page 1', () => {
    const p = new URLSearchParams('feature=chat&page=3')
    toggleIn(p, 'feature', 'brief')
    expect(p.get('feature')).toBe('chat,brief')
    expect(p.get('page')).toBeNull()
    toggleIn(p, 'feature', 'chat')
    toggleIn(p, 'feature', 'brief')
    expect(p.has('feature')).toBe(false)
  })

  it('names every filter that is on as a removable chip', () => {
    const p = new URLSearchParams(
      'feature=chat&user=u1,system&q=invoices&cost_min=0.1&feedback=down'
    )
    const chips = activeChips(p, { people: new Map([['u1', 'Pat Lee']]) })
    expect(chips.map((c) => c.label)).toEqual([
      'Ask AI',
      'Pat Lee',
      'System',
      '“invoices”',
      'thumbs down',
      'cost ≥ $0.1'
    ])
    chips.find((c) => c.label === 'Pat Lee')?.clear(p)
    expect(p.get('user')).toBe('system')
    clearFilters(p)
    expect(p.toString()).toBe('')
  })
})

describe('call-log formatting', () => {
  it('money, results and buckets', () => {
    expect(usd(0.00003)).toBe('<$0.0001')
    expect(usd(0.0151)).toBe('$0.0151')
    expect(usd(12.5)).toBe('$12.50')
    expect(resultOf({ status: 'error', stop_reason: 'end_turn' })).toBe('error')
    expect(resultLabel('max_tokens')).toBe('Hit the length limit')
    expect(pctOf(1, 200)).toBe('0.5%')
    expect(bucketRange('2026-11-18T05', 'hour')).toEqual({
      from: '2026-11-18T05:00:00.000Z',
      to: '2026-11-18T06:00:00.000Z'
    })
  })
})
