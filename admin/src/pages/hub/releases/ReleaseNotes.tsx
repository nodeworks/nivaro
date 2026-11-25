import { ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Snowflake, X } from 'lucide-react'
import { useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime } from '@/lib/utils'
import { DeployWindowNotice } from '../changes/DeployWindowNotice'
import { hubError } from '../hub-api'
import { ghostButton } from '../hub-parts'
import {
  computeDeployNotes,
  fetchDeployNotes,
  fetchEnvFreeze,
  previewNotes,
  type ReleaseNotes,
  releaseKeys
} from './releases-api'

/**
 * Release notes (what a run changes) and the freeze banner, shared by the Promote panel and the
 * Hub deploy history. Commits come from GitLab (read-only), migrations and new setting names
 * from the commits' diffs and from the build facts the Hub learned per Nivaro version.
 */

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : '?')

function NameList({ label, names }: { label: string; names: string[] }) {
  if (!names.length) return null
  return (
    <div className='min-w-0'>
      <div className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>{label}</div>
      <ul className='m-0 mt-0.5 flex list-none flex-wrap gap-1 p-0'>
        {names.map((n) => (
          <li
            key={n}
            className='rounded border border-slate-200 bg-white px-1.5 py-px font-mono text-[11px] text-slate-700 dark:border-border dark:bg-background dark:text-slate-200'
          >
            {n}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ReleaseNotesView({ notes }: { notes: ReleaseNotes }) {
  const back = notes.kind === 'rollback'
  const nothing =
    notes.components.every((c) => !c.total_commits && !c.error) &&
    !notes.nivaro.migrations?.length &&
    !notes.nivaro.env_keys?.length
  return (
    <div className='space-y-2.5 text-[12px]'>
      <p className='m-0 text-slate-600 dark:text-slate-300'>
        {back ? 'Rolling back' : 'Promoting'}{' '}
        <span className='font-mono'>{notes.from_version ?? 'nothing'}</span> →{' '}
        <span className='font-mono'>{notes.to_version}</span>
        {back && ': this is what goes away.'}
      </p>
      {nothing && (
        <p className='m-0 text-slate-500 dark:text-muted-foreground'>
          No commits, migrations or new settings between the two builds.
        </p>
      )}
      {notes.components.map((c) => (
        <div
          key={`${c.position}-${c.component}`}
          className='space-y-1.5 border-t border-slate-200 pt-2 dark:border-border'
        >
          <div className='flex flex-wrap items-center gap-x-2 text-[12px]'>
            <span className='font-medium text-slate-900 dark:text-foreground'>{c.component}</span>
            <span className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
              {short(c.from_sha)} → {short(c.to_sha)}
            </span>
            {c.total_commits > 0 && (
              <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                {c.total_commits} commit{c.total_commits === 1 ? '' : 's'}{' '}
                {c.direction === 'removed' ? 'taken away' : 'added'}
              </span>
            )}
          </div>
          {c.error && (
            <p className='m-0 text-[11px] text-amber-800 dark:text-amber-300'>{c.error}</p>
          )}
          {c.commits.length > 0 && (
            <ul className='relative m-0 max-h-48 list-none space-y-0.5 overflow-y-auto p-0'>
              {c.commits.map((m) => (
                <li key={m.sha} className='flex min-w-0 gap-2 text-[11px]'>
                  <span className='shrink-0 font-mono text-slate-500 dark:text-muted-foreground'>
                    {short(m.sha)}
                  </span>
                  <span
                    className='min-w-0 flex-1 truncate text-slate-800 dark:text-slate-200'
                    data-tip={m.title}
                  >
                    {m.title}
                  </span>
                  {m.author && (
                    <span className='shrink-0 text-slate-400 dark:text-slate-500'>{m.author}</span>
                  )}
                </li>
              ))}
              {c.total_commits > c.commits.length && (
                <li className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                  …and {c.total_commits - c.commits.length} older
                </li>
              )}
            </ul>
          )}
          <NameList label='Migrations in these commits' names={c.migrations} />
          <NameList label='New settings in env files' names={c.env_keys} />
        </div>
      ))}
      <div className='space-y-1.5 border-t border-slate-200 pt-2 dark:border-border'>
        <div className='font-medium text-slate-900 dark:text-foreground'>Nivaro</div>
        {notes.nivaro.note && (
          <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
            {notes.nivaro.note}
          </p>
        )}
        {notes.nivaro.migrations && (
          <NameList
            label={back ? 'Migrations that came with the newer version' : 'New migrations'}
            names={notes.nivaro.migrations}
          />
        )}
        {notes.nivaro.env_keys && (
          <NameList
            label={back ? 'Settings the older version does not know' : 'New settings it knows'}
            names={notes.nivaro.env_keys}
          />
        )}
        {notes.nivaro.migrations?.length === 0 && notes.nivaro.env_keys?.length === 0 && (
          <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
            No new migrations or settings.
          </p>
        )}
      </div>
    </div>
  )
}

/** What a promotion or rollback of `version` would change (Promote panel, under the plan). */
export function ReleaseNotesPreview({
  envId,
  kind,
  version
}: {
  envId: number
  kind: 'promote' | 'rollback'
  version: string
}) {
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: releaseKeys.preview(envId, kind, version),
    queryFn: () => previewNotes(envId, kind, version),
    enabled: open && !!version,
    staleTime: 60_000
  })
  if (!version) return null
  return (
    <div className='space-y-2'>
      <button
        type='button'
        className={cn(ghostButton, 'px-1.5')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <FileText className='h-3.5 w-3.5' aria-hidden />{' '}
        {open ? 'Hide what changes' : 'What changes'}
      </button>
      {open &&
        (q.data ? (
          <ReleaseNotesView notes={q.data} />
        ) : q.isPending ? (
          <Skeleton className='h-16 w-full' />
        ) : (
          <ErrorNotice
            description={hubError(q.error, 'Could not work out what changes')}
            onRetry={() => void q.refetch()}
          />
        ))}
    </div>
  )
}

/** The stored notes of a run (deploy history), worked out on demand when none were stored. */
export function DeployNotes({ deployId, onClose }: { deployId: number; onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: releaseKeys.notes(deployId),
    queryFn: () => fetchDeployNotes(deployId),
    staleTime: 5 * 60_000
  })
  const compute = useMutation({
    mutationFn: () => computeDeployNotes(deployId),
    onSuccess: (n) => qc.setQueryData(releaseKeys.notes(deployId), n)
  })
  return (
    <div className='space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/40'>
      <div className='flex items-center gap-2'>
        <h5 className='m-0 flex-1 text-[12px] font-semibold text-slate-900 dark:text-foreground'>
          What deploy #{deployId} changed
        </h5>
        <button type='button' aria-label='Close' className={ghostButton} onClick={onClose}>
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      </div>
      {q.isPending ? (
        <Skeleton className='h-14 w-full' />
      ) : q.isError ? (
        <ErrorNotice
          description={hubError(q.error, 'Could not load the release notes')}
          onRetry={() => void q.refetch()}
        />
      ) : q.data ? (
        <>
          <ReleaseNotesView notes={q.data} />
          <p className='m-0 text-[11px] text-slate-400 dark:text-slate-500'>
            Worked out {formatDateTime(q.data.computed_at)}
          </p>
        </>
      ) : (
        <div className='space-y-1.5'>
          <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
            The Hub stored no release notes for this run (it ran before they existed, or GitLab did
            not answer).
          </p>
          {compute.isError && (
            <ErrorNotice description={hubError(compute.error, 'Could not work them out')} />
          )}
          <button
            type='button'
            className={ghostButton}
            disabled={compute.isPending}
            onClick={() => compute.mutate()}
          >
            {compute.isPending ? 'Working them out…' : 'Work them out now'}
          </button>
        </div>
      )}
    </div>
  )
}

/** A Changes button for a history row; opens DeployNotes below the table via `onOpen`. */
export function DeployNotesButton({
  deployId,
  version,
  onOpen
}: {
  deployId: number
  version: string
  onOpen: (deployId: number) => void
}) {
  return (
    <button
      type='button'
      aria-label={`What ${version} changed`}
      className={cn(ghostButton, 'shrink-0 whitespace-nowrap')}
      onClick={() => onOpen(deployId)}
    >
      <FileText className='h-3.5 w-3.5' aria-hidden /> Changes
    </button>
  )
}

/** A freeze on now for this environment's app (promotions refused, rollbacks allowed). */
export function FreezeBanner({
  envId,
  kind,
  envKey,
  version,
  confirm,
  onOutsideReason
}: {
  envId: number
  kind: 'promote' | 'rollback'
  /** For queuing a promotion refused by a closed deploy window (changes/DeployWindowNotice). */
  envKey?: string
  version?: string
  confirm?: string
  /** An administrator's emergency start outside the window: the typed reason, or null. */
  onOutsideReason?: (reason: string | null) => void
}) {
  const q = useQuery({
    queryKey: releaseKeys.freeze(envId),
    queryFn: () => fetchEnvFreeze(envId),
    staleTime: 30_000
  })
  if (!q.data) return null
  // A closed deploy window never stops a rollback (the same exemption as a freeze).
  if (q.data.code === 'OUTSIDE_WINDOW' || q.data.code === 'WINDOW_INVALID')
    return kind === 'rollback' ? null : (
      <DeployWindowNotice
        envId={envId}
        envKey={envKey}
        version={version}
        confirm={confirm}
        opensAt={q.data.next_opening ?? null}
        invalid={q.data.code === 'WINDOW_INVALID'}
        message={q.data.message}
        onOutsideReason={onOutsideReason}
      />
    )
  return (
    <p
      role='status'
      className='m-0 flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200'
    >
      <Snowflake className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
      <span>
        {q.data.code === 'FREEZE_UNKNOWN'
          ? 'The Hub cannot read its freeze windows right now, so it refuses to start this until it can. Try again shortly.'
          : kind === 'rollback'
            ? `A freeze is on (${q.data.freeze.name}, until ${formatDateTime(q.data.freeze.ends_at)}). Only a rollback to a version older than the running one is allowed.`
            : `Promotions are frozen (${q.data.freeze.name}) until ${formatDateTime(q.data.freeze.ends_at)}. The Hub will refuse to start this; a rollback to an older version is still allowed.`}
      </span>
    </p>
  )
}
