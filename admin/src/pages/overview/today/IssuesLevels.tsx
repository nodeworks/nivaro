import { ErrorNotice, WhenText } from '@nivaro/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatNumber } from '@/lib/utils'
import { SeverityDot, StatusBadge } from '../../issues/badges'
import { useIssueGitlab } from '../../issues/gitlab'
import { IssueDetailPanel } from '../../issues/IssueDetailPanel'
import { useIssueLabels } from '../../issues/issue-display'
import type { CmsUser, Issue } from '../../issues/types'
import { AppTag, GitlabCell } from '../Issues'
import { type IssueRowInput, type IssueRowView, issueRowView } from '../issues-model'
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

type GitlabFilter = 'all' | 'linked' | 'unlinked' | 'suggested'

const GITLAB_FILTERS: Array<{ value: GitlabFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'linked', label: 'In GitLab' },
  { value: 'unlinked', label: 'Not in GitLab' },
  { value: 'suggested', label: 'Suggested' }
]

/** Which GitLab state a row is in, for the filter ("unlinked" covers suggested too). */
export function matchesGitlab(row: IssueRowView, f: GitlabFilter): boolean {
  if (f === 'all' || !row.gitlab) return true
  if (f === 'linked') return row.gitlab.kind === 'linked'
  if (f === 'suggested') return row.gitlab.kind === 'suggested'
  return row.gitlab.kind !== 'linked'
}

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
  const [gl, setGl] = useState<GitlabFilter>('all')
  const q = useOpenIssues(sort)
  const navigate = useNavigate()
  const gitlab = useIssueGitlab()
  const issues = q.data?.rows ?? []
  const labels = useIssueLabels(issues)
  const rows = useMemo(
    () => issues.map((i) => issueRowView(i as unknown as IssueRowInput, gitlab.on, labels)),
    [issues, gitlab.on, labels]
  )
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const counts = useMemo(() => {
    const c = { all: rows.length, linked: 0, unlinked: 0, suggested: 0 }
    for (const r of rows) {
      if (r.gitlab?.kind === 'linked') c.linked++
      else if (r.gitlab) {
        c.unlinked++
        if (r.gitlab.kind === 'suggested') c.suggested++
      }
    }
    return c
  }, [rows])
  const shown = rows.filter((r) => matchesGitlab(r, gl))
  if (q.isLoading)
    return (
      <div className='space-y-2 p-4' aria-busy>
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
          <div key={i} className='h-16 animate-pulse rounded-lg bg-white dark:bg-card' />
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
      {gitlab.on && rows.length > 0 && (
        <div
          role='group'
          aria-label='GitLab'
          className='flex flex-wrap items-center gap-1.5 text-[12px]'
        >
          {GITLAB_FILTERS.filter((f) => f.value !== 'suggested' || counts.suggested > 0).map(
            (f) => (
              <button
                key={f.value}
                type='button'
                aria-pressed={gl === f.value}
                onClick={() => setGl(f.value)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                  gl === f.value
                    ? 'border-nvr-cyan/50 bg-nvr-cyan/10 font-medium text-slate-900 dark:text-slate-50'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-muted dark:border-border dark:bg-card dark:text-slate-300'
                )}
              >
                {f.label}
                <span className='tabular-nums text-slate-500 dark:text-slate-400'>
                  {formatNumber(counts[f.value])}
                </span>
              </button>
            )
          )}
        </div>
      )}
      {shown.length === 0 ? (
        <p className='rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-[12.5px] text-slate-500 dark:border-border dark:bg-card'>
          {rows.length === 0 ? 'No open issues.' : 'No open issues match this GitLab filter.'}
        </p>
      ) : (
        <ul
          className={cn(
            'divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card',
            q.isPlaceholderData && 'opacity-60'
          )}
        >
          {shown.map((r) => (
            <IssueRow
              key={r.id}
              row={r}
              issue={byId.get(r.id)}
              onOpen={() => ctx.go({ ...ctx.drill, issue: r.id })}
            />
          ))}
        </ul>
      )}
      {q.data.total > issues.length && (
        <p className='text-[12px] text-slate-500 dark:text-slate-400'>
          Showing the first {formatNumber(issues.length)} — the issue log has every one.
        </p>
      )}
    </div>
  )
}

/**
 * One open issue: the plain-words title and what it means, then where it came from, how often
 * and to how many people, who owns it and its GitLab state — the GitLab chip opens the GitLab
 * issue itself, the row opens the issue's own panel.
 */
function IssueRow({
  row,
  issue,
  onOpen
}: {
  row: IssueRowView
  issue?: Issue
  onOpen: () => void
}) {
  const assignee = (issue as { assigned_to_name?: string | null } | undefined)?.assigned_to_name
  const firstSeen = issue?.created_at ?? null
  return (
    <li className='group relative flex items-start gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-white/[0.03]'>
      <SeverityDot severity={row.severity} className='mt-1.5' />
      <div className='min-w-0 flex-1'>
        <button
          type='button'
          onClick={onOpen}
          data-today-issue={row.id}
          data-tip={row.fullTitle}
          className='block w-full text-left text-[13px] font-medium leading-snug text-slate-900 after:absolute after:inset-0 focus-visible:outline-none dark:text-slate-50 [&:focus-visible]:after:ring-2 [&:focus-visible]:after:ring-inset [&:focus-visible]:after:ring-nvr-cyan/60'
        >
          <span className='line-clamp-2'>{row.headline}</span>
        </button>
        {row.description && (
          <p className='mt-0.5 line-clamp-2 text-[12px] leading-snug text-slate-600 dark:text-slate-300'>
            {row.description}
          </p>
        )}
        <div className='mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
          <StatusBadge status={row.status} />
          {row.sourceLabel && (
            <span className='rounded bg-slate-100 px-1.5 py-px text-[10.5px] font-medium text-slate-600 dark:bg-white/[0.06] dark:text-slate-300'>
              {row.sourceLabel}
            </span>
          )}
          <AppTag row={row} />
          {row.where && (
            <span className='max-w-[22rem] truncate font-mono text-[11px]' data-tip={row.where}>
              {row.where}
            </span>
          )}
          <span className='tabular-nums'>{row.countText}</span>
          {assignee ? <span>· {assignee}</span> : <span>· Unassigned</span>}
          {/* The chip sits above the row's click area so its GitLab link stays its own. */}
          <span className='relative z-10'>
            <GitlabCell row={row} />
          </span>
        </div>
      </div>
      <div className='shrink-0 text-right text-[11.5px] text-slate-500 dark:text-slate-400'>
        <div data-tip={`Last seen ${formatDateTime(row.lastSeen)}`}>
          <WhenText at={row.lastSeen} />
        </div>
        {firstSeen && firstSeen !== row.lastSeen && (
          <div
            className='mt-0.5 text-[10.5px] text-slate-400 dark:text-slate-500'
            data-tip={`First seen ${formatDateTime(firstSeen)}`}
          >
            since <WhenText at={firstSeen} />
          </div>
        )}
      </div>
      <ChevronRight
        className='mt-1 h-4 w-4 shrink-0 text-slate-300 group-hover:text-slate-500'
        aria-hidden
      />
    </li>
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
