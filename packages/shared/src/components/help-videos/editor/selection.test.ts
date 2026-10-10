import { describe, expect, it } from 'vitest'
import type { VideoEdits } from '../types'
import {
  alignItems,
  deleteItems,
  describeItems,
  duplicateItems,
  isItemSelected,
  lanesBetween,
  marqueeItems,
  moveItems,
  pruneSelection,
  type Selection,
  selectedItems,
  selectionBounds,
  selectionOf,
  toggleItem
} from './selection'

const base: VideoEdits = {
  v: 1,
  segments: [
    { start_ms: 0, end_ms: 10_000, speed: 1 },
    { start_ms: 12_000, end_ms: 20_000, speed: 1 }
  ],
  poster_ms: 0,
  chapters: [{ id: 'c1', at_ms: 3000, title: 'Start' }],
  annotations: [
    {
      id: 'a1',
      type: 'callout',
      start_ms: 2000,
      end_ms: 5000,
      rect: { x: 0, y: 0, w: 0.2, h: 0.1 },
      to: null,
      text: 'First',
      tone: 'accent'
    },
    {
      id: 'a2',
      type: 'box',
      start_ms: 14_000,
      end_ms: 16_000,
      rect: { x: 0, y: 0, w: 0.2, h: 0.1 },
      to: null,
      text: '',
      tone: 'accent'
    }
  ],
  zooms: [
    { id: 'z1', start_ms: 1000, end_ms: 3000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, ease_ms: 300 },
    { id: 'z2', start_ms: 4000, end_ms: 6000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, ease_ms: 300 }
  ],
  blurs: [],
  captions: [{ id: 'k1', start_ms: 2500, end_ms: 4000, text: 'Hello' }],
  holds: [{ id: 'h1', at_ms: 4000, hold_ms: 2000 }]
}
const SRC = 20_000
const a1 = { lane: 'annotations', id: 'a1' } as const
const k1 = { lane: 'captions', id: 'k1' } as const
const c1 = { lane: 'chapters', id: 'c1' } as const
const h1 = { lane: 'holds', id: 'h1' } as const
const z1 = { lane: 'zooms', id: 'z1' } as const

describe('selection shape', () => {
  it('is none, one or a group, without duplicates', () => {
    expect(selectionOf([])).toBeNull()
    expect(selectionOf([a1])).toEqual(a1)
    expect(selectionOf([a1, k1, a1])).toEqual({ lane: 'multi', items: [a1, k1] })
    expect(selectedItems({ lane: 'cuts', index: 0 })).toEqual([])
    expect(selectedItems(null)).toEqual([])
  })
  it('toggles an item in and out, and lets a kept piece go', () => {
    expect(toggleItem(null, a1)).toEqual(a1)
    expect(toggleItem(a1, k1)).toEqual({ lane: 'multi', items: [a1, k1] })
    expect(toggleItem({ lane: 'multi', items: [a1, k1] }, a1)).toEqual(k1)
    expect(toggleItem({ lane: 'cuts', index: 1 }, a1)).toEqual(a1)
    expect(isItemSelected({ lane: 'multi', items: [a1, k1] }, 'captions', 'k1')).toBe(true)
    expect(isItemSelected(a1, 'annotations', 'a2')).toBe(false)
  })
  it('drops items that no longer exist', () => {
    const gone = { lane: 'annotations', id: 'nope' } as const
    expect(pruneSelection(base, { lane: 'multi', items: [a1, gone] })).toEqual(a1)
    expect(pruneSelection(base, gone)).toBeNull()
    const sel: Selection = { lane: 'multi', items: [a1, k1] }
    expect(pruneSelection(base, sel)).toBe(sel)
  })
})

