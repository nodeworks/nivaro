// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { postLoginTarget, refusedLoginRedirect } from './post-login-target'

// Security audit 2026-10-27: after sign-in only listed server pages may be
// loaded; any other /api URL in ?redirect= lands on the app home instead.

afterEach(() => {
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('postLoginTarget', () => {
  it('keeps app paths', () => {
    expect(postLoginTarget('/collections/projects/12?tab=a#x')).toBe(
      '/collections/projects/12?tab=a#x'
    )
    expect(postLoginTarget(null)).toBe('/')
  })

  it('refuses other origins and scheme-relative targets', () => {
    expect(postLoginTarget('https://evil.example/x')).toBe('/')
    expect(postLoginTarget('//evil.example/x')).toBe('/')
  })

  it('allows the listed server pages', () => {
    expect(postLoginTarget('/oauth/authorize?client_id=a&state=b')).toBe(
      '/oauth/authorize?client_id=a&state=b'
    )
    expect(postLoginTarget('/api/message-actions/confirm?t=abc')).toBe(
      '/api/message-actions/confirm?t=abc'
    )
    expect(postLoginTarget('/api/teams/connect?t=x')).toBe('/api/teams/connect?t=x')
  })

  it('refuses any other API or OAuth URL, including dot-segment tricks', () => {
    for (const raw of [
      '/api/auth/me',
      '/api/files/123',
      '/API/users/me/token',
      '/oauth/token',
      '/api/message-actions/../auth/logout',
      '/api/message-actions/%2e%2e/users/me'
    ])
      expect(postLoginTarget(raw), raw).toBe('/')
  })
})

describe('refusedLoginRedirect', () => {
  it('drops a refused redirect from the login URL, keeping the rest', () => {
    window.history.replaceState(null, '', '/login?redirect=%2Fapi%2Fusers%2Fme&reauth=1')
    expect(refusedLoginRedirect()).toBe('/login?reauth=1')
  })

  it('leaves an allowed redirect alone', () => {
    window.history.replaceState(null, '', '/login?redirect=%2Fqueues%2F3')
    expect(refusedLoginRedirect()).toBeNull()
  })

  it('clears a refused stored copy', () => {
    sessionStorage.setItem('nivaro_post_login_redirect', '/api/auth/me')
    refusedLoginRedirect()
    expect(sessionStorage.getItem('nivaro_post_login_redirect')).toBeNull()
  })
})
