// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  LIST_ADDRESS_EVENT,
  replaceListLinkParam,
  sanitizeCbvLinkState,
  sanitizeQueueLinkState
} from './list-link'
import {
  displayTrail,
  getNavTrail,
  listTrailDetail,
  recordNavigation,
  reduceTrail,
  resetNavTrailForTests,
  scrollToRestore,
  setTrailDetail,
  setTrailScroll,
  type TrailState,
  trailChain,
  trailCrumbText
} from './nav-trail'

/** #21 Back to the exact list: the list's address, scroll and name survive the round trip. */

describe('listTrailDetail', () => {
  it('names the view, search, filters and page', () => {
    expect(listTrailDetail({ view: 'My open', page: 3 })).toBe('My open · page 3')
    expect(listTrailDetail({ search: 'pump', filters: 2 })).toBe('“pump” · 2 filters')
    expect(listTrailDetail({ filters: 1, page: 1 })).toBe('1 filter')
    // A view names its own filters: no count on top.
    expect(listTrailDetail({ view: 'Open', filters: 4 })).toBe('Open')
    expect(listTrailDetail({})).toBe('')
    expect(listTrailDetail({ search: 'a very long search phrase indeed here' })).toBe(
      '“a very long search phra…”'
    )
  })

  it('crumb text joins the label and the detail', () => {
    expect(trailCrumbText('Workflows', 'My open · page 3')).toBe('Workflows · My open · page 3')
    expect(trailCrumbText('Workflows', '')).toBe('Workflows')
  })
})

