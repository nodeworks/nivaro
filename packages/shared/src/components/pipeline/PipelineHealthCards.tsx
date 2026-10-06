import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'

// ─── Template reachability lint (#1241) ──────────────────────────────────────

interface LintFinding {
  code: string
  severity: 'warn' | 'info'
  message: string
  state_id?: string
  transition_id?: string
}

interface LintResult {
  template_name: string
  states: number
  transitions: number
  reachable: number
  warnings: number
  findings: LintFinding[]
}

const LINT_TITLES: Record<string, string> = {
  no_initial: 'No starting state',
  any_state_auto: 'Automatic jump from any state',
  never_entered: 'Nothing enters',
  unreachable: 'Unreachable',
  dead_end: 'Dead end',
  auto_shadows_manual: 'Automatic transition hides manual ones',
  impossible_conditions: 'Conditions can never pass',
  dead_transition: 'Can never fire',
  terminal_exit: 'Terminal state with an exit'
}

export function TemplateLintCard({ templateId }: { templateId: string }) {
  const client = useNivaroClient()
  const [showInfo, setShowInfo] = useState(false)
  const { data, isLoading, isFetching, refetch, isError } = useQuery({
    queryKey: ['pipeline-lint', templateId],
    queryFn: () =>
      client
        .request<{ data: LintResult }>(get(`/pipelines/${templateId}/lint`))
        .then((r) => r.data),
    staleTime: 30_000
  })
  const warns = (data?.findings ?? []).filter((f) => f.severity === 'warn')
  const infos = (data?.findings ?? []).filter((f) => f.severity === 'info')

  return (
    <div
      className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
      data-pipeline-lint
    >
      <div className='flex items-start justify-between gap-4'>
        <div>
          <h3 className='text-[14px] font-semibold text-slate-800 dark:text-foreground'>
            Reachability
          </h3>
          <p className='mt-0.5 max-w-[68ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
            Can a record get everywhere this template promises? States nothing leads to, transitions
            whose conditions contradict each other, steps with no way out, and automatic moves that
            fire before anyone can press a button.
          </p>
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-8 shrink-0 text-[12.5px]'
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          {isFetching ? 'Checking…' : 'Re-check'}
        </Button>
      </div>

      {isLoading ? (
        <div className='mt-4 space-y-2'>
          <Skeleton className='h-4 w-2/3' />
          <Skeleton className='h-4 w-1/2' />
        </div>
      ) : isError || !data ? (
        <p className='mt-4 text-[12.5px] text-rose-600 dark:text-rose-400'>
          Could not check this template.
        </p>
      ) : (
        <div className='mt-4 space-y-3'>
          {warns.length === 0 ? (
            <p
              className='flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-600 dark:text-emerald-400'
              data-pipeline-lint-clean
            >
              <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
              Every state is reachable, every transition can fire, and every unfinished state has a
              way out.
            </p>
          ) : (
            <p className='flex items-center gap-1.5 text-[12.5px] text-slate-700 dark:text-foreground'>
              <span className='h-1.5 w-1.5 rounded-full bg-amber-500' />
              <span>
                <span className='font-semibold tabular-nums'>{warns.length}</span> problem
                {warns.length === 1 ? '' : 's'} — {data.reachable} of {data.states} states reachable
              </span>
            </p>
          )}
          {warns.length > 0 && (
            <ul className='divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200 dark:divide-border/60 dark:border-border'>
              {warns.map((f) => (
                <li
                  key={`${f.code}:${f.message}`}
                  className='flex gap-2.5 px-3 py-2'
                  data-pipeline-lint-finding={f.code}
                >
                  <span className='mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500' />
                  <div className='min-w-0'>
                    <p className='text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400'>
                      {LINT_TITLES[f.code] ?? f.code}
                    </p>
                    <p className='text-[12.5px] text-slate-700 dark:text-foreground'>{f.message}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {infos.length > 0 && (
            <div>
              <button
                type='button'
                onClick={() => setShowInfo((v) => !v)}
                className='text-[11.5px] text-slate-500 underline-offset-2 hover:underline dark:text-muted-foreground'
              >
                {showInfo ? 'Hide' : 'Show'} {infos.length} note{infos.length === 1 ? '' : 's'}
              </button>
              {showInfo && (
                <ul className='mt-1.5 space-y-1'>
                  {infos.map((f) => (
                    <li
                      key={`${f.code}:${f.message}`}
                      className='flex gap-2 text-[12px] text-slate-600 dark:text-muted-foreground'
                      data-pipeline-lint-finding={f.code}
                    >
                      <span className='mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400' />
                      {f.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Skip-criteria firing report (#716) ──────────────────────────────────────

type Verdict = 'never' | 'always' | 'sometimes' | 'too_few'

interface SkipReportState {
  id: string
  label: string
  color: string | null
  configured: boolean
  mode: 'all' | 'any'
  skip_if_no_owners: boolean
  is_initial: boolean
  is_terminal: boolean
  history: { entered: number; skipped: number; skip_rate: number | null }
  now: {
    evaluated: number
    would_skip: number
    no_owners: { matched: number; evaluated: number; verdict: Verdict } | null
    criteria: Array<{
      index: number
      type: string
      description: string
      matched: number
      evaluated: number
      verdict: Verdict
    }>
  }
}

interface SkipReport {
  days: number
  ms: number
  sample: { open_instances: number; requested: number; judged: number; truncated: boolean }
  states: SkipReportState[]
}

const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  never: {
    label: 'Never fires',
    cls: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
  },
  always: {
    label: 'Always fires',
    cls: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
  },
  sometimes: {
    label: 'Fires sometimes',
    cls: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'
  },
  too_few: {
    label: 'Too few records',
    cls: 'border-slate-200 bg-white text-slate-400 dark:border-border dark:bg-transparent'
  }
}

function VerdictChip({ v }: { v: Verdict }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10.5px] font-medium',
        VERDICT[v].cls
      )}
      data-skip-verdict={v}
    >
      {VERDICT[v].label}
    </span>
  )
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0)

export function SkipReportCard({ templateId }: { templateId: string }) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const { data, isFetching, refetch, isError } = useQuery({
    queryKey: ['pipeline-skip-report', templateId],
    queryFn: () =>
      client
        .request<{ data: SkipReport }>(get(`/pipelines/${templateId}/skip-report`))
        .then((r) => r.data),
    enabled: open,
    staleTime: 5 * 60_000
  })
  const rows = (data?.states ?? []).filter(
    (s) => !s.is_initial && (showAll || s.configured || s.history.skipped > 0)
  )
  const flagged = (data?.states ?? []).filter(
    (s) =>
      s.now.criteria.some((c) => c.verdict === 'never' || c.verdict === 'always') ||
      (s.now.no_owners &&
        s.now.no_owners.verdict !== 'sometimes' &&
        s.now.no_owners.verdict !== 'too_few')
  ).length

  return (
    <div
      className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
      data-skip-report
    >
      <div className='flex items-start justify-between gap-4'>
        <div>
          <h3 className='text-[14px] font-semibold text-slate-800 dark:text-foreground'>
            Skip criteria in practice
          </h3>
          <p className='mt-0.5 max-w-[68ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
            How often records entered each step versus jumped straight over it in the last 90 days,
            and which skip rule would fire for the newest open records right now. A threshold that
            never or always fires is usually set wrong.
          </p>
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-8 shrink-0 text-[12.5px]'
          disabled={isFetching}
          onClick={() => {
            if (!open) setOpen(true)
            else void refetch()
          }}
          data-skip-report-run
        >
          {isFetching ? 'Analyzing…' : open ? 'Re-analyze' : 'Analyze'}
        </Button>
      </div>

      {open && isFetching && !data && (
        <div className='mt-4 space-y-2'>
          <Skeleton className='h-4 w-3/4' />
          <Skeleton className='h-4 w-2/3' />
          <Skeleton className='h-4 w-1/2' />
        </div>
      )}
      {open && isError && (
        <p className='mt-4 text-[12.5px] text-rose-600 dark:text-rose-400'>
          Could not build the report.
        </p>
      )}

      {data && (
        <div className='mt-4 space-y-3'>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {flagged > 0 ? (
              <span className='font-medium text-amber-700 dark:text-amber-400'>
                {flagged} step{flagged === 1 ? ' has a rule' : 's have rules'} that never or always
                fire.{' '}
              </span>
            ) : null}
            Right-now figures judge the {data.sample.judged.toLocaleString()} newest open record
            {data.sample.judged === 1 ? '' : 's'} with a skip-configured step still ahead
            {data.sample.truncated ? ' (stopped at the time limit — the rest were not judged)' : ''}{' '}
            of {data.sample.open_instances.toLocaleString()} open.
          </p>
          {rows.length === 0 ? (
            <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              No step here has skip rules, and nothing was jumped over in the last {data.days} days.
            </p>
          ) : (
            <div className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              <table className='w-full text-[12px]'>
                <thead className='bg-slate-50 text-[10.5px] uppercase tracking-wide text-slate-500 dark:bg-muted/30 dark:text-muted-foreground'>
                  <tr>
                    <th className='px-3 py-1.5 text-left font-medium'>Step</th>
                    <th className='px-3 py-1.5 text-right font-medium'>Entered</th>
                    <th className='px-3 py-1.5 text-right font-medium'>Skipped</th>
                    <th className='w-[160px] px-3 py-1.5 text-left font-medium'>Skip rate</th>
                    <th className='px-3 py-1.5 text-right font-medium'>Would skip now</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <SkipRow key={s.id} s={s} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button
            type='button'
            onClick={() => setShowAll((v) => !v)}
            className='text-[11.5px] text-slate-500 underline-offset-2 hover:underline dark:text-muted-foreground'
          >
            {showAll ? 'Only steps with skip rules or skips' : 'Show every step'}
          </button>
          <p className='text-[11px] text-slate-400'>
            A skip is read off the history: a move that jumped over a step the record never visited.
            Steps on another branch of the template can show skips without any rule.
          </p>
        </div>
      )}
    </div>
  )
}

function SkipRow({ s }: { s: SkipReportState }) {
  const rate = s.history.skip_rate
  return (
    <>
      <tr className='border-t border-slate-100 dark:border-border/60' data-skip-state={s.label}>
        <td className='px-3 py-1.5'>
          <span className='flex items-center gap-1.5 font-medium text-slate-800 dark:text-foreground'>
            <span
              className='h-2 w-2 shrink-0 rounded-full'
              style={{ backgroundColor: s.color ?? '#94a3b8' }}
            />
            {s.label}
            {!s.configured && (
              <span className='text-[10.5px] font-normal text-slate-400'>no skip rules</span>
            )}
          </span>
        </td>
        <td className='px-3 py-1.5 text-right tabular-nums text-slate-700 dark:text-foreground'>
          {s.history.entered.toLocaleString()}
        </td>
        <td className='px-3 py-1.5 text-right tabular-nums text-slate-700 dark:text-foreground'>
          {s.history.skipped.toLocaleString()}
        </td>
        <td className='px-3 py-1.5'>
          {rate == null ? (
            <span className='text-slate-400'>—</span>
          ) : (
            <span className='flex items-center gap-2'>
              <span className='h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
                <span
                  className='block h-full rounded-full bg-nvr-cyan'
                  style={{ width: `${Math.min(100, rate)}%` }}
                />
              </span>
              <span className='w-10 text-right tabular-nums text-slate-600 dark:text-muted-foreground'>
                {rate}%
              </span>
            </span>
          )}
        </td>
        <td className='px-3 py-1.5 text-right tabular-nums text-slate-700 dark:text-foreground'>
          {s.configured && s.now.evaluated > 0 ? (
            <>
              {s.now.would_skip}
              <span className='text-slate-400'> / {s.now.evaluated}</span>
            </>
          ) : (
            <span className='text-slate-400'>—</span>
          )}
        </td>
      </tr>
      {s.now.no_owners && (
        <tr className='bg-slate-50/60 dark:bg-muted/10'>
          <td colSpan={5} className='px-3 py-1 pl-7'>
            <span className='flex items-center gap-2 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
              <VerdictChip v={s.now.no_owners.verdict} />
              <span>
                Skip when no owner resolves —{' '}
                <span className='tabular-nums'>
                  {s.now.no_owners.matched} of {s.now.no_owners.evaluated} (
                  {pct(s.now.no_owners.matched, s.now.no_owners.evaluated)}%)
                </span>
              </span>
            </span>
          </td>
        </tr>
      )}
      {s.now.criteria.map((c) => (
        <tr
          key={c.index}
          className='bg-slate-50/60 dark:bg-muted/10'
          data-skip-criterion={c.verdict}
        >
          <td colSpan={5} className='px-3 py-1 pl-7'>
            <span className='flex items-center gap-2 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
              <VerdictChip v={c.verdict} />
              <span className='min-w-0'>
                {c.description} —{' '}
                <span className='tabular-nums'>
                  {c.matched} of {c.evaluated} ({pct(c.matched, c.evaluated)}%)
                </span>
                {s.now.criteria.length > 1 && (
                  <span className='text-slate-400'>
                    {' '}
                    · {s.mode === 'any' ? 'any rule skips' : 'all rules must hold'}
                  </span>
                )}
              </span>
            </span>
          </td>
        </tr>
      ))}
    </>
  )
}
