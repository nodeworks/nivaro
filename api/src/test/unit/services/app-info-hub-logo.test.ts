import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  standalone: false
}))

vi.mock('../../../db/index.js', () => ({
  db: () => ({ where: () => ({ where: () => ({}), first: async () => state.row }) })
}))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))
vi.mock('../../../services/security.js', () => ({ maintenanceState: async () => ({ on: false }) }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://hub.test' }))
vi.mock('../../../services/environment-notice.js', () => ({ currentNotice: async () => null }))
vi.mock('../../../services/phone-push.js', () => ({ phonePushMode: async () => 'off' }))
vi.mock('../../../services/hub/brand.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/brand.js')>()),
  hubStandaloneCached: async () => state.standalone
}))

import { buildAppInfo, resetAppInfoCache } from '../../../services/app-info.js'

beforeEach(() => {
  resetAppInfoCache()
  state.row = undefined
  state.standalone = false
})

describe('app-info logo and name (the phone app shows these)', () => {
  it('a regular install: no logo, name Nivaro, no hub_only — unchanged', async () => {
    const info = await buildAppInfo()
    expect(info.logo_url).toBeNull()
    expect(info.name).toBe('Nivaro')
    expect(info.features).not.toContain('hub_only')
  })

  it('a standalone Hub shows the Hub mark, name and amber', async () => {
    state.standalone = true
    const info = await buildAppInfo()
    expect(info.logo_url).toBe('https://hub.test/hub-brand/icon-512.png')
    expect(info.name).toBe('Nivaro Hub')
    expect(info.color).toBe('#f5a623')
    expect(info.features).toContain('hub_only')
  })

  it('the database default name "Nivaro CMS" and stock cyan count as nothing chosen', async () => {
    state.standalone = true
    state.row = { project_name: 'Nivaro CMS', project_color: '#00CEFF' }
    const info = await buildAppInfo()
    expect(info.name).toBe('Nivaro Hub')
    expect(info.color).toBe('#f5a623')
  })

  it('a regular install keeps "Nivaro CMS" and its colour as they are', async () => {
    state.row = { project_name: 'Nivaro CMS', project_color: '#00ceff' }
    const info = await buildAppInfo()
    expect(info.name).toBe('Nivaro CMS')
    expect(info.color).toBe('#00ceff')
  })

  it("an operator's own logo and name win on a standalone Hub (white-label first)", async () => {
    state.standalone = true
    state.row = { project_name: 'Acme Ops', brand_logo: 'f1', project_color: '#123456' }
    const info = await buildAppInfo()
    expect(info.logo_url).toBe('https://hub.test/api/files/f1')
    expect(info.name).toBe('Acme Ops')
    expect(info.color).toBe('#123456')
  })
})
