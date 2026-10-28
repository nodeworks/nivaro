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
