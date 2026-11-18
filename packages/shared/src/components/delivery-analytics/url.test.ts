import { describe, expect, it } from 'vitest'
import { clearDrill, decodeCond, drillQuery, encodeCond, readDrill, writeDrill } from './url'

const win = {
  from: '2026-11-11T00:00:00.000Z',
  to: '2026-11-18T00:00:00.000Z',
  prev_from: '2026-11-04T00:00:00.000Z',
  prev_to: '2026-11-11T00:00:00.000Z',
  asof: '2026-11-18T00:00:00.000Z',
  acted_hours: 24
}

describe('delivery analytics URL state', () => {
  it('round-trips conditions with commas and colons in values', () => {
    const c: [string, string[]] = ['template', ['flow:mail,addendum', 'x']]
    expect(decodeCond(encodeCond(c))).toEqual(c)
    expect(decodeCond('nocolon')).toBeNull()
  })

  it('writes a drill into the URL and reads it back, page filters kept', () => {
    const p = new URLSearchParams('window=30d&category=workflow&leaf=n:5')
    writeDrill(
      p,
      {
        n: 3,
        s: 'm',
        w: [
          ['outcome', ['failed']],
          ['template', ['a b']]
        ],
        win: 'prev'
      },
      'Emails failed'
    )
    const d = readDrill(new URLSearchParams(p.toString()))
    expect(d).toMatchObject({
      source: 'm',
      prev: true,
      label: 'Emails failed',
      where: [
        ['outcome', ['failed']],
        ['template', ['a b']]
      ],
      leaf: null
    })
    expect(p.get('category')).toBe('workflow')
    clearDrill(p)
    expect(readDrill(p)).toBeNull()
    expect(p.get('window')).toBe('30d')
  })

  it('a drill request carries the summary window, the page filters and its conditions', () => {
    const page = new URLSearchParams('window=7d&channel=email&sender=ABC&by=lane')
    const q = drillQuery(page, { source: 'n', where: [['read', ['unread']]], prev: false }, win)
    expect(q.get('from')).toBe(win.from)
    expect(q.get('to')).toBe(win.to)
    expect(q.get('asof')).toBe(win.asof)
    expect(q.get('channel')).toBe('email')
    expect(q.get('sender')).toBe('ABC')
    expect(q.get('by')).toBeNull()
    expect(q.getAll('w')).toEqual(['read:unread'])
    const prev = drillQuery(page, { source: 'n', where: [], prev: true }, win)
    expect(prev.get('from')).toBe(win.prev_from)
    expect(prev.get('to')).toBe(win.prev_to)
  })

  it('a leaf alone opens without a list behind it', () => {
    expect(readDrill(new URLSearchParams('leaf=m:42'))).toMatchObject({
      source: 'm',
      leaf: { source: 'm', id: 42 },
      where: []
    })
    expect(readDrill(new URLSearchParams('leaf=q:42'))).toBeNull()
  })
})
