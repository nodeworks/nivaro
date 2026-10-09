// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  accessibleName,
  describeClickTarget,
  findStepElement,
  hookSelector,
  normalizePath,
  roleOf,
  stableHook,
  stepMatchesHere,
  stepScreen
} from './target'

const html = (s: string) => {
  document.body.innerHTML = s
}
const $ = (sel: string) => document.querySelector(sel) as Element
const always = { visible: () => true, inView: () => true }

afterEach(() => {
  document.body.innerHTML = ''
})

describe('accessibleName and roleOf', () => {
  it('prefers aria-label, then labelledby, then visible text', () => {
    html(`
      <button id='a' aria-label='Approve request'><svg></svg></button>
      <span id='lbl'>Send back</span><button id='b' aria-labelledby='lbl'>x</button>
      <a id='c' href='/x'>  Open   the record </a>`)
    expect(accessibleName($('#a'))).toBe('Approve request')
    expect(accessibleName($('#b'))).toBe('Send back')
    expect(accessibleName($('#c'))).toBe('Open the record')
    expect(roleOf($('#a'))).toBe('button')
    expect(roleOf($('#c'))).toBe('link')
  })

  it('names a field by its label only, never its value', () => {
    html(`
      <label for='t'>Vendor name</label><input id='t' value='ACME secret'>
      <label>Notes <textarea id='n'>typed text</textarea></label>
      <input id='p' type='password' placeholder='Password' value='hunter2'>
      <div id='cb' role='combobox' aria-label='Region'>Zone 1 private</div>
      <input id='q'>`)
    expect(accessibleName($('#t'))).toBe('Vendor name')
    expect(accessibleName($('#n'))).toBe('Notes')
    expect(accessibleName($('#p'))).toBe('Password')
    expect(accessibleName($('#cb'))).toBe('Region')
    expect(accessibleName($('#q'))).toBe('')
    expect(roleOf($('#t'))).toBe('textbox')
    expect(roleOf($('#p'))).toBe('textbox')
  })

  it('names a field by an unattached label just above it', () => {
    html(`<div data-field='created'><div><label>Created<span>*</span></label></div>
      <div><input id='f' value='2026-10-09'></div></div>
      <div><label>Other</label><input id='g'><input id='h'></div>`)
    expect(accessibleName($('#f'))).toBe('Created')
    // Two fields share the wrapper: the label cannot be told apart, so none.
    expect(accessibleName($('#h'))).toBe('')
  })

  it('caps the name at 80 characters', () => {
    html(`<button id='x'>${'word '.repeat(40)}</button>`)
    expect(accessibleName($('#x')).length).toBeLessThanOrEqual(80)
  })
})

describe('stableHook', () => {
  it('skips state and library attributes and finds one up the tree', () => {
    html(
      `<div data-hv-pick='v1'><button id='b' data-state='open' data-radix-x='1'>Go</button></div>`
    )
    expect(stableHook($('#b'))).toBe('data-hv-pick=v1')
  })
  it('keeps an attribute without a value as its name', () => {
    html(`<button id='b' data-hv-add-ripples>Add</button>`)
    expect(stableHook($('#b'))).toBe('data-hv-add-ripples')
  })
  it('refuses values with quotes', () => {
    html(`<button id='b' data-x='a"b'>Go</button>`)
    expect(stableHook($('#b'))).toBeUndefined()
  })
})

describe('describeClickTarget', () => {
  it('describes the nearest interactive ancestor', () => {
    html(`<button id='b' data-save>  <span id='s'>Save</span></button>`)
    expect(describeClickTarget($('#s'), { pageKey: 'records', path: '/x/12?q=1' })).toEqual({
      label: 'Save',
      role: 'button',
      hook: 'data-save',
      page_key: 'records',
      path: '/x/12'
    })
  })
  it('keeps nothing inside a masked area or the walk', () => {
    html(`<div class='nvr-no-record'><button id='a'>Pay</button></div>
      <div data-nvr-no-record><button id='b'>Pay</button></div>
      <div data-hv-walk><button id='c'>Next</button></div>`)
    expect(describeClickTarget($('#a'))).toEqual({})
    expect(describeClickTarget($('#b'))).toEqual({})
    expect(describeClickTarget($('#c'))).toEqual({})
  })
  it('never stores a typed value for a field', () => {
    html(`<label for='t'>Search</label><input id='t' value='my secret'>`)
    const d = describeClickTarget($('#t'))
    expect(d).toMatchObject({ label: 'Search', role: 'textbox' })
    expect(JSON.stringify(d)).not.toContain('secret')
  })
})

