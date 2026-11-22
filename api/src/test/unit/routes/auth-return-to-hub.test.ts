import { afterEach, describe, expect, it, vi } from 'vitest'

// Ruling X-5 follow-up: a Hub hands out hubPublicOrigin() (HUB_URL by the one rule, else the
// PUBLIC_URL origin). When HUB_URL names another host than ADMIN_URL / PUBLIC_URL, the Hub's own
// sign-in must still send the person back to its OpenID authorize page at that origin.

vi.mock('../../../config.js', () => ({
  config: {
    ADMIN_URL: 'https://hub-admin.example.net',
    PUBLIC_URL: 'https://hub-internal.example.net',
    APP_URLS: ''
  }
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { resolveReturnTo } = await import('../../../routes/auth.js')

const saved = { HUB: process.env.HUB, HUB_URL: process.env.HUB_URL }
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const AUTHORIZE = 'https://hub.example.com/api/hub/oidc/authorize?client_id=hubc_x'

describe('resolveReturnTo on a Hub', () => {
  it("accepts the Hub's public address (HUB_URL) when hub mode is on", () => {
    process.env.HUB = 'on'
    process.env.HUB_URL = 'https://hub.example.com'
    expect(resolveReturnTo(AUTHORIZE)).toBe(AUTHORIZE)
  })

  it('never on an app (HUB off): HUB_URL there is the Hub, another origin', () => {
    delete process.env.HUB
    process.env.HUB_URL = 'https://hub.example.com'
    expect(resolveReturnTo(AUTHORIZE)).toBe('https://hub-admin.example.net/')
  })
})
