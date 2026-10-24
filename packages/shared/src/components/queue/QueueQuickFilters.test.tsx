// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilterDef } from '../DataTable'
import { QueueQuickFilters } from './QueueQuickFilters'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const defs = [
  {
    key: 'extra.project_type',
    placeholder: 'Project Type',
    type: 'combobox',
    multi: true,
    options: [
      { label: 'CRAN', value: 'CRAN' },
      { label: 'HQ Funded', value: 'HQ Funded' }
    ]
  }
] as unknown as FilterDef[]

function mount(
  values: Record<string, string | string[]>,
  onApply: (p: Record<string, unknown>) => void
) {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <QueueQuickFilters
          defs={defs}
          values={values}
          seededKeys={new Set(['extra.project_type'])}
          onApply={onApply}
          onClear={() => {}}
        />
      </QueryClientProvider>
    )
  )
}

describe('QueueQuickFilters', () => {
  it('applies at once when a facet is emptied with its ✕ — no separate Apply', () => {
    const onApply = vi.fn()
    mount({ 'extra.project_type': ['CRAN'] }, onApply)
    const clear = host.querySelector('[aria-label="Clear Project Type"]') as HTMLElement
    expect(clear).not.toBeNull()
    act(() => clear.click())
    expect(onApply).toHaveBeenCalledWith({ 'extra.project_type': [] })
  })
})
