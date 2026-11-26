import { QueryErrorState } from '@nivaro/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { HardDrive, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime } from '@/lib/utils'
import { type ChipState, hubToast } from '../hub-api'
import { SectionCard, StatusChip } from '../hub-parts'
import {
  checkDriverNow,
  formatBytes,
  type OpsHealth,
  opsKeys,
  stateWords,
  useDriverStorage,
  usedPct,
  useStorageOverview
} from './ops-api'

const LEVEL_BAR: Record<string, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  critical: 'bg-red-500',
  unknown: 'bg-slate-300 dark:bg-slate-600'
}
/** A storage level as the Apps hub's health chip (the same colours as every other health). */
const LEVEL_CHIP: Record<string, ChipState> = {
  ok: 'ok',
  warn: 'degraded',
  critical: 'unreachable',
  unknown: 'checking'
}
const LEVEL_WORDS: Record<string, string> = {
  ok: 'Healthy',
  warn: 'Filling up',
  critical: 'Almost full',
  unknown: 'Unknown'
}

/** A usage bar with its figures; the level is said in words too, never by colour alone. */
export function UsageBar({ h }: { h: OpsHealth }) {
  const pct = usedPct(h)
  const level = h.level ?? 'unknown'
  return (
    <div className='space-y-1'>
      <div className='flex items-baseline gap-2 text-[12px]'>
        <span className='font-medium text-slate-900 dark:text-foreground'>
          {pct == null ? '—' : `${pct}% used`}
        </span>
        <span className='text-slate-500 dark:text-muted-foreground'>
          {formatBytes(h.free_bytes)} free of {formatBytes(h.total_bytes)}
        </span>
        <span className='ml-auto'>
          <StatusChip
            compact
            glyph
            state={LEVEL_CHIP[level] ?? 'checking'}
            label={LEVEL_WORDS[level] ?? level}
          />
        </span>
      </div>
      <div
        aria-hidden
        className='h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
      >
        <div
          className={cn('h-full rounded-full', LEVEL_BAR[level] ?? LEVEL_BAR.unknown)}
          style={{ width: `${Math.min(100, pct ?? 0)}%` }}
        />
      </div>
    </div>
  )
}

function DriverFacts({ h }: { h: OpsHealth }) {
  if (h.state !== 'ok')
    return (
      <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>{stateWords(h.state)}</p>
    )
  return (
    <div className='space-y-2'>
      <UsageBar h={h} />
      <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        {h.kind === 'nfs' ? 'NFS export' : 'Local volumes'}
        {h.files != null
          ? ` · ${h.files.toLocaleString()} files${h.files_complete === false ? ' or more' : ''}`
          : ''}
        {h.checked_at ? ` · read ${formatDateTime(h.checked_at)}` : ''}
      </p>
    </div>
  )
}

/** The Docker driver page's storage card (Drivers tab, administrators). */
export function DriverStorageCard({ driverId }: { driverId: number }) {
  const q = useDriverStorage(driverId)
  const qc = useQueryClient()
  const check = useMutation({
    mutationFn: () => checkDriverNow(driverId),
    onSuccess: (row) => {
      qc.setQueryData(opsKeys.driverStorage(driverId), row)
      void qc.invalidateQueries({ queryKey: opsKeys.storage })
    },
    onError: (e) => hubToast(e, 'The storage could not be read')
  })
  return (
    <SectionCard
      title='Volume storage'
      description='How full the storage this driver’s volumes live on is, as its agent reports it. Warns at 80 % and 90 %.'
      actions={
        <Button
          size='sm'
          variant='outline'
          className='h-8'
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          <RefreshCw
            className={cn('mr-1.5 h-3.5 w-3.5', check.isPending && 'animate-spin')}
            aria-hidden
          />
          {check.isPending ? 'Reading…' : 'Read now'}
        </Button>
      }
    >
      <div className='p-4'>
        {q.isPending ? (
          <Skeleton className='h-10 w-full' />
        ) : q.isError ? (
          <QueryErrorState error={q.error} what='the storage' onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Not read yet. Read now, or wait for the next 15-minute round.
          </p>
        ) : (
          <DriverFacts h={q.data} />
        )}
      </div>
    </SectionCard>
  )
}

