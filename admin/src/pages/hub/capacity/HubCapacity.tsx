import { QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRightLeft, Pencil, RefreshCw } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { HubToolbar } from '@/components/hub-page'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatFileSize } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { ghostButton, SectionCard } from '../hub-parts'
import {
  type Advice,
  type AppCapacity,
  capacityKeys,
  type Figures,
  fetchAdvice,
  fetchCapacity,
  num,
  pct,
  type SharedCapacity,
  sampleError,
  sampleNow,
  topShare
} from './capacity-api'
import { LimitsEditor, limitsText, ShareBar, Sparkline } from './capacity-parts'
import { RebalancePanel } from './RebalancePanel'

/**
 * Capacity (Apps hub tab): what each shared deployment and dedicated stack uses — CPU, memory,
 * database connections in use against the pool, requests, background work, file storage — from
 * the Hub's 15-minute samples, with a 30-day trend; the apps that use most of their deployment;
 * the move advisor's suggestions (each a link to a pre-filled move plan); per-app limits on a
 * shared deployment; and rebalancing between shared deployments.
 */
export default function HubCapacity() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const qc = useQueryClient()
  const overview = useQuery({
    queryKey: capacityKeys.overview(),
    queryFn: fetchCapacity,
    enabled: isAdmin
  })
  const advice = useQuery({
    queryKey: capacityKeys.advice(),
    queryFn: fetchAdvice,
    enabled: isAdmin
  })
  const sample = useMutation({
    mutationFn: sampleNow,
    onSuccess: (r) => {
      toast.success(
        r.failed
          ? `Sampled — ${r.failed} did not answer`
          : `Sampled ${r.shared} shared deployments and ${r.environments} environments`
      )
      void qc.invalidateQueries({ queryKey: capacityKeys.all })
    },
    onError: (err) => hubToast(err, 'Could not take a sample')
  })

  if (!isAdmin)
    return (
      <div className='p-6 text-[13px] text-slate-600 dark:text-muted-foreground'>
        Capacity is for Hub administrators.
      </div>
    )

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description={
          overview.data
            ? `Sampled every 15 minutes, trend over 30 days. As of ${formatDateTime(overview.data.generated_at)}.`
            : 'Sampled every 15 minutes.'
        }
        actions={
          <button
            type='button'
            className={ghostButton}
            disabled={sample.isPending}
            onClick={() => sample.mutate()}
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', sample.isPending && 'animate-spin')}
              aria-hidden
            />
            {sample.isPending ? 'Sampling…' : 'Sample now'}
          </button>
        }
      />
      <div className='flex-1 min-h-0 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-4 p-4 sm:p-6'>
          {overview.isPending ? (
            <Skeleton className='h-48 w-full' />
          ) : overview.isError ? (
            <QueryErrorState
              error={overview.error}
              what='the capacity figures'
              onRetry={() => void overview.refetch()}
            />
          ) : (
            <>
              <AdviceCard
                advice={advice.data ?? []}
                loading={advice.isPending}
                error={advice.error}
                retry={() => void advice.refetch()}
              />
              {overview.data.shared.length === 0 && overview.data.dedicated.length === 0 && (
                <p className='m-0 rounded-lg border border-dashed border-slate-300 p-6 text-center text-[13px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                  No samples yet. The first is taken within 15 minutes, or press Sample now.
                </p>
              )}
              {overview.data.shared.map((s) => (
                <SharedCard key={s.id} s={s} mostShare={overview.data.settings.most_share} />
              ))}
              {overview.data.dedicated.length > 0 && (
                <DedicatedCard apps={overview.data.dedicated} />
              )}
              <RebalancePanel shared={overview.data.shared} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** A figure per minute, or a dash when it was not read. */
const rate = (n: number | null | undefined) => (n == null ? '—' : `${num(n)}/min`)

/** Connections in use of the pool, or a dash when not read. */
const conns = (f: Figures | null | undefined) =>
  f?.db_in_use == null ? '—' : `${f.db_in_use} / ${f.db_pool_max ?? '—'}`

/** Jobs running (and waiting for a slot), or a dash. */
const jobsText = (f: Figures | null | undefined) =>
  f?.jobs_running == null ? '—' : `${f.jobs_running}${f.jobs_waiting ? ` +${f.jobs_waiting}` : ''}`

const jobsTip = (f: Figures | null | undefined) =>
  f?.jobs_running == null
    ? undefined
    : `${f.jobs_running} running${f.jobs_waiting ? `, ${f.jobs_waiting} waiting for a slot` : ''}`

/** A small trend with its name above it. */
function TrendLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className='flex flex-col items-start gap-0.5'>
      <span className='text-[10px] text-slate-500 dark:text-muted-foreground'>{label}</span>
      {children}
    </span>
  )
}

function MetaCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className='min-w-0 bg-white px-3 py-2 dark:bg-card' data-tip={hint}>
      <p className='m-0 truncate text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</p>
      <p className='m-0 truncate text-[14px] font-medium tabular-nums text-slate-900 dark:text-foreground'>
        {value}
      </p>
    </div>
  )
}

