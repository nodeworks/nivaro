// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider, ParentDraftContext } from '../../context'
import {
  cascadeClearText,
  cascadeRootParent,
  joinLabels,
  notePersonLinkEdit
} from './cascade-clear-notice'
import { CascadeEffectController, type CascadeRule } from './helpers'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Rob 2026-11-08 (army 11): changing Zone clears a Region that is NOT available
// for the new Zone, down the chain; a Region that still fits stays. The rule is
// `clear_on_unavailable` (efp-ops cascade-auto-clear.ts turns it on).

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
  { parent_field: 'division', filter_column: 'division', clear_on_unavailable: true } as CascadeRule
]

async function run(availableIds: number[], zone: number, dirty: Set<string>) {
  const onClear = vi.fn()
  const client = {
    request: vi.fn(async () => ({
      data: availableIds.includes(7) ? [{ id: 7 }] : []
    }))
  }
  await act(async () => {
    root.render(
      <NivaroProvider client={client as never}>
        <ParentDraftContext.Provider
          value={{
            draft: { division: zone, region: 7 },
            collection: 'inventory_request',
            dirtyFields: dirty
          }}
        >
          <CascadeEffectController
            cascadeRules={rules}
            cascadeFilter={{ division: { _eq: zone } }}
            currentValue={7}
            relatedCollection='regions'
            onClear={onClear}
          />
        </ParentDraftContext.Provider>
      </NivaroProvider>
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return { onClear, client }
}

describe('cascade auto-clear (clear_on_unavailable)', () => {
  it('clears Region when the person changed Zone and Region is not in the new Zone', async () => {
    const { onClear, client } = await run([], 1, new Set(['division']))
    expect(client.request).toHaveBeenCalledTimes(1)
    expect(onClear).toHaveBeenCalledTimes(1)
  })
  it('keeps Region when it is still available for the new Zone', async () => {
    const { onClear, client } = await run([7], 3, new Set(['division']))
    expect(client.request).toHaveBeenCalledTimes(1)
    expect(onClear).not.toHaveBeenCalled()
  })
  it('never clears a value on a record that only loaded (Zone not changed by the person)', async () => {
    const { onClear, client } = await run([], 1, new Set())
    expect(client.request).not.toHaveBeenCalled()
    expect(onClear).not.toHaveBeenCalled()
  })
})

describe('cascade clear notice', () => {
  it('names what was cleared and the field the person changed', () => {
    expect(joinLabels(['Region'])).toBe('Region')
    expect(joinLabels(['Region', 'Project', 'Sub Type'])).toBe('Region, Project and Sub Type')
    expect(cascadeClearText(['Region', 'Project'], 'Zone')).toBe(
      'Region and Project cleared — not available for the Zone you picked'
    )
  })
  it('the root is the changed parent, not a child cleared in the same chain', () => {
    const notes = [
      { field: 'region', label: 'Region', parents: ['division'] },
      { field: 'project', label: 'Project', parents: ['division', 'region', 'funding_year'] }
    ]
    const seq = (f: string) => ({ division: 9, funding_year: 2 })[f] ?? -1
    expect(cascadeRootParent(notes, seq)).toBe('division')
  })
})

describe('a person-changed linked parent (army11 browser check: Zone 1 → 2 kept Region BLT)', () => {
  const state = () => {
    let n = 10
    return { touched: new Set<string>(), seq: new Map<string, number>(), next: () => ++n }
  }
  it('a Zone pick (M2M) counts as the person changing Zone, so Region is judged', () => {
    const s = state()
    expect(notePersonLinkEdit(s, 'divisions', { crossFill: 0, notPerson: 0 })).toBe(true)
    expect(s.touched.has('divisions')).toBe(true)
    expect(s.seq.get('divisions')).toBe(11)
  })
  it('a link the form filled itself (cross-record default, import) is not the person', () => {
    const s = state()
    expect(notePersonLinkEdit(s, 'divisions', { crossFill: 1, notPerson: 0 })).toBe(false)
    expect(notePersonLinkEdit(s, 'divisions', { crossFill: 0, notPerson: 1 })).toBe(false)
    expect(s.touched.size).toBe(0)
  })
  it('the notice names Zone, not an older Project Type pick', () => {
    const s = state()
    notePersonLinkEdit(s, 'project_type', { crossFill: 0, notPerson: 0 }) // earlier pick
    notePersonLinkEdit(s, 'divisions', { crossFill: 0, notPerson: 0 }) // the Zone change
    notePersonLinkEdit(s, 'regions', { crossFill: 0, notPerson: 0 }) // the clear itself
    const notes = [
      { field: 'regions', label: 'Region', parents: ['divisions', 'project'] },
      { field: 'project', label: 'Project', parents: ['divisions', 'regions', 'project_type'] }
    ]
    expect(cascadeRootParent(notes, (f) => s.seq.get(f) ?? -1)).toBe('divisions')
  })
})
