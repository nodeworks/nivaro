import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 7 (review minor 3): the deployment link's exemptions (anonymous limiter,
// maintenance freeze, API log) apply only on a Hub shared deployment, where the route exists.
// Cloud and self-hosted are unchanged to the letter.

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/traffic-breaker.js', () => ({
  entityBreakerHook: async () => {},
  startBreakerSync: () => {}
}))

import { shouldSkip } from '../../../plugins/api-logger.js'
import { exemptFromLimits } from '../../../plugins/rate-limit.js'
import { maintenanceExemptPath } from '../../../services/maintenance-freeze.js'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

const URL = '/api/hub-deployment/status'
const limiterReq = { raw: { url: URL }, headers: {}, socket: { remoteAddress: '203.0.113.9' } }

function mode(m: 'hub' | 'self' | 'cloud') {
  delete process.env.HUB_SHARED_DEPLOYMENT
  delete process.env.CLOUD_META_DB_URL
  if (m === 'hub') process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  if (m === 'cloud') process.env.CLOUD_META_DB_URL = 'postgres://meta@127.0.0.1:1/meta'
}

describe('deployment link exemptions', () => {
  it('apply on a Hub shared deployment', () => {
    mode('hub')
    expect(exemptFromLimits(limiterReq)).toBe(true)
    expect(maintenanceExemptPath(URL)).toBe(true)
    expect(shouldSkip(URL, 'GET')).toBe(true)
  })

  for (const m of ['self', 'cloud'] as const)
    it(`do not apply in ${m === 'self' ? 'self-hosted' : 'Nivaro Cloud'}`, () => {
      mode(m)
      expect(exemptFromLimits(limiterReq)).toBe(false)
      expect(maintenanceExemptPath(URL)).toBe(false)
      expect(shouldSkip(URL, 'GET')).toBe(false)
    })
})
