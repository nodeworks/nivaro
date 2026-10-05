import { describe, expect, it } from 'vitest'
import {
  bundleAsNotification,
  bundleHeadline,
  bundleLocally,
  categoryChipLabel,
  laneTone
} from './bundles'

const bundle = {
  collection: 'workflows',
  item: '42',
  label: 'CM26-80332',
  count: 3,
  unread: 2,
  lane: 'needs_you' as const,
  categories: ['workflow', 'mentions'],
  newest: '2026-10-01T12:00:00.000Z',
  url: '/collections/workflows/42',
  ids: [5, 3, 1],
  rows: []
}

describe('bundle helpers', () => {
  it('headlines count the things on the record', () => {
    expect(bundleHeadline(bundle)).toBe('3 things on CM26-80332')
    expect(bundleHeadline({ ...bundle, count: 1 })).toBe('1 thing on CM26-80332')
  })
  it('presents a bundle as a record notification for the host resolver', () => {
    expect(bundleAsNotification(bundle)).toEqual({
      collection: 'workflows',
      item: '42',
      target: { kind: 'record', collection: 'workflows', id: '42' },
      url: '/collections/workflows/42'
    })
  })
  it('labels categories', () => {
    expect(categoryChipLabel('workflow')).toBe('Workflow')
    expect(categoryChipLabel('field_watch')).toBe('Field Watch')
  })
  it('colours by lane, critical red', () => {
    expect(laneTone('critical').dot).toContain('red')
    expect(laneTone('fyi').dot).toContain('slate')
    expect(laneTone(null).dot).toContain('nvr-cyan')
  })
})

describe('bundleLocally', () => {
  const row = (id: number, collection: string | null, item: string | null, read = false) => ({
    id,
    collection,
    item,
    read,
    lane: null,
    category: null,
    created_at: `2026-10-01T12:00:0${id}.000Z`
  })
  it('mirrors the server rule: two or more rows on one record fold', () => {
    const rows = [row(3, 'w', '1'), row(2, 'p', '9'), row(1, 'w', '1', true)]
    const out = bundleLocally(rows)
    expect(out.rows.map((r) => r.id)).toEqual([2])
    expect(out.bundles).toHaveLength(1)
    expect(out.bundles[0]).toMatchObject({ collection: 'w', item: '1', count: 2, unread: 1 })
    expect(out.bundles[0].label).toBe('1')
  })
  it('never folds pseudo-collections', () => {
    const rows = [row(2, '__chat__', 'global'), row(1, '__chat__', 'global')]
    expect(bundleLocally(rows).bundles).toEqual([])
  })
})
