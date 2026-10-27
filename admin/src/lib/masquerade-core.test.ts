// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { captureMasqueradeFromHash, MASQUERADE_KEY, readMasquerade } from './masquerade-core'

// Security audit 2026-10-27: a `#masq=` View-as token is adopted only by a tab
// this app opened (same-origin opener), never from a pasted or clicked link.

function setOpener(value: unknown) {
  Object.defineProperty(window, 'opener', { value, configurable: true, writable: true })
}

function arrive() {
  window.history.replaceState(null, '', '/#masq=nvm_abc123&name=Pat&uid=U2')
  captureMasqueradeFromHash()
}

afterEach(() => {
  sessionStorage.removeItem(MASQUERADE_KEY)
  setOpener(null)
})

describe('captureMasqueradeFromHash', () => {
  it('adopts the token in a tab opened by this app', () => {
    setOpener({ location: { origin: window.location.origin } })
    arrive()
    expect(readMasquerade()).toEqual({ token: 'nvm_abc123', name: 'Pat', user_id: 'U2' })
    expect(window.location.hash).toBe('')
  })

  it('refuses a link with no opener, and still strips it from the address bar', () => {
    setOpener(null)
    arrive()
    expect(readMasquerade()).toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('refuses a link opened from another site', () => {
    setOpener({
      get location(): never {
        throw new DOMException('Blocked a frame with origin', 'SecurityError')
      }
    })
    arrive()
    expect(readMasquerade()).toBeNull()
    setOpener({ location: { origin: 'https://evil.example' } })
    arrive()
    expect(readMasquerade()).toBeNull()
  })
})
