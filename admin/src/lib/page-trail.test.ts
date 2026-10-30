import { describe, expect, it } from 'vitest'
import { describePath, isTrailRoot, structuralCrumbs } from './page-trail'

describe('describePath', () => {
  it('knows records, new records, collections and queues', () => {
    expect(describePath('/collections/po/4471?tab=lines')).toEqual({
      kind: 'record',
      collection: 'po',
      id: '4471'
    })
    expect(describePath('/collections/po/new')).toEqual({ kind: 'new-record', collection: 'po' })
    expect(describePath('/collections/po')).toEqual({ kind: 'collection', collection: 'po' })
    expect(describePath('/queues/12')).toEqual({ kind: 'queue', id: '12' })
  })

  it('names nav pages, hub tabs and detail pages from the nav map', () => {
    expect(describePath('/my-work')).toEqual({ kind: 'static', label: 'My Work' })
    expect(describePath('/jobs')).toEqual({ kind: 'static', label: 'Jobs' })
    expect(describePath('/jobs/timeline')).toEqual({ kind: 'static', label: 'Jobs · Timeline' })
    expect(describePath('/tasks/42')).toEqual({ kind: 'static', label: 'Tasks #42' })
  })
})

describe('isTrailRoot', () => {
  it('lists, hubs, queues and nav pages start a trail; records do not', () => {
    expect(isTrailRoot('/')).toBe(true)
    expect(isTrailRoot('/queues/12')).toBe(true)
    expect(isTrailRoot('/collections/po')).toBe(true)
    expect(isTrailRoot('/jobs/timeline')).toBe(true)
    expect(isTrailRoot('/collections/po/4471')).toBe(false)
  })
})

describe('structuralCrumbs (cold load)', () => {
  it('record → Collections › collection', () => {
    expect(structuralCrumbs('/collections/po/4471').map((c) => c.to)).toEqual([
      '/collections',
      '/collections/po'
    ])
  })
  it('a non-first hub tab → the hub; a nav page → nothing', () => {
    expect(structuralCrumbs('/jobs/timeline').map((c) => c.to)).toEqual(['/jobs'])
    expect(structuralCrumbs('/jobs')).toEqual([])
    expect(structuralCrumbs('/my-work')).toEqual([])
  })
  it('a queue worklist → Queues', () => {
    expect(structuralCrumbs('/queues/9').map((c) => c.to)).toEqual(['/queues'])
  })
})
