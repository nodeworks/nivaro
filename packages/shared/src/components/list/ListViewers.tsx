import { useListViewers, viewersSentence } from '../../lib/list-viewers'
import { cn } from '../../lib/utils'
import { UserAvatar } from '../UserAvatar'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''))
    .toUpperCase()
    .slice(0, 2)
}

/**
 * Small avatars of who else has this list / queue open — administrators only (the server
 * sends the names to administrators and nobody else; for everyone else this renders
 * nothing). Quiet: no toast, no movement of the toolbar beyond the stack appearing.
 */
export function ListViewers({
  kind,
  id,
  className
}: {
  kind: 'list' | 'queue'
  id: string | number | null | undefined
  className?: string
}) {
  const viewers = useListViewers(kind, id)
  if (viewers.length === 0) return null
  const shown = viewers.slice(0, 3)
  const sentence = viewersSentence(viewers)
  const tip = `${sentence}: ${viewers.map((v) => v.name).join(', ')}`
  return (
    <span
      data-list-viewers={viewers.length}
      data-tip={tip}
      aria-label={tip}
      role='img'
      className={cn(
        'nvr-fade-in inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full pl-1 pr-2 text-[11.5px] text-slate-500 dark:text-slate-400',
        className
      )}
    >
      <span className='flex -space-x-1.5'>
        {shown.map((v) => (
          <UserAvatar
            key={v.id}
            userId={v.id}
            alt=''
            className='h-6 w-6 rounded-full object-cover ring-2 ring-white dark:ring-background'
            fallback={
              <span className='inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-[9.5px] font-semibold text-slate-600 ring-2 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-background'>
                {initials(v.name)}
              </span>
            }
          />
        ))}
      </span>
      {viewers.length > shown.length && (
        <span className='font-medium tabular-nums'>+{viewers.length - shown.length}</span>
      )}
      <span className='hidden whitespace-nowrap xl:inline'>{sentence}</span>
    </span>
  )
}
