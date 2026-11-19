import { ErrorNotice, WhenText } from '@nivaro/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'
import { SeverityDot, SourceTag, StatusBadge } from '../../issues/badges'
import { IssueDetailPanel } from '../../issues/IssueDetailPanel'
import { issueDisplay, useIssueLabels } from '../../issues/issue-display'
import type { CmsUser, Issue } from '../../issues/types'
import type { TodayCtx } from './TodaySheet'

/**
 * "Open issues" → the issues the figure counts (open + in progress — GET /issues?status=active,
 * which answers a non-administrator with their own), sortable, then one issue in the issue log's
 * own detail panel (assign, status, notes, GitLab — everything the Issues page allows).
 */

const SORTS = [
  { value: 'severity', label: 'Most severe' },
  { value: 'last_seen', label: 'Seen most recently' },
  { value: 'newest', label: 'Newest' },
  { value: 'count', label: 'Seen most often' }
]

function useOpenIssues(sort: string) {
  return useQuery({
    queryKey: ['issues', 'overview-today', sort],
    queryFn: () =>
      api
        .get<{ data: Issue[]; meta?: { total?: number }; total?: number }>('/issues', {
          params: { status: 'active', sort, limit: 200 }
        })
        .then((r) => ({
          rows: r.data.data,
          total: r.data.meta?.total ?? r.data.total ?? r.data.data.length
        })),
    placeholderData: keepPreviousData,
    staleTime: 30_000
  })
}

export function IssuesRoot({ ctx }: { ctx: TodayCtx }) {
  const [sort, setSort] = useState('severity')
  const q = useOpenIssues(sort)
  const navigate = useNavigate()
  const rows = q.data?.rows ?? []
  const labels = useIssueLabels(rows)
  if (q.isLoading)
    return (
      <div className='space-y-2 p-4' aria-busy>
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
          <div key={i} className='h-14 animate-pulse rounded-lg bg-white dark:bg-card' />
        ))}
      </div>
    )
  if (q.error || !q.data)
    return (
      <div className='p-4'>
        <ErrorNotice error={q.error} what='open issues' onRetry={() => void q.refetch()} />
      </div>
    )
  return (
    <div className='flex flex-col gap-3 p-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <p className='mr-auto text-[13px] text-slate-600 dark:text-slate-300'>
          <span className='font-semibold tabular-nums text-slate-900 dark:text-slate-50'>
            {formatNumber(q.data.total)}
          </span>{' '}
          open {q.data.total === 1 ? 'issue' : 'issues'}
          {!ctx.isAdmin && ' you raised or own'}
        </p>
        <SimpleSelect
          value={sort}
          onChange={setSort}
          options={SORTS}
          ariaLabel='Sort issues'
          className='h-8 w-44 bg-white text-[12.5px] dark:bg-card'
        />
        <button
          type='button'
          onClick={() => navigate('/issues?status=active')}
          className='inline-flex items-center gap-1 text-[12px] font-medium text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
        >
          Issue log <ExternalLink className='h-3 w-3' aria-hidden />
        </button>
      </div>
      {rows.length === 0 ? (
        <p className='rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-[12.5px] text-slate-500 dark:border-border dark:bg-card'>
          No open issues.
        </p>
      ) : (
        <ul
          className={cn(
            'divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card',
            q.isPlaceholderData && 'opacity-60'
          )}
        >
          {rows.map((i) => {
            const d = issueDisplay(i, { labels })
            return (
              <li key={i.id}>
                <button
                  type='button'
                  onClick={() => ctx.go({ ...ctx.drill, issue: i.id })}
                  className='group flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-white/[0.03]'
                  data-today-issue={i.id}
                >
                  <SeverityDot severity={i.severity} className='mt-1.5' />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-slate-50'>
                      {d.title}
                    </span>
                    <span className='flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
                      <StatusBadge status={i.status} />
                      <SourceTag source={i.source ?? null} />
                      {d.where && <span className='truncate'>{d.where}</span>}
                      {(i.occurrence_count ?? 0) > 1 && (
                        <span className='tabular-nums'>
                          {formatNumber(i.occurrence_count ?? 0)}×
                        </span>
                      )}
                      {i.assigned_to_name && <span>· {i.assigned_to_name}</span>}
                    </span>
                  </span>
                  <span className='shrink-0 text-[11.5px] text-slate-500 dark:text-slate-400'>
                    <WhenText at={i.last_seen_at ?? i.created_at} />
                  </span>
                  <ChevronRight
                    className='mt-1 h-4 w-4 shrink-0 text-slate-300 group-hover:text-slate-500'
                    aria-hidden
                  />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {q.data.total > rows.length && (
        <p className='text-[12px] text-slate-500 dark:text-slate-400'>
          Showing the first {formatNumber(rows.length)} — the issue log has every one.
        </p>
      )}
    </div>
  )
}

export function IssueLevel({ ctx }: { ctx: TodayCtx }) {
  const id = ctx.drill.issue as number
  const listed = useOpenIssues('severity')
  const fromList = listed.data?.rows.find((i) => i.id === id)
  const single = useQuery({
    queryKey: ['issues', 'linked', id],
    queryFn: () => api.get<{ data: Issue }>(`/issues/${id}`).then((r) => r.data.data),
    enabled: !listed.isLoading && !fromList,
    retry: false,
    staleTime: 60_000
  })
  const { data: users = [] } = useQuery<CmsUser[]>({
    queryKey: ['users-list-for-issues'],
    queryFn: () => api.get<{ data: CmsUser[] }>('/users').then((r) => r.data.data),
    staleTime: 60_000,
    enabled: ctx.isAdmin
  })
  const issue = fromList ?? single.data
  const forLabels = useMemo(() => (issue ? [issue] : []), [issue])
  const labels = useIssueLabels(forLabels)
  if (!issue)
    return single.error ? (
      <div className='p-4'>
        <ErrorNotice error={single.error} what='this issue' onRetry={() => void single.refetch()} />
      </div>
    ) : (
      <div className='m-4 h-64 animate-pulse rounded-lg bg-white dark:bg-card' aria-busy />
    )
  return (
    <div className='flex min-h-[70vh] flex-1 flex-col'>
      <IssueDetailPanel
        key={issue.id}
        issue={issue}
        labels={labels}
        users={users}
        onClose={() => ctx.go({ ...ctx.drill, issue: undefined })}
      />
    </div>
  )
}
