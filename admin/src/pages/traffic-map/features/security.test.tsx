import { describe, expect, it } from 'vitest'
import { type CacheRoute, headerChips } from './http-cache'
import { securityBadge } from './security'

describe('security badges', () => {
  it('shows the most severe flag (the server sorts them)', () => {
    expect(
      securityBadge([
        { kind: 'two-places', tone: 'error', text: 'session from two places' },
        { kind: 'new-place', tone: 'info', text: 'new place GB' }
      ])
    ).toEqual({ text: 'session from two places', tone: 'error' })
    expect(securityBadge(undefined)).toBeNull()
    expect(securityBadge([])).toBeNull()
  })
})

describe('HTTP caching chips', () => {
  const row = (over: Partial<CacheRoute>): CacheRoute => ({
    route: 'GET /api/x',
    n: 40,
    not_modified: 0,
    conditional: 0,
    cache_control: 0,
    no_store: 0,
    max_age: 0,
    etag: 0,
    last_modified: 0,
    repeat: 0,
    hit_rate: 0,
    cacheable: false,
    no_headers: false,
    unused_validators: false,
    ...over
  })
  it('lists each header sent with its share', () => {
    expect(headerChips(row({ cache_control: 40, max_age: 20, etag: 10 }))).toEqual([
      'Cache-Control 100%',
      'max-age 50%',
      'ETag 25%'
    ])
    expect(headerChips(row({}))).toEqual([])
  })
})
