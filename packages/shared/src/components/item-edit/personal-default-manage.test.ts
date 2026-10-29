import { describe, expect, it } from 'vitest'
import { personalDefaultSlotFor } from './PersonalDefaultControl'
import type { PersonalDefaultsApi } from './usePersonalDefaults'

const api = (over: Partial<PersonalDefaultsApi>): PersonalDefaultsApi =>
  ({
    allowed: () => true,
    manageable: () => true,
    loaded: true,
    failed: false,
    isNew: true,
    hasValue: () => true,
    defaultFor: () => null,
    isDefault: () => false,
    applied: () => false,
    ...over
  }) as PersonalDefaultsApi

describe('personalDefaultSlotFor — Make default on the form switched off', () => {
  it('offers nothing to save, update or clear', () => {
    expect(personalDefaultSlotFor(api({ manageable: () => false }), 'ship_to', true)).toBeNull()
    expect(
      personalDefaultSlotFor(
        api({ manageable: () => false, defaultFor: () => ({ value: 1 }) as never }),
        'ship_to',
        true
      )
    ).toBeNull()
  })

  it('still shows a default it filled in (with Undo)', () => {
    expect(
      personalDefaultSlotFor(
        api({
          manageable: () => false,
          applied: () => true,
          defaultFor: () => ({ value: 1 }) as never
        }),
        'ship_to',
        true
      )
    ).toBe('applied')
  })

  it("switched on keeps today's behaviour", () => {
    expect(personalDefaultSlotFor(api({}), 'ship_to', true)).toBe('offer')
  })
})