describe('trail entries keep a list’s state', () => {
  beforeEach(() => {
    resetNavTrailForTests()
    sessionStorage.clear()
    window.history.replaceState(null, '', '/collections/workflows')
  })

  it('a POP back onto an entry whose address the list rewrote keeps its scroll and detail', () => {
    let s: TrailState = { entries: [], current: null }
    s = reduceTrail(s, { action: 'PUSH', key: 'a', idx: 0, path: '/collections/workflows', at: 1 })
    s = {
      ...s,
      entries: s.entries.map((e) => ({
        ...e,
        detail: 'My open · page 3',
        scroll: [{ path: '0.1', top: 640 }]
      }))
    }
    s = reduceTrail(s, {
      action: 'PUSH',
      key: 'b',
      idx: 1,
      path: '/collections/workflows/7',
      at: 2
    })
    s = reduceTrail(s, {
      action: 'POP',
      key: 'a',
      idx: 0,
      path: '/collections/workflows?lv=abc',
      at: 3
    })
    expect(s.entries[0]).toMatchObject({
      key: 'a',
      path: '/collections/workflows?lv=abc',
      detail: 'My open · page 3',
      scroll: [{ path: '0.1', top: 640 }]
    })
    expect(
      scrollToRestore(s, { action: 'POP', idx: 0, path: '/collections/workflows?lv=abc' })
    ).toEqual([{ path: '0.1', top: 640 }])
  })

  it('the first entry after a load keeps its scroll when its key was minted later', () => {
    let s: TrailState = { entries: [], current: null }
    // react-router names the first entry 'default'; list-page-memory mints a key into it later.
    s = reduceTrail(s, {
      action: 'POP',
      key: 'default',
      idx: 0,
      path: '/collections/workflows',
      at: 1
    })
    s = { ...s, entries: s.entries.map((e) => ({ ...e, scroll: [{ path: '0.1', top: 303 }] })) }
    s = reduceTrail(s, {
      action: 'PUSH',
      key: 'r',
      idx: 1,
      path: '/collections/workflows/7',
      at: 2
    })
    s = reduceTrail(s, {
      action: 'POP',
      key: 'nvrab12cd34',
      idx: 0,
      path: '/collections/workflows?lv=x',
      at: 3
    })
    expect(s.entries[0].scroll).toEqual([{ path: '0.1', top: 303 }])
  })

  it('a different page at that index does not inherit the scroll', () => {
    let s: TrailState = { entries: [], current: null }
    s = reduceTrail(s, { action: 'PUSH', key: 'a', idx: 0, path: '/collections/workflows', at: 1 })
    s = { ...s, entries: s.entries.map((e) => ({ ...e, scroll: [{ path: '', top: 90 }] })) }
    s = reduceTrail(s, { action: 'POP', key: 'zz', idx: 0, path: '/queues/7', at: 2 })
    expect(s.entries[0].scroll).toBeUndefined()
  })

  it('a "return to the list" push restores the newest earlier visit of that page', () => {
    let s: TrailState = { entries: [], current: null }
    s = reduceTrail(s, { action: 'PUSH', key: 'a', idx: 0, path: '/records/workflows', at: 1 })
    s = { ...s, entries: s.entries.map((e) => ({ ...e, scroll: [{ path: '', top: 1200 }] })) }
    s = reduceTrail(s, { action: 'PUSH', key: 'b', idx: 1, path: '/records/workflows/7', at: 2 })
    s = reduceTrail(s, {
      action: 'PUSH',
      key: 'c',
      idx: 2,
      path: '/records/workflows?lv=x',
      at: 3
    })
    expect(
      scrollToRestore(s, {
        action: 'PUSH',
        idx: 2,
        path: '/records/workflows?lv=x',
        returning: true
      })
    ).toEqual([{ path: '', top: 1200 }])
    // A plain push (a nav click) starts at the top.
    expect(scrollToRestore(s, { action: 'PUSH', idx: 2, path: '/records/workflows' })).toBeNull()
  })

  it('crumbs carry the list’s detail; an empty detail clears it', () => {
    recordNavigation({ action: 'PUSH', key: 'a', idx: 0, path: '/collections/workflows' })
    setTrailDetail('My open · page 3')
    setTrailScroll([{ path: '', top: 300 }])
    recordNavigation({ action: 'PUSH', key: 'b', idx: 1, path: '/collections/workflows/9' })
    const crumbs = displayTrail(trailChain(getNavTrail()), {
      idx: 1,
      path: '/collections/workflows/9'
    })
    expect(crumbs).toHaveLength(1)
    expect(crumbs[0]).toMatchObject({ path: '/collections/workflows', detail: 'My open · page 3' })
    recordNavigation({ action: 'POP', key: 'a', idx: 0, path: '/collections/workflows' })
    setTrailDetail('')
    expect(getNavTrail().entries[0].detail).toBeUndefined()
  })

  it('replaceListLinkParam keeps the trail’s address in step and tells the host', () => {
    recordNavigation({ action: 'PUSH', key: 'a', idx: 0, path: '/collections/workflows' })
    const seen: string[] = []
    const on = (e: Event) => seen.push((e as CustomEvent<{ path: string }>).detail.path)
    window.addEventListener(LIST_ADDRESS_EVENT, on)
    replaceListLinkParam('cbv:workflows', { q: 'pump', p: 3 })
    expect(window.location.search).toMatch(/^\?lv=/)
    const path = `/collections/workflows${window.location.search}`
    expect(getNavTrail().entries[0].path).toBe(path)
    expect(seen).toEqual([path])
    // Same state again: nothing rewritten, nothing fired.
    replaceListLinkParam('cbv:workflows', { q: 'pump', p: 3 })
    expect(seen).toEqual([path])
    window.removeEventListener(LIST_ADDRESS_EVENT, on)
  })
})

describe('the saved view rides the link', () => {
  it('collection browser: v', () => {
    expect(sanitizeCbvLinkState({ v: 12 })).toEqual({ v: 12 })
    expect(sanitizeCbvLinkState({ v: -1 })).toEqual({})
    expect(sanitizeCbvLinkState({ v: 'x' })).toEqual({})
  })
  it('queue worklist: view_id', () => {
    expect(sanitizeQueueLinkState({ view_id: 4 })).toEqual({ view_id: 4 })
    expect(sanitizeQueueLinkState({ view_id: 0 })).toEqual({})
  })
})
