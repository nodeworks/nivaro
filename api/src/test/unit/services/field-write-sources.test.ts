import { afterEach, describe, expect, it } from 'vitest'
import {
  describeRawSource,
  mergeRawSources,
  noteRawWriteSources,
  plannedSources,
  readRawWriteSources,
  resetFieldSourcesForTests,
  setFieldSourceRedis,
  sourceForField
} from '../../../services/field-write-sources.js'

afterEach(() => resetFieldSourcesForTests())

describe('raw-write field sources (realtime round 7 #7)', () => {
  it('keeps one entry per record field, never collection-wide or batch writes', () => {
    const planned = plannedSources(
      [
        { collection: 'orders', ids: [1, 2], changed_fields: ['amount'], source: 'rollup' },
        { collection: 'orders', ids: null, source: 'procedure:nightly' },
        { collection: 'orders', ids: [3], source: 'batch-update', changed_fields: ['x'] },
        { collection: 'orders', ids: [4], source: 'reforecast' }
      ],
      1000,
      true
    )
    expect([...planned.keys()].sort()).toEqual(['orders\u00011', 'orders\u00012', 'orders\u00014'])
    expect(JSON.parse(planned.get('orders\u00011')!.values.amount).source).toBe('rollup')
    // From the inbox, an unprefixed tag is a procedure's own name; no fields = the whole record.
    expect(JSON.parse(planned.get('orders\u00014')!.values['*']).source).toBe(
      'procedure:reforecast'
    )
  })

  it('round-trips through the memory store and a Redis-like store', async () => {
    setFieldSourceRedis(null)
    await noteRawWriteSources([
      { collection: 'orders', ids: ['7'], changed_fields: ['status'], source: 'procedure:close' }
    ])
    const mem = await readRawWriteSources('orders', '7')
    expect(mem.status?.source).toBe('procedure:close')

    const hashes = new Map<string, Record<string, string>>()
    setFieldSourceRedis({
      hset: async (k, v) => hashes.set(k, { ...(hashes.get(k) ?? {}), ...v }),
      hgetall: async (k) => hashes.get(k) ?? {},
      expire: async () => 1
    })
    await noteRawWriteSources([{ collection: 'orders', ids: [8], source: 'outside-write-watch' }])
    const red = await readRawWriteSources('orders', '8')
    expect(sourceForField(red, 'anything')?.source).toBe('outside-write-watch')
  })

  it('reads tags the way a person says them', () => {
    expect(describeRawSource('procedure:reforecast')).toEqual({
      via: 'procedure',
      who: 'procedure reforecast'
    })
    expect(describeRawSource('import:po-lines').via).toBe('import')
    expect(describeRawSource('outside-write-watch').via).toBe('outside')
    expect(describeRawSource('rollup').who).toBe('the total recalculation')
  })

  it('lets a newer announcement beat an older revision, never an older one', () => {
    const out = {
      amount: { at: '2026-11-14T10:00:00.000Z', who: 'Beth', via: 'user' as const },
      status: { at: '2026-11-14T12:00:00.000Z', who: 'Beth', via: 'user' as const }
    }
    const at = Date.parse('2026-11-14T11:00:00.000Z')
    mergeRawSources(out, ['amount', 'status', 'notes'], {
      '*': { source: 'procedure:recalc', at }
    })
    expect(out.amount.who).toBe('procedure recalc')
    expect(out.status.who).toBe('Beth')
    expect((out as Record<string, { via: string }>).notes.via).toBe('procedure')
  })
})
