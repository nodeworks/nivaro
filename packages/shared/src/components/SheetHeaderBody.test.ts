import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SheetHeaderBody } from './SheetHeaderBody'

describe('SheetHeaderBody', () => {
  it('says the figures failed to load instead of summing no rows to zero', () => {
    const html = renderToStaticMarkup(
      createElement(SheetHeaderBody, {
        stats: [{ label: 'Budget', field: 'budget', format: 'currency' }],
        rows: [],
        params: {},
        loading: false,
        error: true
      })
    )
    expect(html).toContain('data-sheet-header-error')
    expect(html).toContain('Couldn')
    expect(html).not.toContain('$0')
    expect(html).not.toContain('0.00')
  })

  it('adds the "as of" line from the latest dated row, and omits it when none is dated', () => {
    const base = {
      stats: [],
      params: {},
      loading: false,
      error: false,
      asOf: { field: 'synced_at', label: 'Figures as of' }
    }
    const html = renderToStaticMarkup(
      createElement(SheetHeaderBody, {
        ...base,
        rows: [{ synced_at: '2026-10-01' }, { synced_at: '2026-10-07' }, { synced_at: null }]
      })
    )
    expect(html).toContain('data-sheet-header-as-of')
    expect(html).toContain('Figures as of Oct 7, 2026')
    const none = renderToStaticMarkup(
      createElement(SheetHeaderBody, { ...base, rows: [{ synced_at: null }] })
    )
    expect(none).not.toContain('data-sheet-header-as-of')
  })
})