describe('marquee', () => {
  it('picks the lanes a vertical range crosses, never the cuts lane', () => {
    const rows = [
      { key: 'cuts', height: 28 },
      { key: 'holds', height: 28 },
      { key: 'chapters', height: 28 },
      { key: 'annotations', height: 66 },
      { key: 'zooms', height: 28 }
    ] as const
    expect(lanesBetween([...rows], 10, 40)).toEqual(['holds'])
    expect(lanesBetween([...rows], 100, 30)).toEqual(['holds', 'chapters', 'annotations'])
    expect(lanesBetween([...rows], 28, 28)).toEqual([])
    expect(lanesBetween([...rows], 0, 500)).toEqual(['holds', 'chapters', 'annotations', 'zooms'])
  })
  it('selects every item on those lanes that overlaps the time range', () => {
    expect(
      marqueeItems(base, 2600, 4500, ['annotations', 'captions', 'chapters', 'holds'])
    ).toEqual([c1, a1, k1, h1])
    // Either drag direction; a touching edge counts.
    expect(marqueeItems(base, 5000, 2600, ['annotations', 'zooms'])).toEqual([
      a1,
      z1,
      { lane: 'zooms', id: 'z2' }
    ])
    expect(marqueeItems(base, 6000, 6500, ['zooms'])).toEqual([{ lane: 'zooms', id: 'z2' }])
    expect(marqueeItems(base, 7000, 9000, ['annotations', 'zooms', 'captions'])).toEqual([])
  })
})

describe('moveItems', () => {
  it('moves the group together and keeps their distances', () => {
    const r = moveItems(base, [a1, k1, c1, h1], 1000, SRC)
    expect(r.refused).toBeUndefined()
    expect(r.edits.annotations[0]).toMatchObject({ start_ms: 3000, end_ms: 6000 })
    expect(r.edits.captions[0]).toMatchObject({ start_ms: 3500, end_ms: 5000 })
    expect(r.edits.chapters[0].at_ms).toBe(4000)
    expect(r.edits.holds?.[0].at_ms).toBe(5000)
    // Untouched lanes keep their very objects.
    expect(r.edits.zooms).toBe(base.zooms)
    expect(r.edits.segments).toBe(base.segments)
  })
  it('stops the whole group at the start and the end of the recording', () => {
    const left = moveItems(base, [a1, k1], -5000, SRC)
    expect(left.edits.annotations[0]).toMatchObject({ start_ms: 0, end_ms: 3000 })
    expect(left.edits.captions[0]).toMatchObject({ start_ms: 500, end_ms: 2000 })
    const right = moveItems(base, [a1, k1], 50_000, SRC)
    expect(right.edits.annotations[0]).toMatchObject({ start_ms: 17_000, end_ms: 20_000 })
    expect(right.edits.captions[0]).toMatchObject({ start_ms: 17_500, end_ms: 19_000 })
    expect(selectionBounds(right.edits, [a1, k1])).toEqual({ start_ms: 17_000, end_ms: 20_000 })
  })
  it('refuses a zoom landing on another zoom, and a hold leaving the kept pieces', () => {
    const z = moveItems(base, [z1], 2500, SRC)
    expect(z.refused).toMatch(/Zooms can.t overlap/)
    expect(z.edits).toBe(base)
    const h = moveItems(base, [h1], 7000, SRC)
    expect(h.refused).toBe('A hold has to sit on a part viewers see')
    expect(h.edits).toBe(base)
    // Both zooms together keep their distance, so no overlap.
    const both = moveItems(base, [z1, { lane: 'zooms', id: 'z2' }], 2500, SRC)
    expect(both.refused).toBeUndefined()
    expect(both.edits.zooms.map((x) => x.start_ms)).toEqual([3500, 6500])
  })
  it('keeps sorted lanes sorted after a move', () => {
    // z1 lands right after z2 (a touching edge is no overlap).
    const r = moveItems(base, [z1], 5000, SRC)
    expect(r.refused).toBeUndefined()
    expect(r.edits.zooms.map((x) => [x.id, x.start_ms])).toEqual([
      ['z2', 4000],
      ['z1', 6000]
    ])
  })
  it('does nothing for an empty or zero move', () => {
    expect(moveItems(base, [], 500, SRC).edits).toBe(base)
    expect(moveItems(base, [a1], 0, SRC).edits).toBe(base)
  })
})

