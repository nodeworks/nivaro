import { ErrorNotice } from '@nivaro/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Loader2, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { formatRelative } from '@/lib/utils'
import { fetchPreview, type RuleDraft, ruleErrorsOf, trackerKeys } from './api'
import { ChoiceButtons } from './rule-fields'
import { ruleBody } from './rule-sentence'

export const PREVIEW_DEBOUNCE_MS = 600
const SHOWN = 15

/** The value, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

/**
 * What the draft rule would have done over the last 7 or 30 days — a read-only
 * replay on the server (nothing is stored or sent), asked again 600 ms after
 * the last change.
 */
export function RulePreview({ draft }: { draft: RuleDraft }) {
  const [days, setDays] = useState<7 | 30>(7)
  const body = useMemo(() => JSON.stringify(ruleBody(draft)), [draft])
  const settled = useDebounced(body, PREVIEW_DEBOUNCE_MS)
  const waiting = settled !== body
  const preview = useQuery({
    queryKey: trackerKeys.preview(settled, days),
    queryFn: () => fetchPreview(JSON.parse(settled) as Record<string, unknown>, days),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000
  })
  const ticket = draft.applies_to === 'ticket'
  const thing = ticket ? 'support ticket' : 'issue'
  const verb = draft.mode === 'create' ? 'opened' : 'suggested'
  const invalid = preview.isError ? ruleErrorsOf(preview.error) : null
  const d = preview.data

  return (
    <section
      aria-labelledby='tracker-rule-preview'
      aria-busy={preview.isFetching || waiting}
      className='space-y-3'
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h4
          id='tracker-rule-preview'
          className='inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-900 dark:text-foreground'
        >
          Preview
          {(preview.isFetching || waiting) && (
            <Loader2 className='h-3 w-3 animate-spin text-slate-400' aria-label='Updating' />
          )}
        </h4>
        <ChoiceButtons
          single
          ariaLabel='Preview period'
          value={[String(days)]}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' }
          ]}
          onChange={(v) => setDays(v[0] === '30' ? 30 : 7)}
        />
      </div>

      {invalid ? (
        <div className='space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-500/30 dark:bg-amber-500/10'>
          <p className='inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-900 dark:text-amber-200'>
            <TriangleAlert className='h-3.5 w-3.5' aria-hidden />
            Fix the rule to see a preview
          </p>
          <ul className='list-disc space-y-0.5 pl-5 text-[11.5px] text-amber-900 dark:text-amber-200'>
            {invalid.map((e) => (
              <li key={`${e.path}:${e.message}`}>{e.message}</li>
            ))}
          </ul>
        </div>
      ) : preview.isError ? (
        <ErrorNotice
          error={preview.error}
          what='the preview'
          onRetry={() => void preview.refetch()}
        />
      ) : !d ? (
        <div className='space-y-2'>
          <Skeleton className='h-5 w-3/4' />
          <Skeleton className='h-16' />
        </div>
      ) : (
        <div className='space-y-3'>
          <div>
            <p className='text-[13px] text-slate-800 dark:text-slate-100'>
              Would have {verb}{' '}
              <span className='font-semibold tabular-nums'>{d.would_open.length}</span> GitLab{' '}
              {d.would_open.length === 1 ? 'issue' : 'issues'} in the last {days} days
            </p>
            <p className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
              Replayed over <span className='tabular-nums'>{d.considered}</span> {thing}
              {d.considered === 1 ? '' : 's'}.{' '}
              {d.truncated && 'The replay stopped early — the real number may be higher. '}
              Joining an existing GitLab issue is not replayed, so the real number can be lower.
            </p>
          </div>

          {d.would_open.length > 0 && (
            <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'>
              {d.would_open.slice(0, SHOWN).map((o) => (
                <li
                  key={`${o.issue}:${o.at}`}
                  className='flex items-baseline gap-2 px-2.5 py-1.5 text-[12px]'
                >
                  <Link
                    to={ticket ? `/support?ticket=${o.issue}` : `/issues/${o.issue}`}
                    className='shrink-0 font-mono text-[11px] text-nvr-navy hover:underline dark:text-nvr-cyan'
                  >
                    #{o.issue}
                  </Link>
                  <span className='min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200'>
                    {o.title || 'Untitled'}
                  </span>
                  <span className='shrink-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {formatRelative(o.at)}
                  </span>
                </li>
              ))}
              {d.would_open.length > SHOWN && (
                <li className='px-2.5 py-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  and {d.would_open.length - SHOWN} more
                </li>
              )}
            </ul>
          )}

          {d.held.length > 0 && <HeldSummary held={d.held} />}
        </div>
      )}
    </section>
  )
}

function HeldSummary({ held }: { held: Array<{ issue: number; reason: string }> }) {
  const groups = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of held) m.set(h.reason, (m.get(h.reason) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [held])
  return (
    <div className='space-y-1'>
      <p className='text-[11.5px] font-medium text-slate-700 dark:text-slate-200'>
        Held back <span className='tabular-nums'>{held.length}</span>
      </p>
      <ul className='space-y-0.5 text-[11.5px] text-slate-600 dark:text-slate-300'>
        {groups.map(([reason, n]) => (
          <li key={reason} className='flex gap-2'>
            <span className='w-8 shrink-0 text-right tabular-nums text-slate-500 dark:text-muted-foreground'>
              {n}
            </span>
            <span className='min-w-0'>{reason}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
