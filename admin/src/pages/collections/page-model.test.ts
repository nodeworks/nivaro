import { describe, expect, it } from 'vitest'
import { buildPageModel, nearSpellings } from './page-model'
import type { Collection, OverviewStats, PageState } from './types'

const col = (collection: string, extra: Partial<Collection> = {}): Collection =>
  ({
    collection,
    display_name: null,
    group: null,
    hidden: false,
    singleton: false,
    sort: null,
    color: null,
    icon: null,
    note: null,
    ...extra
  }) as Collection

const rows: Collection[] = [
  col('wf', { display_name: 'Workflow', sort: 2 }), // folder
  col('inv', { display_name: 'Inventory', sort: 1 }), // folder
  col('workflows', { group: 'wf', sort: 10 }),
  col('workflow_states', { group: 'wf', sort: 20, hidden: true }),
  col('warehouses', { group: 'inv' }),
  col('vendors'),
  col('alpha'),
  col('vendors_locations'), // link
  col('secret', { hidden: true })
]
const stats: OverviewStats = {
  workflows: {
    rows: 500,
    changed_at: '2026-10-29T10:00:00Z',
    pipeline: 'WF',
    forms: 2,
    imports: 0,
    link: false,
    virtual: false
  },
  warehouses: {
    rows: 0,
    changed_at: '2026-10-20T10:00:00Z',
    pipeline: null,
    forms: 0,
    imports: 1,
    link: false,
    virtual: false
  },
  vendors: {
    rows: 40,
    changed_at: null,
    pipeline: null,
    forms: 1,
    imports: 0,
    link: false,
    virtual: false
  },
  vendors_locations: {
    rows: 90,
    changed_at: null,
    pipeline: null,
    forms: 0,
    imports: 0,
    link: true,
    virtual: false
  }
}
const base: PageState = {
  view: 'folders',
  density: 'compact',
  chips: [],
  showHidden: false,
  showLinks: false,
  arranging: false,
  selecting: false
}
const usage = { counts: { alpha: 5, vendors: 2 } }

describe('collections page model', () => {
  it('folders in their own sort order, loose A–Z, hidden and link tables folded away', () => {
    const m = buildPageModel(rows, stats, base, '', usage)
    expect(m.folders.map((f) => f.key)).toEqual(['inv', 'wf'])
    expect(
      m.sections.map((s) => [s.folder.key, s.cols.map((c) => c.collection), s.hiddenCount])
    ).toEqual([
      ['inv', ['warehouses'], 0],
      ['wf', ['workflows'], 1]
    ])
    expect(m.loose.map((c) => c.collection)).toEqual(['alpha', 'vendors'])
    expect(m.linkTables.map((c) => c.collection)).toEqual(['vendors_locations'])
    expect(m.counts).toMatchObject({ total: 7, hidden: 2, links: 1 })
  })

  it('show hidden / show links bring them back into place', () => {
    const m = buildPageModel(rows, stats, { ...base, showHidden: true, showLinks: true }, '', usage)
    expect(m.sections.find((s) => s.folder.key === 'wf')?.cols.map((c) => c.collection)).toEqual([
      'workflows',
      'workflow_states'
    ])
    expect(m.loose.map((c) => c.collection)).toEqual([
      'alpha',
      'secret',
      'vendors',
      'vendors_locations'
    ])
    expect(m.linkTables).toEqual([])
  })

  it('a filter keeps folders, drops empty ones and reports folded matches', () => {
    const m = buildPageModel(rows, stats, base, 'ven', usage)
    expect(m.sections).toEqual([])
    expect(m.loose.map((c) => c.collection)).toEqual(['vendors'])
    expect(m.foldedMatches.links.map((c) => c.collection)).toEqual(['vendors_locations'])
    const s = buildPageModel(rows, stats, base, 'secr', usage)
    expect(s.shownCount).toBe(0)
    expect(s.foldedMatches.hidden.map((c) => c.collection)).toEqual(['secret'])
  })

  it('chips AND together and count over every collection', () => {
    const m = buildPageModel(rows, stats, { ...base, chips: ['has_records', 'form'] }, '', usage)
    expect(
      m.sections
        .flatMap((s) => s.cols)
        .concat(m.loose)
        .map((c) => c.collection)
        .sort()
    ).toEqual(['vendors', 'workflows'])
    expect(m.counts.chip.empty).toBe(1)
    expect(m.counts.chip.link).toBe(1)
  })

  it('flat views sort by records, recent change and your own use', () => {
    const order = (view: PageState['view']) =>
      buildPageModel(rows, stats, { ...base, view }, '', usage).flat.map((c) => c.collection)
    expect(order('records')).toEqual(['workflows', 'vendors', 'warehouses', 'alpha'])
    expect(order('recent')).toEqual(['workflows', 'warehouses', 'alpha', 'vendors'])
    expect(order('used')).toEqual(['alpha', 'vendors', 'warehouses', 'workflows'])
    expect(order('az')).toEqual(['alpha', 'vendors', 'warehouses', 'workflows'])
  })

  it('suggests near spellings for a typo', () => {
    expect(nearSpellings('vendrs', rows).map((c) => c.collection)).toContain('vendors')
    expect(nearSpellings('zz', rows)).toEqual([])
  })
})
