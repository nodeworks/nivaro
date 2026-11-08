import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeDashboardLayout } from './dashboard-layout.js'
import {
  allSeedItems,
  OFFLOAD_H,
  OFFLOAD_KEY,
  placeOffloadWidget,
  type SeedItem,
  type SeedLayout
} from './dashboard-offload-seed.js'

// The layouts are the real dev saves (keys + geometry only): the Admin role default and two
// customised administrators.
const L = JSON.parse(
  readFileSync(new URL('./__fixtures__/dashboard-layouts.json', import.meta.url), 'utf8')
) as Record<string, SeedLayout>
const find = (l: SeedLayout, key: string) => allSeedItems(l).find((i) => i.key === key) as SeedItem
const w = (key: string, y: number, h = 2, x = 0, wd = 12): SeedItem => ({
  id: `i-${key}`,
  kind: 'widget',
  key,
  x,
  y,
  w: wd,
  h
})

describe('placeOffloadWidget on real layouts', () => {
  it('Admin role default: full width right under "People needing attention", nothing above moves', () => {
    const { layout, placement } = placeOffloadWidget(L.adminRoleDefault)
    expect(placement).toMatchObject({ rule: 'anchor', anchor: 'people-attention' })
    const card = find(layout, OFFLOAD_KEY)
    // people-attention ends at row 14, where ai-summary (rows 8–14) also ends: a clean line.
    expect(card).toMatchObject({ x: 0, y: 14, w: 12, h: OFFLOAD_H })
    for (const key of ['figures', 'approver-waiting', 'inbox', 'ai-summary', 'people-attention']) {
      const before = L.adminRoleDefault.items.find((i) => (i.key ?? i.kind) === key) as SeedItem
      const after = layout.items.find((i) => (i.key ?? i.kind) === key) as SeedItem
      expect(after.y).toBe(before.y)
    }
    expect(find(layout, 'admin-access-requests').y).toBe(14 + OFFLOAD_H)
    expect(normalizeDashboardLayout(layout).layout).toBeTruthy()
  })

  it('customised, no People-needing-attention: goes under Access requests, ahead of the sections', () => {
    const { layout, placement } = placeOffloadWidget(L.custom1)
    expect(placement).toMatchObject({
      rule: 'anchor',
      anchor: 'admin-access-requests',
      inSection: false
    })
    const access = find(layout, 'admin-access-requests')
    const card = find(layout, OFFLOAD_KEY)
    expect(card.y).toBe(access.y + access.h)
    expect(find(layout, 'approver-waiting').y).toBe(find(L.custom1, 'approver-waiting').y)
    const first = layout.items.find((i) => i.title === 'Across the portal') as SeedItem
    expect(first.y).toBe(card.y + OFFLOAD_H)
    expect(normalizeDashboardLayout(layout).layout).toBeTruthy()
  })

  it('a long customised layout: only items at or below the card move, by exactly its height', () => {
    const { layout } = placeOffloadWidget(L.custom2)
    const card = find(layout, OFFLOAD_KEY)
    for (const before of L.custom2.items) {
      const after = layout.items.find((i) => i.id === before.id) as SeedItem
      expect(after.y).toBe(before.y >= card.y ? before.y + OFFLOAD_H : before.y)
    }
    expect(normalizeDashboardLayout(layout).layout).toBeTruthy()
  })

  it('is idempotent: a layout that has the card is returned as it is', () => {
    const once = placeOffloadWidget(L.adminRoleDefault).layout
    const twice = placeOffloadWidget(once)
    expect(twice.placement.rule).toBe('present')
    expect(twice.layout).toBe(once)
  })
})

describe('placeOffloadWidget fallbacks', () => {
  it('anchor inside a section: the card joins that section and the section grows', () => {
    const layout: SeedLayout = {
      version: 1,
      items: [
        w('figures', 0, 1),
        {
          id: 's1',
          kind: 'section',
          title: 'Data health',
          x: 0,
          y: 1,
          w: 12,
          h: 3,
          children: [w('integrity', 0, 2, 0, 6), w('owner-coverage', 0, 2, 6, 6)]
        },
        w('chat', 4, 2)
      ]
    }
    const { layout: out, placement } = placeOffloadWidget(layout)
    expect(placement).toMatchObject({ rule: 'anchor', anchor: 'owner-coverage', inSection: true })
    const s = out.items.find((i) => i.id === 's1') as SeedItem
    expect(s.h).toBe(3 + OFFLOAD_H)
    expect(s.children?.find((c) => c.key === OFFLOAD_KEY)).toMatchObject({ y: 2, w: 12 })
    expect(out.items.find((i) => i.key === 'chat')?.y).toBe(4 + OFFLOAD_H)
  })

  it('no anchor: above the first section, never over the figures', () => {
    const layout: SeedLayout = {
      version: 1,
      items: [
        w('figures', 0, 1),
        w('chat', 1, 3),
        { id: 's1', kind: 'section', title: 'X', x: 0, y: 4, w: 12, h: 3, children: [] }
      ]
    }
    const { layout: out, placement } = placeOffloadWidget(layout)
    expect(placement.rule).toBe('above-first-section')
    expect(find(out, OFFLOAD_KEY).y).toBe(4)
    expect(find(out, 'figures').y).toBe(0)
  })

  it('no anchor, no section: below the work band; with nothing known: at the bottom', () => {
    const a = placeOffloadWidget({
      version: 1,
      items: [w('figures', 0, 1), w('my-work', 1, 7), w('chat', 8, 2)]
    })
    expect(a.placement.rule).toBe('below-work-band')
    expect(find(a.layout, OFFLOAD_KEY).y).toBe(8)
    expect(find(a.layout, 'chat').y).toBe(8 + OFFLOAD_H)
    const b = placeOffloadWidget({ version: 1, items: [w('chat', 0, 2), w('recents', 2, 3)] })
    expect(b.placement.rule).toBe('bottom')
    expect(find(b.layout, OFFLOAD_KEY).y).toBe(5)
    const c = placeOffloadWidget({ version: 1, items: [] })
    expect(find(c.layout, OFFLOAD_KEY).y).toBe(0)
  })

  it('never cuts a tall neighbour in two: the line moves below what straddles it', () => {
    const layout: SeedLayout = {
      version: 1,
      items: [w('people-attention', 0, 2, 6, 6), w('ai-summary', 0, 6, 0, 6), w('chat', 6, 2)]
    }
    const { layout: out } = placeOffloadWidget(layout)
    expect(find(out, OFFLOAD_KEY).y).toBe(6)
    expect(find(out, 'chat').y).toBe(6 + OFFLOAD_H)
  })
})
