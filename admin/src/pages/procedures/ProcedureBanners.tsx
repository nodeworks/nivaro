import { AlertTriangle, ArrowUpRight, Info, Loader2, Lock, RotateCcw, Upload } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { DiffView } from './DiffView'
import { CHIP_TONE, type Chip, type ProcDetail, type ProcState } from './status'
import type { Conflict, useProcWrites } from './use-proc-writes'

/** Touch screens get 44px targets; pointer screens keep the dense 28–32px rows. */
export const TOUCH = '[@media(hover:none)]:min-h-11'

export function StatusChip({ chip, className }: { chip: Chip; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-px text-[10.5px] font-medium ring-1 ring-inset',
        CHIP_TONE[chip.tone],
        className
      )}
      data-tip={chip.tip}
    >
      {chip.label}
    </span>
  )
}

type Tone = 'neutral' | 'warn' | 'info' | 'danger'

const BANNER: Record<Tone, string> = {
  neutral:
    'border-slate-200 bg-white text-slate-700 dark:border-border dark:bg-card dark:text-slate-200',
  info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-100',
  warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100',
  danger:
    'border-red-200 bg-red-50 text-red-900 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-100'
}
const ICON: Record<Tone, string> = {
  neutral: 'text-slate-500 dark:text-muted-foreground',
  info: 'text-sky-700 dark:text-sky-300',
  warn: 'text-amber-700 dark:text-amber-300',
  danger: 'text-red-700 dark:text-red-300'
}

function Banner({
  tone,
  icon: Icon,
  title,
  children,
  actions,
  role
}: {
  tone: Tone
  icon: typeof Info
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
  role?: 'alert' | 'status'
}) {
  return (
    <div role={role} className={cn('rounded-lg border px-3 py-2.5', BANNER[tone])}>
      <div className='flex items-start gap-2'>
        <Icon aria-hidden className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', ICON[tone])} />
        <div className='min-w-0 flex-1'>
          <p className='text-[12.5px] font-medium'>{title}</p>
          {children && <div className='mt-0.5 text-[12px] [&>p]:max-w-[80ch]'>{children}</div>}
          {actions && <div className='mt-2 flex flex-wrap items-center gap-2'>{actions}</div>}
        </div>
      </div>
    </div>
  )
}

const BTN = cn('h-7 gap-1.5 text-[12px]', TOUCH)

type Writes = ReturnType<typeof useProcWrites>

