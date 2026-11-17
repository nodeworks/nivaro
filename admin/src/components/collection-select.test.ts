import { describe, expect, it } from 'vitest'
import { collectionSections } from './collection-select'

describe('collectionSections', () => {
  const rows = [
    { collection: 'finance', display_name: 'Finance', sort: 2, color: '#10b981' },
    { collection: 'ops', display_name: 'Operations', sort: 1 },
    { collection: 'invoices', display_name: 'Invoices', group: 'finance' },
    { collection: 'budgets', group: 'finance' },
    { collection: 'workflows', display_name: 'Workflows', group: 'ops' },
    { collection: 'vendors', display_name: 'Vendors' },
    { collection: 'workflows_divisions', hidden: true },
    { collection: 'nivaro_issues', display_name: 'Issues' }
  ]

  it('groups by folder in folder order, names A–Z, other collections last', () => {
    const s = collectionSections(rows)
    expect(s.map((x) => x.label)).toEqual(['Operations', 'Finance', 'Other collections'])
    expect(s[1].options.map((o) => o.label)).toEqual(['Budgets', 'Invoices'])
    expect(s[1].color).toBe('#10b981')
    expect(s[2].options.map((o) => o.collection)).toEqual(['vendors'])
  })

  it('leaves out folder rows, hidden link tables and system tables unless asked', () => {
    const all = collectionSections(rows).flatMap((x) => x.options.map((o) => o.collection))
    expect(all).not.toContain('finance')
    expect(all).not.toContain('workflows_divisions')
    expect(all).not.toContain('nivaro_issues')
    const wide = collectionSections(rows, { includeHidden: true, includeSystem: true }).flatMap(
      (x) => x.options.map((o) => o.collection)
    )
    expect(wide).toEqual(expect.arrayContaining(['workflows_divisions', 'nivaro_issues']))
  })
})

describe('matchScore', () => {
  const o = { collection: 'inventory_request', label: 'Inventory Request', folder: null }
  it('ranks the exact key first, then starts-with, then a word, then contains, then folder', async () => {
    const { matchScore } = await import('./collection-select')
    expect(matchScore(o, 'Warehouse', 'inventory_request')).toBe(1)
    expect(matchScore(o, 'Warehouse', 'inv')).toBe(0.9)
    expect(matchScore(o, 'Warehouse', 'req')).toBe(0.75)
    expect(matchScore(o, 'Warehouse', 'ntory')).toBe(0.5)
    expect(matchScore(o, 'Warehouse', 'wareh')).toBe(0.25)
    expect(matchScore(o, 'Warehouse', 'zzz')).toBe(0)
    expect(matchScore(o, 'Warehouse', '  ')).toBe(1)
  })
})