function growth(bytes: number | null, prev: number | null): string | null {
  if (bytes == null || prev == null) return null
  const d = bytes - prev
  if (d === 0) return 'no change'
  return `${d > 0 ? '+' : '−'}${formatBytes(Math.abs(d))} since the last reading`
}

/**
 * Storage (Apps hub tab): each Docker driver's volume storage (administrators) and each app
 * environment's stored files — count, size and growth — read over its link.
 */
export default function HubStorage() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const q = useStorageOverview()
  return (
    <div className='relative flex-1 space-y-5 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
      {q.isPending ? (
        <Skeleton className='h-32 w-full' />
      ) : q.isError ? (
        <QueryErrorState error={q.error} what='the storage' onRetry={() => void q.refetch()} />
      ) : (
        <>
          {isAdmin && (
            <SectionCard
              title='Docker drivers'
              description={`Volume storage per driver. Filling up at ${q.data.warn_pct} %, almost full at ${q.data.critical_pct} %: administrators and the owners of apps on the driver are told once per level.`}
            >
              {q.data.drivers.length === 0 ? (
                <p className='m-0 p-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No Docker drivers.
                </p>
              ) : (
                <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
                  {q.data.drivers.map((d) => (
                    <li key={d.id} className='space-y-2 px-4 py-3'>
                      <Link
                        to={`/hub/drivers?driver=${d.id}`}
                        className='inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-900 hover:underline dark:text-foreground'
                      >
                        <HardDrive className='h-3.5 w-3.5 text-slate-400' aria-hidden />
                        {d.name}
                      </Link>
                      <DriverFacts h={d} />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          )}
          <SectionCard
            title='Stored files per environment'
            description='What each app keeps in its file storage, read over its link every 15 minutes.'
          >
            {q.data.environments.length === 0 ? (
              <p className='m-0 p-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
                No environments.
              </p>
            ) : (
              <div className='overflow-x-auto'>
                <table className='w-full min-w-[34rem] text-left text-[12px]'>
                  <thead>
                    <tr className='border-b border-slate-200 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                      <th className='px-4 py-2 font-medium'>Environment</th>
                      <th className='px-4 py-2 font-medium'>Files</th>
                      <th className='px-4 py-2 font-medium'>Size</th>
                      <th className='px-4 py-2 font-medium'>Growth</th>
                      <th className='px-4 py-2 font-medium'>Read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.environments.map((e) => (
                      <tr
                        key={e.environment_id}
                        className='border-b border-slate-100 last:border-0 dark:border-border'
                      >
                        <td className='px-4 py-2.5 font-medium text-slate-800 dark:text-foreground'>
                          <span className='hub-fact'>
                            {e.app_key} / {e.environment_key}
                          </span>
                          <HubEnvTag envKey={e.environment_key} className='ml-1.5' />
                          {e.on_shared && (
                            <span className='ml-1.5 text-[11px] font-normal text-slate-500 dark:text-muted-foreground'>
                              shared
                            </span>
                          )}
                        </td>
                        {e.state === 'ok' ? (
                          <>
                            <td className='whitespace-nowrap px-4 py-2.5 tabular-nums'>
                              {e.files?.toLocaleString() ?? '—'}
                            </td>
                            <td className='whitespace-nowrap px-4 py-2.5 tabular-nums'>
                              {formatBytes(e.bytes)}
                            </td>
                            <td className='px-4 py-2.5 text-slate-500 dark:text-muted-foreground'>
                              {growth(e.bytes, e.prev_bytes) ?? '—'}
                            </td>
                          </>
                        ) : (
                          <td
                            colSpan={3}
                            className='px-4 py-2.5 text-slate-500 dark:text-muted-foreground'
                          >
                            {stateWords(e.state)}
                          </td>
                        )}
                        <td className='whitespace-nowrap px-4 py-2.5 text-slate-500 dark:text-muted-foreground'>
                          {e.checked_at ? formatDateTime(e.checked_at) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  )
}
