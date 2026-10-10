import { useMemo } from 'react'
import { ANNOTATION_PALETTE } from './annotationStyles'
import type { View } from './playerMath'
import {
  CURSOR_HALO,
  CURSOR_POINTER,
  pointerAt,
  shortcutAt,
  shortcutLabel,
  smoothPointerPath
} from './pointer'
import type { PointerPath, VideoEdits } from './types'

/** The pointer glyph (the classic arrow), 20 units tall with its tip at 0,0:
 *  the same outline the render draws (help-video-cursor.ts pointerPath). */
const POINTER_PATH = 'M0 0 L0 20 L5 15 L8.5 23 L12 21.5 L8.5 14 L15 14 Z'

/**
 * The recorded cursor (#1517) for one moment of SOURCE time, drawn in the
 * player's frame (over the picture, through its crop and zoom): a soft halo
 * with a pointer glyph on the smoothed pointer path, and — when the edits
 * ask for it — a badge for the shortcut just pressed, bottom left. The
 * render burns the same thing in; sizes follow the picture's width.
 */
export function CursorLayer({
  pointer,
  edits,
  frame,
  srcMs,
  view
}: {
  pointer: PointerPath
  edits: VideoEdits
  frame: { width: number; height: number }
  srcMs: number
  /** The crop and zoom in effect (playerMath.viewAt). */
  view: View
}) {
  const samples = useMemo(() => smoothPointerPath(pointer.samples), [pointer])
  const W = frame.width
  const H = frame.height
  const p = pointerAt(samples, srcMs)
  const r = Math.max(4, W * CURSOR_HALO)
  const ph = Math.max(6, W * CURSOR_POINTER)
  const x = p ? (p.x * view.sx + view.ox) * W : null
  const y = p ? (p.y * view.sy + view.oy) * H : null
  const shown = x !== null && y !== null && x >= -r && x <= W + r && y >= -r && y <= H + r
  const badge = edits.cursor?.shortcuts ? shortcutAt(pointer.shortcuts, srcMs) : null
  const badgeSize = Math.max(10, Math.round(W / 56))
  return (
    <div className='pointer-events-none absolute inset-0 overflow-hidden' data-hv-cursor-layer>
      {shown && x !== null && y !== null && (
        <>
          <div
            aria-hidden
            data-hv-cursor-halo
            style={{
              position: 'absolute',
              left: x - r,
              top: y - r,
              width: 2 * r,
              height: 2 * r,
              borderRadius: '50%',
              background: `${ANNOTATION_PALETTE.accent}8c`,
              filter: `blur(${r / 5}px)`
            }}
          />
          <svg
            aria-hidden='true'
            data-hv-cursor
            width={ph * 0.8}
            height={ph * 1.2}
            viewBox='0 0 16 24'
            style={{ position: 'absolute', left: x, top: y, overflow: 'visible' }}
          >
            <path
              d={POINTER_PATH}
              fill='#ffffff'
              stroke='#141414'
              strokeWidth={1.5}
              strokeLinejoin='round'
            />
          </svg>
        </>
      )}
      {badge && (
        <div
          data-hv-shortcut-badge={badge.keys}
          style={{
            position: 'absolute',
            left: W * 0.03,
            bottom: H * 0.05,
            padding: `${Math.round(badgeSize * 0.3)}px ${Math.round(badgeSize * 0.5)}px`,
            borderRadius: Math.round(badgeSize * 0.3),
            background: 'rgba(16,16,16,0.75)',
            color: '#ffffff',
            fontSize: badgeSize,
            fontWeight: 700,
            lineHeight: 1.2,
            fontFamily: 'Arial, Helvetica, sans-serif',
            whiteSpace: 'nowrap'
          }}
        >
          {shortcutLabel(badge.keys)}
        </div>
      )}
    </div>
  )
}
