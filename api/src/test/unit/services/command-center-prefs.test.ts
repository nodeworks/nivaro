import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))

const { applyPrefsChange, normalizeCcPrefs, prefsBodyRefusal } = await import(
  '../../../services/command-center/prefs.js'
)
const { cleanKioskInput } = await import('../../../services/command-center/kiosk.js')
const { maskQueryString, maskUrlQuery } = await import('../../../services/secret-mask.js')

describe('Command Center prefs normalisation', () => {
  it('defaults everything from nothing', () => {
    for (const raw of [null, undefined, 'x', [], 42]) {
      expect(normalizeCcPrefs(raw)).toEqual({
        layout: null,
        theme: 'app',
        saved_views: [],
        tv_cycle_seconds: 30
      })
    }
  })

  it('keeps unknown panel keys but drops junk and duplicates', () => {
    const p = normalizeCcPrefs({
      layout: { order: ['map', 'future_panel', 'map', 7, 'no spaces'], hidden: ['feed', null] }
    })
    expect(p.layout).toEqual({ order: ['map', 'future_panel'], hidden: ['feed'] })
  })

  it('cleans saved views: names required, ids unique, filters typed, capped at 20', () => {
    const p = normalizeCcPrefs({
      saved_views: [
        {
          id: 'a',
          name: '  North  ',
          region: '12',
          map_collection: 'locations',
          filters: { sla: ['breached', 'bogus'], states: ['open'], owner: 'u1' }
        },
        { id: 'a', name: 'Duplicate id' },
        { name: '' },
        { id: 'b', name: 'Bad region', region: 'a b', map_collection: 'drop;table' },
        ...Array.from({ length: 30 }, (_, i) => ({ id: `v${i}`, name: `View ${i}` }))
      ]
    })
    expect(p.saved_views[0]).toEqual({
      id: 'a',
      name: 'North',
      region: '12',
      map_collection: 'locations',
      filters: { states: ['open'], sla: ['breached'], owner: 'u1' }
    })
    expect(p.saved_views[1]).toMatchObject({ id: 'b', region: null, map_collection: null })
    expect(p.saved_views).toHaveLength(20)
  })

  it('theme is app unless exactly dark; TV cycle is bounded', () => {
    expect(normalizeCcPrefs({ theme: 'DARK' }).theme).toBe('app')
    expect(normalizeCcPrefs({ theme: 'dark' }).theme).toBe('dark')
    expect(normalizeCcPrefs({ tv_cycle_seconds: 5 }).tv_cycle_seconds).toBe(30)
    expect(normalizeCcPrefs({ tv_cycle_seconds: 45.4 }).tv_cycle_seconds).toBe(45)
  })

  it('a PUT changes only the keys it sends; layout null goes back to the role default', () => {
    const current = normalizeCcPrefs({
      layout: { order: ['map'], hidden: [] },
      theme: 'dark',
      saved_views: [{ id: 'x', name: 'X' }]
    })
    expect(applyPrefsChange(current, { theme: 'app' })).toMatchObject({
      layout: { order: ['map'], hidden: [] },
      theme: 'app',
      saved_views: [{ id: 'x' }]
    })
    expect(applyPrefsChange(current, { layout: null }).layout).toBeNull()
  })

  it('refuses bodies it cannot understand', () => {
    expect(prefsBodyRefusal({})).toMatch(/Send one of/)
    expect(prefsBodyRefusal({ layout: 'x' })).toMatch(/layout/)
    expect(prefsBodyRefusal({ saved_views: {} })).toMatch(/saved_views/)
    expect(prefsBodyRefusal({ layout: null })).toBeNull()
  })
})

describe('wallboard link input', () => {
  it('requires a name and an expiry of 1–90 whole days', () => {
    expect(cleanKioskInput({ expires_in_days: 7 })).toHaveProperty('error')
    expect(cleanKioskInput({ label: 'x'.repeat(81), expires_in_days: 7 })).toHaveProperty('error')
    expect(cleanKioskInput({ label: 'Wall', expires_in_days: 120 })).toHaveProperty('error')
    expect(cleanKioskInput({ label: 'Wall' })).toHaveProperty('error')
    expect(cleanKioskInput({ label: ' Wall ', expires_in_days: 90, region: '' })).toEqual({
      label: 'Wall',
      days: 90,
      region: null,
      map_collection: null
    })
  })
})

describe('the wallboard token never reaches a log', () => {
  it('masks kiosk in logged query strings and trace URLs', () => {
    const token = 'ab'.repeat(24)
    expect(maskQueryString(`region=4&kiosk=${token}`)).toBe('region=4&kiosk=••••••')
    expect(maskQueryString(`KIOSK=${token}`)).toBe('KIOSK=••••••')
    expect(maskUrlQuery(`/api/command-center/snapshot?kiosk=${token}&at=x`)).toBe(
      '/api/command-center/snapshot?kiosk=••••••&at=x'
    )
    expect(maskUrlQuery('/api/command-center/snapshot')).toBe('/api/command-center/snapshot')
  })
})
