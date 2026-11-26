import { describe, expect, it } from 'vitest'
import { fleetStripKey } from './HubFleetStrip'
import { isHubQuery } from './use-hub-live'

describe('isHubQuery', () => {
  it('takes every Hub key family and nothing else', () => {
    for (const k of [['hub', 'apps'], ['hub-ops'], ['hub-incidents', 3], fleetStripKey()])
      expect(isHubQuery({ queryKey: k as readonly unknown[] })).toBe(true)
    for (const k of [['users'], ['collections'], [{ hub: true }], [42]])
      expect(isHubQuery({ queryKey: k as readonly unknown[] })).toBe(false)
  })
})
