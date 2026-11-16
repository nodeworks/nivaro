import { describe, expect, it } from 'vitest'
import {
  activeFilterCount,
  bulkResultLine,
  defaultFilters,
  initialsOf,
  listParams,
  readFilters,
  shortAgo,
  writeFilters
} from './support-list'

const memory = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v)
  }
}

describe('support list filters', () => {
  it('desk defaults to needs attention, mine to recently updated', () => {
    expect(defaultFilters('desk').sort).toBe('attention')
    expect(defaultFilters('mine').sort).toBe('updated')
  })

  it('builds the query; the assignee filter only on the desk', () => {
    const f = { ...defaultFilters('desk'), assignee: 'me', priority: 'urgent' }
    expect(listParams('desk', f, ' po ')).toEqual({
      scope: 'desk',
      status: 'open',
      sort: 'attention',
      assignee: 'me',
      priority: 'urgent',
      q: 'po'
    })
    expect(listParams('mine', f, '').assignee).toBeUndefined()
  })

  it('remembers per tab and drops anything unknown', () => {
    const s = memory()
    writeFilters('desk', { ...defaultFilters('desk'), status: 'closed', sort: 'newest' }, s)
    expect(readFilters('desk', s)).toMatchObject({ status: 'closed', sort: 'newest' })
    expect(readFilters('mine', s)).toEqual(defaultFilters('mine'))
    s.setItem(
      'nvr:support-list:desk',
      JSON.stringify({ status: 'x', sort: 'y', assignee: "'; drop", category: 'abc' })
    )
    expect(readFilters('desk', s)).toEqual(defaultFilters('desk'))
    s.setItem('nvr:support-list:desk', '{not json')
    expect(readFilters('desk', s)).toEqual(defaultFilters('desk'))
  })

  it('a storage that throws is no storage', () => {
    const bad = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }
    expect(readFilters('mine', bad)).toEqual(defaultFilters('mine'))
    expect(() => writeFilters('mine', defaultFilters('mine'), bad)).not.toThrow()
  })

  it('counts filters that differ from the defaults (not the sort)', () => {
    expect(activeFilterCount('desk', { ...defaultFilters('desk'), sort: 'newest' })).toBe(0)
    expect(
      activeFilterCount('desk', { ...defaultFilters('desk'), assignee: 'me', category: '3' })
    ).toBe(2)
  })
})

describe('support list words', () => {
  it('short ages', () => {
    const now = Date.parse('2026-11-16T12:00:00Z')
    expect(shortAgo('2026-11-16T11:59:40Z', now)).toBe('now')
    expect(shortAgo('2026-11-16T11:48:00Z', now)).toBe('12m')
    expect(shortAgo('2026-11-16T09:00:00Z', now)).toBe('3h')
    expect(shortAgo('2026-11-12T12:00:00Z', now)).toBe('4d')
    expect(shortAgo('2026-10-01T12:00:00Z', now)).toBe('6w')
    expect(shortAgo('2026-06-01T12:00:00Z', now)).toBe('5mo')
    expect(shortAgo('2025-05-01T12:00:00Z', now)).toBe('1y')
    expect(shortAgo(null, now)).toBe('')
  })

  it('initials', () => {
    expect(initialsOf('Beth Ann Cole')).toBe('BC')
    expect(initialsOf('sam')).toBe('S')
    expect(initialsOf('')).toBe('?')
  })

  it('the bulk result line names refusals', () => {
    expect(
      bulkResultLine(
        { kind: 'status', status: 'done' },
        {
          updated: 12,
          unchanged: 0,
          refused: 1,
          results: [{ outcome: 'refused', reason: 'You do not work this request' }]
        }
      )
    ).toBe('Closed: 12 · 1 not allowed (You do not work this request)')
    expect(
      bulkResultLine(
        { kind: 'assign', assignee: 'X', name: 'Beth Cole' },
        { updated: 2, unchanged: 1, refused: 0, results: [] }
      )
    ).toBe('Assigned to Beth Cole: 2 · 1 already that way')
  })
})
