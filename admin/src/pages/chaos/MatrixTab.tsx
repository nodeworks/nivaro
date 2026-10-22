import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Play, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime } from '@/lib/utils'
import { type Catalog, type CatalogFault, chaosKeys, fetchCatalog, type Verdict } from './api'
import {
  type ClaimStatus,
  type ClaimView,
  fetchClaims,
  fetchMatrix,
  fmtAge,
  type Matrix,
  type MatrixCell,
  type MatrixKind,
  reportKeys,
  VERDICT_WORD
} from './report-api'
import { StartForm } from './StartForm'

/**
 * Matrix (#2850) — the screen for the resilience scorecard (#2830). Top: every dependency ×
 * how it can fail, each cell coloured by the verdict of its newest drill and faded as that drill
 * ages; a cell nobody has drilled reads "Not proven". A cell opens a small popover beside it:
 * the last report, or run it again (the start form opens under the grid, pre-filled). Below:
 * every claim Nivaro makes about degrading, with its status.
 */

const KIND_LABEL: Record<MatrixKind, string> = {
  down: 'Down',
  slow: 'Slow',
  errors: 'Errors',
  partitioned: 'Cut off'
}
const KIND_HINT: Record<MatrixKind, string> = {
  down: 'Unreachable or out of capacity',
  slow: 'Answers, but late',
  errors: 'Answers with failures',
  partitioned: 'One replica cut off from the rest'
}

const TINT: Record<Verdict, string> = {
  held: 'bg-emerald-100 dark:bg-emerald-500/20',
  broke: 'bg-red-100 dark:bg-red-500/20',
  aborted: 'bg-amber-100 dark:bg-amber-500/20'
}
const INK: Record<Verdict, string> = {
  held: 'text-emerald-900 dark:text-emerald-200',
  broke: 'text-red-900 dark:text-red-200',
  aborted: 'text-amber-900 dark:text-amber-200'
}

/** A verdict fades as it ages: full strength today, 45% at 90 days and beyond. */
const fade = (ageDays: number) => Math.max(0.45, 1 - (Math.min(ageDays, 90) / 90) * 0.55)

export function MatrixTab() {
  const matrix = useQuery<Matrix>({ queryKey: reportKeys.matrix, queryFn: fetchMatrix })
  const catalog = useQuery<Catalog>({ queryKey: chaosKeys.catalog, queryFn: fetchCatalog })
  const [rerun, setRerun] = useState<{ fault: CatalogFault; where: string } | null>(null)
  const formRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (rerun) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [rerun])

  const faults = useMemo(
    () => new Map((catalog.data?.faults ?? []).map((f) => [f.key, f])),
    [catalog.data]
  )
  const startRerun = (cell: MatrixCell, rowLabel: string) => {
    const f = cell.rerun ? faults.get(cell.rerun.fault_key) : null
    if (!f || !cell.rerun) return
    setRerun({
      fault: prefill(f, cell.rerun.params),
      where: `${rowLabel} · ${KIND_LABEL[cell.kind]}`
    })
  }

  return (
    <div className='flex-1 overflow-y-auto px-4 py-5 sm:p-6'>
      <div className='mb-4 min-w-0'>
        <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
          Resilience matrix
        </h2>
        <p className='mt-0.5 max-w-[75ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Each dependency and each way it can fail, coloured by its newest drill. Colour fades as
          the proof gets older; an outlined cell has never been proven.
        </p>
      </div>

      {matrix.isLoading ? (
        <Skeleton className='h-72 w-full' />
      ) : matrix.isError || !matrix.data ? (
        <p className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
          The matrix did not load. Reload the page to try again.
        </p>
      ) : (
        <>
          <MatrixKey />
          <MatrixGrid
            matrix={matrix.data}
            canRun={!matrix.data.refusal}
            refusal={matrix.data.refusal}
            hasFault={(k) => faults.has(k)}
            onRerun={startRerun}
          />
        </>
      )}

      {rerun && (
        <div
          ref={formRef}
          className='mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
        >
          <div className='flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
            <div className='min-w-0 text-[12.5px]'>
              <span className='font-semibold text-slate-900 dark:text-foreground'>
                {rerun.fault.label}
              </span>
              <span className='text-slate-500 dark:text-muted-foreground'> · {rerun.where}</span>
            </div>
            <button
              type='button'
              onClick={() => setRerun(null)}
              aria-label='Close the start form'
              className='inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>
          <StartForm key={rerun.where} fault={rerun.fault} onClose={() => setRerun(null)} />
        </div>
      )}

      <ClaimsSection />
    </div>
  )
}

