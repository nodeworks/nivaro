import { AlertCircle, Ban, CheckCircle2, Eye, RefreshCw, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import type { TemplateDetail } from './api'
import { usePayloadEditor } from './editor-context'
import { CHECK_LIMIT, type CheckResult, useCheck } from './panel-api'
import { InlineError, OUTLINE_BTN, PanelFrame, SECTION_LABEL } from './panel-parts'

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

function useElapsed(running: boolean) {
  const [s, setS] = useState(0)
  useEffect(() => {
    if (!running) return
    setS(0)
    const t = setInterval(() => setS((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [running])
  return s
}

/** "Checking up to 20 recent records…" while the one request runs (it answers all at once). */
export function CheckProgress({ what }: { what: string }) {
  const s = useElapsed(true)
  return (
    <div className='space-y-2' role='status' aria-live='polite' data-payload-check-progress>
      <div className='flex items-center justify-between text-[12.5px] text-slate-600 dark:text-slate-300'>
        <span>
          Rendering up to {CHECK_LIMIT} recent records with {what}…
        </span>
        <span className='tabular-nums text-slate-400'>{s > 1 ? `${s} s` : ''}</span>
      </div>
      <div className='h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
        <div className='h-full w-full rounded-full bg-nvr-cyan/40 motion-safe:animate-pulse' />
      </div>
      <p className='text-[11.5px] text-slate-400'>
        Each record renders on the server; this usually takes a few seconds.
      </p>
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
 * Check recent records: renders the newest records (or the registrar's recent
 * set) through the saved draft — or what is live — and lists which would fail
 * and why, with links to each record.
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
  const hasLive = template.published_version != null
  const [which, setWhich] = useState<'draft' | 'published'>('draft')
  const [run, setRun] = useState<{ rev: number; saved: boolean } | null>(null)
  const [preparing, setPreparing] = useState(false)

  const start = useCallback(async () => {
    setPreparing(true)
    const saved = await ctxRef.current.saveNow()
    setPreparing(false)
    setRun({ rev: ctxRef.current.getRev() ?? 0, saved })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once when the panel opens
  useEffect(() => {
    void start()
  }, [])

  const checkRev = which === 'published' ? (template.published_version ?? 0) : (run?.rev ?? null)
  const q = useCheck(template.key, which, checkRev, which === 'published' || !!run)
  const draftMoved = which === 'draft' && run != null && ctx.rev != null && ctx.rev !== run.rev

  const runAgain = async () => {
    if (which === 'published') return void q.refetch()
    const before = run?.rev
    await start()
    if (ctxRef.current.getRev() === before) void q.refetch()
  }

  return (
    <PanelFrame
      title='Check recent records'
      panel='check'
      onClose={onClose}
      actions={
        <button
          type='button'
          onClick={() => void runAgain()}
          disabled={q.isFetching || preparing}
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
          <div
            className='inline-flex rounded-md border border-slate-200 p-0.5 dark:border-border'
            role='tablist'
            aria-label='Which version to check'
          >
            {(['draft', 'published'] as const).map((w) => {
              const off = w === 'published' && !hasLive
              return (
                <span key={w} data-tip={off ? 'Nothing is published yet' : undefined}>
                  <button
                    type='button'
                    role='tab'
                    aria-selected={which === w}
                    disabled={off}
                    onClick={() => setWhich(w)}
                    className={cn(
                      'rounded px-2.5 py-1 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-40',
                      which === w
                        ? 'bg-slate-100 text-slate-900 dark:bg-muted dark:text-foreground'
                        : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                    )}
                  >
                    {w === 'draft' ? 'Your draft' : `Live v${template.published_version ?? ''}`}
                  </button>
                </span>
              )
            })}
          </div>
        </div>

        {which === 'draft' && run && !run.saved && (
          <p className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
            Your latest edit didn't save
            {ctx.saveError ? ` (${ctx.saveError.message})` : ''}, so this checks the last saved
            draft.
          </p>
        )}
        {draftMoved && !q.isFetching && (
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            You've edited the draft since this check.{' '}
            <button
              type='button'
              onClick={() => void runAgain()}
              className='font-medium text-slate-800 underline underline-offset-2 dark:text-foreground'
            >
              Run again
            </button>
          </p>
        )}

        {preparing || (q.isFetching && !q.data) || (which === 'draft' && !run) ? (
          <CheckProgress what={which === 'draft' ? 'your draft' : 'the live version'} />
        ) : q.isError ? (
          <InlineError
            title='The check could not run.'
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        ) : q.data ? (
          <>
            {q.isFetching && (
              <CheckProgress what={which === 'draft' ? 'your draft' : 'the live version'} />
            )}
            <CheckSummary results={q.data} collection={template.collection} />
            <CheckResultsList
              results={q.data}
              collection={template.collection}
              onPreview={onPreview}
            />
          </>
        ) : null}
      </div>
    </PanelFrame>
  )
}
