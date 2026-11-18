import { Gitlab } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  chipOf,
  chipTone,
  isLink,
  safeHref,
  stateWord,
  type TrackerAny,
  type TrackerSourceRef
} from './tracker-model'
import { useSourceTracker } from './use-tracker-link'

const TONE = {
  open: 'border-orange-500/30 bg-orange-50 text-orange-800 dark:border-orange-400/30 dark:bg-orange-500/10 dark:text-orange-300',
  closed:
    'border-slate-300/70 bg-slate-50 text-slate-500 dark:border-border dark:bg-muted/40 dark:text-muted-foreground',
  error:
    'border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300'
} as const

/**
 * `#482 · open` — the GitLab issue something is linked to, opening GitLab in a new tab. A whole
 * link (administrators) with a sync error reads `#482 · sync error`. Renders nothing without a
 * tracker (GitLab sync off, or not linked).
 */
export function TrackerChip({
  tracker,
  className
}: {
  tracker: TrackerAny | null | undefined
  className?: string
}) {
  if (!tracker) return null
  const c = chipOf(tracker)
  const tone = chipTone(tracker)
  const href = safeHref(c.web_url)
  const word = tone === 'error' ? 'sync error' : stateWord(c.state)
  const error = isLink(tracker) ? tracker.sync_error : null
  const body = (
    <>
      <Gitlab className='h-3 w-3 shrink-0' aria-hidden />
      <span className='tabular-nums'>#{c.iid}</span>
      <span aria-hidden className='opacity-60'>
        ·
      </span>
      <span>{word}</span>
    </>
  )
  const cls = cn(
    'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[10.5px] font-medium',
    TONE[tone],
    className
  )
  const tip = error
    ? `Could not read it from GitLab: ${error}`
    : c.title
      ? `${c.title} — opens GitLab`
      : 'Opens GitLab'
  if (!href)
    return (
      <span
        className={cls}
        data-tip={error ?? (c.title || undefined)}
        data-gitlab-chip={c.iid}
        data-gitlab-chip-state={tone}
      >
        {body}
      </span>
    )
  return (
    <a
      href={href}
      target='_blank'
      rel='noreferrer noopener'
      className={cn(
        cls,
        'hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
      )}
      data-tip={tip}
      aria-label={`GitLab issue #${c.iid}, ${word}${c.title ? `: ${c.title}` : ''} (opens GitLab)`}
      data-gitlab-chip={c.iid}
      data-gitlab-chip-state={tone}
    >
      {body}
    </a>
  )
}

/**
 * The GitLab chip(s) of a support ticket or a record, for anyone who can read it. Nothing is read
 * while GitLab sync is off, and nothing renders when it is not linked on a connection that syncs
 * this kind. Read-only: the chip shows even to people who may not create.
 */
export function SourceTrackerChips({
  source,
  className
}: {
  source: TrackerSourceRef | null
  className?: string
}) {
  const t = useSourceTracker(source, { mayCreate: false })
  return <TrackerChips tracker={t} className={className} />
}

/** The chips of a tracker the host already reads (no second hook). */
export function TrackerChips({
  tracker,
  className
}: {
  tracker: { shown: TrackerAny[] }
  className?: string
}) {
  if (!tracker.shown.length) return null
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {tracker.shown.map((c) => (
        <TrackerChip key={`${c.web_url}:${c.iid}`} tracker={c} />
      ))}
    </span>
  )
}

/** The small "GitLab" mark on a comment mirrored in from GitLab. */
export function GitlabBadge() {
  return (
    <span className='inline-flex items-center gap-1 rounded border border-orange-500/30 bg-orange-50 px-1 text-[10px] font-medium text-orange-800 dark:border-orange-400/30 dark:bg-orange-500/10 dark:text-orange-300'>
      <Gitlab className='h-2.5 w-2.5' aria-hidden />
      GitLab
    </span>
  )
}