/** The start form reads its initial values from the fault: hand it one pre-set for this cell. */
function prefill(f: CatalogFault, params: Record<string, number | string | boolean>): CatalogFault {
  const next: CatalogFault['params'] = {}
  for (const [k, spec] of Object.entries(f.params)) {
    const v = params[k]
    if (v == null) next[k] = spec
    else if (spec.type === 'number') {
      const n = Number(v)
      next[k] = Number.isFinite(n)
        ? { ...spec, default: Math.min(spec.max, Math.max(spec.min, n)) }
        : spec
    } else if (spec.type === 'enum')
      next[k] = spec.options.includes(String(v)) ? { ...spec, default: String(v) } : spec
    else if (spec.type === 'boolean') next[k] = { ...spec, default: Boolean(v) }
    else next[k] = { ...spec, default: String(v) }
  }
  return { ...f, params: next }
}

function MatrixKey() {
  const sw = 'inline-block h-3 w-4 rounded-sm'
  return (
    <div className='mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
      <span className='flex items-center gap-1.5'>
        <span className={cn(sw, TINT.held)} /> Held
      </span>
      <span className='flex items-center gap-1.5'>
        <span className={cn(sw, TINT.broke)} /> Broke
      </span>
      <span className='flex items-center gap-1.5'>
        <span className={cn(sw, TINT.aborted)} /> Aborted itself
      </span>
      <span className='flex items-center gap-1.5'>
        <span className={cn(sw, 'border border-dashed border-slate-300 dark:border-border')} /> Not
        proven
      </span>
      <span>Paler = older proof</span>
    </div>
  )
}

