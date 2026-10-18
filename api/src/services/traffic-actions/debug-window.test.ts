// #2215 debug windows: what a window matches, the log level, validation.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

import {
  callerKeyOf,
  DEBUG_MAX_LIVE,
  debugOnRequest,
  debugTargetKind,
  startDebugWindow,
  windowsMatching
} from './debug-window.js'
import { setTimedRulesForTest, type TimedRule } from './timed-rules.js'

const UID = 'AAAAAAAA-0000-4000-8000-000000000001'

function rule(target: string, id = target): TimedRule {
  return {
    kind: 'debug',
    id,
    target,
    until: Date.now() + 60_000,
    at: Date.now(),
    by: null,
    by_name: null
  }
}

afterEach(() => setTimedRulesForTest([]))

describe('targets', () => {
  it('knows endpoints and callers apart', () => {
    expect(debugTargetKind('items/orders')).toBe('entity')
    expect(debugTargetKind('k12')).toBe('caller')
    expect(debugTargetKind(`u${UID}`)).toBe('caller')
    expect(debugTargetKind('cron:sync')).toBeNull()
    expect(debugTargetKind('../etc')).toBeNull()
  })

  it('reads the caller key off a finished request', () => {
    expect(callerKeyOf({ authMethod: 'api_key', apiKeyId: 9 })).toBe('k9')
    expect(callerKeyOf({ authMethod: 'session', user: { id: UID.toLowerCase() } })).toBe(`u${UID}`)
    expect(callerKeyOf({})).toBeNull()
  })
})

describe('matching', () => {
  const entityOf = (_m: string, url: string) =>
    url.startsWith('/api/items/orders') ? 'items/orders' : null

  it('matches the endpoint and the caller it names, nothing else', () => {
    const rules = [rule('items/orders'), rule('k9')]
    expect(
      windowsMatching(rules, { method: 'GET', url: '/api/items/orders?limit=1' }, entityOf).map(
        (r) => r.id
      )
    ).toEqual(['items/orders'])
    expect(
      windowsMatching(
        rules,
        { method: 'GET', url: '/api/items/other', request: { authMethod: 'api_key', apiKeyId: 9 } },
        entityOf
      ).map((r) => r.id)
    ).toEqual(['k9'])
    expect(windowsMatching(rules, { method: 'GET', url: '/api/items/other' }, entityOf)).toEqual([])
  })

  it('never debugs the map polling itself', () => {
    const rules = [rule('k9')]
    expect(
      windowsMatching(
        rules,
        {
          method: 'GET',
          url: '/api/traffic-map/debug-windows',
          request: { authMethod: 'api_key', apiKeyId: 9 }
        },
        entityOf
      )
    ).toEqual([])
  })

  it('lowers the request logger only for an endpoint under a window', () => {
    setTimedRulesForTest([rule('items/orders')])
    const hit = {
      method: 'GET',
      url: '/api/items/orders',
      raw: { url: '/api/items/orders' },
      log: { level: 'info' }
    }
    const miss = {
      method: 'GET',
      url: '/api/items/x',
      raw: { url: '/api/items/x' },
      log: { level: 'info' }
    }
    debugOnRequest(hit)
    debugOnRequest(miss)
    expect(hit.log.level).toBe('debug')
    expect(miss.log.level).toBe('info')
  })
})

describe('starting', () => {
  it('validates the node, the minutes and Redis', async () => {
    const user = { id: 'u' }
    await expect(startDebugWindow({ target: 'nope', user })).rejects.toMatchObject({
      code: 'DEBUG_TARGET'
    })
    await expect(
      startDebugWindow({ target: 'items/orders', minutes: 61, user })
    ).rejects.toMatchObject({ code: 'DEBUG_MINUTES' })
    await expect(
      startDebugWindow({ target: 'items/orders', minutes: 0, user })
    ).rejects.toMatchObject({ code: 'DEBUG_MINUTES' })
    await expect(startDebugWindow({ target: 'items/orders', user })).rejects.toMatchObject({
      code: 'DEBUG_UNAVAILABLE'
    })
  })
})

describe('live cap', () => {
  it('refuses a window past the cap with a 409 the page shows', async () => {
    setTimedRulesForTest(
      Array.from({ length: DEBUG_MAX_LIVE }, (_, i) => rule(`items/c${i}`)),
      {} as never
    )
    await expect(
      startDebugWindow({ target: 'items/orders', user: { id: 'u' } })
    ).rejects.toMatchObject({ code: 'DEBUG_LIMIT', status: 409 })
  })
})
