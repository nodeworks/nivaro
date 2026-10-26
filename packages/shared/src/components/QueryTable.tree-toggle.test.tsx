// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { QueryTable } from './QueryTable'

// Budget detail's Spend Details tab: rows grouped by category group, open by
// default — Expand all / Collapse all flips every section at once.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// jsdom has no ResizeObserver (the table watches its scroller's width).
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const rows = [
  { core_group: 'Capital', category: 'Capital - Labor', spend: 10 },
  { core_group: 'Capital', category: 'Capital - Materials', spend: 5 },
  { core_group: 'Expense', category: 'Expense - Services', spend: 7 }
]

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function mount(treeCollapsed?: boolean) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryTable
        rows={rows}
        config={
          {
            tree_group_by: 'core_group',
            ...(treeCollapsed !== undefined ? { tree_collapsed: treeCollapsed } : {}),
            columns: [
              { field: 'category', label: 'Category' },
              { field: 'spend', label: 'Spend', format: 'currency' }
            ]
          } as never
        }
      />
    )
  )
  return host
}

const shown = (host: HTMLElement, text: string) => host.textContent?.includes(text) ?? false
const toggle = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('[data-query-tree-toggle]')

describe('QueryTable tree — Expand all / Collapse all', () => {
  it('open by default: the button collapses every section, then expands them again', async () => {
    const host = await mount()
    expect(shown(host, 'Capital - Labor')).toBe(true)
    expect(toggle(host)?.textContent).toBe('Collapse all')
    await act(async () => toggle(host)?.click())
    expect(shown(host, 'Capital - Labor')).toBe(false)
    expect(shown(host, 'Expense - Services')).toBe(false)
    expect(toggle(host)?.textContent).toBe('Expand all')
    await act(async () => toggle(host)?.click())
    expect(shown(host, 'Capital - Labor')).toBe(true)
    expect(shown(host, 'Expense - Services')).toBe(true)
  })

  it('collapsed by default (tree_collapsed): starts at Expand all', async () => {
    const host = await mount(true)
    expect(shown(host, 'Capital - Labor')).toBe(false)
    expect(toggle(host)?.textContent).toBe('Expand all')
    await act(async () => toggle(host)?.click())
    expect(shown(host, 'Capital - Labor')).toBe(true)
  })

  it('a flat table has no toggle', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryTable rows={rows} config={{ columns: [{ field: 'category' }] } as never} />
      )
    )
    expect(toggle(host)).toBeNull()
  })
})
