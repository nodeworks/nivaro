// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { FieldChangeList } from './RevisionsPanel'

// army9 b01: "changed 1 field" listed 5 changes — the forecast columns a
// background recalculation wrote between two saves were shown as this edit's.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

const meta = new Map([
  ['vendor_contact', { label: 'Vendor Contact', system: false, onLayout: true }],
  ['forecast_total', { label: 'Forecast Total', system: false, onLayout: false }]
])

describe('revision change list', () => {
  it('lists fields this save did not write apart, after its own', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <FieldChangeList
            before={{ vendor_contact: 'A', forecast_total: null }}
            after={{ vendor_contact: 'B', forecast_total: 551.52 }}
            meta={meta as never}
            mode='changes'
            ownFields={new Set(['vendor_contact'])}
          />
        </QueryClientProvider>
      )
    )
    const text = document.body.textContent ?? ''
    const note = document.querySelector('[data-recalculated-between]')
    expect(note?.textContent).toContain('Not part of this edit')
    expect(text.indexOf('Vendor Contact')).toBeLessThan(text.indexOf('Recalculated since'))
    expect(text.indexOf('Recalculated since')).toBeLessThan(text.indexOf('Forecast Total'))
  })
})
