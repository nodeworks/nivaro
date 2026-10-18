// api/src/test/unit/services/traffic-geoip.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import {
  geoStatus,
  lookupPlace,
  placeKey,
  resetGeoForTests
} from '../../../services/traffic-geoip.js'

afterEach(() => {
  delete process.env.TRAFFIC_GEOIP_DB
  resetGeoForTests()
})

describe('#2154 offline geo database', () => {
  it('is off without TRAFFIC_GEOIP_DB', () => {
    expect(geoStatus()).toMatchObject({ enabled: false, configured: false, error: null })
    expect(lookupPlace('8.8.8.8')).toBeNull()
  })
  it('reports an unreadable file instead of throwing', () => {
    process.env.TRAFFIC_GEOIP_DB = '/nonexistent/GeoLite2-Country.mmdb'
    resetGeoForTests()
    const s = geoStatus()
    expect(s.enabled).toBe(false)
    expect(s.configured).toBe(true)
    expect(s.error).toBeTruthy()
    expect(lookupPlace('8.8.8.8')).toBeNull()
  })
  it('keys places by country, then region', () => {
    expect(placeKey({ country: 'US', country_name: null, region: 'Ohio', city: null })).toBe(
      'US · Ohio'
    )
    expect(placeKey({ country: 'GB', country_name: null, region: null, city: null })).toBe('GB')
  })
})
