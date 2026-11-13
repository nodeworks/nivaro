// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TipLayer } from './TipLayer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// An app shell mounts one TipLayer for every page; some pages mount their own. Only one
// may listen at a time, and leaving such a page must not leave the shell without tips.

let root: Root
let host: HTMLDivElement
let showPage: (v: boolean) => void = () => {}

function Shell() {
  const [page, setPage] = useState(true)
  showPage = setPage
  return (
    <>
      {/* The page (and its own TipLayer) mounts first: child effects run before the shell's. */}
      {page && (
        <div>
          <TipLayer />
        </div>
      )}
      <TipLayer />
      <button type='button' data-tip='Field options'>
        x
      </button>
    </>
  )
}

const hover = async () =>
  act(async () => {
    host.querySelector('[data-tip]')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
const tips = () =>
  [...document.body.querySelectorAll('div')].filter((d) => d.textContent === 'Field options')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('TipLayer', () => {
  it('draws one tip with two mounted, and keeps working after the page that owned it goes', async () => {
    await act(async () => root.render(<Shell />))
    await hover()
    expect(tips()).toHaveLength(1)
    await act(async () => showPage(false))
    await hover()
    expect(tips()).toHaveLength(1)
  })
})

// A row's tip in a menu (the record's More menu: "Edit layout", "Dossier") was drawn under
// the row, over the row below it. Inside a menu it goes beside the menu instead.
describe('TipLayer in a menu', () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({})
    }) as DOMRect

  function Menu({ panelLeft }: { panelLeft: number }) {
    return (
      <>
        <TipLayer />
        <div
          data-nvr-header-menu-panel
          role='menu'
          ref={(el) => {
            if (el) el.getBoundingClientRect = () => rect(panelLeft, 100, 240, 200)
          }}
        >
          <button
            type='button'
            data-tip='Field options'
            ref={(el) => {
              if (el) el.getBoundingClientRect = () => rect(panelLeft + 4, 140, 232, 32)
            }}
          >
            Edit layout
          </button>
          <button type='button'>Delete</button>
        </div>
      </>
    )
  }
  const shownTip = () => tips()[0] as HTMLDivElement | undefined

  it('draws a menu row’s tip beside the menu, level with the row, never over the row below', async () => {
    await act(async () => root.render(<Menu panelLeft={600} />))
    await hover()
    const tip = shownTip()
    expect(tip).toBeDefined()
    const left = Number.parseFloat(tip?.style.left ?? '')
    const top = Number.parseFloat(tip?.style.top ?? '')
    expect(left).toBeLessThan(600)
    expect(top).toBeGreaterThanOrEqual(140)
    expect(top).toBeLessThan(172)
  })

  it('goes to the other side of the menu when there is no room on its left', async () => {
    await act(async () => root.render(<Menu panelLeft={4} />))
    await hover()
    expect(Number.parseFloat(shownTip()?.style.left ?? '')).toBeGreaterThanOrEqual(244)
  })
})
