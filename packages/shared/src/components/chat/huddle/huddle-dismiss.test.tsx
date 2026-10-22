// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useCloseOnWindowBlur } from './huddle-dismiss'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function Menu() {
  const [open, setOpen] = useState(true)
  useCloseOnWindowBlur(open, () => setOpen(false))
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type='button'>More</button>
        </PopoverTrigger>
        <PopoverContent data-testid='menu'>Raise your hand</PopoverContent>
      </Popover>
      <p data-outside>Chat messages</p>
    </>
  )
}

const menuOpen = () => !!document.querySelector('[data-testid="menu"]')

async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('huddle popovers close when you go elsewhere', () => {
  it('a click anywhere else on the page closes it', async () => {
    act(() => root.render(<Menu />))
    await tick()
    expect(menuOpen()).toBe(true)
    const outside = document.querySelector('[data-outside]') as HTMLElement
    act(() => {
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    await tick()
    expect(menuOpen()).toBe(false)
  })

  it('focus leaving the window (another app, the mini-player, the screen picker, a frame) closes it', async () => {
    act(() => root.render(<Menu />))
    await tick()
    expect(menuOpen()).toBe(true)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    await tick()
    expect(menuOpen()).toBe(false)
  })
})
