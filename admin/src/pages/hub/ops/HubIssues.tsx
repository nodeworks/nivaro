import { QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bug, ExternalLink, RefreshCw, Server } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime } from '@/lib/utils'
import { fetchHubApps, hubKeys, hubToast } from '../hub-api'
import { SectionCard } from '../hub-parts'
import {
  collectNow,
  type IssueGroupSummary,
  stateWords,
  useIssueGroup,
  useIssueGroups,
  useIssueReads
} from './ops-api'

const SEV_TONE: Record<string, string> = {
  critical:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300',
  high: 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300',
  error:
    'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300'
}
const SEV_DEFAULT =
  'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-slate-300'

function SeverityChip({ severity }: { severity: string | null }) {
  return (
    <span
      className={cn(
        'whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium',
        (severity && SEV_TONE[severity]) || SEV_DEFAULT
      )}
    >
      {severity ?? 'unknown'}
    </span>
  )
}

const KIND_OPTIONS = [
  { value: '', label: 'Crashes and server errors' },
  { value: 'crash', label: 'Crashes (front end)' },
  { value: 'server', label: 'Server errors' }
]
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open somewhere' },
  { value: 'resolved', label: 'Resolved everywhere' },
  { value: '', label: 'Any status' }
]
const SEVERITY_OPTIONS = [
  { value: '', label: 'Any severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' }
]

/**
 * Issues (Apps hub tab): issue and crash groups read from every app over its link, folded by
 * signature — "the same bug in 3 apps". Scrubbed titles and counts only; each row links into
 * that app's own issue log. Admins see every app, owners their own.
 */
export default function HubIssues() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params, setParams] = useSearchParams()
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps })
  const filters = {
    app_id: params.get('app') ?? '',
    kind: params.get('kind') ?? '',
    severity: params.get('severity') ?? '',
    status: params.get('status') ?? 'open',
    multi: params.get('multi') === '1',
    q: params.get('q') ?? ''
  }
  const [q, setQ] = useState(filters.q)
  const groups = useIssueGroups(filters)
  const reads = useIssueReads()
  const selected = params.get('sig')
  const qc = useQueryClient()
  const collect = useMutation({
    mutationFn: collectNow,
    onSuccess: () => {
      toast.success('Reading every app now', {
        description: 'The list fills in over the next minute.'
      })
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['hub-ops'] }), 15_000)
    },
    onError: (e) => hubToast(e, 'The apps could not be read')
  })

  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        for (const [k, v] of Object.entries(patch)) {
          if (v == null || v === '') out.delete(k)
          else out.set(k, v)
        }
        return out
      },
      { replace: true }
    )

  const notRead = (reads.data ?? []).filter((r) => r.state !== 'ok')

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <div
        className={cn(
          'min-w-0 flex-1 space-y-4 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background',
          selected && 'hidden lg:block'
        )}
      >
        <div className='flex flex-wrap items-center gap-2'>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') set({ q })
            }}
            onBlur={() => set({ q })}
            placeholder='Search titles or apps'
            aria-label='Search titles or apps'
            className='h-8 w-full sm:w-56'
          />
          <SimpleSelect
            value={filters.app_id}
            onChange={(v) => set({ app: v })}
            ariaLabel='App'
            className='h-8 w-full sm:w-44'
            options={[
              { value: '', label: 'Every app' },
              ...(apps.data ?? []).map((a) => ({ value: String(a.id), label: a.name }))
            ]}
          />
          <SimpleSelect
            value={filters.kind}
            onChange={(v) => set({ kind: v })}
            ariaLabel='Kind'
            className='h-8 w-full sm:w-52'
            options={KIND_OPTIONS}
          />
          <SimpleSelect
            value={filters.severity}
            onChange={(v) => set({ severity: v })}
            ariaLabel='Severity'
            className='h-8 w-full sm:w-36'
            options={SEVERITY_OPTIONS}
          />
          <SimpleSelect
            value={params.has('status') ? filters.status : 'open'}
            onChange={(v) => set({ status: v === 'open' ? null : v || 'any' })}
            ariaLabel='Status'
            className='h-8 w-full sm:w-44'
            options={STATUS_OPTIONS.map((o) => (o.value === '' ? { ...o, value: 'any' } : o))}
          />
          <label className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
            <input
              type='checkbox'
              checked={filters.multi}
              onChange={(e) => set({ multi: e.target.checked ? '1' : null })}
              className='h-3.5 w-3.5 accent-[#00ceff]'
            />
            In 2 or more apps
          </label>
          {isAdmin && (
            <Button
              size='sm'
              variant='outline'
              className='ml-auto h-8'
              disabled={collect.isPending}
              onClick={() => collect.mutate()}
            >
              <RefreshCw
                className={cn('mr-1.5 h-3.5 w-3.5', collect.isPending && 'animate-spin')}
                aria-hidden
              />
              Read the apps now
            </Button>
          )}
        </div>

        {notRead.length > 0 && (
          <p className='m-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200'>
            Not read:{' '}
            {notRead
              .slice(0, 6)
              .map((r) => `${r.app_key}/${r.environment_key} (${stateWords(r.state)})`)
              .join('; ')}
            {notRead.length > 6 ? ` and ${notRead.length - 6} more` : ''}. Their last reading is
            kept.
          </p>
        )}

        <SectionCard
          title='Issues across apps'
          description='Read every 15 minutes from each app’s issue log (last 30 days). The same signature in several apps is one line.'
        >
          {groups.isPending ? (
            <div className='space-y-2 p-4'>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className='h-10 w-full' />
              ))}
            </div>
          ) : groups.isError ? (
            <QueryErrorState
              error={groups.error}
              what='the issues'
              onRetry={() => void groups.refetch()}
              className='m-4'
            />
          ) : groups.data.groups.length === 0 ? (
            <p className='m-0 p-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
              Nothing matches. Apps report issues once they run 0.3.215 or later and have a hub
              link.
            </p>
          ) : (
            <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
              {groups.data.groups.map((g) => (
                <IssueLine
                  key={g.sig}
                  g={g}
                  active={g.sig === selected}
                  onOpen={() => set({ sig: g.sig })}
                />
              ))}
            </ul>
          )}
          {groups.data?.truncated && (
            <p className='m-0 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
              Showing the first 300. Narrow the filters to see the rest.
            </p>
          )}
        </SectionCard>
      </div>
      {selected && <IssueDetail sig={selected} onClose={() => set({ sig: null })} />}
    </div>
  )
}

