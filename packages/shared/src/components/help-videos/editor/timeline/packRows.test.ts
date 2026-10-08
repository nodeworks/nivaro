import { describe, expect, it } from 'vitest'
import type { VideoEdits } from '../../types'
import { LANE_H, laneLayout, MAX_ROWS, packRows, SUB_H } from './packRows'

const bar = (id: string, start_ms: number, end_ms: number) => ({ id, start_ms, end_ms })

describe('packRows', () => {
  it('puts bars that overlap in time on separate rows, the first free row first', () => {
    const p = packRows([
      bar('a', 0, 3000),
      bar('b', 0, 3000),
      bar('c', 1000, 2000),
      bar('d', 3500, 4000)
    ])
    expect(p.rows).toBe(3)
    expect([...p.row.entries()]).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 0]
    ])
  })
  it('lets a bar that starts where another ends share its row', () =>
    expect(packRows([bar('a', 0, 1000), bar('b', 1000, 2000)]).rows).toBe(1))
  it('orders by start, then id, whatever the stored order', () => {
    const p = packRows([bar('z', 0, 1000), bar('b', 500, 900), bar('a', 0, 1000)])
    expect(p.row.get('a')).toBe(0)
    expect(p.row.get('z')).toBe(1)
    expect(p.row.get('b')).toBe(2)
  })
  it('caps the rows; overflow goes on the last row', () => {
    const many = Array.from({ length: 7 }, (_, i) => bar(`k${i}`, 0, 3000))
    const p = packRows(many)
    expect(p.rows).toBe(MAX_ROWS)
    expect(p.row.get('k3')).toBe(MAX_ROWS - 1)
    expect(p.row.get('k6')).toBe(MAX_ROWS - 1)
  })
  it('gives an empty lane one row', () => expect(packRows([]).rows).toBe(1))
})

describe('laneLayout', () => {
  const e: VideoEdits = {
    v: 1,
    segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
    poster_ms: 0,
    chapters: [],
    annotations: [
      {
        id: 'a',
        type: 'callout',
        start_ms: 0,
        end_ms: 3000,
        rect: { x: 0, y: 0, w: 0.2, h: 0.1 },
        to: null,
        text: '',
        tone: 'accent'
      },
      {
        id: 'b',
        type: 'arrow',
        start_ms: 0,
        end_ms: 3000,
        rect: { x: 0, y: 0, w: 0.02, h: 0.02 },
        to: { x: 1, y: 1 },
        text: '',
        tone: 'accent'
      }
    ],
    zooms: [],
    blurs: [],
    captions: []
  }
  it('keeps one-row lanes at the usual height and grows stacked ones', () => {
    const l = laneLayout(e)
    expect(l.height.cuts).toBe(LANE_H)
    expect(l.height.zooms).toBe(LANE_H)
    expect(l.height.annotations).toBe(2 * SUB_H)
    expect(l.lanes.annotations.row.get('b')).toBe(1)
  })
})
