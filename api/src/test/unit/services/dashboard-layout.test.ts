import { describe, expect, it } from 'vitest'
import {
  normalizeDashboardLayout,
  normalizeDashboardRoleDefaults
} from '../../../services/dashboard-layout.js'

const widget = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'widget',
  key: 'my-work',
  x: 0,
  y: 0,
  w: 12,
  h: 4,
  ...over
})

describe('normalizeDashboardLayout', () => {
  it('keeps a well-formed layout and drops unknown keys', () => {
    const r = normalizeDashboardLayout({
      version: 1,
      extra: true,
      items: [
        widget('a', { stray: 1 }),
        {
          id: 's',
          kind: 'section',
          title: '  Invoices  ',
          collapsed: true,
          x: 0,
          y: 4,
          w: 12,
          h: 3,
          children: [{ id: 'f', kind: 'figures', x: 0, y: 0, w: 6, h: 1, tiles: ['a', 'a', ' b '] }]
        }
      ]
    })
    expect(r.error).toBeUndefined()
    expect(r.layout).toEqual({
      version: 1,
      items: [
        { id: 'a', kind: 'widget', key: 'my-work', x: 0, y: 0, w: 12, h: 4 },
        {
          id: 's',
          kind: 'section',
          title: 'Invoices',
          collapsed: true,
          x: 0,
          y: 4,
          w: 12,
          h: 3,
          children: [{ id: 'f', kind: 'figures', x: 0, y: 0, w: 6, h: 1, tiles: ['a', 'b'] }]
        }
      ]
    })
  })

  it('refuses an item that runs past the last column', () => {
    expect(
      normalizeDashboardLayout({ version: 1, items: [widget('a', { x: 6, w: 8 })] }).error
    ).toMatch(/past the last column/)
  })

  it('refuses a duplicate id anywhere in the tree', () => {
    const r = normalizeDashboardLayout({
      version: 1,
      items: [
        widget('a'),
        { id: 's', kind: 'section', x: 0, y: 4, w: 12, h: 2, children: [widget('a', { w: 6 })] }
      ]
    })
    expect(r.error).toMatch(/used twice/)
  })

  it('refuses a section inside a section', () => {
    const r = normalizeDashboardLayout({
      version: 1,
      items: [
        {
          id: 's',
          kind: 'section',
          x: 0,
          y: 0,
          w: 12,
          h: 2,
          children: [{ id: 't', kind: 'section', x: 0, y: 0, w: 12, h: 1, children: [] }]
        }
      ]
    })
    expect(r.error).toMatch(/inside a section/)
  })

  it('refuses a widget without a key and a bad version', () => {
    expect(
      normalizeDashboardLayout({ version: 1, items: [widget('a', { key: '' })] }).error
    ).toMatch(/name a widget/)
    expect(normalizeDashboardLayout({ version: 2, items: [] }).error).toMatch(/version/)
  })

  it('caps the serialised size', () => {
    const items = Array.from({ length: 200 }, (_, i) =>
      widget(`w${i}`, { key: 'k'.repeat(80), y: i, h: 1 })
    )
    // 200 × 80-char keys is still under 64 KB; pad the ids' neighbour instead
    const big = normalizeDashboardLayout({
      version: 1,
      items: [
        ...items.slice(0, 150),
        {
          id: 'f',
          kind: 'figures',
          x: 0,
          y: 999,
          w: 12,
          h: 1,
          tiles: Array.from({ length: 40 }, (_, i) => `${'t'.repeat(78)}${i}`)
        }
      ]
    })
    expect(big.error).toBeUndefined()
    // 30 figures widgets × 40 tiles × 80 chars ≈ 96 KB of tile names
    const tooBig = normalizeDashboardLayout({
      version: 1,
      items: Array.from({ length: 30 }, (_, i) => ({
        id: `f${i}`,
        kind: 'figures',
        x: 0,
        y: i,
        w: 12,
        h: 1,
        tiles: Array.from({ length: 40 }, (_, t) => `${'t'.repeat(72)}${i}-${t}`)
      }))
    })
    expect(tooBig.error).toMatch(/larger than 64 KB/)
  })
})

describe('widget titles (#1044)', () => {
  it('keeps a trimmed title on a widget placed from a report', () => {
    const r = normalizeDashboardLayout({
      version: 1,
      items: [widget('a', { key: 'rp:12', title: '  Spend velocity  ' })]
    })
    expect(r.error).toBeUndefined()
    expect(r.layout!.items[0].title).toBe('Spend velocity')
  })
  it('refuses a title that is not text', () => {
    expect(
      normalizeDashboardLayout({ version: 1, items: [widget('a', { key: 'rp:12', title: 5 })] })
        .error
    ).toMatch(/title must be text/)
  })
})

describe('normalizeDashboardRoleDefaults', () => {
  it('upper-cases role ids and validates each layout', () => {
    const r = normalizeDashboardRoleDefaults({
      '3dff3947-a6da-4b1e-9c1a-0123456789ab': { version: 1, items: [widget('a')] }
    })
    expect(r.error).toBeUndefined()
    expect(Object.keys(r.map!)).toEqual(['3DFF3947-A6DA-4B1E-9C1A-0123456789AB'])
  })

  it('refuses a key that is not a role id', () => {
    expect(normalizeDashboardRoleDefaults({ creator: { version: 1, items: [] } }).error).toMatch(
      /not a role id/
    )
  })
})