function Meta({ f, budget }: { f: Figures | null; budget?: number }) {
  return (
    <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6 dark:border-border dark:bg-border'>
      <MetaCell
        label='CPU'
        value={f?.cpu_pct == null ? '—' : `${num(f.cpu_pct)}%`}
        hint='Percent of one core, summed over its processes'
      />
      <MetaCell label='Memory' value={f?.memory_mb == null ? '—' : `${num(f.memory_mb, 0)} MB`} />
      <MetaCell
        label='Requests'
        value={f?.requests_per_min == null ? '—' : `${num(f.requests_per_min)}/min`}
      />
      <MetaCell
        label='Database connections'
        value={f?.db_in_use == null ? '—' : `${f.db_in_use} of ${budget ?? f.db_pool_max ?? '—'}`}
        hint={budget ? 'In use, of the deployment’s connection budget' : 'In use, of its pool'}
      />
      <MetaCell
        label='Background work'
        value={
          f?.jobs_running == null
            ? '—'
            : `${f.jobs_running} running${f.jobs_waiting ? `, ${f.jobs_waiting} waiting` : ''}`
        }
      />
      <MetaCell
        label='Files'
        value={f?.storage_bytes == null ? '—' : formatFileSize(f.storage_bytes)}
      />
    </div>
  )
}

function SampleNote({ f }: { f: Figures | null }) {
  const text = sampleError(f?.error ?? null)
  if (!text) return null
  return (
    <p className='m-0 flex items-center gap-1.5 text-[12px] text-amber-700 dark:text-amber-300'>
      <AlertTriangle className='h-3.5 w-3.5 shrink-0' aria-hidden /> Last sample: {text}
    </p>
  )
}

