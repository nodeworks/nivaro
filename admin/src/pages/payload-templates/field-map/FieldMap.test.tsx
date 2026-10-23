import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Field, MapSpec } from '../api'
import { FieldMap } from './FieldMap'

// Count FieldRow renders (the real component, wrapped) — the 200-row test asserts on it.
const renders = vi.hoisted(() => ({ rows: 0 }))
vi.mock('./FieldRow', async (orig) => {
  const real = (await orig()) as typeof import('./FieldRow')
  return {
    ...real,
    FieldRow: (p: Parameters<typeof real.FieldRow>[0]) => {
      renders.rows++
      return real.FieldRow(p)
    }
  }
})

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
/** Stands in for the shell replacing the draft (409 Reload, someone else's publish). */
let replaceFromOutside: (s: MapSpec) => void = () => {}
let key = 0

function Harness({
  problems = []
}: {
  problems?: { field_id: string; path: string; message: string; severity: 'error' | 'warning' }[]
}) {
  const [spec, setSpec] = useState(start)
  latest = spec
  replaceFromOutside = setSpec
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
          { field_id: 'gone', path: 'x', message: 'Row that is not in the map', severity: 'error' }
        ]}
      />
    )
    expect(screen.getAllByText('IR-36514 has no PO yet')).toHaveLength(1)
    expect(screen.getByText('MWF API has no token secret yet')).toBeInTheDocument()
    // a problem naming no row is never dropped — it shows above the map
    expect(screen.getByText('Row that is not in the map')).toBeInTheDocument()
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

  it('a keystroke re-renders only its own row (200 rows)', () => {
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
    renders.rows = 0
    for (let i = 0; i < 10; i++) fireEvent.change(inputs[100], { target: { value: `k${i}` } })
    expect(latest.fields[100].key).toBe('k9')
    // One keystroke re-renders the edited row only — never all 200.
    expect(renders.rows).toBe(10)
  })

  it('a row typed through the locked name stays editable and removable', () => {
    key++
    render(<Harness />)
    for (const k of ['e', 'efp_stat', 'efp_state'])
      fireEvent.change(keyInputs()[1], { target: { value: k } })
    expect(keyInputs()[1].readOnly).toBe(false)
    fireEvent.change(keyInputs()[1], { target: { value: 'efp_state_2' } })
    expect(latest.fields[1].key).toBe('efp_state_2')
    expect(keyInputs()[0].readOnly).toBe(true)
  })

  it('a draft replaced from outside while the map is open starts the undo history over', () => {
    key++
    render(<Harness />)
    fireEvent.change(keyInputs()[1], { target: { value: 'po' } })
    act(() => {
      replaceFromOutside({ v: 1, fields: [f('z', 'from_someone_else')] })
    })
    expect(keys()).toEqual(['from_someone_else'])
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true })
    expect(latest.fields.map((x) => x.key)).toEqual(['from_someone_else'])
    expect(screen.getByLabelText('Undo')).toBeDisabled()
  })

  it('a fixed number types naturally (1. → 1.5 → 1.50) and commits the number', () => {
    key++
    render(<Harness />)
    // turn po_number into a Number row, then open its value
    act(() => {
      fireEvent.click(screen.getAllByLabelText(/^Type: /)[1])
    })
    act(() => {
      fireEvent.click(screen.getByText('Number'))
    })
    act(() => {
      fireEvent.click(document.querySelectorAll<HTMLElement>('[data-value-chip]')[1])
    })
    const box = screen.getByPlaceholderText('0') as HTMLInputElement
    for (const t of ['1', '1.', '1.5', '1.50']) fireEvent.change(box, { target: { value: t } })
    expect(box.value).toBe('1.50')
    expect(latest.fields[1].value).toEqual({ source: 'fixed', value: 1.5 })
    fireEvent.change(box, { target: { value: 'abc' } })
    expect(latest.fields[1].value).toEqual({ source: 'fixed', value: 'abc' })
  })

  it('the first If/then case keeps the current value as Otherwise', () => {
    key++
    render(<Harness />)
    act(() => {
      fireEvent.click(document.querySelectorAll<HTMLElement>('[data-value-chip]')[0])
    })
    const pop = document.querySelector('[data-field-map-popover]') as HTMLElement
    act(() => {
      fireEvent.click(within(pop).getByRole('tab', { name: /If \/ then/ }))
    })
    act(() => {
      fireEvent.click(within(pop).getByText('Add a case'))
    })
    const v = latest.fields[0].value as { source: string; cases: unknown[]; else?: unknown }
    expect(v.source).toBe('switch')
    expect(v.cases).toHaveLength(1)
    expect(v.else).toEqual({ source: 'builtin', name: 'state.label' })
  })
})
