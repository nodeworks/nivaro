import { describe, expect, it } from 'vitest'
import {
  parseTodayDrill,
  sortPeople,
  todayLevels,
  toLevel,
  upOne,
  windowSubtitle,
  withTodayDrill
} from './model'

const UID = '11111111-2222-3333-4444-555555555555'

describe('today drill in the URL', () => {
  it('round-trips every depth and keeps the page’s own params', () => {
    const d = { kind: 'people' as const, person: UID, entry: 42 }
    const p = withTodayDrill(new URLSearchParams('x=1'), d)
    expect(p.get('x')).toBe('1')
    expect(parseTodayDrill(p)).toEqual(d)
    const r = {
      kind: 'records' as const,
      tab: 'records' as const,
      rec: { collection: 'invoices', item: 'A:7' }
    }
    expect(parseTodayDrill(withTodayDrill(new URLSearchParams(), r))).toEqual(r)
  })

  it('ignores junk', () => {
    expect(parseTodayDrill(new URLSearchParams('today=nope'))).toBeNull()
    expect(parseTodayDrill(new URLSearchParams(`today=people&td_person=sam&td_entry=-1`))).toEqual({
      kind: 'people'
    })
  })

  it('breadcrumbs and Back walk up one level at a time', () => {
    const d = { kind: 'people' as const, person: UID, entry: 9 }
    expect(todayLevels(d)).toEqual(['root', 'person', 'entry'])
    expect(upOne(d)).toEqual({ kind: 'people', person: UID })
    expect(upOne({ kind: 'people', person: UID })).toEqual({ kind: 'people' })
    expect(upOne({ kind: 'people' })).toBeNull()
    expect(toLevel(d, 'root')).toEqual({ kind: 'people' })
    const s = { kind: 'slot' as const, at: '2026-11-18T10:00:00.000Z', run: 5 }
    expect(upOne(s)).toEqual({ kind: 'slot', at: s.at })
  })

  it('withTodayDrill(null) closes the sheet', () => {
    const p = withTodayDrill(new URLSearchParams('today=jobs&td_run=4&keep=1'), null)
    expect(p.toString()).toBe('keep=1')
  })
})

describe('sortPeople', () => {
  const row = (id: string, name: string, actions: number, role = 'Staff') => ({
    id,
    name,
    email: `${name.toLowerCase()}@x.test`,
    role,
    status: 'active',
    first_at: '2026-11-18T08:00:00.000Z',
    last_at: `2026-11-18T1${actions}:00:00.000Z`,
    actions,
    writes: 0,
    records_changed: 0,
    records_opened: 0
  })
  const rows = [row('a', 'Pat', 3), row('b', 'Ann', 7, 'Admin'), row('c', 'Sam', 1)]

  it('sorts and filters by words and role', () => {
    expect(sortPeople(rows, 'actions', 'desc').map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(sortPeople(rows, 'name', 'asc').map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(sortPeople(rows, 'last', 'desc', 'sa').map((r) => r.id)).toEqual(['c'])
    expect(sortPeople(rows, 'name', 'asc', '', 'Admin').map((r) => r.id)).toEqual(['b'])
  })
})

describe('windowSubtitle', () => {
  it('says the window is today from the viewer’s midnight to when the figure was counted', () => {
    const now = new Date(2026, 10, 18, 19, 44)
    const from = new Date(2026, 10, 18, 0, 0).toISOString()
    const to = new Date(2026, 10, 18, 19, 40).toISOString()
    const s = windowSubtitle(from, to, now)
    expect(s).toMatch(/^today since 12:00\sAM your time, up to 7:40\sPM$/)
  })

  it('names the start when it is not today’s midnight', () => {
    const now = new Date(2026, 10, 18, 19, 44)
    const s = windowSubtitle(new Date(2026, 10, 17, 14, 0).toISOString(), now.toISOString(), now)
    expect(s.startsWith('from ')).toBe(true)
  })
})
