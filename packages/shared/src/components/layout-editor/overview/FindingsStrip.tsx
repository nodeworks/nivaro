import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Languages,
  Repeat,
  Tags,
  Unlink
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../../lib/utils'
import { DuplicateRow, LabelRow } from '../crossform/CrossformFindings'
import { useCrossform } from '../crossform/crossform-api'
import { useOrphans, useTranslationSummary } from '../inspect/inspect-api'
import { amberStrip } from '../panel-style'
import { CoverageSummary, useCoverageResult } from './analysis'
import { OrphanRow } from './OrphanRow'
import type { OverviewRow } from './types'

/**
 * Under the overview header: ONE strip for everything that needs a look
 * across the forms (design review: up to six stacked strips, each its own
 * amber, before). Collapsed it reads "4 things need a look" with a chip per
 * kind; a chip opens its rows, the heading opens them all. The coverage
 * check's result sits at its end. Kinds: rule loops (#2642), placements that
 * point at nothing (#2650), missing translations (#2665), a field labelled
 * differently on different forms (#2631) and near copies (#2660).
 */

type Kind = 'loops' | 'orphans' | 'translations' | 'labels' | 'duplicates'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const listCls =
  'divide-y divide-slate-100 bg-white text-slate-700 dark:divide-border/60 dark:bg-card dark:text-foreground'

