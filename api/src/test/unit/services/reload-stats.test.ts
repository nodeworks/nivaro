import { describe, expect, it } from 'vitest'
import {
  compareReleases,
  type NavRow,
  navColumns,
  reloadSectionRows,
  summarizeReloads
} from '../../../services/reload-stats.js'

describe('navColumns (beacon intake)', () => {
  it('keeps a known nav type; prev route only on back_forward', () => {
    expect(navColumns({ kind: 'load', nav: 'reload', prev: '/a' }, '0.3.160')).toEqual({
      nav_type: 'reload',
      prev_route: null,
      release: '0.3.160'
    })
    expect(navColumns({ kind: 'route', nav: 'back_forward', prev: '/b' }, '1')).toMatchObject({
      nav_type: 'back_forward',
      prev_route: '/b'
    })
    expect(navColumns({ kind: 'load', nav: 'teleport' }, '1').nav_type).toBeNull()
    expect(navColumns({ kind: 'widget', nav: 'reload' }, '1').nav_type).toBeNull()
  })
})

describe('compareReleases', () => {
  it('newest first, numerically', () => {
    expect(['0.3.99', '0.3.160', 'unknown', '0.3.2'].sort(compareReleases)).toEqual([
      '0.3.160',
      '0.3.99',
      '0.3.2',
      'unknown'
    ])
  })
})

describe('summarizeReloads', () => {
  const row = (p: Partial<NavRow>): NavRow => ({
    route: '/collections/:c/:id',
    kind: 'load',
    nav_type: 'navigate',
    prev_route: null,
    release: '0.3.160',
    app: 'admin',
    ...p
  })
  const rows: NavRow[] = [
    row({}),
    row({ nav_type: 'reload' }),
    row({ nav_type: 'reload', release: '0.3.159' }),
    row({ route: '/', nav_type: 'reload', app: 'efp' }),
    row({ route: '/', app: 'efp' }),
    row({ route: '/', kind: 'route', nav_type: 'back_forward', prev_route: '/q/:id', app: 'efp' }),
    row({ route: '/', kind: 'route', nav_type: 'back_forward', prev_route: '/q/:id', app: 'efp' }),
    row({ nav_type: null })
  ]
  const s = summarizeReloads(rows, 7)

  it('ranks the most reloaded screens with their share of loads', () => {
    expect(s.reloads).toBe(3)
    expect(s.views).toBe(7)
    expect(s.reloaded[0]).toMatchObject({ screen: '/collections/:c/:id', reloads: 2, loads: 3 })
    expect(s.reloaded[0].share).toBeCloseTo(0.667, 2)
    expect(s.reloaded[0].by_release.map((r) => r.release)).toEqual(['0.3.160', '0.3.159'])
    expect(s.reloaded[1]).toMatchObject({ screen: 'efp /', reloads: 1, loads: 2 })
  })

  it('pairs Back-and-forth as screen ← the screen left', () => {
    expect(s.back_forward).toBe(2)
    expect(s.back_forth[0]).toMatchObject({ screen: 'efp /', via: 'efp /q/:id', count: 2 })
  })

  it('report rows: totals then screens', () => {
    const r = reloadSectionRows(s)
    expect(r[0]).toMatchObject({ label: 'Page reloads', value: 3 })
    expect(r.some((x) => x.label === 'Back-and-forth: efp / ← efp /q/:id')).toBe(true)
    expect(reloadSectionRows({ ...s, available: false })).toEqual([])
  })
})
