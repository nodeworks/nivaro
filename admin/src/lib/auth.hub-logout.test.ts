import { describe, expect, it } from 'vitest'
import { safeHubLogoutUrl } from './auth'

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
})
