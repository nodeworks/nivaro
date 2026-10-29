import { useQuery } from '@tanstack/react-query'
import { History, Loader2, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { personName, usePeople } from '@/lib/people'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { DiffView } from './DiffView'
import {
  deployedVersion,
  type ProcDetail,
  type ProcState,
  restoreCopy,
  type VersionDetail,
  type VersionSummary
} from './status'
import { procKeys } from './use-proc-writes'

const MARK =
  'inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium ring-1 ring-inset'
const MARK_CURRENT =
  'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-muted dark:text-slate-200 dark:ring-border'
const MARK_DEPLOYED =
  'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:ring-emerald-400/30'

/**
 * Saved versions of a managed procedure, newest first. Picking one shows what restoring it
 * changes against the current version; Restore saves its body as the next version and deploys.
 */
export function ProcedureHistory({
  detail,
  state,
  busy,
  dirty,
  restoring,
  onRestore
}: {
  detail: ProcDetail
  state: ProcState
  busy: boolean
  /** The editor holds an unsaved edit (a restore replaces it). */
  dirty: boolean
  /** The version a restore is running for. */
  restoring: number | null
  onRestore: (version: number, body: string) => void
}) {
  const name = detail.name
  const config = detail.config
  const versionsQ = useQuery({
    queryKey: procKeys.versions(name),
    queryFn: () =>
      api
        .get<{ data: VersionSummary[] }>(`/procedures/${encodeURIComponent(name)}/versions`)
        .then((r) => r.data.data)
  })
  const versions = versionsQ.data ?? []
  const people = usePeople(versions.map((v) => v.created_by))
  const deployed = deployedVersion(
    versions,
    state.status === 'dropped' ? null : config?.deployed_hash
  )
  const [picked, setPicked] = useState<number | null>(null)
  const pickedSummary = versions.find((v) => v.version === picked) ?? null

  return (
    <section
      aria-labelledby='proc-history-h'
      className='rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-100 px-4 py-3 dark:border-border'>
        <History aria-hidden className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground' />
        <h3
          id='proc-history-h'
          className='text-[13px] font-medium text-slate-800 dark:text-slate-200'
        >
          History
        </h3>
        <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          {versions.length > 0
            ? `${versions.length} saved version${versions.length === 1 ? '' : 's'} in config`
            : 'Saved versions in config'}
        </span>
      </div>
      <div className='grid md:grid-cols-[minmax(220px,300px)_minmax(0,1fr)]'>
        <div className='border-slate-100 md:border-r dark:border-border'>
          {versionsQ.isLoading ? (
            <div className='space-y-1.5 p-3'>
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className='h-11 w-full rounded-md' />
              ))}
            </div>
          ) : versionsQ.isError ? (
            <p className='p-4 text-[12px] text-red-700 dark:text-red-300'>
              Versions could not load.{' '}
              <button
                type='button'
                className='font-medium underline underline-offset-2'
                onClick={() => void versionsQ.refetch()}
              >
                Retry
              </button>
            </p>
          ) : (
            <ul className='max-h-[min(420px,50vh)] overflow-y-auto py-1'>
              {versions.map((v) => {
                const who = personName(people.data, v.created_by)
                const isCurrent = v.version === config?.version
                return (
                  <li key={v.version}>
                    <button
                      type='button'
                      aria-pressed={picked === v.version}
                      onClick={() => setPicked(v.version)}
                      className={cn(
                        'flex min-h-11 w-full items-start gap-3 px-4 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                        picked === v.version
                          ? 'bg-nvr-cyan/10'
                          : 'hover:bg-slate-50 dark:hover:bg-muted/60'
                      )}
                    >
                      <span className='mt-px w-9 shrink-0 font-mono text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
                        v{v.version}
                      </span>
                      <span className='min-w-0 flex-1'>
                        <span className='flex flex-wrap items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                          {isCurrent && <span className={cn(MARK, MARK_CURRENT)}>current</span>}
                          {deployed === v.version && (
                            <span
                              className={cn(MARK, MARK_DEPLOYED)}
                              data-tip='This is what the database has'
                            >
                              deployed
                            </span>
                          )}
                          <span className='whitespace-nowrap'>
                            <span className='text-slate-700 dark:text-slate-200'>
                              {who ?? 'Someone'}
                            </span>{' '}
                            <span aria-hidden>·</span>{' '}
                            <span data-tip={formatDateTime(v.created_at)}>
                              {formatRelative(v.created_at)}
                            </span>
                          </span>
                        </span>
                        <span className='mt-0.5 line-clamp-2 block break-words text-[12px] text-slate-700 dark:text-slate-300'>
                          {v.note || (
                            <span className='text-slate-500 dark:text-muted-foreground'>
                              No note
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
              {versions.length === 0 && (
                <li className='px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No versions yet.
                </li>
              )}
            </ul>
          )}
        </div>
        <div className='min-w-0 border-t border-slate-100 p-4 md:border-t-0 dark:border-border'>
          {pickedSummary && config ? (
            <VersionCompare
              key={pickedSummary.version}
              name={name}
              summary={pickedSummary}
              who={personName(people.data, pickedSummary.created_by)}
              current={config.version}
              currentBody={config.body}
              currentHash={config.body_hash}
              dropped={state.dropped}
              dirty={dirty}
              busy={busy}
              restoring={restoring === pickedSummary.version}
              onRestore={onRestore}
            />
          ) : (
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              {state.dropped
                ? `Pick a version to bring back. Restoring saves it as version ${(config?.version ?? 0) + 1} and deploys it.`
                : 'Pick a version to compare it with the current one, or restore it.'}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function VersionCompare({
  name,
  summary,
  who,
  current,
  currentBody,
  currentHash,
  dropped,
  dirty,
  busy,
  restoring,
  onRestore
}: {
  name: string
  summary: VersionSummary
  who: string | null
  current: number
  currentBody: string
  currentHash: string
  dropped: boolean
  dirty: boolean
  busy: boolean
  restoring: boolean
  onRestore: (version: number, body: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const vq = useQuery({
    queryKey: procKeys.version(name, summary.version),
    queryFn: () =>
      api
        .get<{ data: VersionDetail }>(
          `/procedures/${encodeURIComponent(name)}/versions/${summary.version}`
        )
        .then((r) => r.data.data),
    staleTime: Number.POSITIVE_INFINITY // a saved version never changes
  })
  const isCurrent = summary.version === current
  // A dropped proc brings back any version, the current one included.
  const canRestore = dropped || !isCurrent

  return (
    <div className='space-y-3'>
      <div>
        <p className='flex flex-wrap items-center gap-x-1.5 text-[13px] text-slate-900 dark:text-foreground'>
          <span className='font-mono font-semibold'>v{summary.version}</span>
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {who ?? 'Someone'} · {formatDateTime(summary.created_at)}
          </span>
        </p>
        <p className='mt-1 max-w-[80ch] whitespace-pre-wrap break-words text-[12.5px] text-slate-700 dark:text-slate-200'>
          {summary.note || 'No note'}
        </p>
      </div>
      {vq.isError ? (
        <p className='text-[12px] text-red-700 dark:text-red-300'>
          Version {summary.version} could not load.{' '}
          <button
            type='button'
            className='font-medium underline underline-offset-2'
            onClick={() => void vq.refetch()}
          >
            Retry
          </button>
        </p>
      ) : !vq.data ? (
        <Skeleton className='h-48 w-full rounded-lg' />
      ) : (
        <DiffView
          base={currentBody}
          draft={vq.data.body}
          baseLabel={`current version ${current}`}
          added={`in version ${summary.version}`}
          removed={`only in version ${current}`}
          className='max-h-[min(360px,50vh)]'
        />
      )}
      {vq.data && canRestore && (
        <div className='flex flex-wrap items-center gap-2'>
          {confirming ? (
            <>
              <span className='basis-full text-[12px] text-slate-700 dark:text-slate-200'>
                {restoreCopy(summary, current, currentHash, dropped)}
                {dirty ? ' Your unsaved edit is discarded.' : ''}
              </span>
              <Button
                size='sm'
                className='h-8 gap-1.5 text-[12px] [@media(hover:none)]:min-h-11'
                disabled={busy}
                onClick={() => onRestore(summary.version, vq.data.body)}
              >
                {restoring ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <RotateCcw className='h-3.5 w-3.5' />
                )}
                Restore
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className='h-8 text-[12px] [@media(hover:none)]:min-h-11'
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size='sm'
              variant='outline'
              className='h-8 gap-1.5 text-[12px] [@media(hover:none)]:min-h-11'
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <RotateCcw className='h-3.5 w-3.5' /> Restore version {summary.version}
            </Button>
          )}
        </div>
      )}
      {vq.data && !canRestore && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          This is the current version.
        </p>
      )}
    </div>
  )
}
