import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /global-search/click (search program item 6) and the scope layers (item 2).

const calls = vi.hoisted(() => ({ log: [] as unknown[], open: [] as unknown[] }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: vi.fn(async (r: unknown) => r)
}))
vi.mock('../../../services/search-analytics.js', () => ({
  cleanQuery: (v: unknown) => (typeof v === 'string' && v.trim().length >= 2 ? v.trim() : null),
  logSearch: vi.fn(async (_u: string, b: unknown) => {
    calls.log.push(b)
    return 41
  }),
  markOpened: vi.fn(async (id: number, _u: string, b: unknown) => {
    calls.open.push({ id, ...(b as object) })
    return true
  })
}))

import { mergeScopeLayers } from '../../../services/search-scopes.js'
import { recordClick } from '../../../services/search-signals.js'

beforeEach(() => {
  calls.log = []
  calls.open = []
})

describe('recordClick', () => {
  it('marks the palette’s own log row when it has one', async () => {
    const r = await recordClick('u-1', { q: 'Canton', collection: 'workflows', id: 7, log_id: 12 })
    expect(r).toEqual({ ok: true, log_id: 12 })
    expect(calls.log).toEqual([])
    expect(calls.open).toEqual([{ id: 12, type: 'record', collection: 'workflows', item: '7' }])
  })

  it('logs the search first otherwise — never as an empty search', async () => {
    const r = await recordClick('u-1', { q: 'Canton', collection: 'workflows', id: 7, position: 0 })
    expect(r.log_id).toBe(41)
    expect(calls.log).toEqual([{ surface: 'palette', query: 'canton', result_count: 1 }])
  })

  it('refuses a malformed collection or id', async () => {
    expect(await recordClick('u-1', { q: 'x', collection: 'a;drop', id: 1 })).toEqual({
      ok: false,
      log_id: null
    })
    expect(await recordClick('u-1', { q: 'x', collection: 'workflows' })).toMatchObject({
      ok: false
    })
  })
})

describe('search scopes', () => {
  it('@ is always people; later layers win; "" removes', () => {
    expect(
      mergeScopeLayers([
        { wf: 'workflows', po: 'purchase_orders' },
        { po: '' },
        { ir: 'inventory_request' }
      ])
    ).toEqual({ '@': '__people__', wf: 'workflows', ir: 'inventory_request' })
    expect(mergeScopeLayers(['{"@":""}'])).toEqual({ '@': '__people__' })
  })
})
