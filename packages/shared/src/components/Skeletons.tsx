import type { CSSProperties, ReactNode } from 'react'
import {
  type CellShape,
  cellWidth,
  type FormSkeletonPlan,
  type SkeletonColumn
} from '../lib/skeleton-shapes'
import { cn } from '../lib/utils'

/**
 * Shape-matched loading placeholders (#3229). Each one takes the shape of what is coming —
 * same row heights, same column count and alignment, same section and field grid — so nothing
 * jumps when the data lands. Every bar uses the `--nvr-skeleton` token (zero chroma in dark
 * mode) and stops pulsing under prefers-reduced-motion.
 */

const BAR = 'block animate-pulse bg-[hsl(var(--nvr-skeleton))] motion-reduce:animate-none'

export function SkeletonBar({
  shape,
  width,
  className,
  style
}: {
  shape?: CellShape
  width?: string | number
  className?: string
  style?: CSSProperties
}) {
  const round =
    shape === 'avatar' ? 'h-5 rounded-full' : shape === 'badge' ? 'h-4 rounded-full' : ''
  const box = shape === 'bool' ? 'h-3.5 rounded-[4px]' : ''
  return (
    <span
      aria-hidden
      className={cn(BAR, 'h-3 rounded', round, box, className)}
      style={{ width, ...style }}
    />
  )
}

/**
 * Body rows for a real `<table>` whose header is already on screen: one cell per real column
 * (plus the table's own leading/trailing cells), with the row height and cell padding of the
 * real rows. Render inside `<tbody>`.
 */