function SharedCard({ s, mostShare }: { s: SharedCapacity; mostShare: number }) {
  const [editing, setEditing] = useState<number | null>(null)
  return (
    <SectionCard
      title={`Shared · ${s.key}`}
      description={`${s.name} · ${s.apps.length} ${s.apps.length === 1 ? 'app' : 'apps'}${s.status !== 'active' ? ` · ${s.status}` : ''}`}
      actions={
        <span className='flex items-center gap-4'>
          <TrendLabel label='Requests, 30 days'>
            <Sparkline
              points={s.trend}
              pick={(p) => p.requests_per_min}
              label='Requests per minute'
            />
          </TrendLabel>
          <TrendLabel label='CPU, 30 days'>
            <Sparkline points={s.trend} pick={(p) => p.cpu_pct} label='CPU' />
          </TrendLabel>
        </span>
      }
    >
      <div className='space-y-3 p-4'>
        <Meta f={s.latest} budget={s.pool_budget} />
        <SampleNote f={s.latest} />
        {s.apps.length > 0 && (
          <div className='overflow-x-auto'>
            <table className='w-full min-w-[760px] text-[12px]'>
              <thead className='text-left text-slate-500 dark:text-muted-foreground'>
                <tr>
                  <th className='whitespace-nowrap py-1.5 pr-3 font-medium'>App</th>
                  <th className='whitespace-nowrap py-1.5 pr-3 font-medium'>Share</th>
                  <th className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'>Requests</th>
                  <th
                    className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'
                    data-tip='The deployment’s CPU split by answering time'
                  >
                    CPU (est.)
                  </th>
                  <th className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'>
                    Connections
                  </th>
                  <th className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'>Jobs</th>
                  <th className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'>Files</th>
                  <th className='whitespace-nowrap py-1.5 pr-3 font-medium'>Limits</th>
                  <th className='whitespace-nowrap py-1.5 font-medium'>30 days</th>
                </tr>
              </thead>
              <tbody>
                {s.apps.map((a) => {
                  const label = `${a.app_key}/${a.env_key}`
                  const top = topShare(a.share)
                  return (
                    <Fragment key={a.env_id}>
                      <tr className='border-t border-slate-100 align-middle dark:border-border'>
                        <td className='py-1.5 pr-3'>
                          <span className='block min-w-[12rem] break-words font-mono'>{label}</span>
                          {a.uses_most && (
                            <span
                              className='mt-1 inline-block whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
                              data-tip={`Uses ${pct(top)} of the deployment (threshold ${pct(mostShare)})`}
                            >
                              Uses most of the deployment
                            </span>
                          )}
                        </td>
                        <td className='py-1.5 pr-3'>
                          <ShareBar value={top} strong={a.uses_most} />
                        </td>
                        <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                          {rate(a.latest?.requests_per_min)}
                        </td>
                        <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                          {a.latest?.cpu_pct == null ? '—' : `${num(a.latest.cpu_pct)}%`}
                        </td>
                        <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                          {conns(a.latest)}
                        </td>
                        <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                          <span data-tip={jobsTip(a.latest)}>{jobsText(a.latest)}</span>
                        </td>
                        <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                          {a.latest?.storage_bytes == null
                            ? '—'
                            : formatFileSize(a.latest.storage_bytes)}
                        </td>
                        <td className='py-1.5 pr-3'>
                          <button
                            type='button'
                            className={cn(
                              ghostButton,
                              'h-7 px-2 text-[12px]',
                              editing === a.env_id && 'bg-accent'
                            )}
                            aria-expanded={editing === a.env_id}
                            onClick={() => setEditing(editing === a.env_id ? null : a.env_id)}
                          >
                            <Pencil className='h-3 w-3 shrink-0 opacity-60' aria-hidden />
                            {limitsText(a.limits)}
                          </button>
                        </td>
                        <td className='py-1.5'>
                          <Sparkline
                            points={a.trend}
                            pick={(p) => p.requests_per_min}
                            label={`Requests of ${label}`}
                          />
                        </td>
                      </tr>
                      {a.latest?.error && (
                        <tr>
                          <td colSpan={9} className='pb-1.5'>
                            <SampleNote f={a.latest} />
                          </td>
                        </tr>
                      )}
                      {editing === a.env_id && (
                        <tr>
                          <td colSpan={9} className='pb-3'>
                            <LimitsEditor
                              envId={a.env_id}
                              label={label}
                              limits={a.limits}
                              onDone={() => setEditing(null)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SectionCard>
  )
}

function DedicatedCard({ apps }: { apps: AppCapacity[] }) {
  return (
    <SectionCard
      title='Dedicated stacks'
      description='Each environment on a stack of its own, read over its hub link.'
    >
      <div className='overflow-x-auto p-4'>
        <table className='w-full min-w-[720px] text-[12px]'>
          <thead className='text-left text-slate-500 dark:text-muted-foreground'>
            <tr>
              <th className='whitespace-nowrap py-1.5 pr-3 font-medium'>App</th>
              <th className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'>CPU</th>
              <th className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'>Memory</th>
              <th className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'>Requests</th>
              <th className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'>Connections</th>
              <th className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'>Jobs</th>
              <th className='whitespace-nowrap py-1.5 pr-3 text-right font-medium'>Files</th>
              <th className='whitespace-nowrap py-1.5 font-medium'>30 days</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => {
              const label = `${a.app_key}/${a.env_key}`
              const err = sampleError(a.latest?.error ?? null)
              return (
                <tr key={a.env_id} className='border-t border-slate-100 dark:border-border'>
                  <td className='py-1.5 pr-3'>
                    <span className='font-mono'>{label}</span>
                    {err && (
                      <span className='ml-2 inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300'>
                        <AlertTriangle className='h-3 w-3' aria-hidden /> {err}
                      </span>
                    )}
                  </td>
                  <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                    {a.latest?.cpu_pct == null ? '—' : `${num(a.latest.cpu_pct)}%`}
                  </td>
                  <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                    {a.latest?.memory_mb == null ? '—' : `${num(a.latest.memory_mb, 0)} MB`}
                  </td>
                  <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                    {rate(a.latest?.requests_per_min)}
                  </td>
                  <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                    {conns(a.latest)}
                  </td>
                  <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                    {jobsText(a.latest)}
                  </td>
                  <td className='whitespace-nowrap py-1.5 pr-3 text-right tabular-nums'>
                    {a.latest?.storage_bytes == null ? '—' : formatFileSize(a.latest.storage_bytes)}
                  </td>
                  <td className='py-1.5'>
                    <Sparkline
                      points={a.trend}
                      pick={(p) => p.requests_per_min}
                      label={`Requests of ${label}`}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}

function AdviceCard({
  advice,
  loading,
  error,
  retry
}: {
  advice: Advice[]
  loading: boolean
  error: unknown
  retry: () => void
}) {
  return (
    <SectionCard
      title='Move advisor'
      description='Suggestions from the last 7 days of samples. Each opens the move panel with the target filled in: you check the plan and start it there, or not.'
    >
      <div className='p-4'>
        {loading ? (
          <Skeleton className='h-10 w-full' />
        ) : error ? (
          <QueryErrorState error={error} what='the move advice' onRetry={retry} />
        ) : advice.length === 0 ? (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No suggestions: every app sits where its figures fit (or there are not 24 hours of
            samples yet).
          </p>
        ) : (
          <ul className='m-0 list-none space-y-3 p-0'>
            {advice.map((a) => (
              <li
                key={`${a.kind}-${a.env_id}`}
                className='rounded-lg border border-slate-200 p-3 dark:border-border'
              >
                <div className='flex flex-wrap items-center gap-2'>
                  <span className='hub-fact font-mono text-[13px]'>
                    {a.app_key}/{a.env_key}
                  </span>
                  <HubEnvTag envKey={a.env_key} />
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[11px]',
                      a.kind === 'fits_shared'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
                        : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
                    )}
                  >
                    {a.kind === 'fits_shared'
                      ? `Fits shared${a.target.kind === 'shared' ? ` · ${a.target.key}` : ''}`
                      : 'Outgrew shared'}
                  </span>
                  <span className='flex-1' />
                  <Link to={a.plan_path} className={ghostButton}>
                    <ArrowRightLeft className='h-3.5 w-3.5 text-nvr-cyan' aria-hidden /> Plan the
                    move
                  </Link>
                </div>
                <ul className='m-0 mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                  {a.reasons.map((r) => (
                    <li key={r.code}>{r.text}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  )
}
