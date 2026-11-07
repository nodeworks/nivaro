import { describe, expect, it } from 'vitest'
import { collidingIds, disambiguators, isNamelessLabel } from './option-disambiguate'

describe('collidingIds', () => {
  it('lists every option whose label another option shares', () => {
    const items = [
      { id: 1, name: 'CEG 1' },
      { id: 2, name: 'ceg 1 ' },
      { id: 3, name: 'CEG 2' }
    ]
    expect(collidingIds(items, (i) => String(i.name))).toEqual(['1', '2'])
  })
})

describe('disambiguators', () => {
  it('picks the column that tells same-label rows apart', () => {
    const rows = [
      { id: 10, name: 'CEG 1', system_id: 'A-100', zone: 3, date_created: '2026-01-01' },
      { id: 11, name: 'CEG 1', system_id: 'B-200', zone: 4, date_created: '2026-02-01' }
    ]
    const d = disambiguators([rows], ['name'])
    expect(d.get('10')).toBe('System Id: A-100')
    expect(d.get('11')).toBe('System Id: B-200')
  })

  it('prefers text over bare numbers (foreign keys) on a tie', () => {
    const rows = [
      { id: 1, name: 'X', zone: 3, market: 'Atlanta' },
      { id: 2, name: 'X', zone: 4, market: 'Boston' }
    ]
    expect(disambiguators([rows], ['name']).get('1')).toBe('Market: Atlanta')
  })

  it('falls back to a position, never the internal id, when nothing differs', () => {
    const rows = [
      { id: 1, name: 'X', note: null },
      { id: 2, name: 'X', note: null }
    ]
    const d = disambiguators([rows], ['name'])
    expect(d.get('1')).toBe('Same name · 1 of 2')
    expect(d.get('2')).toBe('Same name · 2 of 2')
  })

  it('never offers a raw ISO timestamp or the created/changed bookkeeping columns', () => {
    const rows = [
      { id: 8163, name: null, created: '2026-09-07T10:32:53.709Z', opened: '2026-09-07T10:00:00Z' },
      { id: 8164, name: null, created: '2026-09-07T10:32:53.821Z', opened: '2026-09-08T10:00:00Z' }
    ]
    const d = disambiguators([rows], ['name'])
    expect(d.get('8163')).toMatch(/^Opened: Sep \d+, 2026/)
    expect(d.get('8163')).not.toMatch(/T\d{2}:/)
  })
})

describe('isNamelessLabel', () => {
  it('reads a label with no letter or digit as nameless', () => {
    expect(isNamelessLabel('')).toBe(true)
    expect(isNamelessLabel(' - ')).toBe(true)
    expect(isNamelessLabel(' / ')).toBe(true)
    expect(isNamelessLabel(null)).toBe(true)
    expect(isNamelessLabel('alameda.ca')).toBe(false)
    expect(isNamelessLabel('8163 - ')).toBe(false)
    expect(isNamelessLabel('Ünïcode')).toBe(false)
  })
})
