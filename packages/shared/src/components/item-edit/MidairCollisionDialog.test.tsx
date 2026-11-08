// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LineCollision, lineConflictKey } from './line-midair'
import { LineCollisionDialog, MidairCollisionDialog } from './MidairCollisionDialog'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const line: LineCollision = {
  key: 'lines.workflow',
  rowId: '5',
  label: 'Line 3',
  conflicts: [
    { field: 'quantity', current_value: 9 },
    { field: 'price', current_value: 2 }
  ],
  latest: 31,
  mine: { quantity: 4, price: 3 }
}

const buttons = () => [...document.querySelectorAll('button')]
const byText = (t: string) => buttons().find((b) => b.textContent?.includes(t))

describe('LineCollisionDialog (grid + record form line chooser)', () => {
  it('names the line and field, shows theirs and mine, defaults to theirs', () => {
    const onResolve = vi.fn()
    act(() =>
      root.render(
        <LineCollisionDialog
          lines={[line]}
          fieldLabel={(f) => (f === 'quantity' ? 'Quantity' : '')}
          onCancel={() => {}}
          onResolve={onResolve}
        />
      )
    )
    // The portal host resolves after the anchor mounts.
    act(() => {})
    const text = document.body.textContent ?? ''
    expect(text).toContain('Someone else changed Line 3')
    expect(text).toContain('Line 3 · Quantity')
    expect(text).toContain('Line 3 · Price')
    act(() => byText('Apply')?.click())
    expect(onResolve).toHaveBeenCalledWith(
      new Set([lineConflictKey(line, 'quantity'), lineConflictKey(line, 'price')])
    )
  })

  it('picking Mine for one field leaves only the other on theirs', () => {
    const onResolve = vi.fn()
    act(() =>
      root.render(<LineCollisionDialog lines={[line]} onCancel={() => {}} onResolve={onResolve} />)
    )
    act(() => {})
    const mine = buttons().filter((b) => b.textContent?.includes('Mine (overwrite)'))
    act(() => mine[0].click())
    act(() => byText('Apply')?.click())
    expect(onResolve).toHaveBeenCalledWith(new Set([lineConflictKey(line, 'price')]))
  })

  it('cancel says so and calls onCancel', () => {
    const onCancel = vi.fn()
    act(() =>
      root.render(
        <LineCollisionDialog
          lines={[line, { ...line, rowId: '6', label: 'Line 4' }]}
          cancelLabel='Keep theirs'
          onCancel={onCancel}
          onResolve={() => {}}
        />
      )
    )
    act(() => {})
    expect(document.body.textContent).toContain('Someone else changed 2 lines')
    act(() => byText('Keep theirs')?.click())
    expect(onCancel).toHaveBeenCalled()
  })

  it('money reads as dollars without float artefacts, and each pair says which is picked (army 11 f4 M1)', () => {
    act(() =>
      root.render(
        <LineCollisionDialog
          lines={[
            {
              key: 'inventory_request_materials.inventory_request',
              rowId: '163134',
              label: '100340 · Fiber splice tray',
              conflicts: [{ field: 'total', current_value: 10.5 }],
              latest: 9,
              mine: { total: 18.900000000000002 }
            }
          ]}
          onCancel={() => {}}
          onResolve={() => {}}
        />
      )
    )
    act(() => {})
    const text = document.body.textContent ?? ''
    expect(text).toContain('Someone else changed 100340 · Fiber splice tray')
    expect(text).toContain('$10.50')
    expect(text).toContain('$18.90')
    expect(text).not.toContain('18.900000000000002')
    const choices = [...document.querySelectorAll('fieldset[aria-labelledby] button[aria-pressed]')]
    expect(choices).toHaveLength(2)
    expect(choices[0].getAttribute('aria-pressed')).toBe('true')
    expect(choices[1].getAttribute('aria-pressed')).toBe('false')
    expect(
      document.querySelector('fieldset[aria-labelledby]')?.getAttribute('aria-labelledby')
    ).toBeTruthy()
  })

  it('Merge (Rob, army 11): nothing preselected, Save merged waits, preview recomputes, picks resolve', () => {
    const onResolve = vi.fn()
    const merge: LineCollision = {
      key: 'workflow_line_items.workflow',
      rowId: '475948',
      label: 'Line 1',
      conflicts: [
        { field: 'quantity', current_value: 110 },
        { field: 'amount', current_value: 110 },
        { field: 'price', current_value: 1 }
      ],
      latest: 41,
      mine: { quantity: 107, amount: 107, price: 1 },
      edit: { quantity: 107, amount: 107, price: 1, item_description: 'Splice kit', category: 66 },
      current: { id: 475948, quantity: 110, price: 1, amount: 110, category: 66 },
      derived: [{ field: 'amount', formula: 'item.price * item.quantity' }]
    }
    act(() =>
      root.render(
        <LineCollisionDialog
          lines={[merge]}
          onCancel={() => {}}
          onResolve={onResolve}
          hideField={(_l, f) => f === 'category'}
        />
      )
    )
    act(() => {})
    act(() => (document.querySelector('[data-resolve-mode="merge"]') as HTMLButtonElement).click())
    const text = () => document.body.textContent ?? ''
    expect(text()).toContain('Item Description: yours (Splice kit) — only you changed it')
    expect(text()).toContain('Price: you both set $1.00')
    expect(text()).toContain('Amount: worked out again from the merged values')
    expect(text()).toContain('Pick a value for 1 field to save')
    expect(text()).not.toContain('66')
    const picks = [...document.querySelectorAll('[data-merge-pick]')]
    expect(picks).toHaveLength(2)
    expect(picks.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true)
    const save = byText('Save merged') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    act(() => (document.querySelector('[data-merge-pick="mine"]') as HTMLButtonElement).click())
    expect(save.disabled).toBe(false)
    const preview = document.querySelector('[data-merge-preview]')?.textContent ?? ''
    expect(preview).toContain('Quantity 107')
    expect(preview).toContain('Amount $107.00')
    expect(preview).toContain('Item Description Splice kit')
    act(() => save.click())
    // Mine for quantity: only the same-value price and the derived amount stay theirs.
    expect(onResolve).toHaveBeenCalledWith(
      new Set([lineConflictKey(merge, 'amount'), lineConflictKey(merge, 'price')])
    )
  })
})

