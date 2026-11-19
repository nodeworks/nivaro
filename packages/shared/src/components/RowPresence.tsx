import { useQueries } from '@tanstack/react-query'
import { useOptionalNivaroClient } from '../context'
import type { RowViewers } from '../lib/presence-hooks'
import { whoText } from '../lib/presence-signals'
import { type UserCardRow, userCardQuery } from '../lib/user-cards'
import { UserChip } from './item-edit/UserChip'
import { UserAvatar } from './UserAvatar'

/**
 * "Who has this row open" on a list row (#2486): up to three 16px avatar discs, overlapping,
 * then "+N" when more people are there; the names in the instant tooltip. People the viewer
 * may not see (the presence visibility rule) count but show no face — a neutral disc with
 * the number stands for them. Nothing renders when nobody else has the row open.
 *
 * Small on purpose: it sits in the row's 16px mark slot (next to the lock / new / unseen
 * marks) or inline after a label, and must never move the text beside it.
 *
 * Each face opens that person's user card (UserChip), like avatars everywhere else; clicks and
 * keys inside never reach the row (React events bubble through the card's portal).
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
    // biome-ignore lint/a11y/noStaticElementInteractions: an event fence; the face buttons inside are the controls
    <span
      {...{ [dataAttr]: String(viewers.count) }}
      data-tip={tip}
      className='inline-flex shrink-0 items-center transition-opacity duration-150'
      style={{ height: size }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {shown.map((id, i) => {
        const card = cards[i]?.data
        const name = card
          ? [card.first_name, card.last_name].filter(Boolean).join(' ') || card.email
          : null
        return (
          <UserChip key={id} userId={id}>
            <button
              type='button'
              aria-label={name ? `${name} — open their card` : 'Open their card'}
              className={`${disc} relative cursor-pointer hover:z-10 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan`}
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
                fallback={<span aria-hidden>{initialsOf(card)}</span>}
                className='rounded-full object-cover'
                style={{ width: size, height: size }}
                alt=''
              />
            </button>
          </UserChip>
        )
      })}
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
