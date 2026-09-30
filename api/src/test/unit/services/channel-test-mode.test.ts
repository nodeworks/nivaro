import { afterEach, describe, expect, it } from 'vitest'
import {
  channelTestConfigFrom,
  routePushDecision,
  routeTeamsDecision
} from '../../../services/channel-test-mode.js'

afterEach(() => {
  delete process.env.PUSH_TEST_MODE
  delete process.env.PUSH_TEST_RECIPIENT
  delete process.env.TEAMS_TEST_MODE
  delete process.env.TEAMS_TEST_WEBHOOK_URL
})

describe('push and Teams test mode', () => {
  it('env forces the mode on; the settings switch supplies its own recipient', () => {
    process.env.PUSH_TEST_MODE = 'true'
    process.env.PUSH_TEST_RECIPIENT = 'env@example.com'
    expect(channelTestConfigFrom({}).push).toEqual({ on: true, recipient: 'env@example.com', allowlist: [] })
    // Settings on with an empty field means drop — never the env address.
    expect(channelTestConfigFrom({ push_test_mode: 1 }).push.recipient).toBeNull()
    expect(
      channelTestConfigFrom({ push_test_mode: true, push_test_recipient: 'qa@example.com' }).push.recipient
    ).toBe('qa@example.com')
  })

  it('a push outside the allowlist is redirected with who it was for, or dropped', () => {
    const cfg = { on: true, recipient: 'qa@example.com', allowlist: ['@example.org', 'boss@x.com'] }
    expect(routePushDecision({ ...cfg, on: false }, 'a@b.com')).toEqual({ redirectTo: null, prefix: null })
    expect(routePushDecision(cfg, 'Pat@Example.org')).toEqual({ redirectTo: null, prefix: null })
    expect(routePushDecision(cfg, 'a@b.com')).toEqual({
      redirectTo: 'qa@example.com',
      prefix: '[TEST — was: a@b.com] '
    })
    expect(routePushDecision({ ...cfg, recipient: null }, 'a@b.com')).toBeNull()
    expect(routePushDecision(cfg, 'QA@example.com')).toEqual({ redirectTo: null, prefix: null })
  })

  it('a Teams card goes to the test channel, or nowhere', () => {
    const url = 'https://tenant.webhook.office.com/hook/1'
    expect(routeTeamsDecision({ on: false, webhook: null }, url)).toEqual({ url, prefix: '' })
    expect(routeTeamsDecision({ on: true, webhook: null }, url)).toBeNull()
    expect(routeTeamsDecision({ on: true, webhook: 'https://test/hook' }, url)).toEqual({
      url: 'https://test/hook',
      prefix: '[TEST — was: tenant.webhook.office.com] '
    })
  })
})
