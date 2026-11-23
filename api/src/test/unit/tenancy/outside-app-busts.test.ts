import type { Knex } from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 final review (rest) Minor 1: a cache bust heard outside any app (a timer, another
// process's config change) reaches EVERY app's entries, by the dropAppEntries convention. Two
// hand-keyed caches dropped only the '' slot there: the audit-level cache (one collection) and the
// alert-banner memo.

const reads = vi.hoisted(() => ({ accountability: 'all', banners: '[1]', n: 0 }))
vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const chain = {
      where: () => chain,
      first: async () => {
        reads.n++
        if (table === 'nivaro_collections') return { accountability: reads.accountability }
        return { value: reads.banners }
      }
    }
    return chain
  }
  return { db, _backgroundDb: null, _staticDb: null, resolveDb: () => db }
})

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { auditLevelOf, clearAccountabilityCache } = await import('../../../hooks/activity.js')
const banners = await import('../../../services/alert-banners.js')

function inApp<T>(app: string, fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) =>
    runWithTenantDb({} as Knex, app, () => void fn().then(resolve, reject), app)
  )
}

beforeEach(() => {
  reads.accountability = 'all'
  reads.banners = '[1]'
})

describe('outside-app busts reach every app', () => {
  it('clearAccountabilityCache(collection) outside an app drops that collection in every app', async () => {
    expect(await inApp('oa-e1', () => auditLevelOf('workflows'))).toBe('all')
    expect(await inApp('ob-e2', () => auditLevelOf('workflows'))).toBe('all')
    reads.accountability = 'activity'
    clearAccountabilityCache('workflows')
    expect(await inApp('oa-e1', () => auditLevelOf('workflows'))).toBe('activity')
    expect(await inApp('ob-e2', () => auditLevelOf('workflows'))).toBe('activity')
  })

  it('inside an app it drops only that app’s entry', async () => {
    reads.accountability = 'all'
    clearAccountabilityCache()
    expect(await inApp('oa-e1', () => auditLevelOf('tasks'))).toBe('all')
    expect(await inApp('ob-e2', () => auditLevelOf('tasks'))).toBe('all')
    reads.accountability = 'none'
    await inApp('oa-e1', async () => clearAccountabilityCache('tasks'))
    expect(await inApp('oa-e1', () => auditLevelOf('tasks'))).toBe('none')
    expect(await inApp('ob-e2', () => auditLevelOf('tasks'))).toBe('all')
  })

  it('the banner memo bust outside an app reaches every app', async () => {
    expect([...(await inApp('oa-e1', () => banners.bannerDefinitionIds()))]).toEqual([1])
    expect([...(await inApp('ob-e2', () => banners.bannerDefinitionIds()))]).toEqual([1])
    reads.banners = '[2]'
    banners.forgetBannerMemo()
    expect([...(await inApp('oa-e1', () => banners.bannerDefinitionIds()))]).toEqual([2])
    expect([...(await inApp('ob-e2', () => banners.bannerDefinitionIds()))]).toEqual([2])
  })
})
