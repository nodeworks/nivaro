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
})