describe('alignItems', () => {
  it('puts every start edge at the playhead, each keeping its length', () => {
    const r = alignItems(base, [a1, k1, c1], 'start', 8000, SRC)
    expect(r.edits.annotations[0]).toMatchObject({ start_ms: 8000, end_ms: 11_000 })
    expect(r.edits.captions[0]).toMatchObject({ start_ms: 8000, end_ms: 9500 })
    expect(r.edits.chapters[0].at_ms).toBe(8000)
  })
  it('puts every end edge at the playhead, and never past the recording', () => {
    const r = alignItems(base, [a1, k1], 'end', 10_000, SRC)
    expect(r.edits.annotations[0]).toMatchObject({ start_ms: 7000, end_ms: 10_000 })
    expect(r.edits.captions[0]).toMatchObject({ start_ms: 8500, end_ms: 10_000 })
    const late = alignItems(base, [a1], 'start', 19_000, SRC)
    expect(late.edits.annotations[0]).toMatchObject({ start_ms: 17_000, end_ms: 20_000 })
    const early = alignItems(base, [a1], 'end', 1000, SRC)
    expect(early.edits.annotations[0]).toMatchObject({ start_ms: 0, end_ms: 3000 })
  })
  it('refuses when aligned zooms would overlap', () => {
    const r = alignItems(base, [z1, { lane: 'zooms', id: 'z2' }], 'start', 8000, SRC)
    expect(r.refused).toMatch(/overlap/)
    expect(r.edits).toBe(base)
  })
})

describe('duplicateItems', () => {
  it('copies the group right after itself with new ids, and selects the copies', () => {
    const r = duplicateItems(base, [a1, k1], SRC)
    expect(r.refused).toBeUndefined()
    // The group spans 2000–5000, so the copies start 3 s on.
    const copies = r.edits.annotations.filter((a) => a.id !== 'a1' && a.id !== 'a2')
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatchObject({ start_ms: 5000, end_ms: 8000, text: 'First' })
    const cap = r.edits.captions.find((c) => c.id !== 'k1')
    expect(cap).toMatchObject({ start_ms: 5500, end_ms: 7000, text: 'Hello' })
    expect(r.selection).toEqual({
      lane: 'multi',
      items: [
        { lane: 'annotations', id: copies[0].id },
        { lane: 'captions', id: cap?.id }
      ]
    })
    expect(r.edits.captions.map((c) => c.start_ms)).toEqual([2500, 5500])
  })
  it('puts a copied moment one second on', () => {
    const r = duplicateItems(base, [c1], SRC)
    expect(r.edits.chapters.map((c) => c.at_ms)).toEqual([3000, 4000])
    expect(r.selection).toEqual({ lane: 'chapters', id: r.edits.chapters[1].id })
  })
  it('refuses without room, over the cap, or when a copied zoom would overlap', () => {
    const late = {
      ...base,
      annotations: [{ ...base.annotations[0], start_ms: 15_000, end_ms: 19_000 }]
    }
    expect(duplicateItems(late, [a1], SRC).refused).toMatch(/No room/)
    expect(duplicateItems(base, [z1], SRC).refused).toMatch(/overlap/)
    const full = {
      ...base,
      holds: Array.from({ length: 50 }, (_, i) => ({ id: `h${i}`, at_ms: 100 + i, hold_ms: 500 }))
    }
    expect(duplicateItems(full, [{ lane: 'holds', id: 'h0' }], SRC).refused).toMatch(/at most 50/)
  })
})

describe('deleteItems / describeItems', () => {
  it('removes every selected item, and drops an emptied holds key', () => {
    const r = deleteItems(base, [a1, k1, h1])
    expect(r.annotations.map((a) => a.id)).toEqual(['a2'])
    expect(r.captions).toEqual([])
    expect('holds' in r).toBe(false)
    expect(r.zooms).toBe(base.zooms)
  })
  it('says what a group holds', () => {
    expect(describeItems([a1, { lane: 'annotations', id: 'a2' }, z1, c1])).toBe(
      '1 chapter, 2 callouts and 1 zoom'
    )
    expect(describeItems([h1])).toBe('1 hold')
    expect(describeItems([])).toBe('nothing')
  })
})
