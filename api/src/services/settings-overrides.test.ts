import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))

import { INSTANCE_RESERVED_KEYS, withoutReservedKeys } from './settings-overrides.js'

describe('instance reserved keys', () => {
  it('withoutReservedKeys drops issue_trackers', () => {
    expect(INSTANCE_RESERVED_KEYS).toContain('issue_trackers')
    expect(withoutReservedKeys({ app_name: 'x', issue_trackers: { enabled: true } })).toEqual({
      app_name: 'x'
    })
  })
})