describe('paths and screens', () => {
  it('folds record ids', () => {
    expect(normalizePath('/collections/workflows/371367')).toBe('/collections/workflows/:id')
    expect(normalizePath('/records/workflows/CR26-80329/')).toBe('/records/workflows/:id')
    expect(normalizePath('/x/0c30566d-d246-4079-b823-2b0551b2c461?y=1')).toBe('/x/:id')
    expect(normalizePath('/help-videos')).toBe('/help-videos')
  })
  it('matches by page key, else by path shape', () => {
    const here = { pageKey: 'budget', path: '/collections/workflows/9' }
    expect(stepMatchesHere({ page_key: 'budget', path: '/other' }, here)).toBe(true)
    expect(stepMatchesHere({ page_key: null, path: '/collections/workflows/12' }, here)).toBe(true)
    expect(stepMatchesHere({ page_key: 'queues', path: '/queues' }, here)).toBe(false)
    expect(stepScreen({ page_key: null, path: null }, here)).toBe('here')
    expect(stepScreen({ page_key: 'queues', path: null }, here)).toBe('elsewhere')
  })
})

describe('findStepElement', () => {
  it('finds by hook first, then by role and name', () => {
    html(`
      <button data-hv-pick='v1'>Watch</button>
      <button id='two'>Approve</button>
      <a id='link' href='/a'>Approve</a>`)
    expect(
      findStepElement({ label: 'Watch', role: 'button', hook: 'data-hv-pick=v1' }, always)
    ).toBe($('[data-hv-pick]'))
    expect(findStepElement({ label: 'approve', role: 'button', hook: null }, always)).toBe(
      $('#two')
    )
    expect(findStepElement({ label: 'Approve', role: 'link', hook: 'data-gone' }, always)).toBe(
      $('#link')
    )
  })

  it('looks inside a hooked ancestor for the named element', () => {
    html(`<div data-row='1'><button>Edit</button><button id='del'>Delete</button></div>`)
    expect(findStepElement({ label: 'Delete', role: 'button', hook: 'data-row=1' }, always)).toBe(
      $('#del')
    )
  })

  it('keeps a renamed hooked element of the same kind, never a hooked wrapper', () => {
    html(`<button id='n' data-hv-button='3'>Videos (3)</button>
      <div data-group><button hidden>History</button></div>`)
    expect(
      findStepElement({ label: 'Videos (2)', role: 'button', hook: 'data-hv-button=3' }, always)
    ).toBe($('#n'))
    expect(
      findStepElement(
        { label: 'History', role: 'button', hook: 'data-group' },
        { visible: (el) => !el.closest('[hidden]'), inView: () => true }
      )
    ).toBeNull()
  })

  it('prefers a match in the viewport and skips invisible ones', () => {
    html(`<button id='a'>Save</button><button id='b'>Save</button><button id='c'>Save</button>`)
    const found = findStepElement(
      { label: 'Save', role: 'button', hook: null },
      { visible: (el) => el.id !== 'a', inView: (el) => el.id === 'c' }
    )
    expect(found).toBe($('#c'))
  })

  it('returns null when nothing matches', () => {
    html(`<button>Cancel</button>`)
    expect(findStepElement({ label: 'Approve', role: 'button', hook: null }, always)).toBeNull()
  })

  it('matches a step without a role by the deepest element with that text', () => {
    html(`<table><tr><td id='cell'><span id='t'>CR26-80329</span></td></tr></table>`)
    expect(findStepElement({ label: 'CR26-80329', role: null, hook: null }, always)).toBe($('#t'))
  })

  it('never matches the walk overlay itself', () => {
    html(`<div data-hv-walk><button>Next</button></div>`)
    expect(findStepElement({ label: 'Next', role: 'button', hook: null }, always)).toBeNull()
  })

  it('builds hook selectors only from stored shapes', () => {
    expect(hookSelector('data-a=b c')).toBe('[data-a="b c"]')
    expect(hookSelector('data-a')).toBe('[data-a]')
    expect(hookSelector('onclick=x')).toBeNull()
  })
})
