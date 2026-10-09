import type { CSSProperties } from 'react'
import { ANNOTATION_PALETTE, annotationUnit } from './annotationStyles'
import { annotationOpacity } from './edits'
import { activeAt, liveBlurPx, renderSize } from './playerMath'
import type { Annotation, CaptionStyle, VideoEdits } from './types'
import { CAPTION_SIZE_SCALE } from './viewer/moments'

/** Annotations, blur boxes and the caption line for one moment of SOURCE
 *  time. Visuals mirror the server's rasterizer
 *  (api/src/services/help-video-annotations.ts): annotations are laid out on
 *  a canvas the size of the rendered file (`renderSize` of the recording's
 *  `source` size) and scaled down to the frame, so text and line widths keep
 *  the same proportions in a live preview and in the render. Without
 *  `source` they are laid out in frame pixels. Annotation text is always a
 *  React text node. */
export function OverlayLayer({
  edits,
  frame,
  srcMs,
  source,
  showAnnotations = true,
  showCaptions = true,
  fade = false,
  captionStyle
}: {
  edits: VideoEdits
  frame: { width: number; height: number }
  srcMs: number
  /** The recording's own size (width x height in pixels). */
  source?: { width: number; height: number } | null
  showAnnotations?: boolean
  showCaptions?: boolean
  /** Callouts, boxes and arrows fade in and out (#1553), as in the render.
   *  Off while paused, so something just drawn at the playhead is solid. */
  fade?: boolean
  /** The viewer's caption settings (#1529); absent = the default look. */
  captionStyle?: CaptionStyle
}) {
  const { width: W, height: H } = frame
  const canvas = source?.width && source?.height ? renderSize(source.width, source.height) : frame
  const kx = canvas.width ? W / canvas.width : 1
  const ky = canvas.height ? H / canvas.height : 1
  const unit = annotationUnit(canvas.width)
  return (
    <>
      <div className='pointer-events-none absolute inset-0' data-hv-overlay>
        {activeAt(edits.blurs, srcMs).map((b) => {
          // the render's boxblur radius, scaled to the frame and softened to match
          const px = liveBlurPx(b.strength, b.rect, canvas, W)
          return (
            <div
              key={b.id}
              data-hv-blur={b.id}
              style={{
                position: 'absolute',
                left: b.rect.x * W,
                top: b.rect.y * H,
                width: b.rect.w * W,
                height: b.rect.h * H,
                backdropFilter: `blur(${px}px)`,
                WebkitBackdropFilter: `blur(${px}px)`
              }}
            />
          )
        })}
        {showAnnotations && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: canvas.width,
              height: canvas.height,
              transform: `scale(${kx}, ${ky})`,
              transformOrigin: '0 0'
            }}
          >
            {activeAt(edits.annotations, srcMs).map((a) => (
              <AnnotationShape
                key={a.id}
                a={a}
                W={canvas.width}
                H={canvas.height}
                unit={unit}
                srcMs={srcMs}
                opacity={fade ? annotationOpacity(a, srcMs) : 1}
              />
            ))}
          </div>
        )}
      </div>
      {showCaptions && (
        <CaptionLine edits={edits} srcMs={srcMs} frameWidth={W} captionStyle={captionStyle} />
      )}
    </>
  )
}

