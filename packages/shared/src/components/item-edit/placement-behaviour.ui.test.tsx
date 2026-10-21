// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { type FieldAffordances, FieldAffordancesContext } from './FieldAffordances'
import { FieldRow } from './FieldRow'
import type { CMSField } from './types'

// The record page side of the placement behaviour settings: what FieldRow
// draws for a label rule, a recommended field, a counter, Repeat last and a
// display formula.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  })
}))

let host: HTMLDivElement
let root: Root
const asked: string[] = []

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  asked.length = 0
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const client = {
  request: vi.fn(async (cmd: { _path: string; _query?: Record<string, unknown> }) => {
    asked.push(cmd._path)
    if (cmd._path === '/revisions/my-last-value')
      return { data: { value: 'Acme', item: 'r1', at: '2026-10-20T10:00:00.000Z' } }
    return { data: [] }
  })
}

const f = (field: string, extra: Partial<CMSField> = {}): CMSField => ({
  field,
  type: 'string',
  interface: 'input',
  label: field,
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
  layout_assigned: true,
  ...extra
})

const affordances = (stateKey: string | null): FieldAffordances => ({
  remoteChanges: {},
  dismissRemoteChange: () => {},
  lockReasons: {},
  applyToLines: {},
  placementText: { stateKey, roleId: null }
})

async function draw(
  field: CMSField,
  draft: Record<string, unknown>,
  onChange = vi.fn(),
  stateKey: string | null = null
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <FieldAffordancesContext.Provider value={affordances(stateKey)}>
            <FieldRow
              field={field}
              draft={draft}
              onChange={onChange}
              relations={[]}
              collection='orders'
              itemId='r9'
              visible
              locked={false}
            />
          </FieldAffordancesContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
  return onChange
}

describe('FieldRow placement behaviour', () => {
  it('reads the label rule for the record state (#2703)', async () => {
    const field = f('due', {
      label: 'Requested date',
      _overrides: {
        text_rules: [{ type: 'pipeline_state', state_keys: ['done'], label: 'Delivered date' }]
      }
    })
    await draw(field, {}, vi.fn(), 'done')
    expect(host.querySelector('[data-field-label]')?.textContent).toContain('Delivered date')
    await draw(field, {}, vi.fn(), 'open')
    expect(host.querySelector('[data-field-label]')?.textContent).toContain('Requested date')
  })

  it('marks a recommended field amber, never as required (#2704)', async () => {
    await draw(f('po', { _overrides: { recommended: true } }), {})
    expect(host.querySelector('[data-recommended]')).toBeTruthy()
    expect(host.querySelector('.text-destructive')).toBeNull()
  })

  it('counts words against the limit (#2709)', async () => {
    await draw(f('summary', { _overrides: { counter: { unit: 'words', limit: 3 } } }), {
      summary: 'one two three four'
    })
    const c = host.querySelector('[data-field-counter]')
    expect(c?.getAttribute('data-field-counter')).toBe('over')
    expect(c?.textContent).toContain('4 / 3 words')
  })

  it('fills the last value this person entered (#2706)', async () => {
    const onChange = await draw(f('vendor_name', { _overrides: { repeat_last: true } }), {})
    const btn = host.querySelector('[data-repeat-last="vendor_name"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    await act(async () => {
      btn.click()
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(asked).toContain('/revisions/my-last-value')
    expect(onChange).toHaveBeenCalledWith('vendor_name', 'Acme')
  })

  it('shows a display formula computed from the form, with no input (#2712)', async () => {
    await draw(
      f('__calc_1__', {
        label: 'Remaining',
        interface: 'display-formula',
        readonly: true,
        type: 'alias',
        _overrides: {
          label: 'Remaining',
          display_formula: { expr: '{{budget}} - {{committed}}', format: 'currency' }
        }
      }),
      { budget: 1000, committed: 250.5 }
    )
    expect(host.querySelector('[data-display-formula]')?.textContent).toContain('$749.50')
    expect(host.querySelector('input')).toBeNull()
  })
})
