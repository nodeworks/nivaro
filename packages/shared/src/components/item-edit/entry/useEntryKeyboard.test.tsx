// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntryConfig } from '../../../lib/entry-config'
import { useEntryKeyboard } from './useEntryKeyboard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom lays nothing out: every element counts as visible.
beforeEach(() => {
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList
})

function Form({
  config,
  draft = {},
  save = () => {}
}: {
  config: EntryConfig
  draft?: Record<string, unknown>
  save?: () => void
}) {
  useEntryKeyboard({
    collection: 'orders',
    config,
    enabled: true,
    ready: true,
    recordKey: 'orders:new',
    required: new Set(['title', 'vendor']),
    draft,
    save
  })
  const f = (name: string, body: React.ReactNode) => (
    <div data-field={name} data-field-collection='orders'>
      {body}
    </div>
  )
  return (
    <form>
      {f(
        'title',
        <>
          <button type='button' id='menu' data-field-menu-trigger='title' />
          <button type='button' id='undo' data-personal-default-undo='title' />
          <button type='button' id='make' data-personal-default-make='title' />
          <button type='button' id='update' data-personal-default-update='title' />
          <button type='button' id='clear' data-personal-default-clear='title' />
          <input id='title' />
        </>
      )}
      {f('vendor', <input id='vendor' />)}
      {f('notes', <textarea id='notes' />)}
      {f('amount', <input id='amount' />)}
    </form>
  )
}

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

const render = async (el: React.ReactNode) => {
  await act(async () => {
    root.render(el)
  })
}
const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}
const $ = (id: string) => document.getElementById(id) as HTMLElement

describe('useEntryKeyboard (#2707 #2708)', () => {
  it('Enter moves to the next field and does not submit', async () => {
    await render(<Form config={{ enter_next: true }} />)
    $('title').focus()
    const e = press($('title'), 'Enter')
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe($('vendor'))
  })

  it('entering a field lands on its input, never the field menu, Make default or a default undo / clear', async () => {
    await render(<Form config={{ tab_order: ['amount', 'title'] }} />)
    $('amount').focus()
    press($('amount'), 'Tab')
    expect(document.activeElement).toBe($('title'))
  })

  it('leaves Enter alone in a text area', async () => {
    await render(<Form config={{ enter_next: true }} />)
    $('notes').focus()
    const e = press($('notes'), 'Enter')
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe($('notes'))
  })

  it('Ctrl+Enter saves', async () => {
    const save = vi.fn()
    await render(<Form config={{ enter_next: true }} save={save} />)
    $('title').focus()
    press($('title'), 'Enter', { ctrlKey: true })
    expect(save).toHaveBeenCalledOnce()
  })

  it('does nothing with the setting off', async () => {
    await render(<Form config={{}} />)
    $('title').focus()
    expect(press($('title'), 'Enter').defaultPrevented).toBe(false)
  })

  it('Tab follows the stored order, Shift+Tab goes back', async () => {
    await render(<Form config={{ tab_order: ['amount', 'title'] }} />)
    $('amount').focus()
    expect(press($('amount'), 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe($('title'))
    press($('title'), 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe($('amount'))
  })

  it('focuses the first empty required field when the form opens', async () => {
    vi.useFakeTimers()
    try {
      await render(<Form config={{ focus_first: true }} draft={{ title: 'PO-1' }} />)
      await act(async () => {
        vi.advanceTimersByTime(400)
      })
      expect(document.activeElement).toBe($('vendor'))
    } finally {
      vi.useRealTimers()
    }
  })
})
