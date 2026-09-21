import { describe, expect, it } from 'vitest'
import {
  accountKindFromEmail,
  accountKindOf,
  isAccountKind,
  isMachineAccount
} from '../../../services/machine-accounts.js'

describe('machine accounts', () => {
  it('treats an unclassified ordinary address as a person', () => {
    expect(accountKindOf({ email: 'jane@example.com' })).toBeNull()
    expect(isMachineAccount({ email: 'jane@example.com', account_kind: null })).toBe(false)
  })

  it('lets the explicit column win over the address', () => {
    expect(accountKindOf({ email: 'sync@example.com', account_kind: 'integration' })).toBe(
      'integration'
    )
    expect(accountKindOf({ email: 'x@nivaro.local', account_kind: 'service' })).toBe('service')
  })

  it('ignores a value that is not a known kind', () => {
    expect(accountKindOf({ email: 'jane@example.com', account_kind: 'robot' })).toBeNull()
    expect(isAccountKind('robot')).toBe(false)
    expect(isAccountKind('bot')).toBe(true)
  })

  it('falls back to the address conventions', () => {
    expect(accountKindFromEmail('chat-bot@nivaro.local')).toBe('bot')
    expect(accountKindFromEmail('Sync@NIVARO.local')).toBe('integration')
    expect(accountKindFromEmail('legacy-123@invalid.local')).toBe('placeholder')
    expect(accountKindFromEmail('erp-integration@example.com')).toBe('integration')
  })

  it('reads "integration" only from the local part', () => {
    expect(accountKindFromEmail('jane@integration-partners.com')).toBeNull()
  })

  it('handles missing input', () => {
    expect(accountKindOf(null)).toBeNull()
    expect(accountKindOf({})).toBeNull()
    expect(accountKindFromEmail('')).toBeNull()
  })
})