function IssueLine({
  g,
  active,
  onOpen
}: {
  g: IssueGroupSummary
  active: boolean
  onOpen: () => void
}) {
  const Icon = g.kind === 'crash' ? Bug : Server
  return (
    <li>
      <button
        type='button'
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
          active ? 'bg-accent' : 'hover:bg-muted'
        )}
      >
        <Icon
          className='mt-0.5 h-4 w-4 shrink-0 text-slate-400 dark:text-muted-foreground'
          aria-label={g.kind === 'crash' ? 'Crash' : 'Server error'}
        />
        <span className='min-w-0 flex-1'>
          <span className='block break-words text-[13px] font-medium text-slate-900 dark:text-foreground'>
            {g.title}
          </span>
          <span className='mt-0.5 block text-[11px] text-slate-500 dark:text-muted-foreground'>
            {g.app_keys.join(', ')} · {g.occurrences} hits · {g.people} people
            {g.last_seen ? ` · last ${formatDateTime(g.last_seen)}` : ''}
          </span>
        </span>
        <span className='flex shrink-0 flex-col items-end gap-1'>
          <SeverityChip severity={g.severity} />
          {g.apps > 1 && (
            <span className='whitespace-nowrap rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[11px] font-medium text-cyan-800 dark:border-cyan-900/60 dark:bg-cyan-950/40 dark:text-cyan-300'>
              {g.apps} apps
            </span>
          )}
          {!g.open && (
            <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>Resolved</span>
          )}
        </span>
      </button>
    </li>
  )
}

function IssueDetail({ sig, onClose }: { sig: string; onClose: () => void }) {
  const q = useIssueGroup(sig)
  return (
    <aside className='flex w-full shrink-0 flex-col overflow-y-auto border-slate-200 bg-white lg:w-[420px] lg:border-l dark:border-border dark:bg-card'>
      <div className='flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-border'>
        <h3 className='m-0 flex-1 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Where it happens
        </h3>
        <Button size='sm' variant='ghost' className='h-7' onClick={onClose}>
          Close
        </Button>
      </div>
      {q.isPending ? (
        <Skeleton className='m-4 h-24' />
      ) : q.isError ? (
        <QueryErrorState
          error={q.error}
          what='this issue'
          onRetry={() => void q.refetch()}
          className='m-4'
        />
      ) : (
        <ul className='m-0 list-none space-y-3 p-4'>
          {q.data.map((r) => (
            <li
              key={r.environment_id}
              className='rounded-lg border border-slate-200 p-3 dark:border-border'
            >
              <div className='flex items-center gap-2'>
                <span className='min-w-0 flex-1 truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
                  {r.app_name} · {r.environment_key}
                </span>
                <SeverityChip severity={r.severity} />
              </div>
              <p className='m-0 mt-1 break-words text-[12px] text-slate-700 dark:text-slate-300'>
                {r.title}
              </p>
              <dl className='m-0 mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
                <dt>Status</dt>
                <dd className='m-0'>{r.status ?? 'open'}</dd>
                <dt>Hits / people</dt>
                <dd className='m-0'>
                  {r.occurrences} / {r.people}
                </dd>
                <dt>Release</dt>
                <dd className='m-0 font-mono'>{r.release ?? '—'}</dd>
                {r.screen && (
                  <>
                    <dt>Screen</dt>
                    <dd className='m-0 break-all font-mono'>{r.screen}</dd>
                  </>
                )}
                <dt>First / last seen</dt>
                <dd className='m-0'>
                  {r.first_seen ? formatDateTime(r.first_seen) : '—'} /{' '}
                  {r.last_seen ? formatDateTime(r.last_seen) : '—'}
                </dd>
              </dl>
              {r.link && (
                <a
                  href={r.link}
                  target='_blank'
                  rel='noreferrer noopener'
                  className='mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-cyan-700 hover:underline dark:text-cyan-300'
                >
                  Open in {r.app_key} <ExternalLink className='h-3 w-3' aria-hidden />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
