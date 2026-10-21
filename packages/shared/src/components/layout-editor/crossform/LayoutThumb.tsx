import type { ReactNode } from 'react'
import type { LayoutThumbData, ThumbBlock } from './crossform-api'

// A small schematic of a form for the overview (#2664): sections as outlined
// blocks, fields as bars by width, tabs and steps holders with a strip of
// their tabs, page cards as thin filled bars. Drawn from the layout's
// sections and placements (the server sends the shape), never a screenshot.

const W = 60
const PAD = 3
const INNER = W - PAD * 2
const BAR = 2.5
const GAP = 1.5
const STRIP = 3.5

function blockHeight(b: ThumbBlock): number {
  if (b.kind === 'slot') return 3
  if (b.kind === 'text') return 7
  const rows = Math.max(1, b.rows.length)
  const strip = b.kind === 'tabs' || b.kind === 'steps' ? STRIP + GAP : 0
  return PAD + strip + rows * BAR + (rows - 1) * GAP + PAD
}

function Bars({ rows, x, y, width }: { rows: number[][]; x: number; y: number; width: number }) {
  const out: ReactNode[] = []
  rows.forEach((row, r) => {
    let cx = x
    row.forEach((span, i) => {
      const w = (width * span) / 12
      out.push(
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed drawing
          key={`${r}-${i}`}
          x={cx + 0.4}
          y={y + r * (BAR + GAP)}
          width={Math.max(1, w - 0.8)}
          height={BAR}
          rx={0.6}
          className='fill-slate-300 dark:fill-slate-500'
        />
      )
      cx += w
    })
  })
  return <>{out}</>
}

function Block({ b, y }: { b: ThumbBlock; y: number }) {
  const h = blockHeight(b)
  if (b.kind === 'slot')
    return (
      <rect
        x={PAD}
        y={y}
        width={INNER}
        height={h}
        rx={1}
        className='fill-slate-200 dark:fill-slate-700'
      />
    )
  const frame = (
    <rect
      x={PAD + 0.25}
      y={y + 0.25}
      width={INNER - 0.5}
      height={h - 0.5}
      rx={1.5}
      strokeWidth={0.5}
      className='fill-white stroke-slate-300 dark:fill-slate-900 dark:stroke-slate-600'
    />
  )
  if (b.kind === 'text')
    return (
      <>
        {frame}
        <rect
          x={PAD * 2}
          y={y + 2}
          width={INNER - PAD * 2}
          height={1}
          className='fill-slate-200 dark:fill-slate-700'
        />
        <rect
          x={PAD * 2}
          y={y + 4}
          width={(INNER - PAD * 2) * 0.6}
          height={1}
          className='fill-slate-200 dark:fill-slate-700'
        />
      </>
    )
  const tabs = b.kind === 'tabs' || b.kind === 'steps'
  const count = Math.min(Math.max(b.count ?? 1, 1), 8)
  const segW = (INNER - PAD * 2) / count
  return (
    <>
      {frame}
      {tabs &&
        Array.from({ length: count }, (_, i) =>
          b.kind === 'steps' ? (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed drawing
              key={i}
              cx={PAD * 2 + segW * i + 1.5}
              cy={y + PAD + STRIP / 2}
              r={1.4}
              className={
                i === 0
                  ? 'fill-slate-400 dark:fill-slate-400'
                  : 'fill-slate-300 dark:fill-slate-600'
              }
            />
          ) : (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed drawing
              key={i}
              x={PAD * 2 + segW * i + 0.3}
              y={y + PAD}
              width={Math.max(1, segW - 0.6)}
              height={STRIP - 1}
              rx={0.6}
              className={
                i === 0
                  ? 'fill-slate-400 dark:fill-slate-400'
                  : 'fill-slate-200 dark:fill-slate-700'
              }
            />
          )
        )}
      <Bars
        rows={b.rows}
        x={PAD * 2}
        y={y + PAD + (tabs ? STRIP + GAP : 0)}
        width={INNER - PAD * 2}
      />
    </>
  )
}

/** Height of the drawing in its own units (width is always 60). */
export function thumbHeight(thumb: LayoutThumbData): number {
  if (!thumb.blocks.length) return 20
  return thumb.blocks.reduce((h, b) => h + blockHeight(b) + GAP, PAD) + (thumb.more ? 4 : 0) + PAD
}

export function LayoutThumb({
  thumb,
  name,
  className
}: {
  thumb: LayoutThumbData | undefined
  name: string
  className?: string
}) {
  const box =
    'block h-[46px] w-[60px] shrink-0 overflow-hidden rounded-[5px] border border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/40'
  if (!thumb) return <span aria-hidden className={`${box} ${className ?? ''}`} />
  const height = thumbHeight(thumb)
  let y = PAD
  const blocks = thumb.blocks.map((b, i) => {
    // biome-ignore lint/suspicious/noArrayIndexKey: fixed drawing
    const node = <Block key={i} b={b} y={y} />
    y += blockHeight(b) + GAP
    return node
  })
  const sections = thumb.blocks.filter((b) => b.kind !== 'slot').length + thumb.more
  return (
    <span
      data-layout-thumb=''
      role='img'
      aria-label={`Sketch of ${name}: ${sections} ${sections === 1 ? 'section' : 'sections'}`}
      className={`${box} ${className ?? ''}`}
    >
      <svg viewBox={`0 0 ${W} ${height}`} width={58} height={(58 * height) / W} aria-hidden='true'>
        {blocks}
        {thumb.more > 0 && (
          <g className='fill-slate-400 dark:fill-slate-500'>
            {[0, 1, 2].map((i) => (
              <circle key={i} cx={W / 2 - 3 + i * 3} cy={y + 1.5} r={0.7} />
            ))}
          </g>
        )}
      </svg>
    </span>
  )
}
