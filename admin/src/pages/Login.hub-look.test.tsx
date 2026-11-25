// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyHubProduct } from '@/lib/hub-product'
import { LoginPage } from './Login'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function stubFetch(features: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      const body = u.includes('/app-info')
        ? { name: 'Nivaro', features }
        : u.includes('/auth/providers')
          ? {
              data: {
                oidc: { enabled: true, label: 'Microsoft' },
                saml: { enabled: false, label: '' }
              }
            }
          : { data: {} }
      return { ok: true, json: async () => body }
    })
  )
}

let root: Root | null = null
let host: HTMLDivElement | null = null

async function render() {
  window.history.replaceState({}, '', '/login')
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host as HTMLDivElement)
    root.render(<LoginPage />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  act(() => applyHubProduct(false))
  vi.unstubAllGlobals()
})

describe('sign-in page look', () => {
  it('a regular install keeps the Nivaro sign-in page (no Hub look, no fleet map)', async () => {
    stubFetch(['chat'])
    const el = await render()
    expect(el.querySelector('[data-hub-login]')).toBeNull()
    expect(el.querySelector('[data-hub-wordmark]')).toBeNull()
    expect(el.textContent).toContain('Sign in to your account')
    expect(document.documentElement.hasAttribute('data-product')).toBe(false)
  })

  it('a standalone Hub signs in on its own page, same providers', async () => {
    stubFetch(['hub', 'hub_only'])
    const el = await render()
    expect(document.documentElement.getAttribute('data-product')).toBe('hub')
    expect(el.querySelector('[data-hub-login]')).not.toBeNull()
    expect(el.querySelector('[data-hub-wordmark]')).not.toBeNull()
    expect(el.textContent).toContain('Sign in to the Hub')
    expect(el.textContent).toContain('Continue with Microsoft')
  })
})
