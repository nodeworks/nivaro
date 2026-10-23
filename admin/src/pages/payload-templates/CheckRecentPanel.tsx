import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Ban, CheckCircle2, Eye, RefreshCw, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import type { TemplateDetail } from './api'
import { usePayloadEditor } from './editor-context'
import { CHECK_LIMIT, type CheckResult, useChunkedCheck } from './panel-api'
import { InlineError, OUTLINE_BTN, PanelFrame, SECTION_LABEL, Segmented } from './panel-parts'

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const blocking = (r: CheckResult) => r.problems.filter((p) => p.severity === 'error')

/** Failures first, then records the sender would skip, then the ones that pass. */
export function orderResults(results: CheckResult[]): CheckResult[] {
  const rank = (r: CheckResult) => (!r.ok ? 0 : r.skipped ? 1 : 2)
  return [...results].sort((a, b) => rank(a) - rank(b))
}

export function summarize(results: CheckResult[]) {
  const failed = results.filter((r) => !r.ok).length
  const skipped = results.filter((r) => r.ok && r.skipped).length
  return { failed, skipped, passed: results.length - failed - skipped, total: results.length }
}

/** Determinate progress: "12 / 20" records rendered (chunks of CHECK_CHUNK, as they finish). */
export function CheckProgress({
  what,
  done,
  total
}: {
  what: string
  done: number
  total: number | null
}) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div className='space-y-2' role='status' aria-live='polite' data-payload-check-progress>
      <div className='flex items-center justify-between gap-3 text-[12.5px] text-slate-600 dark:text-slate-300'>
        <span>
          {total == null ? 'Finding the recent records…' : `Rendering recent records with ${what}…`}
        </span>
        {total != null && (
          <span className='shrink-0 tabular-nums font-medium text-slate-700 dark:text-slate-200'>
            {done} / {total}
          </span>
        )}
      </div>
      <div
        className='h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
        role='progressbar'
        aria-valuemin={0}
        aria-valuemax={total ?? 0}
        aria-valuenow={done}
        aria-label='Records checked'
      >
        <div
          className={cn(
            'h-full rounded-full bg-nvr-cyan transition-[width] duration-200',
            total == null && 'w-full bg-nvr-cyan/30 motion-safe:animate-pulse'
          )}
          style={total == null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** The pass/fail table. `failuresOnly` lists just the failing records (Publish panel). */
export function CheckResultsList({
  results,
  collection,
  onPreview,
  failuresOnly = false
}: {
  results: CheckResult[]
  collection: string
  onPreview?: (id: string) => void
  failuresOnly?: boolean
}) {
  const rows = useMemo(
    () => orderResults(results).filter((r) => !failuresOnly || !r.ok),
    [results, failuresOnly]
  )
  if (!rows.length) return null
  return (
    <ul
      className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'
      data-payload-check-results
    >
      {rows.map((r) => {
        const errs = blocking(r)
        const warns = r.problems.filter((p) => p.severity !== 'error')
        return (
          <li
            key={r.id}
            className='px-3 py-2'
            data-check-result={!r.ok ? 'fail' : r.skipped ? 'skip' : 'pass'}
          >
            <div className='flex min-w-0 items-center gap-2'>
              {!r.ok ? (
                <XCircle
                  className='h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400'
                  aria-label='Would fail'
                />
              ) : r.skipped ? (
                <Ban className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-label='Would not send' />
              ) : (
                <CheckCircle2
                  className='h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400'
                  aria-label='Would send'
                />
              )}
              <Link
                to={`/collections/${encodeURIComponent(collection)}/${encodeURIComponent(r.id)}`}
                className='min-w-0 truncate text-[12.5px] font-medium text-slate-800 underline-offset-2 hover:underline dark:text-slate-100'
                data-tip={`Open ${collection} ${r.id}`}
              >
                {r.label}
              </Link>
              {r.label !== r.id && (
                <span className='shrink-0 font-mono text-[11px] text-slate-400'>#{r.id}</span>
              )}
              <span className='flex-1' />
              {onPreview && (
                <button
                  type='button'
                  onClick={() => onPreview(r.id)}
                  className='inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted dark:hover:text-foreground'
                  data-tip='Show this record in the preview'
                >
                  <Eye className='h-3 w-3' />
                  Preview
                </button>
              )}
            </div>
            {r.ok && r.skipped && (
              <p className='mt-0.5 pl-[22px] text-[12px] text-slate-500 dark:text-muted-foreground'>
                Wouldn't send: {r.skipped}
              </p>
            )}
            {errs.length > 0 && (
              <ul className='mt-1 space-y-0.5 pl-[22px]'>
                {errs.map((p) => (
                  <li
                    key={`${p.field_id}:${p.path}:${p.message}`}
                    className='text-[12px] leading-snug text-red-700 dark:text-red-300'
                  >
                    {p.path && <span className='mr-1.5 font-mono text-[11.5px]'>{p.path}</span>}
                    {p.message}
                  </li>
                ))}
              </ul>
            )}
            {!failuresOnly && warns.length > 0 && (
              <p className='mt-0.5 pl-[22px] text-[12px] text-amber-700 dark:text-amber-300'>
                {plural(warns.length, 'warning')}: {warns[0].message}
                {warns.length > 1 ? ' …' : ''}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function CheckSummary({
  results,
  collection
}: {
  results: CheckResult[]
  collection: string
}) {
  const s = summarize(results)
  if (!s.total)
    return (
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        No {collection} records to check yet. Once records exist, the newest {CHECK_LIMIT} are
        rendered here.
      </p>
    )
  return (
    <p
      className={cn(
        'flex items-center gap-1.5 text-[12.5px] font-medium',
        s.failed ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'
      )}
      data-payload-check-summary
    >
      {s.failed ? (
        <AlertCircle className='h-3.5 w-3.5' />
      ) : (
        <CheckCircle2 className='h-3.5 w-3.5' />
      )}
      {s.failed ? `${s.failed} of ${s.total} would fail` : `All ${s.total} would send`}
      {s.skipped > 0 && (
        <span className='font-normal text-slate-500 dark:text-muted-foreground'>
          · {s.skipped} wouldn't send at all
        </span>
      )}
    </p>
  )
}

/**
 * Check recent records: renders the recent-records set (the registrar's recent() or the newest
 * records) through the saved draft — or what is live — CHECK_CHUNK at a time, showing "N / M",
 * and lists which would fail and why, with links to each record.
 */
export function CheckRecentPanel({
  template,
  onClose,
  onPreview
}: {
  template: TemplateDetail
  onClose: () => void
  onPreview: (id: string) => void
}) {
  const ctx = usePayloadEditor()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const qc = useQueryClient()
  const hasLive = template.published_version != null
  const [which, setWhich] = useState<'draft' | 'published'>('draft')
  // One run of the draft check: the saved rev it covers + a counter for "Run again".
  const [run, setRun] = useState<{ rev: number; n: number; saved: boolean } | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [liveN, setLiveN] = useState(0)

  const start = useCallback(async (n: number) => {
    setPreparing(true)
    const saved = await ctxRef.current.saveNow()
    setPreparing(false)
    setRun({ rev: ctxRef.current.getRev() ?? 0, n, saved })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once when the panel opens
  useEffect(() => {
    void start(0)
  }, [])

  const runKey =
    which === 'published'
      ? `v${template.published_version ?? 0}:${liveN}`
      : run
        ? `${run.rev}:${run.n}`
        : null
  const check = useChunkedCheck(template.key, which, runKey)
  const running = preparing || check.status === 'running' || (which === 'draft' && !run)
  const draftMoved = which === 'draft' && run != null && ctx.rev != null && ctx.rev !== run.rev

  const runAgain = () => {
    // A new run key starts over; drop the cached result so it really re-renders.
    void qc.removeQueries({ queryKey: ['payload-templates', 'check', template.key] })
    if (which === 'published') setLiveN((x) => x + 1)
    else void start((run?.n ?? 0) + 1)
  }

  return (
    <PanelFrame
      title='Check recent records'
      panel='check'
      onClose={onClose}
      actions={
        <button
          type='button'
          onClick={runAgain}
          disabled={running}
          className={cn(OUTLINE_BTN, 'h-7 px-2.5 text-[12px]')}
        >
          <RefreshCw className='h-3 w-3' />
          Run again
        </button>
      }
    >
      <div className='space-y-3 px-4 py-3'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className={SECTION_LABEL}>Check</span>
          <Segmented
            legend='Which version to check'
            value={which}
            onChange={setWhich}
            options={[
              { value: 'draft', label: 'Your draft' },
              {
                value: 'published',
                label: `Live v${template.published_version ?? ''}`,
                off: hasLive ? undefined : 'Nothing is published yet'
              }
            ]}
          />
        </div>

        {which === 'draft' && run && !run.saved && (
          <p className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
            {ctx.conflicted
              ? 'Saving is paused while the conflict above stands, so this checks the last saved draft.'
              : `Your latest edit didn't save${ctx.saveError ? ` (${ctx.saveError.message})` : ''}, so this checks the last saved draft.`}
          </p>
        )}
        {draftMoved && !running && (
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            You've edited the draft since this check.{' '}
            <button
              type='button'
              onClick={runAgain}
              className='font-medium text-slate-800 underline underline-offset-2 dark:text-foreground'
            >
              Run again
            </button>
          </p>
        )}

        {running && (
          <CheckProgress
            what={which === 'draft' ? 'your draft' : 'the live version'}
            done={check.done}
            total={preparing || (which === 'draft' && !run) ? null : check.total}
          />
        )}
        {check.status === 'error' && (
          <InlineError title='The check could not finish.' error={check.error} onRetry={runAgain} />
        )}
        {check.status === 'done' && (
          <CheckSummary results={check.results} collection={template.collection} />
        )}
        <CheckResultsList
          results={check.results}
          collection={template.collection}
          onPreview={onPreview}
        />
      </div>
    </PanelFrame>
  )
}