export function TableSkeletonRows({
  columns,
  rows = 12,
  rowClassName = 'h-8',
  cellClassName = 'px-3 py-1.5',
  leadingCells = 0,
  trailingCells = 0,
  cellStyle,
  barClassName
}: {
  columns: readonly SkeletonColumn[]
  rows?: number
  rowClassName?: string
  cellClassName?: string
  leadingCells?: number
  trailingCells?: number
  /** Per-column style (pinned offsets, fixed widths) — the real cells' own. */
  cellStyle?: (key: string) => CSSProperties | undefined
  barClassName?: string
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr
          key={r}
          data-skeleton-row=''
          aria-hidden
          className={cn('border-b border-slate-100 dark:border-slate-800', rowClassName)}
        >
          {Array.from({ length: leadingCells }, (_, i) => (
            <td key={`l${i}`} className={cellClassName}>
              <SkeletonBar shape='bool' width={14} className={barClassName} />
            </td>
          ))}
          {columns.map((c, i) => (
            <td key={c.key} style={cellStyle?.(c.key)} className={cellClassName}>
              {/* A text line's box (20px), so the row is exactly as tall as a real one. */}
              <span
                className={cn(
                  'flex h-5 items-center',
                  c.shape === 'number' ? 'justify-end' : 'justify-start'
                )}
              >
                <SkeletonBar
                  shape={c.shape}
                  width={cellWidth(c.shape, r, i)}
                  className={barClassName}
                />
              </span>
            </td>
          ))}
          {Array.from({ length: trailingCells }, (_, i) => (
            <td key={`t${i}`} className={cellClassName}>
              <SkeletonBar width={16} className={barClassName} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

/**
 * A whole list placeholder for surfaces without a real header yet: a header strip (real labels
 * when given) and rows at the real row height, one bar per column.
 */
export function ListSkeleton({
  columns,
  rows = 8,
  header,
  rowClassName = 'h-9',
  className
}: {
  columns: readonly (SkeletonColumn & { label?: ReactNode; grow?: number })[]
  rows?: number
  /** false = no header strip. */
  header?: boolean
  rowClassName?: string
  className?: string
}) {
  const colStyle = (c: SkeletonColumn & { grow?: number }): CSSProperties =>
    c.width ? { width: c.width, flex: 'none' } : { flex: `${c.grow ?? 1} 1 0%` }
  return (
    <div
      data-skeleton='list'
      aria-busy='true'
      className={cn('divide-y divide-slate-100 dark:divide-slate-800', className)}
    >
      {header !== false && (
        <div className='flex h-9 items-center gap-3 bg-slate-50 px-3 dark:bg-muted'>
          {columns.map((c, i) => (
            <span
              key={c.key}
              className='min-w-0 truncate text-[11px] font-medium text-slate-500 dark:text-slate-400'
              style={colStyle(c)}
            >
              {c.label ?? <SkeletonBar width={cellWidth('short', 0, i)} className='h-2.5' />}
            </span>
          ))}
        </div>
      )}
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          aria-hidden
          data-skeleton-row=''
          className={cn('flex items-center gap-3 px-3', rowClassName)}
        >
          {columns.map((c, i) => (
            <span
              key={c.key}
              className={cn('min-w-0', c.shape === 'number' && 'flex justify-end')}
              style={colStyle(c)}
            >
              <SkeletonBar shape={c.shape} width={cellWidth(c.shape, r, i)} />
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * A record form placeholder. With a plan (formSkeletonFromLayout) it paints the form's own tabs,
 * section titles and field grid; without one, two generic sections.
 */
export function FormSkeleton({
  plan,
  className
}: {
  plan: FormSkeletonPlan | null
  className?: string
}) {
  const sections: FormSkeletonPlan['sections'] =
    plan && plan.sections.length > 0
      ? plan.sections
      : [
          {
            key: 'a',
            label: null,
            fields: [6, 6, 6, 6, 12].map((span, i) => ({ key: `a${i}`, span }))
          },
          {
            key: 'b',
            label: null,
            fields: [4, 4, 4, 12].map((span, i) => ({ key: `b${i}`, span }))
          }
        ]
  return (
    <div data-skeleton='form' aria-busy='true' className={cn('space-y-4', className)}>
      {plan && plan.tabs.length > 1 && (
        <div className='flex items-center gap-1 border-b border-slate-200 dark:border-border'>
          {plan.tabs.map((t, i) => (
            <span
              key={`${t}-${i}`}
              className={cn(
                'px-3 py-2 text-[12.5px] font-medium',
                i === 0
                  ? 'border-b-2 border-nvr-cyan text-slate-700 dark:text-slate-200'
                  : 'text-slate-400 dark:text-slate-500'
              )}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {sections.map((s, si) => (
        <section
          key={s.key}
          aria-hidden
          className='rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'
        >
          <div className='flex items-center gap-2 px-5 py-3'>
            {s.label ? (
              <span className='text-[13px] font-medium text-slate-400 dark:text-slate-500'>
                {s.label}
              </span>
            ) : (
              <SkeletonBar width={cellWidth('short', si, 0)} className='h-3.5 max-w-[160px]' />
            )}
          </div>
          <div className='grid grid-cols-12 gap-x-6 gap-y-3 px-5 pb-5'>
            {s.fields.map((f, fi) => (
              <div
                key={f.key}
                className='min-w-0 space-y-1.5'
                style={{ gridColumn: `span ${f.span}` }}
              >
                <SkeletonBar
                  width={`${Math.round(30 + ((fi * 37 + si * 11) % 35))}%`}
                  className='h-2.5'
                />
                <SkeletonBar className={cn('w-full rounded-md', f.tall ? 'h-28' : 'h-9')} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/**
 * A card placeholder: optional title row, a KPI figure, a chart block or text lines — the shape
 * of the card that is coming.
 */
export function CardSkeleton({
  title = true,
  kpi = false,
  chart = false,
  lines = 3,
  className,
  framed = true
}: {
  title?: boolean
  kpi?: boolean
  chart?: boolean
  lines?: number
  className?: string
  /** false = no border/background (the host already draws the card). */
  framed?: boolean
}) {
  return (
    <div
      data-skeleton='card'
      aria-busy='true'
      className={cn(
        'flex flex-col gap-2',
        framed && 'rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card',
        className
      )}
    >
      {title && <SkeletonBar width='38%' className='h-2.5' />}
      {kpi && <SkeletonBar width='46%' className='mt-0.5 h-6 rounded-md' />}
      {chart && <SkeletonBar className='h-full min-h-[96px] w-full flex-1 rounded-md' />}
      {!kpi &&
        !chart &&
        Array.from({ length: lines }, (_, i) => (
          <SkeletonBar key={i} width={cellWidth('text', i, 3)} className='h-3' />
        ))}
    </div>
  )
}