export function FindingsStrip({
  collection,
  rows,
  loops,
  checking,
  onRecheck,
  onOpen,
  onCompare,
  onChanged
}: {
  collection: string
  rows: OverviewRow[]
  /** Rule loops: on every form (collection) and per form (byLayout). */
  loops: { byLayout: Map<number, string[]>; collection: string[] }
  checking: boolean
  onRecheck: () => void
  onOpen: (id: number) => void
  onCompare: (a: number, b: number) => void
  onChanged: () => void
}) {
  const [open, setOpen] = useState<Set<Kind>>(new Set())
  const { data: orphans = [] } = useOrphans(collection)
  const { data: i18n } = useTranslationSummary(collection)
  const { data: cross } = useCrossform(collection, rows.length > 0)
  const coverage = useCoverageResult()

  const missing = i18n?.locales.length ? i18n.layouts.filter((l) => l.missing > 0) : []
  const labels = cross?.labels ?? []
  const duplicates = cross?.duplicates ?? []
  const nameOf = (id: number) => rows.find((r) => r.layout_id === id)?.name ?? `Form ${id}`
  const loopLines = [
    ...loops.collection.map((t) => ({ key: `*:${t}`, form: null as string | null, text: t })),
    ...[...loops.byLayout].flatMap(([id, list]) =>
      list.map((t) => ({ key: `${id}:${t}`, form: nameOf(id), text: t }))
    )
  ]
  const placements = orphans.reduce((n, l) => n + l.placements.length, 0)

  const kinds: Array<{ kind: Kind; n: number; text: string; icon: ReactNode; body: ReactNode }> = [
    {
      kind: 'loops',
      n: loopLines.length,
      text: plural(loopLines.length, 'rule loop'),
      icon: <Repeat className='h-3.5 w-3.5' />,
      body: (
        <ul className={listCls} data-rule-loops=''>
          {loopLines.map((l) => (
            <li key={l.key} className='px-4 py-2 text-[12.5px] leading-snug'>
              <span className='font-medium text-slate-900 dark:text-foreground'>
                {l.form ?? 'Every form'}
              </span>
              {': '}Rule loop: {l.text}.
            </li>
          ))}
        </ul>
      )
    },
    {
      kind: 'orphans',
      n: placements,
      text:
        placements === 1
          ? '1 placement points at nothing'
          : `${placements} placements point at nothing`,
      icon: <Unlink className='h-3.5 w-3.5' />,
      body: (
        <div data-orphans='' className={cn(listCls, 'space-y-1.5 px-4 py-2.5')}>
          {orphans.map((l) => (
            <OrphanRow key={l.layout_id} layout={l} collection={collection} onChanged={onChanged} />
          ))}
        </div>
      )
    },
    {
      kind: 'translations',
      n: missing.length,
      text: `${plural(missing.length, 'form')} missing translations`,
      icon: <Languages className='h-3.5 w-3.5' />,
      body: (
        <p
          data-missing-translations=''
          className={cn(
            listCls,
            'm-0 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-4 py-2.5 text-[12px]'
          )}
        >
          <span>Missing translations ({i18n?.locales.join(', ')}):</span>
          {missing.map((l, i) => (
            <span key={l.layout_id} data-missing-layout={l.layout_id}>
              <span className='font-medium text-slate-800 dark:text-foreground'>{l.name}</span>{' '}
              {l.missing} of {l.total}
              {i < missing.length - 1 ? ' ·' : ''}
            </span>
          ))}
        </p>
      )
    },
    {
      kind: 'labels',
      n: labels.length,
      text: `${plural(labels.length, 'field')} labelled differently`,
      icon: <Tags className='h-3.5 w-3.5' />,
      body: (
        <ul className={listCls}>
          {labels.map((f) => (
            <LabelRow key={f.field} finding={f} collection={collection} />
          ))}
        </ul>
      )
    },
    {
      kind: 'duplicates',
      n: duplicates.length,
      text:
        duplicates.length === 1
          ? '2 forms are near copies'
          : `${duplicates.length} pairs of near copies`,
      icon: <Copy className='h-3.5 w-3.5' />,
      body: (
        <ul className={listCls}>
          {duplicates.map((p) => (
            <DuplicateRow
              key={`${p.a.id}-${p.b.id}`}
              pair={p}
              collection={collection}
              onOpen={onOpen}
              onCompare={onCompare}
            />
          ))}
        </ul>
      )
    }
  ]
  const present = kinds.filter((k) => k.n > 0)
  if (present.length === 0 && !coverage) return null
  const all = present.length > 0 && present.every((k) => open.has(k.kind))
  const toggle = (k: Kind) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  return (
    <section
      data-overview-findings={present.length}
      aria-label='Things that need a look'
      className={cn(
        'shrink-0 border-b',
        present.length > 0
          ? amberStrip
          : 'border-slate-200 bg-white text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'
      )}
    >
      <div className='flex flex-wrap items-center gap-x-1 gap-y-1 px-3 py-1.5'>
        {present.length > 0 && (
          <>
            <button
              type='button'
              data-findings-toggle=''
              aria-expanded={all}
              onClick={() => setOpen(all ? new Set() : new Set(present.map((k) => k.kind)))}
              className='inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] font-semibold hover:bg-amber-100/70 dark:hover:bg-amber-500/10'
            >
              <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
              {present.length} {present.length === 1 ? 'thing needs' : 'things need'} a look
              {all ? <ChevronDown className='h-3 w-3' /> : <ChevronRight className='h-3 w-3' />}
            </button>
            {present.map((k) => (
              <button
                key={k.kind}
                type='button'
                aria-expanded={open.has(k.kind)}
                data-findings-chip={k.kind}
                data-crossform-toggle={
                  k.kind === 'labels' || k.kind === 'duplicates' ? k.kind : undefined
                }
                onClick={() => toggle(k.kind)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors',
                  open.has(k.kind)
                    ? 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100'
                    : 'hover:bg-amber-100/70 dark:hover:bg-amber-500/10'
                )}
              >
                {k.icon}
                {k.text}
              </button>
            ))}
          </>
        )}
        <span className='ml-auto min-w-0'>
          <CoverageSummary rows={rows} checking={checking} onRecheck={onRecheck} />
        </span>
      </div>
      {present
        .filter((k) => open.has(k.kind))
        .map((k) => (
          <div
            key={k.kind}
            data-findings-section={k.kind}
            className='max-h-[320px] overflow-y-auto border-t border-amber-200 dark:border-amber-500/25'
          >
            {k.body}
          </div>
        ))}
    </section>
  )
}
