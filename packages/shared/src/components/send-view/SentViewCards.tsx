import { ArrowUpRight, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { useLiveEvent } from '../../lib/live'
import {
  type NotificationRouteMap,
  resolveNotificationTargetFor,
  runNotificationTarget
} from '../../lib/notification-target'
import { type SentViewCard, senderLead } from '../../lib/send-view'
import { UserAvatar } from '../UserAvatar'

/**
 * The quiet card a colleague's "Send my view" becomes while this person has the app open
 * (api routes/send-view.ts). The socket only says `view:sent {id}`; the card is read through
 * GET /send-view/:id AS THIS PERSON, which also tells the server not to send a notification.
 * No sound, no toast — a small card in the corner until opened or dismissed. Several tabs:
 * Open or dismiss in one clears the rest (BroadcastChannel).
 *
 * Mount once per app, inside NivaroProvider + RealtimeContext, with the app's routes.
 */

const MAX_CARDS = 3
const CHANNEL = 'nvr-sent-views'

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean)
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? (p[p.length - 1][0] ?? '') : '')).toUpperCase()
}

export function SentViewCards({
  routes,
  onNavigate
}: {
  routes: NotificationRouteMap
  onNavigate: (path: string) => void
}) {
  const client = useNivaroClient()
  const [cards, setCards] = useState<SentViewCard[]>([])
  const channelRef = useRef<BroadcastChannel | null>(null)

  const drop = useCallback((id: string, tell = true) => {
    setCards((cs) => cs.filter((c) => c.id !== id))
    if (tell)
      try {
        channelRef.current?.postMessage({ dismiss: id })
      } catch {
        /* other tabs keep theirs */
      }
  }, [])

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const ch = new BroadcastChannel(CHANNEL)
    channelRef.current = ch
    ch.onmessage = (e) => {
      const id = (e.data as { dismiss?: unknown } | null)?.dismiss
      if (typeof id === 'string') drop(id, false)
    }
    return () => {
      ch.close()
      channelRef.current = null
    }
  }, [drop])

  useLiveEvent(
    'view:sent',
    (p: { id?: unknown }) => {
      const id = typeof p?.id === 'string' ? p.id : null
      if (!id) return
      client
        .request<{ data: SentViewCard }>(get(`/send-view/${encodeURIComponent(id)}`))
        .then((r) => {
          const card = r.data
          if (!card?.id) return
          setCards((cs) =>
            cs.some((c) => c.id === card.id) ? cs : [card, ...cs].slice(0, MAX_CARDS)
          )
        })
        .catch(() => {
          /* nothing to show — the server falls back to a notification */
        })
    },
    { includeOwn: true }
  )

  if (cards.length === 0) return null

  // "Later": the card goes, the view waits in their notifications instead.
  const later = (c: SentViewCard) => {
    drop(c.id)
    client.request(post(`/send-view/${encodeURIComponent(c.id)}/later`)).catch(() => {})
  }

  const open = (c: SentViewCard) => {
    const target = resolveNotificationTargetFor({ target: c.target }, routes)
    drop(c.id)
    runNotificationTarget(target, onNavigate)
  }

  return (
    <section
      aria-label='Views sent to you'
      className='pointer-events-none fixed bottom-20 right-4 z-[90] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2'
    >
      {cards.map((c) => (
        <div
          key={c.id}
          data-sent-view-card={c.id}
          className='nvr-rise-in pointer-events-auto flex gap-2.5 rounded-lg border border-slate-200 bg-white p-3 shadow-[0_6px_20px_-8px_rgba(15,23,42,0.25)] dark:border-border dark:bg-card dark:shadow-[0_6px_20px_-8px_rgba(0,0,0,0.6)]'
        >
          <UserAvatar
            userId={c.from.id}
            alt=''
            className='mt-0.5 h-7 w-7 shrink-0 rounded-full object-cover'
            fallback={
              <span className='mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10.5px] font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-200'>
                {initials(c.from.name)}
              </span>
            }
          />
          <div className='min-w-0 flex-1'>
            <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
              {senderLead(c.from.name)}
            </p>
            <p
              className='truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'
              title={c.title}
            >
              {c.title}
            </p>
            {c.summary && (
              <p
                className='truncate text-[12px] text-slate-600 dark:text-slate-300'
                title={c.summary}
              >
                {c.summary}
              </p>
            )}
            {c.note && (
              <p className='mt-1 line-clamp-2 text-[12px] italic text-slate-600 dark:text-slate-300'>
                “{c.note}”
              </p>
            )}
            <div className='mt-2 flex items-center gap-2'>
              <button
                type='button'
                onClick={() => open(c)}
                data-sent-view-open=''
                className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-semibold text-white hover:bg-nvr-cyan/90'
              >
                Open
                <ArrowUpRight className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                onClick={() => later(c)}
                data-tip='Keep it in your notifications'
                className='h-7 rounded-md px-2 text-[12px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-muted dark:hover:text-slate-200'
              >
                Later
              </button>
            </div>
          </div>
          <button
            type='button'
            aria-label='Dismiss'
            onClick={() => drop(c.id)}
            className='-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      ))}
    </section>
  )
}