function AnnotationShape({
  a,
  W,
  H,
  unit,
  srcMs,
  opacity
}: {
  a: Annotation
  W: number
  H: number
  unit: number
  srcMs: number
  opacity: number
}) {
  const color = ANNOTATION_PALETTE[a.tone]
  const x = a.rect.x * W
  const y = a.rect.y * H
  const w = a.rect.w * W
  const h = a.rect.h * H
  if (a.type === 'box' || a.type === 'callout') {
    const style: CSSProperties = {
      position: 'absolute',
      left: x,
      top: y,
      width: w,
      height: h,
      boxSizing: 'border-box',
      borderRadius: 4 * unit,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      padding: 3 * unit,
      fontWeight: 600,
      lineHeight: 1.2,
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: Math.max(12, Math.min(h * 0.45, 9 * unit)),
      opacity
    }
    if (a.type === 'box') Object.assign(style, { border: `${1.5 * unit}px solid ${color}`, color })
    else {
      Object.assign(style, {
        background: color,
        color: '#ffffff',
        boxShadow: '0 2px 10px rgba(0,0,0,0.35)'
      })
    }
    return (
      <div data-hv-annotation={a.id} style={style}>
        {a.text}
      </div>
    )
  }
  if (a.type === 'ripple') {
    const third = (a.end_ms - a.start_ms) / 3
    const scale = srcMs < a.start_ms + third ? 0.6 : srcMs < a.start_ms + 2 * third ? 0.85 : 1
    const r = (Math.min(w, h) / 2) * scale
    return (
      <div
        data-hv-annotation={a.id}
        style={{
          position: 'absolute',
          left: x + w / 2 - r,
          top: y + h / 2 - r,
          width: 2 * r,
          height: 2 * r,
          borderRadius: '50%',
          border: `${1.5 * unit}px solid ${color}`,
          background: `${color}33`,
          boxSizing: 'border-box'
        }}
      />
    )
  }
  if (a.type === 'arrow' && a.to) {
    const x2 = a.to.x * W
    const y2 = a.to.y * H
    const ang = Math.atan2(y2 - y, x2 - x)
    const head = 6 * unit
    const pt = (dx: number, dy: number) => `${x2 + dx},${y2 + dy}`
    return (
      <svg
        data-hv-annotation={a.id}
        width={W}
        height={H}
        style={{ position: 'absolute', left: 0, top: 0, opacity }}
        aria-hidden='true'
      >
        <line
          x1={x}
          y1={y}
          x2={x2 - Math.cos(ang) * head * 0.8}
          y2={y2 - Math.sin(ang) * head * 0.8}
          stroke={color}
          strokeWidth={2 * unit}
          strokeLinecap='round'
        />
        <polygon
          points={[
            pt(0, 0),
            pt(-Math.cos(ang - 0.5) * head, -Math.sin(ang - 0.5) * head),
            pt(-Math.cos(ang + 0.5) * head, -Math.sin(ang + 0.5) * head)
          ].join(' ')}
          fill={color}
        />
      </svg>
    )
  }
  return null
}

const CAPTION_BG = {
  none: 'bg-transparent [text-shadow:0_0_3px_#000,0_1px_2px_#000,0_0_1px_#000]',
  shaded: 'bg-[#000000cc]',
  solid: 'bg-[#000000]'
} as const

function CaptionLine({
  edits,
  srcMs,
  frameWidth,
  captionStyle
}: {
  edits: VideoEdits
  srcMs: number
  frameWidth: number
  captionStyle?: CaptionStyle
}) {
  const c = activeAt(edits.captions, srcMs)[0]
  if (!c) return null
  const size = captionStyle?.size ?? 'm'
  const bg = captionStyle?.background ?? 'shaded'
  const top = captionStyle?.position === 'top'
  // Scales with the picture so a caption never swamps a small (sheet-sized) player.
  const fontSize = Math.round(
    Math.max(11, Math.min(20, frameWidth / 44) * CAPTION_SIZE_SCALE[size])
  )
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 flex justify-center px-4 ${top ? 'top-[6%]' : 'bottom-[6%]'}`}
      data-hv-caption
      data-hv-caption-style={`${size} ${bg} ${top ? 'top' : 'bottom'}`}
    >
      <span
        className={`max-w-[80%] whitespace-pre-line rounded px-2 py-1 text-center font-medium leading-snug text-white ${CAPTION_BG[bg]}`}
        style={{ fontSize }}
      >
        {c.text}
      </span>
    </div>
  )
}
