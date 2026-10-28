import { describe, expect, it } from 'vitest'
import { CONFIRM_TTL_MS, checkConfirmToken, confirmSecretFor, mintConfirmToken } from './confirm.js'

describe('confirmation tokens', () => {
  const secret = confirmSecretFor('nvk_test')

  it('verifies for the same action and secret, within the window', () => {
    const t = mintConfirmToken(secret, 'delete_item|a|1', 1_000)
    expect(checkConfirmToken(secret, 'delete_item|a|1', t, 2_000)).toBe('ok')
    expect(checkConfirmToken(secret, 'delete_item|a|1', t, 1_000 + CONFIRM_TTL_MS + 1)).toBe(
      'expired'
    )
  })

  it('refuses another action, another credential, or a tampered expiry', () => {
    const t = mintConfirmToken(secret, 'delete_item|a|1')
    expect(checkConfirmToken(secret, 'delete_item|a|2', t)).toBe('invalid')
    expect(checkConfirmToken(confirmSecretFor('nvk_other'), 'delete_item|a|1', t)).toBe('invalid')
    const [, sig] = t.split('.')
    const later = (Date.now() + 10 * CONFIRM_TTL_MS).toString(36)
    expect(checkConfirmToken(secret, 'delete_item|a|1', `${later}.${sig}`)).toBe('invalid')
    expect(checkConfirmToken(secret, 'delete_item|a|1', 'true')).toBe('invalid')
    expect(checkConfirmToken(secret, 'delete_item|a|1', undefined)).toBe('invalid')
  })

  it('derives the same key for the same credential (works across replicas)', () => {
    expect(confirmSecretFor('nvk_x')).toBe(confirmSecretFor('nvk_x'))
    expect(confirmSecretFor(null)).not.toBe(confirmSecretFor(null))
  })
})
