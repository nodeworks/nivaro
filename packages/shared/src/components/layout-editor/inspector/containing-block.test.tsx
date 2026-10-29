// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { PanelBody } from '../panel-frame'
import { Setting } from './kit'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Every setting row carries an sr-only scope tag (position: absolute). Without a positioned
// ancestor inside the scroller those tags anchor to the page, escape the overflow-hidden app
// shell and stretch the document: the whole app scrolled past its bottom on the Rules tab.
describe('inspector containing blocks', () => {
  it('the panel body and each setting row are positioned', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() =>
      root.render(
        <PanelBody>
          <Setting k='field.x' label='X' effect='Does x.' />
        </PanelBody>
      )
    )
    expect(host.querySelector('[data-panel-body]')?.className).toMatch(/(^| )relative( |$)/)
    expect(host.querySelector('[data-setting-row]')?.className).toMatch(/(^| )relative( |$)/)
    expect(host.querySelector('[data-scope="form"]')?.className).toBe('sr-only')
    act(() => root.unmount())
  })
})
