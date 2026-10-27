// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  isLoginPath,
  isServerPath,
  POST_LOGIN_KEY,
  postLoginTarget,
  refusedLoginRedirect,
  rememberPostLoginTarget,
  takePostLoginTarget
} from './post-login-target'

// Security audit 2026-10-27: after any sign-in only an SPA path or a listed
// server page may be loaded; everything else lands on the app home.

afterEach(() => {
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('postLoginTarget', () => {
  it('keeps SPA paths', () => {
    expect(postLoginTarget('/collections/projects/12?tab=a#x')).toBe(
      '/collections/projects/12?tab=a#x'
    )
    expect(postLoginTarget('/graphql')).toBe('/graphql') // the GraphiQL page is an SPA route
    expect(postLoginTarget('/files')).toBe('/files') // the Files page (the server's /files is POST-only)
    expect(postLoginTarget(null)).toBe('/')
  })

  it('refuses other origins and protocol-relative targets', () => {
    expect(postLoginTarget('https://evil.example/x')).toBe('/')
    expect(postLoginTarget('//evil.example/x')).toBe('/')
    expect(postLoginTarget(' //evil.example')).toBe('/')
  })

  it('refuses backslash and encoded-slash tricks', () => {
    for (const raw of [
      '/\\evil.example',
      '\\\\evil.example',
      '/api/message-actions/callback%2f..%2fauth',
      '/oauth/authorize%5c..',
      '/queues/3?x=%2F%2Fevil'
    ])
      expect(postLoginTarget(raw), raw).toBe('/')
  })

  it('allows exactly the listed server return pages', () => {
    expect(postLoginTarget('/oauth/authorize?client_id=a&state=b')).toBe(
      '/oauth/authorize?client_id=a&state=b'
    )
    expect(postLoginTarget('/api/message-actions/callback?token=abc.def')).toBe(
      '/api/message-actions/callback?token=abc.def'
    )
    expect(postLoginTarget('/api/teams/connect?t=x')).toBe('/api/teams/connect?t=x')
  })

  it('refuses every other server path, including dot-segment tricks', () => {
    for (const raw of [
      '/api/auth/me',
      '/api/files/123',
      '/API/users/me/token',
      '/api/message-actions/other',
      '/api/message-actions/callbackx',
      '/items/workflows/1',
      '/ITEMS/workflows',
      '/oauth/token',
      '/.well-known/oauth-authorization-server',
      '/share/abc',
      '/form/abc',
      '/status',
      '/socket.io/?EIO=4',
      '/widget.js',
      '/presence.js',
      '/api/message-actions/callback/../../auth/logout',
      '/api/teams/connect/../../users/me'
    ])
      expect(postLoginTarget(raw), raw).toBe('/')
  })
})

describe('isServerPath', () => {
  it('knows the server prefixes and files', () => {
    expect(isServerPath('/api/x')).toBe(true)
    expect(isServerPath('/Share/abc')).toBe(true)
    expect(isServerPath('/assets/app.css')).toBe(true)
    expect(isServerPath('/my-work')).toBe(false)
    expect(isServerPath('/apis-overview')).toBe(false)
  })
})

describe('isLoginPath', () => {
  it('ignores case and trailing slashes', () => {
    expect(isLoginPath('/login')).toBe(true)
    expect(isLoginPath('/LOGIN/')).toBe(true)
    expect(isLoginPath('/login//')).toBe(true)
    expect(isLoginPath('/logins')).toBe(false)
  })
})

describe('stored target', () => {
  it('stores only a target that passes, and reads it back checked', () => {
    rememberPostLoginTarget('/api/auth/me')
    expect(sessionStorage.getItem(POST_LOGIN_KEY)).toBeNull()
    rememberPostLoginTarget('/queues/3')
    expect(takePostLoginTarget()).toBe('/queues/3')
    expect(sessionStorage.getItem(POST_LOGIN_KEY)).toBeNull()
  })

  it('a stored value planted directly is still checked on read', () => {
    sessionStorage.setItem(POST_LOGIN_KEY, '/api/users/me')
    expect(takePostLoginTarget()).toBe('/')
  })
})

describe('refusedLoginRedirect', () => {
  it('drops a refused redirect from the login URL, keeping the rest', () => {
    window.history.replaceState(null, '', '/login?redirect=%2Fapi%2Fusers%2Fme&reauth=1')
    expect(refusedLoginRedirect()).toBe('/login?reauth=1')
  })

  it('works on /LOGIN/ too', () => {
    window.history.replaceState(null, '', '/LOGIN/?redirect=%2Fapi%2Fusers%2Fme')
    expect(refusedLoginRedirect()).toBe('/LOGIN/')
  })

  it('leaves an allowed redirect alone', () => {
    window.history.replaceState(null, '', '/login?redirect=%2Fqueues%2F3')
    expect(refusedLoginRedirect()).toBeNull()
  })

  it('clears a refused stored copy', () => {
    sessionStorage.setItem(POST_LOGIN_KEY, '/api/auth/me')
    refusedLoginRedirect()
    expect(sessionStorage.getItem(POST_LOGIN_KEY)).toBeNull()
  })
})
