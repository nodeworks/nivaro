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

let nav: { assign: any; replace: any; hrefSet: any } | null = null

function spyLocation(search: string) {
  const assign = vi.fn()
  const replace = vi.fn()
  const hrefSet = vi.fn()
  const loc: Record<string, unknown> = {
    origin: 'http://localhost:3000',
    pathname: '/login',
    search,
    hash: '',
    host: 'localhost:3000',
    hostname: 'localhost',
    protocol: 'http:',
    assign,
    replace,
    reload: vi.fn()
  }
  Object.defineProperty(loc, 'href', {
    get: () => `http://localhost:3000/login${search}`,
    set: hrefSet
  })
  vi.stubGlobal('location', loc)
  nav = { assign, replace, hrefSet }
}

async function render(search: string, spy = false) {
  window.history.replaceState({}, '', `/login${search}`)
  if (spy) spyLocation(search)
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
    [
      'hub_unavailable',
      'The Hub, which signs you in to your apps, is not answering right now. Sign in directly with Microsoft instead.'
    ],
    [
      'hub_auth_failed',
      'Your sign-in through the Hub could not be checked. Sign in directly with Microsoft, and tell your administrator.'
    ],
    [
      'hub_access_denied',
      'The Hub would not sign you in with this account: it may still be waiting for approval, or be turned off at the Hub. Sign in directly with Microsoft instead.'
    ],
    [
      'hub_account_conflict',
      'This sign-in matches a different account here. Ask your administrator to check your account.'
    ]
  ]
  for (const [code, copy] of cases) {
    it(`${code} shows its copy and never navigates or signs in by itself`, async () => {
      stubFetch({ configured: true, up: false })
      const host = await render(`?error=${code}`, true)
      expect(host.textContent).toContain(copy)
      expect(nav?.assign).not.toHaveBeenCalled()
      expect(nav?.replace).not.toHaveBeenCalled()
      expect(nav?.hrefSet).not.toHaveBeenCalled()
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      expect(calls.some((c) => String(c[0]).includes('/auth/login'))).toBe(false)
      expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull()
      if (code !== 'hub_account_conflict') expect(directLinks().length).toBeGreaterThan(0)
      // One provider button after a Hub failure: it goes direct, never a second big button.
      if (code !== 'hub_account_conflict') expect(host.textContent).not.toContain('Continue with')
    })
  }

  it('a forged hub error on a non-Hub install shows the copy but no direct button', async () => {
    stubFetch(undefined)
    const host = await render('?error=hub_unavailable')
    expect(host.textContent).toContain('is not answering right now')
    expect(directLinks()).toHaveLength(0)
  })

  it('a hostile ?redirect degrades returnTo to home', async () => {
    stubFetch({ configured: true, up: true })
    await render('?redirect=//evil.example.com/x')
    const href = directLinks()[0].getAttribute('href') as string
    expect(decodeURIComponent(href.split('returnTo=')[1])).toBe('http://localhost:3000/')
  })

  it('a legit /oauth/authorize redirect is carried through', async () => {
    stubFetch({ configured: true, up: true })
    const target = '/oauth/authorize?client_id=abc&state=1'
    await render(`?redirect=${encodeURIComponent(target)}`)
    const href = directLinks()[0].getAttribute('href') as string
    expect(decodeURIComponent(href.split('returnTo=')[1])).toBe(`http://localhost:3000${target}`)
  })
})
