import { describe, expect, it } from 'vitest'
import { enabledFeatures } from '../../../services/app-info.js'
import { hubLinkToken, hubModeEnabled } from '../../../services/hub/mode.js'

describe('hubModeEnabled', () => {
  it('is on only for HUB=on|true|1 and never in cloud mode', () => {
    expect(hubModeEnabled({ HUB: 'on' })).toBe(true)
    expect(hubModeEnabled({ HUB: 'TRUE' })).toBe(true)
    expect(hubModeEnabled({ HUB: '1' })).toBe(true)
    expect(hubModeEnabled({})).toBe(false)
    expect(hubModeEnabled({ HUB: 'off' })).toBe(false)
    expect(hubModeEnabled({ HUB: 'on', CLOUD_META_DB_URL: 'postgres://x' })).toBe(false)
  })
})

describe('hubLinkToken', () => {
  it('answers HUB_TOKEN only when at least 32 characters', () => {
    expect(hubLinkToken({ HUB_TOKEN: 'short' })).toBeNull()
    expect(hubLinkToken({ HUB_TOKEN: 'x'.repeat(32) })).toBe('x'.repeat(32))
    expect(hubLinkToken({})).toBeNull()
  })
})

it('advertises hub in app-info features only in hub mode', () => {
  expect(enabledFeatures({ HUB: 'on' } as any)).toContain('hub')
  expect(enabledFeatures({} as any)).not.toContain('hub')
  expect(enabledFeatures({ HUB: 'on', CLOUD_META_DB_URL: 'x' } as any)).not.toContain('hub')
})

describe('hubStandalone (feature hub_only)', () => {
  it('is on only for a Hub with no app collections; a read failure keeps the full sidebar', async () => {
    const { hubStandalone } = await import('../../../services/hub/standalone.js')
    const none = async () => false
    const some = async () => true
    expect(await hubStandalone({ env: { HUB: 'on' }, hasAppCollections: none })).toBe(true)
    expect(await hubStandalone({ env: { HUB: 'on' }, hasAppCollections: some })).toBe(false)
    expect(await hubStandalone({ env: {}, hasAppCollections: none })).toBe(false)
    const boom = async (): Promise<boolean> => {
      throw new Error('db down')
    }
    expect(await hubStandalone({ env: { HUB: 'on' }, hasAppCollections: boom })).toBe(false)
  })
})
