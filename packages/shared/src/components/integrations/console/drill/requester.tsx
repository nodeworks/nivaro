import { Bot, CalendarClock, CircleHelp, Workflow, Zap } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import { UserAvatar } from '../../../UserAvatar'
import type { Requester } from '../types'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const a = parts[0]?.[0] ?? '?'
  const b = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return `${a}${b}`.toUpperCase()
}

const ICON = {
  machine: Bot,
  automatic: Zap,
  scheduled: CalendarClock,
  flow: Workflow,
  unknown: CircleHelp
} as const

/**
 * Who started a push — a person (avatar + name, an inactive account marked),
 * a machine account, or what did it when no person was involved. An inferred
 * answer says so, with its evidence on hover; nothing is presented as fact
 * that the row did not record.
 */
export function RequesterChip({ r, size = 'md' }: { r: Requester; size?: 'sm' | 'md' }) {
  const disc = size === 'sm' ? 'h-4 w-4 text-[8px]' : 'h-5 w-5 text-[9px]'
  const text = size === 'sm' ? 'text-[11.5px]' : 'text-[12.5px]'
  const person = r.kind === 'person' && r.user
  const Icon = person ? null : (ICON[r.kind as keyof typeof ICON] ?? CircleHelp)
  return (
    <span
      className='inline-flex min-w-0 max-w-full items-center gap-1.5'
      data-ic-requester={r.kind}
      data-ic-requester-basis={r.basis}
    >
      {person && r.user ? (
        <UserAvatar
          userId={r.user.id}
          className={cn(disc, 'shrink-0 rounded-full object-cover')}
          alt=''
          fallback={
            <span
              aria-hidden
              className={cn(
                disc,
                'inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground'
              )}
            >
              {initials(r.user.name)}
            </span>
          }
        />
      ) : Icon ? (
        <span
          aria-hidden
          className={cn(
            disc,
            'inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground'
          )}
        >
          <Icon className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        </span>
      ) : null}
      <span
        className={cn(
          'truncate',
          text,
          r.kind === 'unknown' ? 'italic text-muted-foreground' : 'font-medium text-foreground'
        )}
        data-tip={r.user?.email ?? undefined}
      >
        {r.label}
      </span>
      {r.user?.inactive && (
        <span className='shrink-0 rounded bg-muted px-1 py-px text-[10.5px] font-medium text-muted-foreground'>
          {r.user.inactive}
        </span>
      )}
      {r.basis === 'inferred' && (
        <span
          className='shrink-0 rounded border border-dashed border-border px-1 py-px text-[10.5px] text-muted-foreground'
          data-tip={r.how ? `Inferred — ${r.how}` : 'Inferred — not stored on the push itself'}
        >
          inferred
        </span>
      )}
    </span>
  )
}
