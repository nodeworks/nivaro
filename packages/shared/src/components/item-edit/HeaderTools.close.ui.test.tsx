// @vitest-environment jsdom
import { act, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HeaderMenu, HeaderTools } from './HeaderTools'

// 2026-11-16 (Rob): on a record whose header had folded into ⋯, the clock opened Revision
// history but the ⋯ panel stayed on top of the dimmed page. A row that opens a sheet, a dialog
// or navigates closes the panel (and a nested More menu); the sheet it owns stays open.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  // The header row overflows, so HeaderTools folds into ⋯ (jsdom has no layout).
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).hasAttribute('data-nvr-header-row') ? 900 : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).hasAttribute('data-nvr-header-row') ? 400 : 0
    }
  })
})

/** A tool that owns a sheet (like RevisionsPanel): the sheet is portaled to body. */
function SheetTool({ label, stop }: { label: string; stop?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type='button'
        onClick={(e) => {
          if (stop) e.stopPropagation()
          setOpen(true)
        }}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div role='dialog' data-testid={`sheet-${label}`}>
            {label} sheet
          </div>,
          document.body
        )}
    </>
  )
}

/** A tool that opens a popover beside the panel (Quick pick): the panel must stay. */
function PopoverTool() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type='button' onClick={() => setOpen(true)}>
        Pick
      </button>
      {open &&
        createPortal(
          <div data-radix-popper-content-wrapper>
            <div role='dialog'>picker</div>
          </div>,
          document.body
        )}
    </>
  )
}

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  document.body.innerHTML = ''
})

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)))

function mount(children: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root?.render(
      <header data-nvr-header-row>
        <div>
          <HeaderTools>{children}</HeaderTools>
        </div>
      </header>
    )
  )
}

const panel = () => document.querySelector<HTMLElement>('[data-nvr-header-tools-panel]')
const panelShown = () => !!panel() && panel()?.style.display !== 'none'
const click = (el: Element | null | undefined) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
const byText = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)

describe('HeaderTools ⋯ panel', () => {
  it('closes when a tool opens a sheet, and the sheet stays open', async () => {
    mount(<SheetTool label='History' />)
    click(document.querySelector('[data-nvr-header-tools-btn]'))
    expect(panelShown()).toBe(true)
    click(byText('History'))
    await flush()
    expect(panelShown()).toBe(false)
    expect(document.querySelector('[data-testid="sheet-History"]')).not.toBeNull()
  })

  it('closes even when the tool stops the click from bubbling', async () => {
    mount(<SheetTool label='Videos' stop />)
    click(document.querySelector('[data-nvr-header-tools-btn]'))
    click(byText('Videos'))
    await flush()
    expect(panelShown()).toBe(false)
    expect(document.querySelector('[data-testid="sheet-Videos"]')).not.toBeNull()
  })

  it('stays open for a popover beside it', async () => {
    mount(<PopoverTool />)
    click(document.querySelector('[data-nvr-header-tools-btn]'))
    click(byText('Pick'))
    await flush()
    expect(panelShown()).toBe(true)
  })

  it('closes when a tool navigates', async () => {
    mount(
      <button type='button' onClick={() => window.history.pushState({}, '', '/elsewhere')}>
        Go
      </button>
    )
    click(document.querySelector('[data-nvr-header-tools-btn]'))
    click(byText('Go'))
    await flush()
    expect(panelShown()).toBe(false)
  })

  it('closes the nested More menu and the panel when a More row opens a dialog', async () => {
    mount(
      <HeaderMenu>
        <SheetTool label='Clone' />
      </HeaderMenu>
    )
    click(document.querySelector('[data-nvr-header-tools-btn]'))
    click(document.querySelector('[data-nvr-header-menu-btn]'))
    const menu = () => document.querySelector<HTMLElement>('[data-nvr-header-menu-panel]')
    expect(menu()?.style.display).not.toBe('none')
    click(byText('Clone'))
    await flush()
    expect(menu()?.style.display).toBe('none')
    expect(panelShown()).toBe(false)
    expect(document.querySelector('[data-testid="sheet-Clone"]')).not.toBeNull()
  })
})