describe('record-level Merge (army 11)', () => {
  it('auto-merges same values, asks real conflicts with nothing preselected, previews, resolves by field', () => {
    const onResolve = vi.fn()
    act(() =>
      root.render(
        <MidairCollisionDialog
          collision={{
            conflicts: [
              { field: 'description', current_value: 'Lock test A B4' },
              { field: 'po_amount', current_value: 120 }
            ],
            mine: { description: 'Lock test A S2', po_amount: 120 }
          }}
          merge={{
            edit: { description: 'Lock test A S2', po_amount: 120, vendor: 753, notes_flag: true },
            current: { id: 1, description: 'Lock test A B4', po_amount: 120, vendor: 700 },
            hideField: (f) => f === 'vendor'
          }}
          fieldLabel={(f) => ({ description: 'Description', po_amount: 'PO amount' })[f] ?? f}
          onCancel={() => {}}
          onResolve={onResolve}
        />
      )
    )
    act(() => {})
    act(() => (document.querySelector('[data-resolve-mode="merge"]') as HTMLButtonElement).click())
    const text = document.body.textContent ?? ''
    expect(text).toContain('PO amount: you both set $120.00')
    expect(text).toContain('Description — you both changed it')
    expect(text).not.toContain('753')
    const save = byText('Save merged') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    act(() => (document.querySelector('[data-merge-pick="mine"]') as HTMLButtonElement).click())
    expect(document.querySelector('[data-merge-preview]')?.textContent).toContain(
      'Description Lock test A S2'
    )
    act(() => save.click())
    // Header keys are field names: only the same-value field stays theirs.
    expect(onResolve).toHaveBeenCalledWith(new Set(['po_amount']))
  })

  it('without merge facts the header chooser stays Theirs / Mine only', () => {
    act(() =>
      root.render(
        <MidairCollisionDialog
          collision={{ conflicts: [{ field: 'a', current_value: 1 }], mine: { a: 2 } }}
          fieldLabel={(f) => f}
          onCancel={() => {}}
          onResolve={() => {}}
        />
      )
    )
    act(() => {})
    expect(document.querySelector('[data-resolve-mode]')).toBeNull()
  })
})
