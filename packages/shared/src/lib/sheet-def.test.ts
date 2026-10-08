import { describe, expect, it } from 'vitest'
import { latestAsOf, resolveSheetDef, type SheetDefInput } from './sheet-def'

const resolveConfig = (cfg: Record<string, unknown>) => ({ ...cfg, resolved: true })

describe('resolveSheetDef', () => {
  it('resolves a header strip through the same resolver as a tab', () => {
    const def: SheetDefInput = {
      header: {
        query_slug: 'health',
        params: { projects: '$row.project_id' },
        stats: [{ label: 'Budget' }]
      },
      tabs: [{ label: 'Spend', config: { query_slug: 'spend' } }]
    }
    const out = resolveSheetDef(def, resolveConfig)
    expect(out.header).toEqual({
      config: { query_slug: 'health', params: { projects: '$row.project_id' }, resolved: true },
      stats: [{ label: 'Budget' }]
    })
    expect(out.resolvedTabs).toEqual([
      { label: 'Spend', config: { query_slug: 'spend', resolved: true } }
    ])
  })

  it('keeps a header with no tabs at all', () => {
    const out = resolveSheetDef(
      { header: { query_slug: 'health', stats: [{ label: 'Budget' }] } },
      resolveConfig
    )
    expect(out.resolvedTabs).toEqual([])
    expect(out.header?.config.query_slug).toBe('health')
  })

  it('clamps initial_tab into the tab range and defaults to 0', () => {
    const tabs = [
      { label: 'A', config: {} },
      { label: 'B', config: {} }
    ]
    expect(resolveSheetDef({ tabs, initial_tab: 1 }, resolveConfig).initialTab).toBe(1)
    expect(resolveSheetDef({ tabs, initial_tab: 9 }, resolveConfig).initialTab).toBe(0)
    expect(resolveSheetDef({ tabs, initial_tab: -1 }, resolveConfig).initialTab).toBe(0)
    expect(resolveSheetDef({ tabs }, resolveConfig).initialTab).toBe(0)
  })

  it('turns a bare config into one View tab, as before', () => {
    const out = resolveSheetDef({ config: { query_slug: 'x' } }, resolveConfig)
    expect(out.resolvedTabs.map((t) => t.label)).toEqual(['View'])
  })

  it('passes matrix tabs through untouched for the caller to scope', () => {
    const out = resolveSheetDef(
      {
        tabs: [
          {
            label: 'M',
            matrix: { config: { target_collection: 't' }, scope: { project: '$row.id' } }
          }
        ]
      },
      resolveConfig
    )
    expect(out.resolvedTabs[0]).toEqual({
      label: 'M',
      matrix: { config: { target_collection: 't' }, scope: { project: '$row.id' } }
    })
  })
})

describe('sheet header as-of line', () => {
  it('passes the as-of field through and picks the latest dated row', () => {
    const out = resolveSheetDef(
      {
        header: {
          query_slug: 'health',
          stats: [],
          as_of: { field: 'synced_at', label: 'Figures as of' }
        }
      },
      resolveConfig
    )
    expect(out.header?.asOf).toEqual({ field: 'synced_at', label: 'Figures as of' })
    expect(
      latestAsOf(
        [{ synced_at: '2026-09-30T10:00:00Z' }, { synced_at: '2026-10-02T08:00:00Z' }, {}],
        'synced_at'
      )
    ).toBe('2026-10-02T08:00:00Z')
    expect(latestAsOf([{ synced_at: null }, { synced_at: 'not a date' }], 'synced_at')).toBeNull()
  })
})
