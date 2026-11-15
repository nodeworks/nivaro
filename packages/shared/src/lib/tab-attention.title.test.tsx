// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composeTabTitle, useTabAttention, useTabTitleLabel } from './tab-attention'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The tab title has one owner (2026-11-14): the attention count (TabCountHost) and the
// environment label (EnvironmentNotice) used to run two observers that each put their part
// first and rewrote each other forever — the tab froze on staging/dev with unread items.

describe('composeTabTitle', () => {
  it('composes (count) Label · page and is stable when run on its own output', () => {
    const once = composeTabTitle('My Work · Nivaro', 3, 'Staging')
    expect(once).toBe('(3) Staging · My Work · Nivaro')
    expect(composeTabTitle(once, 3, 'Staging')).toBe(once)
  })
  it('puts the count before the label, never inside it, whatever order it found', () => {
    expect(composeTabTitle('Staging · (3) My Work', 3, 'Staging')).toBe('(3) Staging · My Work')
    expect(composeTabTitle('(2) Staging · My Work', 5, 'Staging')).toBe('(5) Staging · My Work')
    expect(composeTabTitle('(2) Staging · My Work', 0, 'Staging')).toBe('Staging · My Work')
  })
  it('takes a label that went away off, and leaves page text that only looks similar', () => {
    expect(composeTabTitle('(1) Staging · Queues', 1, null, ['Staging'])).toBe('(1) Queues')
    expect(composeTabTitle('Budget (2026) · Nivaro', 0, 'Dev')).toBe('Dev · Budget (2026) · Nivaro')
  })
})

describe('count + label writers against one document', () => {
  let writes = 0
  let restore: (() => void) | null = null
  beforeEach(() => {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'title') as PropertyDescriptor
    Object.defineProperty(document, 'title', {
      configurable: true,
      get: () => d.get?.call(document),
      set: (v: string) => {
        writes++
        d.set?.call(document, v)
      }
    })
    restore = () => {
      delete (document as unknown as { title?: string }).title
    }
    if (!document.querySelector('title')) document.head.appendChild(document.createElement('title'))
    document.title = 'Nivaro'
  })
  afterEach(() => restore?.())

  // MutationObserver callbacks run as microtasks: let a few rounds go by.
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  function Both({ count, label }: { count: number; label: string | null }) {
    useTabAttention(count)
    useTabTitleLabel(label)
    return null
  }

  it('settles in at most two writes after the page sets its title', async () => {
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Both count={3} label='Staging' />))
    await settle()
    expect(document.title).toBe('(3) Staging · Nivaro')

    writes = 0
    document.title = 'CR26-76773 · Nivaro'
    await settle()
    // The page's own write + at most two from the title owner.
    expect(writes - 1).toBeLessThanOrEqual(2)
    expect(document.title).toBe('(3) Staging · CR26-76773 · Nivaro')

    // Nothing keeps writing once it has settled.
    const after = writes
    await settle()
    expect(writes).toBe(after)

    await act(async () => root.render(<Both count={0} label='Staging' />))
    await settle()
    expect(document.title).toBe('Staging · CR26-76773 · Nivaro')
    await act(async () => root.unmount())
    await settle()
    expect(document.title).toBe('CR26-76773 · Nivaro')
  })
})
