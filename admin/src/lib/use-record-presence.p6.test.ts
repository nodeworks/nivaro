import { describe, expect, it } from 'vitest'
import { pageFormField } from './use-record-presence'

/** A page form with one field, plus a drill sheet (role=dialog) holding another record's field. */
function setup() {
  document.body.innerHTML = `
    <div id="page">
      <div data-field="title"><input id="page-input" /></div>
    </div>
    <div id="elsewhere">
      <div data-field="loose"><input id="loose-input" /></div>
    </div>
    <div role="dialog" id="sheet">
      <div data-field="title"><input id="sheet-input" /></div>
    </div>`
  const $ = (id: string) => document.getElementById(id) as HTMLElement
  return { $, root: $('page') }
}

describe('pageFormField (P6 — only the page form is relayed)', () => {
  it('names a field inside the page form', () => {
    const { $, root } = setup()
    expect(pageFormField($('page-input'), root)).toBe('title')
  })

  it('never relays a field inside a dialog (drill sheet / peek holds another record)', () => {
    const { $, root } = setup()
    expect(pageFormField($('sheet-input'), root)).toBeNull()
    // Even with no root marked, a dialog never counts.
    expect(pageFormField($('sheet-input'), null)).toBeNull()
  })

  it('never relays a field outside the marked form root', () => {
    const { $, root } = setup()
    expect(pageFormField($('loose-input'), root)).toBeNull()
    expect(pageFormField($('loose-input'), null)).toBe('loose')
  })

  it('still relays when the page form itself is hosted in a dialog', () => {
    document.body.innerHTML = `
      <div role="dialog" id="host">
        <div id="root">
          <div data-field="title"><input id="own" /></div>
          <div role="dialog"><div data-field="vendor"><input id="nested" /></div></div>
        </div>
      </div>`
    const root = document.getElementById('root')
    expect(pageFormField(document.getElementById('own'), root)).toBe('title')
    // A dialog opened from that form (inside the root) still never relays.
    expect(pageFormField(document.getElementById('nested'), root)).toBeNull()
    // The root may itself be the dialog element.
    const host = document.getElementById('host')
    expect(pageFormField(document.getElementById('own'), host)).toBe('title')
  })

  it('ignores targets without a field wrapper', () => {
    const { root } = setup()
    expect(pageFormField(root, root)).toBeNull()
    expect(pageFormField(null, root)).toBeNull()
  })
})
