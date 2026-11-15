import { useItemEditAuth } from '../../context'
import { type ListViewer, useListViewers, viewersSentence } from '../../lib/list-viewers'
import { cn } from '../../lib/utils'
import { UserAvatar } from '../UserAvatar'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''))
    .toUpperCase()
    .slice(0, 2)
}

const SHOWN = 3
/** Room for three avatars and a "+N" disc — the inline slot never changes width. */
const INLINE_SLOT = 'w-[84px]'

/**
 * Small avatars of who else has this list / queue open — administrators only (the server
 * sends the names to administrators and nobody else; for everyone else this renders
 * nothing). Quiet: no toast, and it never moves anything:
 *
 *   variant 'header'  a page header row (admin list + queue pages): avatars and the sentence.
 *   variant 'inline'  inside a wrapping toolbar (hosts without a header row): avatars only,
 *                     in a fixed-width slot an administrator's toolbar always reserves, so
 *                     names arriving or leaving never push buttons onto another row. The
 *                     sentence and the names ride the tooltip.
 */
export function ListViewers({
  kind,
  id,
  variant = 'inline',
  selfId,
  className
}: {
  kind: 'list' | 'queue'
  id: string | number | null | undefined
  variant?: 'header' | 'inline'
  /** Who "me" is when the host sits outside an ItemEditAuthContext. */
  selfId?: string
  className?: string
}) {
  const { isAdmin } = useItemEditAuth()
  const viewers = useListViewers(kind, id, true, selfId)
  const inline = variant === 'inline'
  // Only an administrator's toolbar keeps the (empty) slot; everyone else gets nothing.
  if (viewers.length === 0)
    return inline && isAdmin ? (
      <span aria-hidden className={cn('h-8 shrink-0', INLINE_SLOT, className)} />
    ) : null
  const sentence = viewersSentence(viewers)
  const tip = `Viewing now: ${viewers.map((v) => v.name).join(', ')}`
  return (
    <span
      data-list-viewers={viewers.length}
      data-tip={tip}
      aria-label={tip}
      role='img'
      className={cn(
        'nvr-fade-in inline-flex shrink-0 items-center gap-2 text-[12px] text-slate-500 dark:text-slate-400',
        inline ? cn('h-8 justify-end', INLINE_SLOT) : 'h-7',
        className
      )}
    >
      <Stack viewers={viewers} ring={inline ? 'toolbar' : 'header'} />
      {!inline && <span className='hidden whitespace-nowrap md:inline'>{sentence}</span>}
    </span>
  )
}

/** Avatars that overlap a little (every initial stays readable) and a "+N" disc. */
function Stack({ viewers, ring }: { viewers: ListViewer[]; ring: 'toolbar' | 'header' }) {
  const shown = viewers.slice(0, SHOWN)
  const more = viewers.length - shown.length
  // The ring is the surface colour, so each disc reads as cut out of the one behind it.
  const ringCls =
    ring === 'header' ? 'ring-2 ring-white dark:ring-card' : 'ring-2 ring-white dark:ring-slate-900'
  const disc = cn('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full', ringCls)
  return (
    <span className='flex -space-x-0.5'>
      {shown.map((v) => (
        <UserAvatar
          key={v.id}
          userId={v.id}
          alt=''
          className={cn('h-6 w-6 shrink-0 rounded-full object-cover', ringCls)}
          fallback={
            <span
              className={cn(
                disc,
                'bg-slate-200 text-[9.5px] font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-100'
              )}
            >
              {initials(v.name)}
            </span>
          }
        />
      ))}
      {more > 0 && (
        <span
          className={cn(
            disc,
            'bg-slate-100 text-[9.5px] font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300'
          )}
        >
          +{more}
        </span>
      )}
    </span>
  )
}
