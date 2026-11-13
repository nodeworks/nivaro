// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useStartsOpen } from './use-starts-open'

// 2026-11-13: flipping "Starts open" in the layout editor did nothing on the canvas until a
// reload — every panel copied the setting once at mount.
let host: HTMLDivElement
let root: Root
let api: { open: boolean; setOpen: (v: boolean) => void }
function Probe({ startsOpen, fallback }: { startsOpen: boolean | undefined; fallback: boolean }) {
  const [open, setOpen] = useStartsOpen(startsOpen, fallback)
  api = { open, setOpen }
  return null
}
const render = (startsOpen: boolean | undefined, fallback = false) =>
  act(() => root.render(<Probe startsOpen={startsOpen} fallback={fallback} />))

beforeEach(() => {
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => act(() => root.unmount()))

describe('useStartsOpen', () => {
  it('follows each change of the setting, without a remount', () => {
    render(true)
    expect(api.open).toBe(true)
    render(false)
    expect(api.open).toBe(false)
    render(true)
    expect(api.open).toBe(true)
  })

  it('keeps what the person did while the setting stays the same', () => {
    render(true)
    act(() => api.setOpen(false))
    render(true)
    expect(api.open).toBe(false)
  })

  it('uses the fallback until the layout says, then the layout', () => {
    render(undefined, true)
    expect(api.open).toBe(true)
    render(false, true)
    expect(api.open).toBe(false)
  })
})
