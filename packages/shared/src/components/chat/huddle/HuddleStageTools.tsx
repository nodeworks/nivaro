import { Hand, SmilePlus, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { cn } from '../../../lib/utils'
import { cameraStore } from './huddle-camera'
import {
  type FloatingReaction,
  HUDDLE_REACTIONS,
  handQueue,
  lowerAllHands,
  REACTION_LIFE_MS,
  raiseHand,
  reactionFeed
} from './huddle-reactions'
import type { HuddlePeer } from './huddle-store'

const tool =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40'
const idle =
  'text-slate-500 hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
const pressed = 'bg-nvr-cyan/15 text-slate-900 dark:text-slate-100'

/**
 * Reactions + raise hand in the stage row (#2857). The emoji open inline next
 * to their button (no popover to clip or portal), and stay open for a burst.
 */
export function HuddleStageTools({
  me,
  handAt,
  disabled,
  children
}: {
  me: { id: string } | null
  handAt: number | null
  disabled?: boolean
  /** Extra buttons at the end of the row (the pop-out). */
  children?: React.ReactNode
}) {
  const [picking, setPicking] = useState(false)
  useEffect(() => {
    if (!picking) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicking(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking])
  const raised = !!handAt
  return (
    <div className='ml-auto flex items-center gap-0.5' data-huddle-stage-tools>
      {picking && (
        <fieldset
          className='m-0 flex min-w-0 items-center gap-0.5 rounded-md border border-slate-200 bg-white px-0.5 dark:border-border dark:bg-card motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-1 motion-safe:duration-150'
          data-huddle-reactions
        >
          <legend className='sr-only'>Send a reaction</legend>
          {HUDDLE_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type='button'
              onClick={() => me && reactionFeed.send(emoji, me.id)}
              className='flex h-6 w-6 items-center justify-center rounded text-[14px] leading-none transition-transform hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan active:scale-90 dark:hover:bg-white/10'
              aria-label={`React ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </fieldset>
      )}
      <button
        type='button'
        onClick={() => setPicking((p) => !p)}
        disabled={disabled}
        className={cn(tool, picking ? pressed : idle)}
        aria-expanded={picking}
        aria-label={picking ? 'Close reactions' : 'React'}
        data-tip={picking ? undefined : 'React — everyone in the huddle sees it'}
      >
        {picking ? (
          <X className='h-3.5 w-3.5' strokeWidth={2} />
        ) : (
          <SmilePlus className='h-3.5 w-3.5' strokeWidth={2} />
        )}
      </button>
      <button
        type='button'
        onClick={() => raiseHand(!raised)}
        disabled={disabled}
        className={cn(tool, raised ? pressed : idle)}
        aria-pressed={raised}
        aria-label={raised ? 'Lower your hand' : 'Raise your hand'}
        data-tip={raised ? 'Lower hand' : 'Raise hand — you join the queue'}
        data-huddle-hand={raised ? 'up' : 'down'}
      >
        <Hand className='h-3.5 w-3.5' strokeWidth={2} />
      </button>
      {children}
    </div>
  )
}

/** Raised hands, in the order they went up. Anyone may lower them all. */
export function HuddleHands({ roster, self }: { roster: HuddlePeer[]; self: string | null }) {
  const queue = useMemo(() => handQueue(roster), [roster])
  if (!queue.length) return null
  return (
    <div
      className='mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300'
      data-huddle-hands
    >
      <Hand className='h-3 w-3 text-slate-500 dark:text-slate-400' strokeWidth={2} aria-hidden />
      <span className='font-medium'>Hands up</span>
      <ol className='m-0 flex list-none flex-wrap items-center gap-1 p-0'>
        {queue.map((p, i) => (
          <li
            key={p.socket}
            className='inline-flex h-5 items-center gap-1 rounded-full bg-white pl-1 pr-2 ring-1 ring-slate-200 dark:bg-card dark:ring-border'
          >
            <span className='flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-slate-100 px-1 text-[9.5px] font-semibold tabular-nums text-slate-600 dark:bg-muted dark:text-slate-300'>
              {i + 1}
            </span>
            <span className='max-w-[120px] truncate'>
              {p.socket === self ? 'You' : (p.name ?? 'Someone')}
            </span>
            {p.socket === self && (
              <button
                type='button'
                onClick={() => raiseHand(false)}
                className='-mr-1 flex h-4 w-4 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-white/10 dark:hover:text-slate-100'
                aria-label='Lower your hand'
              >
                <X className='h-2.5 w-2.5' strokeWidth={2.5} />
              </button>
            )}
          </li>
        ))}
      </ol>
      {queue.length > 0 && (
        <button
          type='button'
          onClick={() => lowerAllHands()}
          className='rounded px-1.5 py-0.5 font-medium text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
          data-huddle-lower-all
        >
          Lower all
        </button>
      )}
    </div>
  )
}

function Floating({ r, name }: { r: FloatingReaction; name: string }) {
  return (
    <span className='absolute bottom-1 -translate-x-1/2' style={{ left: `${r.lane * 100}%` }}>
      <span
        ref={(el) => {
          if (!el || el.dataset.started) return
          el.dataset.started = '1'
          const still =
            typeof window !== 'undefined' &&
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          el.animate?.(
            still
              ? [
                  { opacity: 0 },
                  { opacity: 1, offset: 0.1 },
                  { opacity: 1, offset: 0.7 },
                  { opacity: 0 }
                ]
              : [
                  { transform: 'translateY(0) scale(0.7)', opacity: 0 },
                  { transform: 'translateY(-14px) scale(1)', opacity: 1, offset: 0.12 },
                  { opacity: 1, offset: 0.6 },
                  { transform: 'translateY(-104px) scale(1)', opacity: 0 }
                ],
            {
              duration: REACTION_LIFE_MS,
              easing: still ? 'linear' : 'cubic-bezier(0.16, 1, 0.3, 1)',
              fill: 'forwards'
            }
          )
        }}
        className='flex flex-col items-center gap-0.5 opacity-0'
      >
        <span className='text-[22px] leading-none drop-shadow-sm'>{r.emoji}</span>
        <span className='max-w-[96px] truncate rounded bg-[#0f172a]/80 px-1 py-px text-[9.5px] font-medium text-white'>
          {name}
        </span>
      </span>
    </span>
  )
}

/** Reactions rising over the stage; pointer-transparent, so nothing under them is blocked. */
export function HuddleReactionLayer({
  roster,
  me
}: {
  roster: HuddlePeer[]
  me: { id: string } | null
}) {
  const items = useSyncExternalStore(reactionFeed.subscribe, reactionFeed.getSnapshot)
  if (!items.length) return null
  const nameOf = (user: string) =>
    user === me?.id ? 'You' : (roster.find((p) => p.user === user)?.name ?? 'Someone')
  return (
    <div
      className='pointer-events-none absolute inset-x-0 top-0 z-20 h-[calc(100%+96px)] overflow-hidden'
      aria-live='polite'
      data-huddle-reaction-layer
    >
      {items.map((r) => (
        <Floating key={r.id} r={r} name={nameOf(r.user)} />
      ))}
      <span className='sr-only'>
        {items.length
          ? `${nameOf(items[items.length - 1].user)} reacted ${items[items.length - 1].emoji}`
          : ''}
      </span>
    </div>
  )
}

/** A camera that could not start explains itself under the stage row. */
export function HuddleCameraNotice() {
  const cam = useSyncExternalStore(cameraStore.subscribe, cameraStore.getSnapshot)
  if (!cam.error) return null
  return (
    <div
      className='mt-1.5 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11.5px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
      role='alert'
    >
      <span className='min-w-0 flex-1'>{cam.error}</span>
      <button
        type='button'
        onClick={() => cameraStore.clearError()}
        className='flex h-5 w-5 items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-500/20'
        aria-label='Dismiss'
      >
        <X className='h-3 w-3' strokeWidth={2} />
      </button>
    </div>
  )
}
