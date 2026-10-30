import { describe, expect, it } from 'vitest'
import { decodeListLink, LIST_LINK_PARAM, sanitizeCbvLinkState } from '../../lib/list-link'
import { ageShort, stateListUrl } from './work-links'

const stateOf = (url: string, collection: string) => {
  const raw = new URL(url, 'http://x').searchParams.get(LIST_LINK_PARAM)
  return sanitizeCbvLinkState(decodeListLink(raw, `cbv:${collection}`))
}

describe('stateListUrl (CC-5)', () => {
  it('opens the collection list filtered to the state through the list link', () => {
    const url = stateListUrl('work_orders', { state: 'review' })
    expect(url.startsWith('/collections/work_orders?')).toBe(true)
    expect(stateOf(url, 'work_orders')?.cf).toEqual({
      __state__: { kind: 'state', value: ['review'] }
    })
  })
  it('adds the minimum age for stuck groups', () => {
    const s = stateOf(
      stateListUrl('work_orders', { state: 'review', minAgeHours: 168 }),
      'work_orders'
    )
    expect(s?.cf?.__aging__).toEqual({ kind: 'aging', value: '168:' })
  })
  it('no state = the plain list; the link never bends another list', () => {
    expect(stateListUrl('work_orders')).toBe('/collections/work_orders')
    expect(stateOf(stateListUrl('a', { state: 'x' }), 'b')).toBeNull()
  })
})

describe('ageShort', () => {
  it('minutes, hours, days', () => {
    expect(ageShort(120)).toBe('2m')
    expect(ageShort(5 * 3600)).toBe('5h')
    expect(ageShort(3 * 86_400)).toBe('3d')
    expect(ageShort(null)).toBe('–')
  })
})
