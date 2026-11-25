// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { registerHostDisplay } from '../../lib/host-displays'
import { hostDisplayKey, isHostDisplayField } from '../../lib/placement-behaviour'
import { HostDisplayValue, isDisplayFormulaRow, isHostDisplayRow } from './placement-behaviour'

// `__host_<key>__` placements: a read-only row the host app draws from the live draft
// (EFP's Net terms row in workflow Details, 2026-11-25).

describe('host display placements', () => {
  it('names and keys', () => {
    expect(isHostDisplayField('__host_efp-net-terms__')).toBe(true)
    expect(hostDisplayKey('__host_efp-net-terms__')).toBe('efp-net-terms')
    expect(isHostDisplayField('__calc_1__')).toBe(false)
    expect(isHostDisplayField('vendor')).toBe(false)
    expect(isHostDisplayRow({ field: 'x', interface: 'host-display' })).toBe(true)
    // no column: no history, AI, personal default or input
    expect(isDisplayFormulaRow({ field: '__host_a__', interface: null })).toBe(true)
  })

  it('an unregistered key reads as a dash; a late registration redraws with the draft', () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    act(() =>
      root.render(
        <HostDisplayValue
          field='__host_test-late__'
          draft={{ vendor: 7 }}
          itemId='new'
          collection='workflows'
        />
      )
    )
    expect(el.textContent).toBe('—')
    act(() =>
      registerHostDisplay('test-late', ({ draft, itemId, collection }) => (
        <span>{`${collection} ${itemId} vendor ${String(draft.vendor)}`}</span>
      ))
    )
    expect(el.textContent).toBe('workflows new vendor 7')
    act(() => root.unmount())
  })
})
