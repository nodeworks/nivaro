// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { describeTipTarget } from './TipLayer'

function el(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.firstElementChild as Element
}

describe('describeTipTarget (a11y A11Y-15)', () => {
  it('names an icon-only control from its tip', () => {
    const b = el('<button data-tip="Delete view"><svg></svg></button>')
    describeTipTarget(b)
    expect(b.getAttribute('aria-label')).toBe('Delete view')
  })

  it('describes a named control instead of renaming it', () => {
    const b = el('<button aria-label="Pin" data-tip="Pin this column to the left"></button>')
    describeTipTarget(b)
    expect(b.getAttribute('aria-label')).toBe('Pin')
    expect(b.getAttribute('aria-description')).toBe('Pin this column to the left')
  })

  it('skips a tip that repeats the element text (truncated value)', () => {
    const s = el('<span data-tip="Workflow Status">Workflow Status</span>')
    describeTipTarget(s)
    expect(s.hasAttribute('aria-description')).toBe(false)
    expect(s.hasAttribute('aria-label')).toBe(false)
  })

  it('never overwrites an existing description', () => {
    const b = el('<button aria-describedby="x" data-tip="More">Go</button>')
    describeTipTarget(b)
    expect(b.hasAttribute('aria-description')).toBe(false)
  })

  it('follows a tip that changed since the last focus', () => {
    const b = el('<button data-tip="Watch"><svg></svg></button>')
    describeTipTarget(b)
    b.setAttribute('data-tip', 'Stop watching')
    describeTipTarget(b)
    expect(b.getAttribute('aria-label')).toBe('Stop watching')
  })
})
