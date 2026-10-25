// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { type FieldAffordances, FieldAffordancesContext } from './FieldAffordances'
import { FieldRow } from './FieldRow'
import type { CMSField } from './types'

// A locked field (approval edit lock, someone else's edit lock, a state lock)
// is locked for the keyboard too: the overlay used to stop only the mouse, so
// Tab + typing edited the record, stored a draft and lit "Save all".
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

const affordances: FieldAffordances = {
  remoteChanges: {},
  dismissRemoteChange: () => {},
  lockReasons: { description: 'Locked while the record is in Waiting on Level 1 Approval' },
  applyToLines: {},
  placementText: { stateKey: null, roleId: null }
}

async function draw(locked: boolean, onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <FieldAffordancesContext.Provider value={affordances}>
            <FieldRow
              field={field}
              draft={{ description: 'North Vernon' }}
              onChange={onChange}
              relations={[]}
              collection='workflows'
              itemId='372683'
              visible
              locked={locked}
            />
          </FieldAffordancesContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  return onChange
}

/** Types like a keyboard user would: React reads the native value setter. */
function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    set?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('locked field', () => {
  it('takes the control out of focus and input, and drops edits', async () => {
    const onChange = await draw(true)
    const input = host.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.closest('[inert]')).toBeTruthy()
    type(input, 'North Vernon x')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('lets go of a caret already in the field when it locks', async () => {
    await draw(false)
    const input = host.querySelector('input') as HTMLInputElement
    act(() => input.focus())
    expect(document.activeElement).toBe(input)
    await draw(true)
    expect(document.activeElement).not.toBe(input)
  })

  it('an unlocked field still edits', async () => {
    const onChange = await draw(false)
    const input = host.querySelector('input') as HTMLInputElement
    expect(input.closest('[inert]')).toBeNull()
    type(input, 'North Vernon x')
    expect(onChange).toHaveBeenCalledWith('description', 'North Vernon x')
  })
})