function MatrixGrid({
  matrix,
  canRun,
  refusal,
  hasFault,
  onRerun
}: {
  matrix: Matrix
  canRun: boolean
  refusal: string | null
  hasFault: (key: string) => boolean
  onRerun: (cell: MatrixCell, rowLabel: string) => void
}) {
  const byKey = new Map(matrix.cells.map((c) => [`${c.dependency}|${c.kind}`, c]))
  return (
    <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <table className='w-full min-w-[640px] border-separate border-spacing-0 text-[12.5px]'>
        <thead>
          <tr>
            <th className='w-[200px] border-b border-slate-200 px-3 py-2 text-left text-[11.5px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
              Dependency
            </th>
            {matrix.kinds.map((k) => (
              <th
                key={k}
                scope='col'
                data-tip={KIND_HINT[k]}
                className='border-b border-slate-200 px-1.5 py-2 text-left text-[11.5px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'
              >
                {KIND_LABEL[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={row.id}>
              <th
                scope='row'
                className={cn(
                  'border-b border-slate-100 px-3 py-1.5 text-left font-medium text-slate-900 dark:border-border/60 dark:text-foreground',
                  row.partner && 'pl-7 font-normal text-slate-700 dark:text-foreground/90'
                )}
              >
                {row.label}
              </th>
              {matrix.kinds.map((k) => {
                const cell = byKey.get(`${row.id}|${k}`)
                return (
                  <td key={k} className='border-b border-slate-100 p-1 dark:border-border/60'>
                    {cell && (
                      <Cell
                        cell={cell}
                        rowLabel={row.label}
                        canRun={canRun && !!cell.rerun && hasFault(cell.rerun.fault_key)}
                        refusal={refusal}
                        onRerun={onRerun}
                      />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Cell({
  cell,
  rowLabel,
  canRun,
  refusal,
  onRerun
}: {
  cell: MatrixCell
  rowLabel: string
  canRun: boolean
  refusal: string | null
  onRerun: (cell: MatrixCell, rowLabel: string) => void
}) {
  const [open, setOpen] = useState(false)
  const last = cell.last
  const v = last?.verdict ?? null
  const tip = last
    ? `${v ? VERDICT_WORD[v] : 'No verdict'} · ${formatDateTime(last.at)}`
    : 'Not proven yet'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-tip={tip}
          aria-label={`${rowLabel}, ${KIND_LABEL[cell.kind]}: ${tip}`}
          className={cn(
            'relative flex h-10 w-full min-w-[104px] items-center overflow-hidden rounded-md px-2.5 text-left transition-shadow duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
            last
              ? 'hover:ring-1 hover:ring-slate-300 dark:hover:ring-border'
              : 'border border-dashed border-slate-300 hover:border-slate-400 dark:border-border dark:hover:border-muted-foreground/60'
          )}
        >
          {v && last && (
            <span
              aria-hidden
              className={cn('absolute inset-0', TINT[v])}
              style={{ opacity: fade(last.age_days) }}
            />
          )}
          <span className='relative min-w-0'>
            {last && v ? (
              <>
                <span className={cn('block text-[12px] font-medium leading-tight', INK[v])}>
                  {VERDICT_WORD[v]}
                </span>
                <span className='block truncate text-[11px] leading-tight text-slate-600 dark:text-muted-foreground'>
                  {fmtAge(last.age_days)}
                </span>
              </>
            ) : (
              <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                Not proven
              </span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' side='bottom' className='w-72 p-3'>
        <div className='text-[12.5px]'>
          <div className='font-semibold text-slate-900 dark:text-foreground'>
            {rowLabel} · {KIND_LABEL[cell.kind]}
          </div>
          <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {KIND_HINT[cell.kind]}
          </p>
          {last ? (
            <p className='mt-2 text-slate-700 dark:text-foreground'>
              Last drill{' '}
              <span className={cn('font-medium', v ? INK[v] : '')}>
                {v ? VERDICT_WORD[v].toLowerCase() : 'ended'}
              </span>{' '}
              {fmtAge(last.age_days)} ({formatDateTime(last.at)}) with{' '}
              <span className='font-mono text-[11.5px]'>{last.fault_key}</span>.{' '}
              {cell.runs > 1 ? `${cell.runs} drills in all.` : ''}
            </p>
          ) : (
            <p className='mt-2 text-slate-700 dark:text-foreground'>
              No drill has proven this yet.
              {!cell.rerun && ' No fault in the catalog can simulate it on this instance.'}
            </p>
          )}
          <div className='mt-3 flex flex-wrap gap-2'>
            {last && (
              <Link
                to={`/chaos/runs/${last.run_id}`}
                className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:text-foreground dark:hover:bg-muted'
              >
                <ExternalLink className='h-3 w-3' />
                Open report
              </Link>
            )}
            {cell.rerun && (
              <button
                type='button'
                disabled={!canRun}
                onClick={() => {
                  setOpen(false)
                  onRerun(cell, rowLabel)
                }}
                className='inline-flex h-7 items-center gap-1.5 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white hover:bg-nvr-cyan/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 dark:focus-visible:ring-offset-card'
              >
                <Play className='h-3 w-3' />
                {last ? 'Run again' : 'Run'}
              </button>
            )}
          </div>
          {cell.rerun && !canRun && refusal && (
            <p className='mt-2 text-[11.5px] text-amber-800 dark:text-amber-300'>{refusal}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Claims (#2830) ───────────────────────────────────────────────────────────

const STATUS_CHIP: Record<ClaimStatus, { label: string; cls: string }> = {
  proven: {
    label: 'Proven',
    cls: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
  },
  broke: { label: 'Broke', cls: 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300' },
  stale: {
    label: 'Stale',
    cls: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
  },
  never: {
    label: 'Never proven',
    cls: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
  }
}
const STATUS_ORDER: ClaimStatus[] = ['broke', 'stale', 'never', 'proven']

function ClaimsSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: reportKeys.claims,
    queryFn: fetchClaims
  })
  const claims = [...(data?.claims ?? [])].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
  )
  const counts = STATUS_ORDER.map((s) => [s, claims.filter((c) => c.status === s).length] as const)
  return (
    <section className='mt-8'>
      <div className='mb-2 flex flex-wrap items-end justify-between gap-3'>
        <div className='min-w-0'>
          <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>Claims</h2>
          <p className='mt-0.5 max-w-[75ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            What Nivaro says about how it degrades, and the drill that last proved it. A claim not
            proven within its window, or whose last drill broke, warns on Readiness.
          </p>
        </div>
        {data && (
          <span className='text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
            {counts
              .filter(([, n]) => n)
              .map(([s, n]) => `${n} ${STATUS_CHIP[s].label.toLowerCase()}`)
              .join(' · ')}
          </span>
        )}
      </div>
      {isLoading ? (
        <Skeleton className='h-48 w-full' />
      ) : isError || !data ? (
        <p className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
          The claims did not load.
        </p>
      ) : (
        <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
          {claims.map((c) => (
            <ClaimRow key={c.key} claim={c} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ClaimRow({ claim: c }: { claim: ClaimView }) {
  const chip = STATUS_CHIP[c.status]
  return (
    <li className='flex flex-wrap items-start gap-x-4 gap-y-1.5 px-3 py-2.5'>
      <span
        className={cn(
          'mt-0.5 w-[92px] shrink-0 rounded px-1.5 py-0.5 text-center text-[10.5px] font-medium',
          chip.cls
        )}
      >
        {chip.label}
      </span>
      <div className='min-w-0 flex-1 basis-72'>
        <p className='text-[12.5px] text-slate-900 dark:text-foreground'>{c.statement}</p>
        <p className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
          <span className='font-mono'>{c.key}</span>
          {' · proven by '}
          <span className='font-mono'>{c.faults.join(', ')}</span>
          {!c.provable && ' · no fault for it on this instance yet'}
        </p>
      </div>
      <div className='shrink-0 text-right text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        {c.last_run ? (
          <Link
            to={`/chaos/runs/${c.last_run.id}`}
            className='rounded px-1 py-0.5 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted dark:hover:text-foreground'
          >
            {c.last_run.verdict ? VERDICT_WORD[c.last_run.verdict] : 'Ran'}{' '}
            {fmtAge(c.last_run.age_days)}
          </Link>
        ) : (
          <span>Never run</span>
        )}
      </div>
    </li>
  )
}
