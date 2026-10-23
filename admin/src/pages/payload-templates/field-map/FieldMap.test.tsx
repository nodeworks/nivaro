import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Field, MapSpec } from '../api'
import { FieldMap } from './FieldMap'

beforeAll(() => {
  // jsdom has neither
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= () => {}
})

const f = (id: string, key: string, extra: Partial<Field> = {}): Field => ({
  id,
  key,
  type: 'text',
  include: 'always',
  value: { source: 'fixed', value: '' },
  ...extra
})

const start: MapSpec = {
  v: 1,
  fields: [
    f('a', 'efp_state', { value: { source: 'builtin', name: 'state.label' } }),
    f('b', 'po_number', { include: 'not_empty' }),
    {
      id: 'g',
      key: 'lines',
      type: 'list',
      include: 'always',
      list: {
        source: 'context.materials',
        item: 'line',
        where: [{ field: 'line.quantity', op: 'gt', value: 0 }]
      },
      children: [f('c1', 'qty', { value: { source: 'path', path: 'line.quantity' } })]
    }
  ]
}

let latest: MapSpec = start
let key = 0

function Harness({
  problems = []
}: {
  problems?: { field_id: string; path: string; message: string; severity: 'error' | 'warning' }[]
}) {
  const [spec, setSpec] = useState(start)
  latest = spec
  return (
    <FieldMap
      spec={spec}
      onChange={setSpec}
      values={{ a: 'Submitted', b: 'PO-1', c1: 4 }}
      problems={problems}
      lockedKeys={['efp_state']}
      secretNames={['token']}
      collection='workflows'
      historyKey={`test-${key}`}
      partner='MWF'
    />
  )
}

const keyInputs = () => screen.getAllByLabelText('Key') as HTMLInputElement[]
const keys = () => keyInputs().map((i) => i.value)

