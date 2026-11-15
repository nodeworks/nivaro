// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LayoutSwitch, useSmoothLayout } from './layout-switch'
import type { ActiveLayoutData, CMSField } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const layout = (id: number) =>
  ({ layout: { id, name: `L${id}` }, groups: [], assignments: [] }) as unknown as ActiveLayoutData

let host: HTMLDivElement
let root: Root
let shown: ActiveLayoutData | null | undefined

function Harness(props: {
  f: ActiveLayoutData | undefined
  enabled: boolean
  prepare: (id: number) => Promise<CMSField[] | null>
  onSwitch: (sw: LayoutSwitch) => void
}) {
  shown = useSmoothLayout(props.f, props).shown
  return null
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (p: Parameters<typeof Harness>[0]) =>
  act(() => root.render(createElement(Harness, p)))

describe('useSmoothLayout (rt8 #18)', () => {
  it('shows the first form at once and a refreshed same form straight through', () => {
    const prepare = vi.fn(async () => [])
    const a = layout(1)
    render({ f: a, enabled: true, prepare, onSwitch: vi.fn() })
    expect(shown).toBe(a)
    const a2 = layout(1)
    render({ f: a2, enabled: true, prepare, onSwitch: vi.fn() })
    expect(shown).toBe(a2)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('keeps the old form until the new one is ready, then switches and says so', async () => {
    let resolve: (v: CMSField[]) => void = () => {}
    const prepare = vi.fn(() => new Promise<CMSField[]>((r) => (resolve = r)))
    const onSwitch = vi.fn()
    const a = layout(1)
    const b = layout(2)
    render({ f: a, enabled: true, prepare, onSwitch })
    render({ f: b, enabled: true, prepare, onSwitch })
    expect(shown).toBe(a)
    expect(prepare).toHaveBeenCalledWith(2)
    await act(async () => resolve([]))
    expect(shown).toBe(b)
    expect(onSwitch).toHaveBeenCalledTimes(1)
    expect(onSwitch.mock.calls[0][0]).toMatchObject({ from: a, to: b })
  })

  it('off (a new record, a pinned form, design mode): every answer passes through', () => {
    const prepare = vi.fn(async () => [])
    render({ f: layout(1), enabled: false, prepare, onSwitch: vi.fn() })
    const b = layout(2)
    render({ f: b, enabled: false, prepare, onSwitch: vi.fn() })
    expect(shown).toBe(b)
    expect(prepare).not.toHaveBeenCalled()
  })
})
