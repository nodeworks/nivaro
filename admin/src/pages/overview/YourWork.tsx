import { LoadErrorNote, loadErrorText } from '@nivaro/shared'
import { Link } from 'react-router'
import { cn, formatDate } from '@/lib/utils'
import { type MyWorkData, type MyWorkTask, useMyWork } from './api'
import { Bone, EmptyNote, Section, SectionLink } from './parts'
import { fmt } from './text'

/**
 * Your work — what is waiting on this person (the My Work counts, from the same read as the
 * My Work page) and the tasks due soonest, each a way into /my-work.
 */

const DAY_MS = 86_400_000

function dueOf(task: MyWorkTask, today: number): { text: string; late: boolean } | null {
  if (!task.due_date) return null
  const d = new Date(`${String(task.due_date).slice(0, 10)}T00:00:00`).getTime()
  if (!Number.isFinite(d)) return null
  const days = Math.round((d - today) / DAY_MS)
  if (days < 0) return { text: days === -1 ? 'Due yesterday' : `${-days} days late`, late: true }
  if (days === 0) return { text: 'Due today', late: false }
  if (days === 1) return { text: 'Due tomorrow', late: false }
  return { text: `Due ${formatDate(String(task.due_date).slice(0, 10))}`, late: false }
}

function rowsOf(d: MyWorkData) {
  const c = d.counts
  return [
    {
      label: 'Records waiting on you',
      n: c.owned,
      note: c.owned_breached ? `${fmt(c.owned_breached)} past their deadline` : null
    },
    { label: 'Your open tasks', n: c.tasks, note: null },
    { label: 'Approvals', n: c.approvals, note: null },
    { label: 'Questions from assistants', n: c.questions, note: null },
    { label: 'Team tasks to pick up', n: c.team_tasks, note: null }
  ].filter((r) => r.n > 0)
}

export function YourWorkSection() {
  const { data, isLoading, error, refetch } = useMyWork()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const rows = data ? rowsOf(data) : []
  const tasks = (data?.tasks ?? [])
    .filter((t) => t.due_date)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
    .slice(0, 4)
  return (
    <Section
      id='your-work'
      title='Your work'
      action={<SectionLink to='/my-work'>Open My Work</SectionLink>}
    >
      {isLoading ? (
        <div className='space-y-3 p-4' aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className='flex items-center justify-between'>
              <Bone className='h-3.5 w-40' />
              <Bone className='h-3.5 w-6' />
            </div>
          ))}
          <Bone className='mt-2 h-10 w-full' />
        </div>
      ) : error && !data ? (
        <div className='p-4'>
          <LoadErrorNote
            message={loadErrorText(error, 'your work')}
            onRetry={() => void refetch()}
          />
        </div>
      ) : rows.length === 0 && tasks.length === 0 ? (
        <EmptyNote action={{ label: 'See your tasks', to: '/tasks' }}>
          Nothing is waiting on you. New approvals, tasks and questions land here first.
        </EmptyNote>
      ) : (
        <>
          <ul className='divide-y divide-slate-100 dark:divide-border/60'>
            {rows.map((r) => (
              <li key={r.label}>
                <Link
                  to='/my-work'
                  className='flex items-center justify-between gap-3 px-4 py-2 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:hover:bg-white/[0.04] dark:focus-visible:bg-white/[0.04]'
                >
                  <span className='min-w-0'>
                    <span className='block text-[12.5px] text-slate-700 dark:text-slate-200'>
                      {r.label}
                    </span>
                    {r.note && (
                      <span className='block text-[11px] text-amber-700 dark:text-amber-300'>
                        {r.note}
                      </span>
                    )}
                  </span>
                  <span className='text-[13px] font-semibold tabular-nums text-slate-900 dark:text-slate-50'>
                    {fmt(r.n)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {tasks.length > 0 && (
            <div className='border-t border-slate-100 px-4 pb-3 pt-2.5 dark:border-border/60'>
              <p className='mb-1.5 text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
                Due soonest
              </p>
              <ul className='space-y-1.5'>
                {tasks.map((t) => {
                  const due = dueOf(t, today)
                  return (
                    <li key={t.id} className='flex items-baseline justify-between gap-3'>
                      <Link
                        to={
                          t.collection && t.item
                            ? `/collections/${t.collection}/${t.item}`
                            : '/my-work'
                        }
                        className='min-w-0 truncate rounded text-[12.5px] text-slate-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-100'
                      >
                        {t.title || t.item_label || 'Untitled task'}
                      </Link>
                      {due && (
                        <span
                          className={cn(
                            'shrink-0 text-[11px] tabular-nums',
                            due.late
                              ? 'font-medium text-red-700 dark:text-red-300'
                              : 'text-slate-500 dark:text-slate-400'
                          )}
                        >
                          {due.text}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </Section>
  )
}
