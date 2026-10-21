import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'
import { Skeleton } from '../../ui/skeleton'
import {
  type DependencyNode,
  type LayoutChange,
  type LayoutDependencies,
  useLayoutDependencies
} from './ops-api'

/**
 * What relies on a layout, drawn (#2613): the layout on the left, everything
 * that opens it on the right in lanes (other layouts, queues, grids and
 * drill-downs, share links and public forms, generated files, extension code),
 * joined by lines. With a pending `change` the lines and boxes of what that
 * change would break turn red, and a sentence says how many.
 *
 * Boxes are HTML (real text that wraps and reads at any width); only the
 * lines are SVG, measured from the boxes after layout.
 */

const KIND_LABEL: Record<string, string> = {
  grouped: 'Form',
  summary: 'Summary',
  detail: 'Drill-down',
  file: 'PDF',
  addendum: 'Addendum',
  table: 'Grid columns'
}

export function breaksOn(node: DependencyNode, change: LayoutChange | null | undefined): boolean {
  if (!change || change === 'rename') return false
  return node.breaks.includes(change)
}

/** The sentence over the diagram for a pending change. */
export function impactSentence(
  nodes: DependencyNode[],
  change: LayoutChange | null | undefined
): string {
  const n = nodes.length
  if (n === 0) return 'Nothing stored here uses this layout.'
  const things = `${n} ${n === 1 ? 'thing uses' : 'things use'} this layout`
  if (!change) return `${things}.`
  if (change === 'rename')
    return `${things}. Renaming keeps every one working: they find it by its id or link name.`
  const broken = nodes.filter((x) => breaksOn(x, change)).length
  if (broken === 0) return `${things}. None of them depends on what you are changing.`
  const verb =
    change === 'slug'
      ? 'find it by its link name and stop finding it when the link name changes'
      : change === 'type'
        ? 'expect this kind of layout and may stop working as another kind'
        : 'stop working when it is deleted'
  return `${broken} of ${n} ${verb}.`
}

export function DependencyDiagram({
  layoutId,
  change,
  className,
  compact
}: {
  layoutId: number
  /** The change about to be made; what it breaks is drawn in red. */
  change?: LayoutChange | null
  className?: string
  /** Narrow host (Form settings): smaller boxes. */
  compact?: boolean
}) {
  const { data, isLoading, isError } = useLayoutDependencies(layoutId)
  if (isLoading)
    return (
      <div className={cn('space-y-2', className)} data-dependency-diagram='loading'>
        <Skeleton className='h-4 w-2/3' />
        <Skeleton className='h-20 w-full' />
      </div>
    )
  if (isError || !data)
    return (
      <p className={cn('text-[12px] text-red-600 dark:text-red-400', className)}>
        Could not read what uses this layout.
      </p>
    )
  return (
    <DependencyDiagramView data={data} change={change} className={className} compact={compact} />
  )
}

