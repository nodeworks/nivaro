import { useQueries } from '@tanstack/react-query'
import { useOptionalNivaroClient } from '../context'
import type { RowViewers } from '../lib/presence-hooks'
import { whoText } from '../lib/presence-signals'
import { type UserCardRow, userCardQuery } from '../lib/user-cards'
import { UserAvatar } from './UserAvatar'

/**
 * "Who has this row open" on a list row (#2486): up to three 16px avatar discs, overlapping,
 * then "+N" when more people are there; the names in the instant tooltip. People the viewer
 * may not see (the presence visibility rule) count but show no face — a neutral disc with
 * the number stands for them. Nothing renders when nobody else has the row open.
 *
 * Small on purpose: it sits in the row's 16px mark slot (next to the lock / new / unseen
 * marks) or inline after a label, and must never move the text beside it.
 */
export function RowPresence({
  viewers,
  size = 16,
  dataAttr = 'data-row-presence',
  max = 3
}: {
  viewers: RowViewers | null | undefined
  size?: number
  dataAttr?: string
  max?: number
}) {
  const client = useOptionalNivaroClient()
  const ids = viewers?.ids ?? []
  const shown = ids.slice(0, max)
  const cards = useQueries({
    queries: shown.map((id) => ({
      ...userCardQuery<UserCardRow>(client, id),
      staleTime: 5 * 60_000,
      enabled: !!client
    }))
  })
  if (!viewers || viewers.count <= 0) return null
  const names = cards
    .map((c) => c.data)
    .filter((c): c is UserCardRow => !!c)
    .map((c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email)
  const unnamed = viewers.count - names.length
  const who = whoText(names)
  const tip = who
    ? `${who}${unnamed > 0 ? ` and ${unnamed} other${unnamed === 1 ? '' : 's'}` : ''} ${
        viewers.count === 1 ? 'has' : 'have'
      } this open`
    : `${viewers.count} ${viewers.count === 1 ? 'person has' : 'people have'} this open`
  const extra = viewers.count - shown.length
  const disc = `inline-flex items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-700 ring-2 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-card`
  return (
    <span
      {...{ [dataAttr]: String(viewers.count) }}
      data-tip={tip}
      role='img'
      aria-label={tip}
      className='inline-flex shrink-0 cursor-default items-center transition-opacity duration-150'
      style={{ height: size }}
    >
      {shown.map((id, i) => (
        <span
          key={id}
          className={disc}
          style={{
            width: size,
            height: size,
            fontSize: Math.round(size * 0.42),
            marginLeft: i === 0 ? 0 : -Math.round(size * 0.3),
            zIndex: shown.length - i
          }}
        >
          <UserAvatar
            userId={id}
            fallback={<span aria-hidden>{initialsOf(cards[i]?.data)}</span>}
            className='rounded-full object-cover'
            style={{ width: size, height: size }}
            alt=''
          />
        </span>
      ))}
      {extra > 0 && (
        <span
          className={disc}
          style={{
            minWidth: size,
            height: size,
            padding: '0 3px',
            fontSize: Math.round(size * 0.42),
            marginLeft: shown.length ? -Math.round(size * 0.3) : 0
          }}
        >
          +{extra}
        </span>
      )}
    </span>
  )
}

function initialsOf(card: UserCardRow | null | undefined): string {
  if (!card) return '·'
  const parts = [card.first_name, card.last_name].filter(Boolean) as string[]
  if (parts.length === 0) return (card.email?.[0] ?? '·').toUpperCase()
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}
