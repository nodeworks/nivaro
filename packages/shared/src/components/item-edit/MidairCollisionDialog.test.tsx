// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LineCollision, lineConflictKey } from './line-midair'
import { LineCollisionDialog } from './MidairCollisionDialog'

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
})
