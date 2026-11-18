import { ErrorNotice } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatRelative } from '@/lib/utils'
import { type Explanation, fetchExplain, trackerKeys } from './api'
import { explainName, outcomeLabel, parseIssueRef } from './rule-sentence'
import { SettingsCard } from './SyncCards'

const TONE: Record<string, string> = {
  fired: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  would_fire: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  joined: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  suggested: 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan',
  would_suggest: 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan',
  quiet: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  cap: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  error: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
}
const NEUTRAL = 'bg-slate-100 text-slate-700 dark:bg-muted dark:text-slate-300'

const notFound = (err: unknown) =>
  (err as { response?: { status?: number } })?.response?.status === 404

function Rows({ rows }: { rows: Explanation[] }) {
  return (
    <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'>
      {rows.map((r, i) => (
        <li
          // rows repeat rule ids; their position is their identity
          // biome-ignore lint/suspicious/noArrayIndexKey: stable list from one answer
          key={i}
          className='grid grid-cols-[minmax(0,10rem)_auto_minmax(0,1fr)_auto] items-baseline gap-x-3 px-2.5 py-1.5 text-[12px] max-sm:grid-cols-[minmax(0,1fr)_auto]'
        >
          <span className='truncate font-medium text-slate-800 dark:text-slate-100'>
            {explainName(r)}
          </span>
          <span
            className={cn(
              'justify-self-start rounded px-1.5 py-px text-[11px] font-medium',
              TONE[r.outcome] ?? NEUTRAL
            )}
          >
            {outcomeLabel(r.outcome)}
          </span>
          <span className='min-w-0 text-slate-600 dark:text-slate-300 max-sm:col-span-2'>
            {r.detail}
          </span>
          {!r.live && (
            <span className='text-[11px] text-slate-500 dark:text-muted-foreground max-sm:col-span-2'>
              {formatRelative(r.at)}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * "Why didn't it fire?" — for one issue-log entry: what every enabled rule
 * would do with it now (a dry run, nothing sent) and the decisions stored for
 * it, flow-made ones included.
 */
export function WhyNotFired() {
  const [text, setText] = useState('')
  const [asked, setAsked] = useState<number | null>(null)
  const [bad, setBad] = useState(false)
  const explain = useQuery({
    queryKey: trackerKeys.explain(asked ?? 0),
    queryFn: () => fetchExplain(asked as number),
    enabled: asked != null,
    retry: false
  })
  const rows = explain.data ?? []
  const live = rows.filter((r) => r.live)
  const past = rows.filter((r) => !r.live)

  return (
    <SettingsCard
      title="Why didn't a rule fire?"
      hint='Pick an issue from the issue log to see what each rule makes of it now, and what was decided before.'
    >
      <form
        className='flex flex-wrap items-end gap-2'
        onSubmit={(e) => {
          e.preventDefault()
          const n = parseIssueRef(text)
          setBad(n == null)
          if (n != null) setAsked(n)
        }}
      >
        <div className='space-y-1'>
          <Label htmlFor='tracker-explain-issue' className='text-[11.5px] font-medium'>
            Issue number
          </Label>
          <Input
            id='tracker-explain-issue'
            value={text}
            inputMode='numeric'
            placeholder='#1234'
            aria-invalid={bad || undefined}
            aria-describedby={bad ? 'tracker-explain-bad' : undefined}
            onChange={(e) => {
              setText(e.target.value)
              setBad(false)
            }}
            className='h-8 w-32 text-[12px] tabular-nums'
          />
        </div>
        <Button type='submit' variant='outline' size='sm' className='h-8 gap-1.5 text-[12px]'>
          <Search className='h-3.5 w-3.5' />
          Explain
        </Button>
        {bad && (
          <p
            id='tracker-explain-bad'
            className='w-full text-[11.5px] text-red-600 dark:text-red-400'
          >
            Type an issue number, like 1234.
          </p>
        )}
      </form>

      {asked != null &&
        (explain.isLoading ? (
          <Skeleton className='h-20' />
        ) : explain.isError ? (
          notFound(explain.error) ? (
            <p className='text-[12px] text-slate-600 dark:text-slate-300'>
              There is no issue #{asked} in the issue log.
            </p>
          ) : (
            <ErrorNotice
              error={explain.error}
              what='the explanation'
              onRetry={() => void explain.refetch()}
            />
          )
        ) : (
          <div className='space-y-3'>
            <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Issue{' '}
              <Link
                to={`/issues/${asked}`}
                className='font-mono text-nvr-navy hover:underline dark:text-nvr-cyan'
              >
                #{asked}
              </Link>
            </p>
            <div className='space-y-1.5'>
              <h4 className='text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
                If it came in now
              </h4>
              {live.length ? (
                <Rows rows={live} />
              ) : (
                <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No rule is switched on for the issue log.
                </p>
              )}
            </div>
            <div className='space-y-1.5'>
              <h4 className='text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
                What happened
              </h4>
              {past.length ? (
                <Rows rows={past} />
              ) : (
                <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No rule or flow has decided anything about it yet.
                </p>
              )}
            </div>
          </div>
        ))}
    </SettingsCard>
  )
}
