import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({ select: () => Promise.reject(new Error('no db in test')) }))
}))
const linkTo = vi.fn(async () => 'https://admin.test/profile')
vi.mock('../../../services/app-links.js', () => ({
  linkTo: (...a: unknown[]) => linkTo(...(a as [])),
  userIdForEmail: vi.fn(async () => 'U1'),
  portalRegistration: vi.fn(async () => ({ base: 'https://portal.test', routes: {} }))
}))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://admin.test' }))

import { whyContext } from '../../../services/mail.js'

// Army9 b13: a mail whose links all point at one app names its own rules
// link; the recipient's usual app (admin for an admin) no longer wins.
describe('whyContext rules link', () => {
  it("resolves the recipient's app when the sender names none", async () => {
    expect(await whyContext('a@x.com', 'you approve')).toEqual({
      why: 'you approve',
      rules_url: 'https://admin.test/profile#notification-rules'
    })
  })
  it("keeps the sender's own rules link", async () => {
    linkTo.mockClear()
    expect(await whyContext('a@x.com', 'you approve', 'https://portal.test/profile')).toEqual({
      why: 'you approve',
      rules_url: 'https://portal.test/profile#notification-rules'
    })
    expect(linkTo).not.toHaveBeenCalled()
  })
  it("ignores a link to a host that is not one of this instance's apps (review M8)", async () => {
    expect(
      (await whyContext('a@x.com', 'you approve', 'https://evil.example/profile')).rules_url
    ).toBe('https://admin.test/profile#notification-rules')
    expect((await whyContext('a@x.com', 'you approve', 'https://admin.test/x')).rules_url).toBe(
      'https://admin.test/x'
    )
  })
  it('ignores a rules link that is not a web address', async () => {
    expect((await whyContext('a@x.com', 'you approve', 'javascript:alert(1)')).rules_url).toBe(
      'https://admin.test/profile#notification-rules'
    )
  })
})