/** What the owner and the drift status mean for this procedure, with the one fix each offers. */
export function OwnerBanner({
  detail,
  state,
  writes
}: {
  detail: ProcDetail
  state: ProcState
  writes: Writes
}) {
  const [adopting, setAdopting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const config = detail.config
  const v = state.version ?? config?.version ?? 0
  const name = detail.name

  if (state.owner === 'import') {
    return (
      <Banner tone='neutral' icon={Lock} title={`Owned by import definition ${state.importKey}`}>
        <p>
          Its body is deployed by the import, so it is read-only here. Change it on the definition,
          or the next import deploy overwrites it.
        </p>
        <Link
          to={`/imports?definition=${encodeURIComponent(state.importKey ?? '')}`}
          className='mt-1.5 inline-flex min-h-6 items-center gap-1 font-medium text-[#007a99] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-nvr-cyan [@media(hover:none)]:min-h-11'
        >
          Open import definition <ArrowUpRight aria-hidden className='h-3 w-3' />
        </Link>
      </Banner>
    )
  }
  if (state.owner === 'conflict') {
    return (
      <Banner tone='danger' icon={AlertTriangle} title='Two owners claim this name'>
        <p>
          An import definition and a managed procedure both claim this name; the import wins. Remove
          one of them: the import definition, or this procedure's config.
        </p>
        <Link
          to='/imports'
          className='mt-1.5 inline-flex min-h-6 items-center gap-1 font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan [@media(hover:none)]:min-h-11'
        >
          Open import definitions <ArrowUpRight aria-hidden className='h-3 w-3' />
        </Link>
      </Banner>
    )
  }
  if (state.owner === 'unmanaged' && !state.readable) {
    return (
      <Banner tone='neutral' icon={Lock} title={`${name} is encrypted`}>
        <p>
          Its text cannot be read, so it cannot be adopted, edited or dropped here. You can still
          run it.
        </p>
      </Banner>
    )
  }
  if (state.owner === 'unmanaged') {
    return (
      <Banner
        tone='neutral'
        icon={Info}
        title='Not managed'
        actions={
          adopting ? (
            <>
              <span className='basis-full text-[12px]'>
                Adopt {name}? From then on it travels to staging and production through the nightly
                promote.
              </span>
              <Button
                size='sm'
                className={BTN}
                disabled={writes.busy}
                onClick={() => writes.adopt.mutate({ keepLive: false })}
              >
                {writes.adopt.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
                Adopt it
              </Button>
              <Button size='sm' variant='ghost' className={BTN} onClick={() => setAdopting(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size='sm'
              variant='outline'
              className={BTN}
              disabled={writes.busy}
              onClick={() => setAdopting(true)}
            >
              Adopt
            </Button>
          )
        }
      >
        <p>
          Adopt keeps this definition as version 1 in config; from then on it deploys from config.
        </p>
      </Banner>
    )
  }

  // Managed
  const deployBtn = (label: string) => (
    <Button
      size='sm'
      className={BTN}
      disabled={writes.busy}
      onClick={() => writes.deployConfig.mutate()}
    >
      {writes.deployConfig.isPending ? (
        <Loader2 className='h-3 w-3 animate-spin' />
      ) : (
        <Upload className='h-3 w-3' />
      )}
      {label}
    </Button>
  )
  const restoreCurrent = restoring ? (
    <>
      <span className='basis-full text-[12px]'>
        Restore version {v}? It is saved as version {v + 1} and deployed to this database.
      </span>
      <Button
        size='sm'
        className={BTN}
        disabled={writes.busy || !config}
        onClick={() => config && writes.restore.mutate({ version: v, body: config.body })}
      >
        {writes.restore.isPending ? (
          <Loader2 className='h-3 w-3 animate-spin' />
        ) : (
          <RotateCcw className='h-3 w-3' />
        )}
        Restore
      </Button>
      <Button size='sm' variant='ghost' className={BTN} onClick={() => setRestoring(false)}>
        Cancel
      </Button>
    </>
  ) : (
    <Button
      size='sm'
      variant='outline'
      className={BTN}
      disabled={writes.busy}
      onClick={() => setRestoring(true)}
    >
      <RotateCcw className='h-3 w-3' /> Restore version {v}
    </Button>
  )
  const droppedAt = config?.dropped_at
  const when = droppedAt ? (
    <span data-tip={formatDateTime(droppedAt)}>{formatRelative(droppedAt)}</span>
  ) : null

  switch (state.status) {
    case 'drifted': {
      const liveText = detail.definition
      return (
        <Banner
          tone='warn'
          icon={AlertTriangle}
          title={`The database differs from saved version ${v}.`}
          actions={
            <>
              {deployBtn(`Deploy version ${v}`)}
              <span
                data-tip={
                  liveText
                    ? undefined
                    : 'The database copy is encrypted, so it cannot be kept in config'
                }
              >
                <Button
                  size='sm'
                  variant='outline'
                  className={BTN}
                  disabled={writes.busy || !liveText}
                  onClick={() => writes.adopt.mutate({ keepLive: true })}
                >
                  {writes.adopt.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
                  Keep the database's version
                </Button>
              </span>
              {liveText && (
                <Button
                  size='sm'
                  variant='ghost'
                  className={BTN}
                  aria-expanded={showDiff}
                  onClick={() => setShowDiff((s) => !s)}
                >
                  {showDiff ? 'Hide the difference' : 'Show the difference'}
                </Button>
              )}
            </>
          }
        >
          <p>
            Someone changed it on this database outside config. Deploy version {v} to put config
            back, or keep the database's version as version {v + 1}.
          </p>
          {showDiff && liveText && config && (
            <DiffView
              base={config.body}
              draft={liveText}
              baseLabel={`saved version ${v}`}
              added='only in the database'
              removed={`only in version ${v}`}
              className='-ml-[22px] mt-2 max-h-[min(360px,50vh)] sm:ml-0 text-slate-700 dark:text-slate-200'
            />
          )}
        </Banner>
      )
    }
    case 'not-deployed':
      return (
        <Banner
          tone='info'
          icon={Info}
          title={`Saved as version ${v}, not on this database yet.`}
          actions={deployBtn(`Deploy version ${v}`)}
        >
          <p>It can't run here until it is deployed.</p>
        </Banner>
      )
    case 'dropped':
      return (
        <Banner tone='neutral' icon={Info} title={<>Dropped {when}.</>} actions={restoreCurrent}>
          <p>
            Its versions are kept. Below is the last one, read-only. Restore it, or any version in
            History, to bring the procedure back.
          </p>
        </Banner>
      )
    case 'dropped-but-live':
      return (
        <Banner
          tone='warn'
          icon={AlertTriangle}
          title={<>Dropped in config {when}, but still on this database.</>}
          actions={
            <>
              {deployBtn('Drop it here now')}
              {restoreCurrent}
            </>
          }
        >
          <p>The next deploy drops it here. Restore a version to keep it instead.</p>
        </Banner>
      )
    default:
      return null
  }
}

const STALE_COPY: Record<'save' | 'restore' | 'drop', string> = {
  save: 'Someone saved a newer version. Reload it before deploying.',
  restore: 'Someone saved a newer version. Reload it before restoring.',
  drop: 'Someone saved a newer version. Reload it before dropping.'
}

/** A write that came back 409: the two ways forward, said plainly, next to what changed. */
export function ConflictPanel({
  conflict,
  state,
  writes
}: {
  conflict: Conflict
  state: ProcState
  writes: Writes
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: still ? 'auto' : 'smooth' })
    ref.current?.focus({ preventScroll: true })
  }, [])

  if (conflict.kind === 'stale') {
    return (
      <div ref={ref} tabIndex={-1} className='outline-none'>
        <Banner
          role='alert'
          tone='warn'
          icon={AlertTriangle}
          title={STALE_COPY[conflict.op]}
          actions={
            <>
              <Button size='sm' className={BTN} onClick={writes.reload}>
                Reload
              </Button>
              <Button size='sm' variant='ghost' className={BTN} onClick={writes.clearConflict}>
                Dismiss
              </Button>
            </>
          }
        >
          {conflict.op === 'save' && (
            <p>
              Your edit stays in the editor. After the reload, Highlighted changes compares it with
              their version.
            </p>
          )}
        </Banner>
      </div>
    )
  }

  const { liveNow } = conflict
  const canKeep = !!liveNow
  return (
    <div ref={ref} tabIndex={-1} className='outline-none'>
      <Banner
        role='alert'
        tone='warn'
        icon={AlertTriangle}
        title='The database changed since you opened it.'
        actions={
          <>
            <span
              data-tip={
                liveNow === null
                  ? 'It is no longer on this database'
                  : liveNow === ''
                    ? 'The database copy is encrypted, so it cannot be kept in config'
                    : undefined
              }
            >
              <Button
                size='sm'
                variant='outline'
                className={BTN}
                disabled={writes.busy || !canKeep}
                onClick={() => writes.adopt.mutate({ keepLive: true })}
              >
                {writes.adopt.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
                Keep the database's version
              </Button>
            </span>
            <Button
              size='sm'
              className={BTN}
              disabled={writes.busy}
              onClick={() => conflict.retry(conflict.liveHash)}
            >
              {(writes.save.isPending || writes.restore.isPending) && (
                <Loader2 className='h-3 w-3 animate-spin' />
              )}
              Overwrite with mine
            </Button>
            <Button size='sm' variant='ghost' className={BTN} onClick={writes.clearConflict}>
              Cancel
            </Button>
          </>
        }
      >
        <p>
          Someone changed it on the database after this page read it. Keep their version (it is
          saved to config
          {state.owner === 'managed' ? ` as version ${(state.version ?? 0) + 1}` : ''}
          ), or overwrite it with{' '}
          {conflict.op === 'restore' ? 'the version you are restoring' : 'your edit'}.
        </p>
        {liveNow === undefined ? (
          <Skeleton className='mt-2 h-24 w-full rounded-lg' />
        ) : liveNow ? (
          <DiffView
            base={liveNow}
            draft={conflict.mine}
            baseLabel='the database now'
            added={conflict.op === 'restore' ? 'in the version' : 'yours'}
            removed='only in the database'
            className='-ml-[22px] mt-2 max-h-[min(360px,50vh)] sm:ml-0 text-slate-700 dark:text-slate-200'
          />
        ) : null}
      </Banner>
    </div>
  )
}
