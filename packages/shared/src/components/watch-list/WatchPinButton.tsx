import { Pin, PinOff } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { useLiveRecord } from '../../lib/live'
import { pinKeyOf, typingTarget, useWatchActions } from '../../lib/watch-list'
import { WatchShareMenu } from './WatchExtras'

/**
 * Pin a record to the watch list (rt5 #1) — beside a record's title, in the record sheet's
 * strip. Filled when pinned. With `shortcut`, W on the page pins / unpins it (the newest
 * mounted record wins, so a sheet over a record page answers for the sheet).
 *
 * Looking at a pinned record IS seeing it: its "changed" mark clears while it is open.
 */

type Handler = () => void
const stack: Handler[] = []
let listening = false
function onKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
  if (e.key !== 'w' && e.key !== 'W') return
  if (typingTarget(e.target)) return
  const top = stack[stack.length - 1]
  if (!top) return
  e.preventDefault()
  top()
}
function pushShortcut(fn: Handler): () => void {
  stack.push(fn)
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('keydown', onKey)
    listening = true
  }
  return () => {
    const i = stack.lastIndexOf(fn)
    if (i >= 0) stack.splice(i, 1)
    if (stack.length === 0 && listening) {
      window.removeEventListener('keydown', onKey)
      listening = false
    }
  }
}

export function WatchPinButton({
  collection,
  itemId,
  shortcut = false,
  size = 'md',
  className = ''
}: {
  collection: string
  itemId: string | number | null | undefined
  shortcut?: boolean
  size?: 'sm' | 'md'
  className?: string
}) {
  const client = useOptionalNivaroClient()
  const actions = useWatchActions()
  const id = itemId == null || itemId === '' || itemId === 'new' ? null : String(itemId)
  const pinned = id ? actions.isPinned(collection, id) : false
  const ref = useRef(actions)
  ref.current = actions

  useEffect(() => {
    if (!shortcut || !id) return
    return pushShortcut(() => void ref.current.toggle(collection, id).catch(() => {}))
  }, [shortcut, collection, id])

  // Open = seen: the mark clears on arrival and again after a live change while it is open.
  const key = id ? pinKeyOf(collection, id) : ''
  useEffect(() => {
    if (pinned && key) ref.current.markSeen([key])
  }, [pinned, key])
  useLiveRecord(pinned ? collection : null, id, () => ref.current.markSeen([key]), {
    debounceMs: 2000
  })

  if (!client || !id) return null
  const label = pinned ? 'Remove from your watch list' : 'Add to your watch list'
  const full = !pinned && actions.full
  const icon = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'
  const pinButton = (
    <button
      type='button'
      aria-pressed={pinned}
      aria-label={label}
      data-tip={
        full
          ? 'Your watch list is full. Unpin a record to add this one.'
          : `${label}${shortcut ? ' (W)' : ''}`
      }
      data-watch-pin={pinned ? 'on' : 'off'}
      disabled={full}
      onClick={(e) => {
        e.stopPropagation()
        void actions.toggle(collection, id).catch(() => {})
      }}
      className={`group/pin inline-flex shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:cursor-not-allowed disabled:opacity-40 ${
        size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'
      } ${
        pinned
          ? 'text-nvr-cyan hover:bg-nvr-cyan/10'
          : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-slate-300'
      } ${className}`}
    >
      {pinned ? (
        <>
          <Pin className={`${icon} fill-current group-hover/pin:hidden`} />
          <PinOff className={`${icon} hidden group-hover/pin:block`} />
        </>
      ) : (
        <Pin className={icon} />
      )}
    </button>
  )
  // People on a shared list also get "put it on a shared list" beside the pin (rt6 #1).
  const shared = actions.prefs.teams.some((t) => (t.is_member || t.can_manage) && !t.owner_gone)
  if (!shared) return pinButton
  return (
    <span className='inline-flex shrink-0 items-center'>
      {pinButton}
      <WatchShareMenu actions={actions} collection={collection} itemId={id} size={size} />
    </span>
  )
}
