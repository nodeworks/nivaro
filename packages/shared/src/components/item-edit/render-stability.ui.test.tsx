// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import type { FieldAffordances } from './FieldAffordances'
import { FieldRow } from './FieldRow'
import { useStableFieldAffordances } from './render-stability'
import type { CMSField, RenderFieldProps } from './types'

// The record form re-renders for many reasons that change nothing a field
// shows (presence, lock polls, save state). Rows are memoized; these pin that
// a parent re-render with the same props skips the row, and that the
// affordances context keeps its identity while its content is unchanged.
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

const client = { request: vi.fn(async () => ({ data: [] })) }

const field: CMSField = {
  field: 'description',
  type: 'string',
  interface: 'input',
  label: 'Description',
  required: false,
  hidden: false,
  readonly: false,
  sort: 0,
  group_key: 'main',
  options: null,
  computed_formula: null,
  computed_type: null,
  note: null,
  placeholder: null,
  repeater_schema: null,
  dependency_config: null,
  layout_assigned: true
}
const relations: never[] = []
const onChange = () => {}
// The form's remoteChanges is React state: the same object between renders.
const noRemoteChanges = {}

describe('FieldRow memo', () => {
  it('skips a parent re-render with the same props; renders on a draft change', async () => {
    const renders = vi.fn()
    const renderField = (p: RenderFieldProps) => {
      renders(p.value)
      return <input readOnly value={String(p.value ?? '')} />
    }
    let bump: () => void = () => {}
    let setDraft: (d: Record<string, unknown>) => void = () => {}
    function Host() {
      const [, setTick] = useState(0)
      const [draft, setD] = useState<Record<string, unknown>>({ description: 'North Vernon' })
      bump = () => setTick((t) => t + 1)
      setDraft = setD
      return (
        <FieldRow
          field={field}
          draft={draft}
          onChange={onChange}
          relations={relations}
          collection='workflows'
          itemId='372683'
          visible
          locked={false}
          renderField={renderField}
        />
      )
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <Host />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    const afterMount = renders.mock.calls.length
    await act(async () => bump())
    expect(renders.mock.calls.length).toBe(afterMount)
    await act(async () => setDraft({ description: 'Seymour' }))
    expect(renders.mock.calls.length).toBeGreaterThan(afterMount)
    expect(renders).toHaveBeenLastCalledWith('Seymour')
  })
})

describe('useStableFieldAffordances', () => {
  it('keeps one object while the content holds, and always calls the newest callbacks', async () => {
    const seen: FieldAffordances[] = []
    const calls: string[] = []
    let rerender: (n: number) => void = () => {}
    function Host() {
      const [n, setN] = useState(0)
      rerender = setN
      // Rebuilt on every render, the way the record form builds it.
      const value = useStableFieldAffordances({
        remoteChanges: noRemoteChanges,
        dismissRemoteChange: (f) => calls.push(`dismiss:${f}:${n}`),
        lockReasons: { description: n < 2 ? 'Locked' : 'Locked for your role' },
        applyToLines: {
          vendor: { label: 'Apply', count: 3, onApply: (v) => calls.push(`apply:${v}:${n}`) }
        },
        placementText: null
      })
      seen.push(value)
      return null
    }
    await act(async () => root.render(<Host />))
    await act(async () => rerender(1))
    expect(seen.at(-1)).toBe(seen[0])
    seen.at(-1)?.dismissRemoteChange('description')
    seen.at(-1)?.applyToLines.vendor.onApply('V1')
    expect(calls).toEqual(['dismiss:description:1', 'apply:V1:1'])
    expect(seen[0].takeRemoteChange).toBeUndefined()
    await act(async () => rerender(2))
    expect(seen.at(-1)).not.toBe(seen[0])
    expect(seen.at(-1)?.lockReasons.description).toBe('Locked for your role')
  })
})
