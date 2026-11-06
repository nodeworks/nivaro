// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider, ParentDraftContext, type ParentDraftContextValue } from '../../context'
import { CascadeEffectController, type CascadeRule, cascadeParentKey } from './helpers'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Army 2026-11-05 a02-2: a unit created with Unit Type 38 showed it empty and
// dirty — clear_on_parent_change cleared on ANY cascade filter change,
// including the filter settling after Create. It now clears only when the
// person changed the parent's value.

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

const rules: CascadeRule[] = [
  { parent_field: 'site', filter_column: 'site', clear_on_parent_change: true } as CascadeRule
]
const client = { request: vi.fn(async () => ({ data: [] })) }

function render(
  filter: Record<string, unknown>,
  ctx: ParentDraftContextValue | null,
  onClear: () => void
) {
  const controller = (
    <CascadeEffectController
      cascadeRules={rules}
      cascadeFilter={filter}
      currentValue={38}
      relatedCollection='unit_types'
      onClear={onClear}
    />
  )
  act(() => {
    root.render(
      <NivaroProvider client={client as never}>
        {ctx ? (
          <ParentDraftContext.Provider value={ctx}>{controller}</ParentDraftContext.Provider>
        ) : (
          controller
        )}
      </NivaroProvider>
    )
  })
}

describe('CascadeEffectController clear_on_parent_change', () => {
  it('a filter that settles on its own (no parent change) keeps the value', () => {
    const onClear = vi.fn()
    const dirty = new Set(['site'])
    render({}, { draft: { site: 5 }, collection: 'units', dirtyFields: dirty }, onClear)
    render(
      { site: { _eq: 5 } },
      { draft: { site: 5 }, collection: 'units', dirtyFields: dirty },
      onClear
    )
    // the same pick reshaped by a reload is no change either
    render(
      { site: { _eq: '5' } },
      { draft: { site: { id: '5' } }, collection: 'units', dirtyFields: dirty },
      onClear
    )
    expect(onClear).not.toHaveBeenCalled()
  })

  it('clears when the person changed the parent', () => {
    const onClear = vi.fn()
    const dirty = new Set<string>()
    render(
      { site: { _eq: 5 } },
      { draft: { site: 5 }, collection: 'units', dirtyFields: dirty },
      onClear
    )
    dirty.add('site')
    render(
      { site: { _eq: 6 } },
      { draft: { site: 6 }, collection: 'units', dirtyFields: dirty },
      onClear
    )
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('clears when the filter follows the parent change a render later', () => {
    const onClear = vi.fn()
    const dirty = new Set(['site'])
    render(
      { site: { _eq: 5 } },
      { draft: { site: 5 }, collection: 'units', dirtyFields: dirty },
      onClear
    )
    render(
      { site: { _eq: 5 } },
      { draft: { site: 6 }, collection: 'units', dirtyFields: dirty },
      onClear
    )
    expect(onClear).not.toHaveBeenCalled()
    render(
      { site: { _eq: 6 } },
      { draft: { site: 6 }, collection: 'units', dirtyFields: dirty },
      onClear
    )
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('a parent that changed without the person (load) does not clear', () => {
    const onClear = vi.fn()
    const dirty = new Set<string>()
    render({}, { draft: {}, collection: 'units', dirtyFields: dirty }, onClear)
    render(
      { site: { _eq: 5 } },
      { draft: { site: 5 }, collection: 'units', dirtyFields: dirty },
      onClear
    )
    expect(onClear).not.toHaveBeenCalled()
  })

  it('a host without a parent draft keeps the old rule', () => {
    const onClear = vi.fn()
    render({ site: { _eq: 5 } }, null, onClear)
    render({ site: { _eq: 6 } }, null, onClear)
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

describe('cascadeParentKey', () => {
  it('compares picks by id', () => {
    expect(cascadeParentKey(5)).toBe('5')
    expect(cascadeParentKey({ id: 5 })).toBe('5')
    expect(cascadeParentKey('')).toBeNull()
    expect(cascadeParentKey([1, { id: 2 }])).toBe('1,2')
  })
})