export function DependencyDiagramView({
  data,
  change,
  className,
  compact
}: {
  data: LayoutDependencies
  change?: LayoutChange | null
  className?: string
  compact?: boolean
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const source = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<Array<{ d: string; broken: boolean; key: string }>>([])
  const [size, setSize] = useState({ w: 0, h: 0 })

  const lanes = data.groups
    .map((g) => ({ ...g, nodes: data.nodes.filter((n) => n.group === g.id) }))
    .filter((g) => g.nodes.length > 0 || g.id === 'extensions')

  const measure = useCallback(() => {
    const root = wrap.current
    const src = source.current
    if (!root || !src) return
    const box = root.getBoundingClientRect()
    const s = src.getBoundingClientRect()
    const x0 = Math.floor(s.right - box.left)
    const y0 = Math.floor(s.top - box.top + s.height / 2)
    const next: Array<{ d: string; broken: boolean; key: string }> = []
    for (const el of root.querySelectorAll<HTMLElement>('[data-dep-node]')) {
      const r = el.getBoundingClientRect()
      const x1 = Math.floor(r.left - box.left)
      const y1 = Math.floor(r.top - box.top + r.height / 2)
      const mid = Math.max(12, (x1 - x0) / 2)
      next.push({
        key: el.dataset.depNode ?? String(next.length),
        broken: el.dataset.broken === 'true',
        d: `M ${x0} ${y0} C ${x0 + mid} ${y0}, ${x1 - mid} ${y1}, ${x1} ${y1}`
      })
    }
    setPaths(next)
    setSize({ w: Math.floor(box.width), h: Math.floor(box.height) })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when what is drawn changes
  useLayoutEffect(() => {
    measure()
    const root = wrap.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(root)
    return () => ro.disconnect()
  }, [measure, data, change])

  const broken = data.nodes.filter((n) => breaksOn(n, change)).length
  return (
    <div className={cn('space-y-2', className)} data-dependency-diagram={data.layout.id}>
      <p
        className={cn(
          'text-[12px]',
          broken
            ? 'font-medium text-red-700 dark:text-red-300'
            : 'text-slate-600 dark:text-muted-foreground'
        )}
        data-dependency-summary
      >
        {impactSentence(data.nodes, change)}
      </p>
      <div
        ref={wrap}
        className={cn(
          'relative grid items-center',
          compact ? 'grid-cols-[96px_1fr] gap-x-7' : 'grid-cols-[minmax(120px,28%)_1fr] gap-x-12'
        )}
      >
        <svg
          aria-hidden='true'
          className='pointer-events-none absolute inset-0 overflow-visible'
          width={size.w}
          height={size.h}
        >
          {paths.map((p) => (
            <path
              key={p.key}
              d={p.d}
              fill='none'
              strokeWidth={p.broken ? 1.75 : 1.25}
              strokeDasharray={p.key.startsWith('ext-unchecked') ? '3 3' : undefined}
              className={
                p.broken
                  ? 'stroke-red-400 dark:stroke-red-400/80'
                  : 'stroke-slate-300 dark:stroke-slate-600'
              }
            />
          ))}
        </svg>
        <div
          ref={source}
          className='relative z-[1] rounded-lg border border-nvr-cyan/60 bg-nvr-cyan/10 px-2.5 py-2 text-[12px]'
          data-dep-source
        >
          <div className='font-semibold leading-tight text-slate-900 dark:text-foreground'>
            {data.layout.name}
          </div>
          <div className='mt-0.5 text-[11px] text-slate-600 dark:text-muted-foreground'>
            {KIND_LABEL[data.layout.layout_type] ?? data.layout.layout_type}
            {data.layout.slug ? (
              <>
                {' · '}
                <code className='font-mono'>{data.layout.slug}</code>
              </>
            ) : null}
          </div>
        </div>
        <div className='relative z-[1] min-w-0 space-y-2.5 py-1'>
          {lanes.map((lane) => (
            <div key={lane.id} data-dep-lane={lane.id}>
              <div className='mb-1 text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
                {lane.label}
              </div>
              <div className='space-y-1'>
                {lane.nodes.map((n) => {
                  const b = breaksOn(n, change)
                  return (
                    <div
                      key={`${n.kind}:${n.id}`}
                      data-dep-node={`${n.kind}:${n.id}`}
                      data-broken={b}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[12px] leading-snug',
                        b
                          ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200'
                          : 'border-slate-200 bg-white text-slate-700 dark:border-border dark:bg-card dark:text-foreground'
                      )}
                    >
                      <span className='break-words'>{n.label}</span>
                      <span
                        className={cn(
                          'ml-1.5 whitespace-nowrap text-[10.5px]',
                          b
                            ? 'text-red-700 dark:text-red-300'
                            : 'text-slate-400 dark:text-muted-foreground'
                        )}
                      >
                        {b
                          ? 'breaks'
                          : `by ${n.by === 'slug' ? 'link name' : n.by === 'id' ? 'id' : 'id or link name'}`}
                      </span>
                    </div>
                  )
                })}
                {lane.id === 'extensions' && (
                  <div
                    data-dep-node='ext-unchecked'
                    data-broken='false'
                    className='rounded-md border border-dashed border-slate-300 px-2 py-1 text-[11.5px] text-slate-500 dark:border-border dark:text-muted-foreground'
                  >
                    {data.extensions.note}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
