// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isLeavingLink } from './leave-guard'

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
