import type knex from 'knex'
import { afterAll, describe, expect, it, vi } from 'vitest'

// A connection-less mssql knex: enough to compile SQL, never talks to a server.
const k = vi.hoisted(() => ({ inst: null as unknown }))
vi.mock('../../../db/index.js', async () => {
  const { default: knexFn } = await import('knex')
  k.inst = knexFn({ client: 'mssql' })
  return { db: k.inst }
})

import {
  applyIntegrationsToCache,
  integrationsFilterBuckets,
  outcomesMatchBuckets
} from '../../../services/queue-integrations.js'

afterAll(async () => {
  await (k.inst as ReturnType<typeof knex>).destroy()
})

describe('integrationsFilterBuckets (#630)', () => {
  it('reads the collection browser buckets and the plain-language aliases', () => {
    expect(integrationsFilterBuckets('danger')).toEqual(['danger'])
    expect(integrationsFilterBuckets('failed')).toEqual(['danger'])
    expect(integrationsFilterBuckets('pending')).toEqual(['warning'])
    expect(integrationsFilterBuckets('never')).toEqual(['none'])
    expect(integrationsFilterBuckets('sent')).toEqual(['positive'])
    expect(integrationsFilterBuckets(['failed', 'never'])).toEqual(['danger', 'none'])
    expect(integrationsFilterBuckets('failed, pending')).toEqual(['danger', 'warning'])
  })
  it('no value = no filter; an unknown value = a filter that matches nothing', () => {
    expect(integrationsFilterBuckets(undefined)).toBeNull()
    expect(integrationsFilterBuckets('')).toBeNull()
    expect(integrationsFilterBuckets([])).toBeNull()
    expect(integrationsFilterBuckets('bogus')).toEqual([])
  })
})

describe('outcomesMatchBuckets', () => {
  const set = (...o: string[]) => new Set(o)
  it('danger = overdue / failed / missing; warning = pending / skipped; positive = sent', () => {
    expect(outcomesMatchBuckets(set('failed'), ['danger'])).toBe(true)
    expect(outcomesMatchBuckets(set('missing', 'sent'), ['danger'])).toBe(true)
    expect(outcomesMatchBuckets(set('sent'), ['danger'])).toBe(false)
    expect(outcomesMatchBuckets(set('pending'), ['warning'])).toBe(true)
    expect(outcomesMatchBuckets(set('sent'), ['positive'])).toBe(true)
  })
  it('none = no ledger rows at all; buckets OR together', () => {
    expect(outcomesMatchBuckets(set(), ['none'])).toBe(true)
    expect(outcomesMatchBuckets(set('sent'), ['none'])).toBe(false)
    expect(outcomesMatchBuckets(set(), ['danger', 'none'])).toBe(true)
    expect(outcomesMatchBuckets(set('pending'), ['danger', 'none'])).toBe(false)
  })
})

describe('applyIntegrationsToCache', () => {
  const sql = (buckets: Parameters<typeof applyIntegrationsToCache>[1]) => {
    const inst = k.inst as ReturnType<typeof knex>
    const qb = inst('nivaro_queue_items as qi').select('qi.id')
    applyIntegrationsToCache(qb, buckets)
    return qb.toSQL()
  }
  it('keys the ledger on the cache row and skips superseded rows', () => {
    const q = sql(['danger'])
    expect(q.sql).toContain('exists (select 1 from [nivaro_integration_obligations] as [io]')
    expect(q.sql).toContain('io.collection = qi.collection')
    expect(q.sql).toContain('io.item = qi.item_id')
    expect(q.bindings).toEqual(
      expect.arrayContaining(['superseded', 'overdue', 'failed', 'missing'])
    )
  })
  it('none is a NOT EXISTS; several buckets OR', () => {
    const q = sql(['danger', 'none'])
    expect(q.sql).toMatch(/exists .* or not exists/)
  })
  it('an unreadable filter matches nothing', () => {
    expect(sql([]).sql).toContain('1 = 0')
  })
})
