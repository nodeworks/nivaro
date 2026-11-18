import { cn } from '../../lib/utils'
import { AiMarkdown } from '../ai/AiMarkdown'
import { GitlabBadge } from './TrackerChip'

/**
 * A comment or reply mirrored in from GitLab carries `tracker` (the server sends the provider and
 * the GitLab author's name only — routes/comments.ts, routes/support.ts trackerBadgeOf). Its
 * writer is the GitLab machine user, so the thread shows the GitLab author with a GitLab badge,
 * and its markdown goes through the safe renderer with in-app links and charts off.
 */
export interface MirroredFrom {
  provider: 'gitlab' | string
  author: string | null
}

export function mirroredAuthorName(from: MirroredFrom): string {
  return from.author?.trim() || 'Someone on GitLab'
}

/** "<GitLab badge> Jane Doe" — the author line of a mirrored comment. */
export function MirroredAuthor({ from, className }: { from: MirroredFrom; className?: string }) {
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
      data-comment-gitlab-author
    >
      <GitlabBadge />
      <span className='truncate'>{mirroredAuthorName(from)}</span>
    </span>
  )
}

/** The text of a mirrored comment: safe markdown, no in-app links, no charts. */
export function MirroredBody({ text, className }: { text: string; className?: string }) {
  return (
    <AiMarkdown content={text} mirrored autolink={false} className={cn('break-words', className)} />
  )
}

/** Above a reply box while the thing is linked: what is written here goes to GitLab too. */
export function GitlabSharedNotice({ className }: { className?: string }) {
  return (
    <p
      className={cn('text-[11.5px] text-slate-600 dark:text-muted-foreground', className)}
      data-gitlab-shared
    >
      Comments here are shared with GitLab.
    </p>
  )
}
