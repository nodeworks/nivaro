import { Gitlab } from 'lucide-react'
import { cn } from '@/lib/utils'
import { chipOf, type IssueTracker, safeHref, stateWord } from './gitlab'

/**
 * `#482 · open` — the GitLab issue an issue-log entry is linked to, opening GitLab in a new tab.
 * Renders nothing without a tracker (GitLab sync off, or not linked).
 */
export function GitlabChip({
  tracker,
  className
}: {
  tracker: IssueTracker | null | undefined
  className?: string
}) {
  if (!tracker) return null
  const c = chipOf(tracker)
  const href = safeHref(c.web_url)
  const closed = c.state === 'closed'
  const body = (
    <>
      <Gitlab className='h-3 w-3 shrink-0' aria-hidden />
      <span className='tabular-nums'>#{c.iid}</span>
      <span aria-hidden className='text-slate-400 dark:text-muted-foreground'>
        ·
      </span>
      <span>{stateWord(c.state)}</span>
    </>
  )
  const cls = cn(
    'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[10.5px] font-medium',
    closed
      ? 'border-slate-300/70 bg-slate-50 text-slate-500 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'
      : 'border-orange-500/30 bg-orange-50 text-orange-800 dark:border-orange-400/30 dark:bg-orange-500/10 dark:text-orange-300',
    className
  )
  if (!href)
    return (
      <span className={cls} data-tip={c.title} data-gitlab-chip={c.iid}>
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
      data-tip={c.title ? `${c.title} — opens GitLab` : 'Opens GitLab'}
      aria-label={`GitLab issue #${c.iid}, ${stateWord(c.state)}${c.title ? `: ${c.title}` : ''} (opens GitLab)`}
      data-gitlab-chip={c.iid}
    >
      {body}
    </a>
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
