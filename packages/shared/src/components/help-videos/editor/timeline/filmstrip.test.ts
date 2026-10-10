import { describe, expect, it } from 'vitest'
import type { SpriteSheet } from '../../types'
import { filmstripTiles, MAX_FILMSTRIP_TILES } from './filmstrip'

// #1560: which sprite tiles the frames row draws, and where.

const sheet: SpriteSheet = {
  url: '/api/help-videos/v/sprite?st=t',
  tile_w: 160,
  tile_h: 90,
  cols: 10,
  count: 13,
  interval_ms: 1000
}

describe('filmstripTiles', () => {
  it('lays tiles edge to edge at the row height, each showing the nearest frame', () => {
    // 44 px rows scale a 160x90 tile to 78.22x44; 20 px/s over 12.5 s = 250 px.
    const tileW = (160 * 44) / 90
    const tiles = filmstripTiles(sheet, 20, 12_500, 44)
    expect(tiles).toHaveLength(4)
    expect(tiles[0]).toMatchObject({ left: 0, ms: 0, bgX: 0, bgY: 0 })
    expect(tiles[0].width).toBeCloseTo(tileW, 5)
    expect(tiles[0].bgW).toBeCloseTo(10 * tileW, 5)
    expect(tiles[0].bgH).toBe(88) // two rows of 44
    // The second tile starts at 78.22 px = 3.9 s → frame 4 (the nearest second).
    expect(tiles[1].ms).toBe(3911)
    expect(tiles[1].bgX).toBeCloseTo(-4 * tileW, 5)
    expect(tiles[1].bgY).toBe(0)
    // The last tile is cut to what is left of the row and shows frame 12 (row 2).
    expect(tiles[3].ms).toBe(11_733)
    expect(tiles[3].bgY).toBe(-44)
    expect(tiles[3].bgX).toBeCloseTo(-2 * tileW, 5)
    expect(tiles[3].width).toBeCloseTo(250 - 3 * tileW, 5)
  })
  it('never asks for a frame past the sheet', () => {
    const tiles = filmstripTiles({ ...sheet, count: 3 }, 20, 12_500, 44)
    for (const t of tiles) expect(t.bgX).toBeGreaterThanOrEqual((-2 * 160 * 44) / 90)
    expect(tiles.every((t) => t.bgY === 0)).toBe(true)
  })
  it('spreads the tiles out on a long recording zoomed far in, up to the cap', () => {
    const long = { ...sheet, count: 200, interval_ms: 9000 }
    const tiles = filmstripTiles(long, 200, 30 * 60_000, 44)
    expect(tiles.length).toBeLessThanOrEqual(MAX_FILMSTRIP_TILES)
    expect(tiles.length).toBeGreaterThan(MAX_FILMSTRIP_TILES - 2)
    expect(tiles[1].left - tiles[0].left).toBeGreaterThan((160 * 44) / 90)
  })
  it('draws nothing without frames, width or height', () => {
    expect(filmstripTiles({ ...sheet, count: 0 }, 20, 12_500, 44)).toEqual([])
    expect(filmstripTiles(sheet, 0, 12_500, 44)).toEqual([])
    expect(filmstripTiles(sheet, 20, 0, 44)).toEqual([])
    expect(filmstripTiles(sheet, 20, 12_500, 0)).toEqual([])
  })
})
