import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HUB_MASK,
  HubSecretError,
  maskSecret,
  nextSecret,
  openSecret,
  sealSecret
} from '../../../services/hub/secrets.js'

const KEY = 'a'.repeat(64)

describe('hub secrets', () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = KEY
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prev
  })

  it('seals and opens', () => {
    const s = sealSecret('t')
    expect(s.startsWith('enc:v1:')).toBe(true)
    expect(openSecret(s)).toBe('t')
    expect(openSecret(null)).toBeNull()
  })

  it('masks', () => {
    expect(maskSecret(sealSecret('t'))).toBe(HUB_MASK)
    expect(maskSecret(null)).toBeNull()
  })

  it('nextSecret keeps, clears or reseals', () => {
    const s = sealSecret('t')
    expect(nextSecret(HUB_MASK, s)).toBe(s)
    expect(nextSecret('', s)).toBeNull()
    expect(nextSecret(null, s)).toBeNull()
    const n = nextSecret('new', s) as string
    expect(n.startsWith('enc:v1:')).toBe(true)
    expect(openSecret(n)).toBe('new')
  })

  it('throws a coded error without a valid key', () => {
    for (const bad of [undefined, 'short']) {
      if (bad === undefined) delete process.env.ENCRYPTION_KEY
      else process.env.ENCRYPTION_KEY = bad
      try {
        sealSecret('t')
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(HubSecretError)
        expect((e as HubSecretError).code).toBe('HUB_NEEDS_ENCRYPTION_KEY')
      }
    }
  })
})
