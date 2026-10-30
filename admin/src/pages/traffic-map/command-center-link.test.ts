import { describe, expect, it } from 'vitest'
import { commandCenterUrl } from './links'

describe('Traffic Map → Command Center (CC-17)', () => {
  it('links a business collection node to the board focused on it', () => {
    expect(commandCenterUrl('items', 'orders')).toBe('/command?map=orders')
  })
  it('has no board link for system tables, other lanes or folded entities', () => {
    expect(commandCenterUrl('items', 'nivaro_fields')).toBeNull()
    expect(commandCenterUrl('system', 'nivaro_users')).toBeNull()
    expect(commandCenterUrl('pages', 'budget')).toBeNull()
    expect(commandCenterUrl('items', '__other__')).toBeNull()
  })
})
