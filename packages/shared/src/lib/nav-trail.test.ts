import { describe, expect, it } from 'vitest'
import {
  displayTrail,
  reduceTrail,
  type TrailEvent,
  type TrailState,
  trailChain
} from './nav-trail'

const EMPTY: TrailState = { entries: [], current: null }

function walk(events: Array<Omit<TrailEvent, 'at'>>): TrailState {
  return events.reduce((s, e, i) => reduceTrail(s, { ...e, at: i }), EMPTY)
}

describe('reduceTrail', () => {
  it('appends on PUSH and drops the forward stack', () => {
    let s = walk([
      { action: 'PUSH', key: 'a', idx: 0, path: '/queues/7' },
      { action: 'PUSH', key: 'b', idx: 1, path: '/collections/po/4471' },
      { action: 'PUSH', key: 'c', idx: 2, path: '/collections/po_lines/3' }
    ])
    expect(s.entries.map((e) => e.key)).toEqual(['a', 'b', 'c'])
    // back to b, then push somewhere new: c is gone
    s = reduceTrail(s, { action: 'POP', key: 'b', idx: 1, path: '/collections/po/4471' })
    expect(s.entries).toHaveLength(3)
    expect(s.current).toEqual({ key: 'b', idx: 1 })
    s = reduceTrail(s, { action: 'PUSH', key: 'd', idx: 2, path: '/tasks' })
    expect(s.entries.map((e) => e.key)).toEqual(['a', 'b', 'd'])
  })

  it('REPLACE rewrites one entry and keeps its label when the page is the same', () => {
    let s = walk([
      { action: 'PUSH', key: 'a', idx: 0, path: '/collections/po' },
      { action: 'PUSH', key: 'b', idx: 1, path: '/collections/po/1' }
    ])
    s = {
      ...s,
      entries: s.entries.map((e) => (e.key === 'a' ? { ...e, label: 'Purchase Orders' } : e))
    }
    s = reduceTrail(s, { action: 'POP', key: 'a', idx: 0, path: '/collections/po' })
    s = reduceTrail(s, {
      action: 'REPLACE',
      key: 'a2',
      idx: 0,
      path: '/collections/po?status=open'
    })
    expect(s.entries[0]).toMatchObject({ key: 'a2', label: 'Purchase Orders' })
    expect(s.entries).toHaveLength(2)
  })

  it('a reload (POP onto the known entry) changes nothing', () => {
    const s = walk([{ action: 'PUSH', key: 'a', idx: 0, path: '/' }])
    const again = reduceTrail(s, { action: 'POP', key: 'a', idx: 0, path: '/' })
    expect(again.entries).toBe(s.entries)
  })
})

describe('trailChain + displayTrail', () => {
  const isRoot = (p: string) => p === '/' || /^\/queues\/[^/]+$/.test(p) || p === '/tasks'

  it('shows how you got here, stopping at the root you started from', () => {
    const s = walk([
      { action: 'PUSH', key: 'h', idx: 0, path: '/' },
      { action: 'PUSH', key: 'q', idx: 1, path: '/queues/7?scope=mine' },
      { action: 'PUSH', key: 'p', idx: 2, path: '/collections/po/4471?tab=lines' },
      { action: 'PUSH', key: 'l', idx: 3, path: '/collections/po_lines/3' }
    ])
    const crumbs = displayTrail(
      trailChain(s),
      { idx: 3, path: '/collections/po_lines/3' },
      { isRoot }
    )
    expect(crumbs.map((c) => c.path)).toEqual([
      '/queues/7?scope=mine',
      '/collections/po/4471?tab=lines'
    ])
    expect(crumbs.map((c) => c.delta)).toEqual([-2, -1])
  })

  it('skips repeats (newest visit wins) and the current page itself', () => {
    const s = walk([
      { action: 'PUSH', key: '1', idx: 0, path: '/collections/po/1' },
      { action: 'PUSH', key: '2', idx: 1, path: '/collections/po/2' },
      { action: 'PUSH', key: '3', idx: 2, path: '/collections/po/1?tab=x' },
      { action: 'PUSH', key: '4', idx: 3, path: '/collections/po/2' }
    ])
    const crumbs = displayTrail(trailChain(s), { idx: 3, path: '/collections/po/2' })
    expect(crumbs.map((c) => c.key)).toEqual(['3'])
    expect(crumbs[0].delta).toBe(-1)
  })

  it('a gap in the stack (lost storage) ends the chain', () => {
    const s: TrailState = {
      entries: [
        { key: 'x', idx: 0, path: '/a', at: 0 },
        { key: 'z', idx: 2, path: '/c', at: 0 }
      ],
      current: { key: 'w', idx: 3 }
    }
    expect(trailChain(s).map((e) => e.key)).toEqual(['z'])
  })

  it('caps the number of crumbs', () => {
    const s = walk(
      Array.from({ length: 8 }, (_, i) => ({
        action: 'PUSH' as const,
        key: String(i),
        idx: i,
        path: `/collections/c/${i}`
      }))
    )
    const crumbs = displayTrail(trailChain(s), { idx: 7, path: '/collections/c/7' }, { max: 3 })
    expect(crumbs.map((c) => c.key)).toEqual(['4', '5', '6'])
  })

  it('no current entry = no trail', () => {
    expect(trailChain(EMPTY)).toEqual([])
  })
})

describe('store labels', () => {
  it('a label only lands on the entry that is still current', async () => {
    const mod = await import('./nav-trail')
    mod.resetNavTrailForTests()
    mod.recordNavigation({ action: 'PUSH', key: 'a', idx: 0, path: '/collections/po/1' })
    mod.recordNavigation({ action: 'PUSH', key: 'b', idx: 1, path: '/collections/po/2' })
    mod.setTrailLabel('PO 1', 'a') // late: a is no longer current
    mod.setTrailLabel('PO 2', 'b')
    const s = mod.getNavTrail()
    expect(s.entries.find((e) => e.key === 'a')?.label).toBeUndefined()
    expect(s.entries.find((e) => e.key === 'b')?.label).toBe('PO 2')
  })
})
