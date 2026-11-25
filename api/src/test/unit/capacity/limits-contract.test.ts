import { describe, expect, it } from 'vitest'
import { checkLimitsInput, parseAppLimits } from '../../../services/capacity/limits.js'
import { parseHubTenants } from '../../../services/tenancy/hub-contract.js'

// Hub capacity, idea 15: per-app limits travel with the app in the tenants answer. A bad limit
// drops that limit only, never the app.

const wire = (extra: Record<string, unknown> = {}) => ({
  id: 'shop-e1',
  app_key: 'shop',
  env_key: 'prod',
  name: 'Shop',
  status: 'active',
  hostnames: ['shop.example.com'],
  db: { client: 'pg', connection: 'postgres://u:p@db/shop' },
  ...extra
})

const body = (tenants: unknown[]) => ({
  data: { deployment: 'pool-a', generated_at: new Date().toISOString(), tenants }
})

describe('parseAppLimits', () => {
  it('keeps limits inside their bounds and drops the rest', () => {
    expect(parseAppLimits({ requests_per_minute: 600, jobs: 2, storage_mb: 1024 })).toEqual({
      requests_per_minute: 600,
      jobs: 2,
      storage_mb: 1024
    })
    expect(parseAppLimits({ requests_per_minute: 5, jobs: 99, storage_mb: 1.5 })).toBeUndefined()
    expect(parseAppLimits({ jobs: 3, storage_mb: -1 })).toEqual({ jobs: 3 })
    expect(parseAppLimits(null)).toBeUndefined()
    expect(parseAppLimits([1])).toBeUndefined()
  })

  it('checks a person-sent body: null or empty = no limit, a bad value is refused by name', () => {
    expect(checkLimitsInput({ requests_per_minute: null, jobs: '', storage_mb: 50 })).toEqual({
      ok: true,
      limits: { storage_mb: 50 }
    })
    const bad = checkLimitsInput({ jobs: 40 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.field).toBe('jobs')
    expect(checkLimitsInput('x').ok).toBe(false)
  })
})

describe('hub contract: limits', () => {
  it('lists an app with its limits', () => {
    const out = parseHubTenants(
      body([wire({ limits: { requests_per_minute: 120, jobs: 1 } })]),
      'pool-a'
    )
    expect(out?.tenants[0].limits).toEqual({ requests_per_minute: 120, jobs: 1 })
  })

  it('a bad limit is dropped alone; the app is still served', () => {
    const out = parseHubTenants(
      body([wire({ limits: { jobs: 500, storage_mb: 'lots' } })]),
      'pool-a'
    )
    expect(out?.tenants).toHaveLength(1)
    expect(out?.tenants[0].limits).toBeUndefined()
    expect(out?.dropped).toEqual([])
  })

  it('an app without limits has none', () => {
    const out = parseHubTenants(body([wire()]), 'pool-a')
    expect(out?.tenants[0]).not.toHaveProperty('limits')
  })
})
