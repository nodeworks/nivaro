import { beforeEach, describe, expect, it, vi } from 'vitest'

const post = vi.fn()
vi.mock('./api', () => ({
  api: { post: (...a: unknown[]) => post(...a), get: vi.fn() },
  WORKSPACE_KEY: 'nivaro_workspace'
}))

import { logout, safeHubLogoutUrl } from './auth'

const origin = 'https://app.example.com'

describe('safeHubLogoutUrl', () => {
  it('follows an https URL and a same-origin one', () => {
    expect(safeHubLogoutUrl('https://hub.example.com/out?x=1', origin)).toBe(
      'https://hub.example.com/out?x=1'
    )
    expect(safeHubLogoutUrl('/logout', origin)).toBe('https://app.example.com/logout')
  })
  it('ignores javascript:, data:, a remote http URL and junk', () => {
    expect(safeHubLogoutUrl('javascript:alert(1)', origin)).toBeNull()
    expect(safeHubLogoutUrl('data:text/html,hi', origin)).toBeNull()
    expect(safeHubLogoutUrl('http://hub.example.com/out', origin)).toBeNull()
    expect(safeHubLogoutUrl(undefined, origin)).toBeNull()
    expect(safeHubLogoutUrl(42, origin)).toBeNull()
  })
  it('follows http only on the same origin', () => {
    expect(safeHubLogoutUrl('http://localhost:3056/x', 'http://localhost:3056')).toBe(
      'http://localhost:3056/x'
    )
  })
  it('odd forms: each yields an https URL or null, never a script/data scheme', () => {
    const forms = [
      'https:javascript:alert(1)',
      '//evil.example.com/x',
      '/\\evil.example.com/x',
      '\\\\evil.example.com/x',
      'https://app@evil.example.com/x'
    ]
    for (const f of forms) {
      const out = safeHubLogoutUrl(f, origin)
      if (out !== null) expect(new URL(out).protocol).toBe('https:')
    }
    // recorded results (WHATWG parsing): relative forms resolve against https origin
    expect(safeHubLogoutUrl('https:javascript:alert(1)', origin)).toBe(
      'https://app.example.com/javascript:alert(1)'
    )
    expect(safeHubLogoutUrl('//evil.example.com/x', origin)).toBe('https://evil.example.com/x')
    expect(safeHubLogoutUrl('/\\evil.example.com/x', origin)).toBe('https://evil.example.com/x')
    expect(safeHubLogoutUrl('https://app@evil.example.com/x', origin)).toBe(
      'https://app@evil.example.com/x'
    )
  })
})

describe('logout()', () => {
  beforeEach(() => {
    post.mockReset()
    vi.stubGlobal('location', {
      origin,
      pathname: '/items',
      search: '?a=1',
      href: ''
    })
  })
  it('follows a good hub_logout_url', async () => {
    post.mockResolvedValue({
      data: { ok: true, hub_logout_url: 'https://hub.example.com/out?s=1' }
    })
    await logout()
    expect(window.location.href).toBe('https://hub.example.com/out?s=1')
  })
  it('falls back to /login?redirect= with none, and with a bad one', async () => {
    post.mockResolvedValue({ data: { ok: true } })
    await logout()
    expect(window.location.href).toBe(`/login?redirect=${encodeURIComponent('/items?a=1')}`)
    post.mockResolvedValue({ data: { hub_logout_url: 'javascript:alert(1)' } })
    await logout()
    expect(window.location.href).toBe(`/login?redirect=${encodeURIComponent('/items?a=1')}`)
  })
})
