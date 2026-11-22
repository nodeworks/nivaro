// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './Login'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function stubFetch(hub?: { configured: boolean; up: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const data = String(url).includes('/auth/providers')
        ? { oidc: { enabled: true, label: 'Microsoft' }, saml: { enabled: false, label: '' }, hub }
        : {}
      return { ok: true, json: async () => ({ data }) }
    })
  )
}

async function render(search: string) {
  window.history.replaceState({}, '', `/login${search}`)
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    createRoot(host).render(<LoginPage />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return host
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {}
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const directLinks = () =>
  [...document.querySelectorAll('a')].filter((a) => a.getAttribute('href')?.includes('direct=1'))

describe('Login with the Hub', () => {
  it('shows the direct link only when the hub is configured, keeping direct=1 and returnTo', async () => {
    stubFetch({ configured: true, up: true })
    await render('')
    const links = directLinks()
    expect(links).toHaveLength(1)
    expect(links[0].textContent).toContain('Trouble signing in?')
    expect(links[0].getAttribute('href')).toMatch(/^\/api\/auth\/login\?direct=1&returnTo=/)
    document.body.innerHTML = ''
    stubFetch(undefined)
    await render('')
    expect(directLinks()).toHaveLength(0)
  })

  const cases: Array<[string, string]> = [
    ['hub_unavailable', 'The sign-in hub is not answering. Sign in directly with Microsoft.'],
    [
      'hub_auth_failed',
      'Sign-in through the hub could not be checked. Sign in directly with Microsoft, and tell your administrator.'
    ],
    [
      'hub_access_denied',
      'Your Hub account is waiting for approval. Sign in directly with Microsoft for now.'
    ],
    [
      'hub_account_conflict',
      'This sign-in matches a different account here. Ask your administrator to check your account.'
    ]
  ]
  for (const [code, copy] of cases) {
    it(`${code} shows its copy and never navigates by itself`, async () => {
      stubFetch({ configured: true, up: false })
      const host = await render(`?error=${code}`)
      expect(host.textContent).toContain(copy)
      expect(window.location.href).toContain(`/login?error=${code}`)
      expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull()
      if (code !== 'hub_account_conflict') expect(directLinks().length).toBeGreaterThan(0)
    })
  }
})
