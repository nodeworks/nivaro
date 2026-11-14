// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Rob 2026-11-14: a View-as tab is exactly the person; the bar says so, and that administrators
// can see the changes were made by the admin.
const tab = vi.hoisted(() => ({
  m: null as null | { token: string; name: string; user_id: string }
}))
vi.mock('@/lib/masquerade', () => ({
  readMasquerade: () => tab.m,
  stopMasquerade: vi.fn(async () => {})
}))

import { ViewAsBar, viewAsFirstName } from './ViewAsBar'

function render(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<ViewAsBar />))
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
  tab.m = null
})

describe('ViewAsBar', () => {
  it('says the tab acts exactly as the person, and that admins can see it was you', () => {
    tab.m = { token: 'nvm_x', name: 'David Pry', user_id: 'u-david' }
    const host = render()
    expect(host.querySelector('[data-view-as-text]')?.textContent).toBe(
      'Viewing as David Pry — you see and act exactly as David. Admins can see changes were made by you.'
    )
    expect(host.querySelector('[data-view-as-stop]')?.textContent).toBe('Stop viewing as')
  })

  it('is not there outside a View-as tab', () => {
    expect(render().querySelector('[data-view-as-bar]')).toBeNull()
  })

  it('first name: the first word, "them" when the tab has no name', () => {
    expect(viewAsFirstName('David Pry')).toBe('David')
    expect(viewAsFirstName('  ')).toBe('them')
    expect(viewAsFirstName(null)).toBe('them')
  })
})
