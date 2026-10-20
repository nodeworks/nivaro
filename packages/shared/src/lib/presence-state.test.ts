import { describe, expect, it } from 'vitest'
import { fullHref, presencePlaceHref, stuckText } from './presence-state'

describe('stuckText', () => {
  it('says where and for how long', () => {
    expect(stuckText({ minutes: 12, label: 'CM26-80332' })).toBe('stuck on CM26-80332 for 12m')
    expect(stuckText({ minutes: 75.9, label: null })).toBe('stuck for 1h 15m')
  })
})

describe('presencePlaceHref', () => {
  const ADMIN = 'http://admin.test'
  const PORTAL = 'http://portal.test'
  const recordUrl = (c: string, id: string) => `/r/${c}/${id}`

  it('opens a record through the viewer host’s own record route, from either app', () => {
    expect(presencePlaceHref('/records/workflows/42?tab=2', null, ADMIN, recordUrl, ADMIN)).toBe(
      '/r/workflows/42'
    )
    expect(presencePlaceHref('/collections/workflows/42', 'API', ADMIN, recordUrl, PORTAL)).toBe(
      '/r/workflows/42'
    )
  })

  it('opens an admin-console page in place on the admin, absolute from a portal', () => {
    expect(presencePlaceHref('/traffic-map', 'API', ADMIN, recordUrl, ADMIN)).toBe('/traffic-map')
    expect(presencePlaceHref('/traffic-map', 'admin', ADMIN, recordUrl, PORTAL)).toBe(
      'http://admin.test/traffic-map'
    )
  })

  it('opens a portal page only from that portal', () => {
    expect(presencePlaceHref('/budget', null, ADMIN, recordUrl, PORTAL)).toBe('/budget')
    expect(presencePlaceHref('/budget', null, ADMIN, recordUrl, ADMIN)).toBeNull()
  })

  it('treats a new-record form as a page, not a record', () => {
    expect(presencePlaceHref('/records/workflows/new', null, ADMIN, recordUrl, PORTAL)).toBe(
      '/records/workflows/new'
    )
  })

  it('has no link without a path', () => {
    expect(presencePlaceHref(null, null, ADMIN, recordUrl, ADMIN)).toBeNull()
  })
})

describe('fullHref', () => {
  it('prefixes the origin on a relative link', () => {
    expect(fullHref('/records/workflows/42', 'http://portal.test')).toBe(
      'http://portal.test/records/workflows/42'
    )
    expect(fullHref('http://admin.test/x', 'http://portal.test')).toBe('http://admin.test/x')
  })
})
