import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * A few testing-library style helpers for this folder's tests (the shared package has no
 * @testing-library): mount into a real root, find by role + accessible name or by text,
 * fire events inside act(), wait for something to show.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let mounted: Array<{ root: Root; host: HTMLElement }> = []

export function mount(ui: ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(ui))
  mounted.push({ root, host })
  return {
    container: host,
    rerender: (next: ReactNode) => act(() => root.render(next))
  }
}

export function cleanup() {
  for (const { root, host } of mounted) {
    act(() => root.unmount())
    host.remove()
  }
  mounted = []
  document.body.innerHTML = ''
}

const IMPLICIT: Record<string, string> = {
  BUTTON: 'button',
  A: 'link',
  NAV: 'navigation'
}

function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : null
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'textbox'
  }
  return IMPLICIT[el.tagName] ?? null
}

export function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label')
  if (label != null) return label.replace(/\s+/g, ' ').trim()
  // Text content without aria-hidden parts (the avatar's initial).
  const copy = el.cloneNode(true) as Element
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

const matches = (text: string, want: string | RegExp) =>
  typeof want === 'string' ? text === want : want.test(text)

export function allByRole(role: string, name?: string | RegExp): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('*')].filter(
    (el) => roleOf(el) === role && (name === undefined || matches(nameOf(el), name))
  )
}

export function queryByRole(role: string, name?: string | RegExp): HTMLElement | null {
  return allByRole(role, name)[0] ?? null
}

export function getByRole(role: string, name?: string | RegExp): HTMLElement {
  const el = queryByRole(role, name)
  if (!el) throw new Error(`No ${role} named ${String(name)}`)
  return el
}

/** The innermost elements whose own text matches (like testing-library's getByText). */
export function allByText(want: string | RegExp): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!matches(text, want)) continue
    // Skip a match whose child matches too — keep the innermost.
    if (
      [...el.children].some((c) => matches((c.textContent ?? '').replace(/\s+/g, ' ').trim(), want))
    )
      continue
    out.push(el)
  }
  return out
}

export function queryByText(want: string | RegExp): HTMLElement | null {
  return allByText(want)[0] ?? null
}

export function getByText(want: string | RegExp): HTMLElement {
  const el = queryByText(want)
  if (!el) throw new Error(`No element with text ${String(want)}`)
  return el
}

export function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

/** React's onMouseEnter / onPointerEnter listen to the *over events. */
export function hover(el: Element, kind: 'mouse' | 'pointer' = 'mouse') {
  act(() => {
    el.dispatchEvent(
      new MouseEvent(kind === 'mouse' ? 'mouseover' : 'pointerover', {
        bubbles: true,
        relatedTarget: document.body
      })
    )
  })
}

export function unhover(el: Element, kind: 'mouse' | 'pointer' = 'mouse') {
  act(() => {
    el.dispatchEvent(
      new MouseEvent(kind === 'mouse' ? 'mouseout' : 'pointerout', {
        bubbles: true,
        relatedTarget: document.body
      })
    )
  })
}

/** Type a whole value into a React-controlled input (the native setter + an input event). */
export function typeInto(el: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setValue?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Wait (in act) until `find` returns something, then return it. */
export async function waitFor<T>(find: () => T | null | undefined | false, ms = 2000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    let found: T | null | undefined | false
    try {
      found = find()
    } catch {
      found = null
    }
    if (found) return found
    if (Date.now() > until) throw new Error('waitFor timed out')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}
