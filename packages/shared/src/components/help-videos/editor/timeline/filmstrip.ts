import type { SpriteSheet } from '../../types'

/** The frames row never draws more tiles than this, whatever the zoom. */
export const MAX_FILMSTRIP_TILES = 400

export interface FilmstripTile {
  /** Where the tile sits on the scrolling timeline, in px. */
  left: number
  width: number
  /** The source moment the tile shows. */
  ms: number
  /** CSS background-position / background-size, in px, for the scaled sheet. */
  bgX: number
  bgY: number
  bgW: number
  bgH: number
}

/**
 * Which sprite tiles to draw along the timeline (#1560) and where. Tiles are
 * laid edge to edge at the row's height; each shows the frame nearest the
 * moment under its left edge. On a long recording zoomed far in, the tiles
 * spread out (never more than MAX_FILMSTRIP_TILES) instead of flooding the
 * DOM. Empty when the sheet has nothing to show or the row has no width.
 */
export function filmstripTiles(
  sprite: SpriteSheet,
  pxPerSec: number,
  sourceMs: number,
  rowHeight: number
): FilmstripTile[] {
  if (!sprite.count || !sprite.tile_w || !sprite.tile_h || sourceMs <= 0) return []
  if (!(pxPerSec > 0) || !(rowHeight > 0)) return []
  const scale = rowHeight / sprite.tile_h
  const tileW = sprite.tile_w * scale
  const total = (sourceMs / 1000) * pxPerSec
  if (!(tileW > 0) || !(total > 0)) return []
  const step = Math.max(tileW, total / MAX_FILMSTRIP_TILES)
  const rows = Math.ceil(sprite.count / sprite.cols)
  const bgW = sprite.cols * tileW
  const bgH = rows * rowHeight
  const out: FilmstripTile[] = []
  for (let x = 0; x < total; x += step) {
    const ms = Math.min(sourceMs, (x / pxPerSec) * 1000)
    const idx = Math.max(0, Math.min(sprite.count - 1, Math.round(ms / sprite.interval_ms)))
    const col = idx % sprite.cols
    const row = Math.floor(idx / sprite.cols)
    out.push({
      left: x,
      width: Math.min(tileW, total - x),
      ms: Math.round(ms),
      // Never -0: a tile in the first column or row sits at exactly 0.
      bgX: col ? -col * tileW : 0,
      bgY: row ? -row * rowHeight : 0,
      bgW,
      bgH
    })
  }
  return out
}
