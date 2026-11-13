import type { Knex } from 'knex'
import { describe, expect, it } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import {
  customQueryCacheKey,
  customQueryKeyParams,
  customQueryKeyTouches
} from '../../../services/custom-query-cache.js'

// Cloud: every tenant shares one Redis. Two tenants that installed the same
// starter kit hold the same slug with the same SQL, and people in both run it
// with the same params — the cached rows of one must never answer the other.
const def = { sql_text: 'EXEC health @Projects=:projects', scope_params: null }
const params = { projects: 'A-1' }

function keyAs(tenantId: string): string {
  let key = ''
  runWithTenantDb({} as Knex, `slug-${tenantId}`, () => {
    key = customQueryCacheKey('project-health', params, def)
  }, tenantId)
  return key
}

describe('custom query cache key is per tenant', () => {
  it('the same query and params in two tenants → two entries', () => {
    expect(keyAs('tenant-a')).not.toBe(keyAs('tenant-b'))
    expect(keyAs('tenant-a')).toBe(keyAs('tenant-a'))
  })

  it('a tenant never shares an entry with a call that has no tenant', () => {
    expect(keyAs('tenant-a')).not.toBe(customQueryCacheKey('project-health', params, def))
  })

  it('self-hosted (no tenant) keeps the key it always had', () => {
    expect(customQueryCacheKey('project-health', params, def)).toMatch(
      /^cq:project-health:[0-9a-f]{10}:\{"projects":"A-1"\}$/
    )
  })

  it('a tenant key still starts cq:<slug>: and reads back its params', () => {
    const key = keyAs('3f0c8a52-6f0e-4d5e-9a57-0d7e6a0c1b11')
    expect(key.startsWith('cq:project-health:')).toBe(true)
    expect(customQueryKeyParams(key, 'project-health')).toEqual(params)
    expect(
      customQueryKeyTouches(key, 'project-health', { param: 'projects', values: ['A-1'] })
    ).toBe(true)
    expect(
      customQueryKeyTouches(key, 'project-health', { param: 'projects', values: ['B-2'] })
    ).toBe(false)
  })

  it('a tenant id cannot break out of its segment', () => {
    // Whatever the id holds, the params are still the JSON after the stamp segment.
    const key = keyAs('a:b{"projects":"Z"}')
    expect(customQueryKeyParams(key, 'project-health')).toEqual(params)
  })
})
