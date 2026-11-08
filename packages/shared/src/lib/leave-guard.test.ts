// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isLeavingControl, isLeavingLink, replayLeave } from './leave-guard'

const here = { origin: window.location.origin, pathname: '/records/workflows/new', search: '' }
const click = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false
}

function link(
  href: string,
  attrs: Record<string, string> = {},
  parent: HTMLElement = document.body
) {
  const a = document.createElement('a')
  a.href = href
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v)
  parent.appendChild(a)
  return a
}

describe('isLeavingLink', () => {
  it('holds a plain click on an in-app link to another page', () => {
    expect(isLeavingLink(click, link('/dashboard'), here)).toBe(true)
  })

  it('lets new-tab, modified, foreign, same-page and download clicks through', () => {
    expect(isLeavingLink(click, link('/dashboard', { target: '_blank' }), here)).toBe(false)
    expect(isLeavingLink({ ...click, metaKey: true }, link('/dashboard'), here)).toBe(false)
    expect(isLeavingLink({ ...click, button: 1 }, link('/dashboard'), here)).toBe(false)
    expect(isLeavingLink({ ...click, defaultPrevented: true }, link('/dashboard'), here)).toBe(
      false
    )
    expect(isLeavingLink(click, link('https://example.com/x'), here)).toBe(false)
    expect(isLeavingLink(click, link('/records/workflows/new'), here)).toBe(false)
    expect(isLeavingLink(click, link('/api/files/1', { download: '' }), here)).toBe(false)
    expect(isLeavingLink(click, null, here)).toBe(false)
  })

  it('leaves links inside the form, or in a dialog the form does not live in, to them', () => {
    const form = document.createElement('div')
    document.body.appendChild(form)
    expect(isLeavingLink(click, link('/records/units/1', {}, form), here, form)).toBe(false)
    const sheet = document.createElement('div')
    sheet.setAttribute('role', 'dialog')
    document.body.appendChild(sheet)
    expect(isLeavingLink(click, link('/records/units/2', {}, sheet), here, form)).toBe(false)
    // The form inside a sheet: a link elsewhere in that sheet still leaves.
    sheet.appendChild(form)
    expect(isLeavingLink(click, link('/dashboard', {}, sheet), here, form)).toBe(true)
  })
})

describe('isLeavingControl (army11 f3: New ▸ PO Request left without asking)', () => {
  const click = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false
  }
  it('holds a control that opts in', () => {
    const b = document.createElement('button')
    b.setAttribute('data-leave-guard', '')
    document.body.appendChild(b)
    expect(isLeavingControl(click, b)).toBe(true)
    expect(isLeavingControl({ ...click, metaKey: true }, b)).toBe(false)
    b.remove()
  })
  it('ignores controls without the marker and ones inside the form', () => {
    const form = document.createElement('div')
    const b = document.createElement('button')
    form.appendChild(b)
    expect(isLeavingControl(click, b)).toBe(false)
    b.setAttribute('data-leave-guard', '')
    expect(isLeavingControl(click, b, form)).toBe(false)
  })
})

describe('replayLeave (army11 review #2: Leave did nothing on the New menu)', () => {
  it('clicks a control still on the page', () => {
    const b = document.createElement('button')
    document.body.appendChild(b)
    let clicks = 0
    b.addEventListener('click', () => clicks++)
    expect(replayLeave(b, '/records/workflows/new', () => {})).toBe('clicked')
    expect(clicks).toBe(1)
    b.remove()
  })
  it('a menu row unmounted before Leave goes to its path through the host navigate', () => {
    const b = document.createElement('button')
    const go: string[] = []
    expect(replayLeave(b, '/records/workflows/new', (p) => go.push(p))).toBe('navigated')
    expect(go).toEqual(['/records/workflows/new'])
  })
  it('nothing to replay: says so instead of pretending', () => {
    expect(replayLeave(document.createElement('button'), null, () => {})).toBe('lost')
  })
})
