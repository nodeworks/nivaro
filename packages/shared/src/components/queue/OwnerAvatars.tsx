import { UserAvatar } from '../UserAvatar'
import { useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

// Compact owner display: overlapping initial avatars (Linear/GitHub assignee
// pattern), max `max` shown + a "+N" overflow chip. Every person gets a stable
// color derived from their id, so the same owner reads the same across rows.
// Clicking the stack opens a popover with the full roster.

export interface OwnerLike {
  id: string
  name: string
}

// Hand-tuned pairs (bg / ink) that hold up on both themes — avatars keep their
// own light surface in dark mode, GitHub-style.
const AVATAR_COLORS: Array<{ bg: string; fg: string }> = [
  { bg: '#e0f2fe', fg: '#075985' }, // sky
  { bg: '#dcfce7', fg: '#166534' }, // green
  { bg: '#fef3c7', fg: '#92400e' }, // amber
  { bg: '#fce7f3', fg: '#9d174d' }, // pink
  { bg: '#ede9fe', fg: '#5b21b6' }, // violet
  { bg: '#ffedd5', fg: '#9a3412' }, // orange
  { bg: '#ccfbf1', fg: '#115e59' }, // teal
  { bg: '#fee2e2', fg: '#991b1b' }, // red
  { bg: '#e0e7ff', fg: '#3730a3' }, // indigo
  { bg: '#ecfccb', fg: '#3f6212' }, // lime
  { bg: '#cffafe', fg: '#155e75' }, // cyan
  { bg: '#f3e8ff', fg: '#6b21a8' } // purple
]

function colorFor(id: string): { bg: string; fg: string } {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function Avatar({ owner, className }: { owner: OwnerLike; className?: string }) {
  const c = colorFor(owner.id)
  return (
    <UserAvatar
      userId={owner.id}
      alt={owner.name}
      className={cn('h-[22px] w-[22px] ring-2 ring-white dark:ring-card', className)}
      fallback={
        <span
          title={owner.name}
          className={cn(
            'inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ring-2 ring-white dark:ring-card',
            className
          )}
          style={{ backgroundColor: c.bg, color: c.fg }}
        >
          {initials(owner.name)}
        </span>
      }
    />
  )
}

export function OwnerAvatars({
  owners,
  max = 4,
  emptyLabel = 'No owners'
}: {
  owners: OwnerLike[]
  max?: number
  emptyLabel?: string
}) {
  const [open, setOpen] = useState(false)

  if (owners.length === 0) {
    return (
      <span className='text-[12px] text-slate-300 dark:text-muted-foreground'>{emptyLabel}</span>
    )
  }

  const visible = owners.slice(0, max)
  const overflow = owners.length - visible.length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          onClick={(e) => e.stopPropagation()}
          aria-label={`${owners.length} owner${owners.length === 1 ? '' : 's'}: ${owners
            .map((o) => o.name)
            .join(', ')}`}
          className='group/owners flex items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <span className='flex items-center transition-[gap]'>
            {visible.map((o, i) => (
              <Avatar key={o.id} owner={o} className={cn(i > 0 && '-ml-1.5')} />
            ))}
            {overflow > 0 && (
              <span className='-ml-1.5 inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-slate-100 px-1 text-[9px] font-semibold text-slate-600 ring-2 ring-white dark:bg-muted dark:text-slate-300 dark:ring-card'>
                +{overflow}
              </span>
            )}
          </span>
          {owners.length === 1 && (
            <span className='ml-1.5 truncate text-[12px] text-slate-600 group-hover/owners:text-slate-800 dark:text-slate-300'>
              {owners[0].name}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className='w-[240px] p-1.5'
        align='start'
        onClick={(e) => e.stopPropagation()}
      >
        <p className='px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-muted-foreground'>
          {owners.length} owner{owners.length === 1 ? '' : 's'}
        </p>
        <div className='max-h-[260px] space-y-0.5 overflow-y-auto'>
          {owners.map((o) => (
            <div key={o.id} className='flex items-center gap-2 rounded px-2 py-1'>
              <Avatar owner={o} />
              <span className='truncate text-[12px] text-slate-700 dark:text-slate-200'>
                {o.name}
              </span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