describe('FieldMap', () => {
  it('renders rows as sentences with inline values, locks and the list header', () => {
    key++
    render(<Harness />)
    expect(keys()).toEqual(['efp_state', 'po_number', 'lines', 'qty'])
    expect(keyInputs()[0].readOnly).toBe(true)
    expect(screen.getByLabelText('Locked key')).toBeInTheDocument()
    expect(screen.getByText('Submitted')).toBeInTheDocument()
    expect(screen.getByText('PO-1')).toBeInTheDocument()
    expect(screen.getByText('material')).toBeInTheDocument()
    expect(screen.getByText('quantity > 0')).toBeInTheDocument()
    expect(screen.getByText('State')).toBeInTheDocument()
    expect(screen.getByText('Each line → Quantity')).toBeInTheDocument()
  })

  it('renames, flags a duplicate key at once, and undoes with ⌘Z', () => {
    key++
    render(<Harness />)
    fireEvent.change(keyInputs()[1], { target: { value: 'lines' } })
    expect(latest.fields[1].key).toBe('lines')
    expect(screen.getAllByText(/already called “lines”/)).toHaveLength(2)
    fireEvent.keyDown(keyInputs()[1], { key: 'z', metaKey: true })
    expect(latest.fields[1].key).toBe('po_number')
    fireEvent.keyDown(keyInputs()[1], { key: 'z', metaKey: true, shiftKey: true })
    expect(latest.fields[1].key).toBe('lines')
  })

  it('refuses to rename a locked key', () => {
    key++
    render(<Harness />)
    fireEvent.change(keyInputs()[0], { target: { value: 'state' } })
    expect(latest.fields[0].key).toBe('efp_state')
  })

  it('⌥↓ reorders within the group and ↓ moves focus to the next row', () => {
    key++
    render(<Harness />)
    keyInputs()[1].focus()
    fireEvent.keyDown(keyInputs()[1], { key: 'ArrowDown', altKey: true })
    expect(latest.fields.map((x) => x.key)).toEqual(['efp_state', 'lines', 'po_number'])
    const first = keyInputs()[0]
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(keyInputs()[1])
  })

  it('Enter on the add-row adds a field with that key and focuses its key', () => {
    key++
    render(<Harness />)
    const add = screen.getByLabelText('Add a field') as HTMLInputElement
    fireEvent.change(add, { target: { value: 'requestor' } })
    act(() => {
      fireEvent.keyDown(add, { key: 'Enter' })
    })
    expect(latest.fields.map((x) => x.key)).toEqual([
      'efp_state',
      'po_number',
      'lines',
      'requestor'
    ])
    expect((document.activeElement as HTMLInputElement).value).toBe('requestor')
    expect(add.value).toBe('')
  })

  it('shows server problems under their row and page problems above the map', () => {
    key++
    render(
      <Harness
        problems={[
          {
            field_id: 'b',
            path: 'po_number',
            message: 'IR-36514 has no PO yet',
            severity: 'warning'
          },
          {
            field_id: 'b',
            path: 'po_number',
            message: 'IR-36514 has no PO yet',
            severity: 'warning'
          },
          { field_id: '', path: '', message: 'MWF API has no token secret yet', severity: 'error' },
          { field_id: 'gone', path: 'x', message: 'stale', severity: 'error' }
        ]}
      />
    )
    expect(screen.getAllByText('IR-36514 has no PO yet')).toHaveLength(1)
    expect(screen.getByText('MWF API has no token secret yet')).toBeInTheDocument()
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('⌫ on a focused row removes it; a locked row stays', async () => {
    key++
    const { toast } = await import('sonner')
    const spy = vi.spyOn(toast, 'error').mockImplementation(() => 'x')
    render(<Harness />)
    const rows = document.querySelectorAll<HTMLElement>('[data-row-id]')
    rows[0].focus()
    fireEvent.keyDown(rows[0], { key: 'Backspace' })
    expect(latest.fields).toHaveLength(3)
    expect(spy).toHaveBeenCalled()
    rows[1].focus()
    fireEvent.keyDown(rows[1], { key: 'Backspace' })
    expect(latest.fields.map((x) => x.key)).toEqual(['efp_state', 'lines'])
  })

  it('the value popover switches source and commits as you type', () => {
    key++
    render(<Harness />)
    const chips = document.querySelectorAll<HTMLElement>('[data-value-chip]')
    // po_number's chip (fixed, empty)
    act(() => {
      fireEvent.click(chips[1])
    })
    const fixed = screen.getByPlaceholderText('Text to send') as HTMLInputElement
    fireEvent.change(fixed, { target: { value: 'PO' } })
    expect(latest.fields[1].value).toEqual({ source: 'fixed', value: 'PO' })
    act(() => {
      fireEvent.click(screen.getByRole('tab', { name: /Built-in/ }))
    })
    const pop = document.querySelector('[data-field-map-popover]') as HTMLElement
    act(() => {
      fireEvent.click(within(pop).getByText('Today’s date'))
    })
    expect(latest.fields[1].value).toEqual({ source: 'builtin', name: 'today' })
    // ⌘Z inside the popover undoes the map edit
    fireEvent.keyDown(within(pop).getByText('Today’s date'), { key: 'z', metaKey: true })
    expect(latest.fields[1].value).toEqual({ source: 'fixed', value: 'PO' })
  })

  it('stays quick with 200 rows', () => {
    key++
    const many: MapSpec = {
      v: 1,
      fields: Array.from({ length: 200 }, (_, i) => f(`r${i}`, `key_${i}`))
    }
    function Big() {
      const [spec, setSpec] = useState(many)
      latest = spec
      return (
        <FieldMap
          spec={spec}
          onChange={setSpec}
          values={{}}
          problems={[]}
          lockedKeys={[]}
          secretNames={[]}
          collection='workflows'
          historyKey={`big-${key}`}
        />
      )
    }
    render(<Big />)
    const inputs = keyInputs()
    expect(inputs).toHaveLength(200)
    const t0 = performance.now()
    for (let i = 0; i < 10; i++) fireEvent.change(inputs[100], { target: { value: `k${i}` } })
    const per = (performance.now() - t0) / 10
    expect(latest.fields[100].key).toBe('k9')
    // One keystroke re-renders one row (~10 ms in jsdom); every row re-rendering was ~180 ms.
    expect(per).toBeLessThan(80)
  })
})
