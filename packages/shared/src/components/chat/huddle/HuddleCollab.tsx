import { NotebookPen, Presentation, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { defaultItemUrl, useNavigation } from '../../../context'
import { useOptionalRealtime } from '../../../lib/realtime'
import { cn } from '../../../lib/utils'
import { useChatConfig } from '../chat-core'
import { useRoomRecord } from '../chat-hooks'
import { FormattedMessage } from '../MessageFormat'
import {
  attachHuddleCollab,
  huddleFollow,
  huddleNotes,
  NOTE_MAX_BYTES,
  noteBytes
} from './huddle-collab-store'
import { huddleStore } from './huddle-store'
import type { HuddleHandle } from './useHuddle'

/**
 * Working together in a huddle (#2854 #2855): the Notes and Follow me buttons
 * in the huddle strip, the shared note under it, and the floating chip that
 * tells a follower whom they follow (and a presenter that someone asks to
 * take over). The stores (huddle-collab-store.ts) hold all state; these are
 * views over them.
 */

const stripButton =
  'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40'
const stripIdle =
  'text-slate-600 hover:bg-slate-200/70 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-slate-100'
const stripOn = 'bg-nvr-cyan/15 text-slate-900 dark:text-slate-100'

function useNotes() {
  return useSyncExternalStore(huddleNotes.subscribe, huddleNotes.getSnapshot)
}
function useFollow() {
  return useSyncExternalStore(huddleFollow.subscribe, huddleFollow.getSnapshot)
}

/** A record's room ('ord:ORD-1'), not a channel, General or a DM. */
function isRecordRoom(room: string, globalRoom: string): boolean {
  return (
    !room.startsWith('dm:') && !room.startsWith('ch:') && room !== globalRoom && room.includes(':')
  )
}

function personName(name: string | null | undefined): string {
  return name?.trim() || 'Someone'
}

/** Notes + Follow me, at the end of the huddle strip's people row. */
export function HuddleCollabActions({ room, huddle }: { room: string; huddle: HuddleHandle }) {
  const realtime = useOptionalRealtime()
  useEffect(() => attachHuddleCollab(realtime), [realtime])
  const cfg = useChatConfig()
  const notes = useNotes()
  const follow = useFollow()
  const recordRoom = isRecordRoom(room, cfg.globalRoom)
  const record = useRoomRecord(room, recordRoom && huddle.inThis)
  const live = huddle.state.status === 'live' && notes.room === room
  if (!live) return null

  const other = follow.presenter && !follow.presenting
  return (
    <span className='ml-auto inline-flex items-center gap-0.5' data-huddle-collab>
      <button
        type='button'
        onClick={() => huddleNotes.setOpen(!notes.open)}
        className={cn(stripButton, notes.open ? stripOn : stripIdle, 'relative')}
        aria-expanded={notes.open}
        aria-controls='nvr-huddle-notes'
        data-tip={
          notes.open ? 'Hide the notes' : 'Shared notes — posted to the room when the huddle ends'
        }
        data-huddle-notes-toggle
      >
        <NotebookPen className='h-3.5 w-3.5' strokeWidth={2} />
        Notes
        {notes.unseen && <span className='sr-only'>(changed)</span>}
        {notes.unseen && (
          <span
            className='absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-nvr-cyan'
            aria-hidden
          />
        )}
      </button>
      {recordRoom && (
        <>
          {follow.presenting ? (
            <button
              type='button'
              onClick={() => huddleFollow.stopPresenting()}
              className={cn(stripButton, stripOn)}
              data-tip='Stop presenting — everyone keeps the page they are on'
              data-huddle-follow='presenting'
            >
              <Presentation className='h-3.5 w-3.5' strokeWidth={2} />
              Presenting
              <X className='h-3 w-3 opacity-70' strokeWidth={2} aria-hidden />
            </button>
          ) : other ? (
            <button
              type='button'
              onClick={() => huddleFollow.start(record)}
              disabled={follow.asked === 'pending'}
              className={cn(stripButton, stripIdle)}
              data-tip={`${personName(follow.presenter?.name)} is presenting — ask to take over`}
              data-huddle-follow='ask'
            >
              <Presentation className='h-3.5 w-3.5' strokeWidth={2} />
              {follow.asked === 'pending' ? 'Asked…' : 'Ask to present'}
            </button>
          ) : (
            <button
              type='button'
              onClick={() => huddleFollow.start(record)}
              disabled={!record}
              className={cn(stripButton, stripIdle)}
              data-tip={
                record
                  ? 'Everyone in the huddle follows your tab and section on this record'
                  : 'Opening the record…'
              }
              data-huddle-follow='start'
            >
              <Presentation className='h-3.5 w-3.5' strokeWidth={2} />
              Follow me
            </button>
          )}
        </>
      )}
    </span>
  )
}

/** The shared note, under the strip while open (#2854). */
export function HuddleNotesPanel({ room }: { room: string }) {
  const notes = useNotes()
  const cfg = useChatConfig()
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const ref = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  const [, tick] = useState(0)
  useEffect(() => {
    if (!notes.open || !notes.lastAt) return
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [notes.open, notes.lastAt])
  useEffect(() => {
    if (notes.open && mode === 'write') ref.current?.focus({ preventScroll: true })
  }, [notes.open, mode])
  const bytes = useMemo(() => noteBytes(notes.text), [notes.text])
  if (!notes.open || notes.room !== room) return null

  const near = bytes > NOTE_MAX_BYTES * 0.8
  const status = notes.pending
    ? 'Saving…'
    : notes.lastBy?.name
      ? `${personName(notes.lastBy.name)} edited ${ago(notes.lastAt)}`
      : notes.lastAt
        ? 'Shared with the huddle'
        : null

  return (
    <section
      id='nvr-huddle-notes'
      aria-label='Huddle notes'
      className='mt-1.5 rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150'
      data-huddle-notes
    >
      <div className='flex items-center gap-1 border-b border-slate-200 px-1.5 py-1 dark:border-border'>
        {(['write', 'preview'] as const).map((m) => (
          <button
            key={m}
            type='button'
            onClick={() => setMode(m)}
            className={cn(
              'h-6 rounded px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
              mode === m
                ? 'bg-slate-100 text-slate-900 dark:bg-muted dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
            )}
            aria-pressed={mode === m}
          >
            {m === 'write' ? 'Write' : 'Preview'}
          </button>
        ))}
        <span
          className='ml-auto min-w-0 truncate pr-1 text-[11px] text-slate-500 dark:text-slate-400'
          aria-live='polite'
        >
          {status}
        </span>
        {near && (
          <span
            className={cn(
              'shrink-0 pr-1 text-[11px] tabular-nums',
              bytes > NOTE_MAX_BYTES
                ? 'text-red-600 dark:text-red-300'
                : 'text-amber-700 dark:text-amber-300'
            )}
          >
            {(bytes / 1024).toFixed(1)} / 20 KB
          </span>
        )}
      </div>
      {mode === 'write' ? (
        <textarea
          ref={ref}
          value={notes.text}
          onChange={(e) => huddleNotes.setText(e.target.value)}
          onKeyDown={(e) => {
            // The room's composer owns Escape elsewhere; here it only leaves the note.
            if (e.key === 'Escape') e.currentTarget.blur()
          }}
          rows={5}
          placeholder={
            'Decisions, owners, next steps…\n**bold**, _italic_, - lists and `code` work.'
          }
          className='block max-h-[260px] min-h-[96px] w-full resize-y bg-transparent px-2.5 py-2 text-[12.5px] leading-relaxed text-slate-800 outline-none placeholder:text-slate-500 dark:text-slate-100 dark:placeholder:text-slate-400'
          aria-describedby={hintId}
          aria-invalid={!!notes.error}
          data-huddle-notes-input
        />
      ) : (
        <div className='max-h-[260px] min-h-[96px] overflow-y-auto px-2.5 py-2 text-[12.5px] leading-relaxed text-slate-800 dark:text-slate-100'>
          {notes.text.trim() ? (
            <FormattedMessage
              text={notes.text}
              mine={false}
              entityPattern={cfg.entityPattern}
              renderToken={(t, key) => <span key={key}>{t.text}</span>}
            />
          ) : (
            <span className='text-slate-500 dark:text-slate-400'>Nothing written yet.</span>
          )}
        </div>
      )}
      <p
        id={hintId}
        className={cn(
          'border-t border-slate-200 px-2.5 py-1 text-[11px] dark:border-border',
          notes.error ? 'text-red-600 dark:text-red-300' : 'text-slate-500 dark:text-slate-400'
        )}
        role={notes.error ? 'alert' : undefined}
      >
        {notes.error ??
          'Everyone in the huddle can edit. When the huddle ends the notes are posted to this room.'}
      </p>
    </section>
  )
}

function ago(at: number | null): string {
  if (!at) return ''
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

// ── The host: navigation for followers + the floating chip ──────────────────

let claims: number[] = []
let nextClaim = 1
const claimListeners = new Set<() => void>()
function claimHost(): () => void {
  const id = nextClaim++
  claims = [...claims, id]
  for (const l of claimListeners) l()
  const release = () => {
    claims = claims.filter((c) => c !== id)
    for (const l of claimListeners) l()
  }
  return Object.assign(release, { id })
}

/**
 * Mounted once by ChatPanel (which every host keeps mounted): gives the follow
 * store the host's navigation and shows the Following / Presenting chip over
 * whatever page is open. A second ChatPanel in the same app yields to the
 * first, so a page never navigates twice or shows two chips.
 */
export function HuddleFollowHost() {
  const realtime = useOptionalRealtime()
  const nav = useNavigation()
  const [claim, setClaim] = useState<number | null>(null)
  const primary = useSyncExternalStore(
    (l) => {
      claimListeners.add(l)
      return () => {
        claimListeners.delete(l)
      }
    },
    () => claim !== null && claims[0] === claim,
    () => false
  )

  useEffect(() => {
    const release = claimHost() as (() => void) & { id: number }
    setClaim(release.id)
    return release
  }, [])
  useEffect(() => attachHuddleCollab(realtime), [realtime])
  // #2854 — the room refused the notes' writer: offer a copy instead of losing them.
  useEffect(() => {
    if (!primary) return
    return huddleNotes.onUnpostedNote(({ room, reason }) => {
      toast.warning('Huddle notes were not posted', {
        description: `${reason[0]?.toUpperCase() ?? ''}${reason.slice(1)}. Copy them before they expire.`,
        duration: 30_000,
        action: {
          label: 'Copy notes',
          onClick: () => {
            const text = huddleNotes.endedNote(room)
            if (!text) return void toast.error('The notes are no longer available.')
            void navigator.clipboard
              ?.writeText(text)
              .then(() => toast.success('Notes copied'))
              .catch(() => toast.error('Could not copy the notes.'))
          }
        }
      })
    })
  }, [primary])
  // Latest navigation, read at the moment the store navigates.
  const navRef = useRef(nav)
  navRef.current = nav
  useEffect(() => {
    if (!primary) return
    huddleFollow.setNavigator({
      navigate: (path) => navRef.current.navigate(path),
      urlFor: (t) => (navRef.current.itemUrl ?? defaultItemUrl)(t)
    })
    return () => huddleFollow.setNavigator(null)
  }, [primary])

  if (!primary || typeof document === 'undefined') return null
  return createPortal(<FollowChip />, document.body)
}

function FollowChip() {
  const follow = useFollow()
  const huddle = useSyncExternalStore(huddleStore.subscribe, huddleStore.getSnapshot)
  if (!follow.room || huddle.status !== 'live' || huddle.room !== follow.room) return null

  let body: React.ReactNode = null
  if (follow.error) {
    body = (
      <>
        <span className='min-w-0 truncate text-red-700 dark:text-red-200'>{follow.error}</span>
        <ChipButton onClick={() => huddleFollow.clearError()} aria-label='Dismiss'>
          <X className='h-3.5 w-3.5' strokeWidth={2} />
        </ChipButton>
      </>
    )
  } else if (follow.presenting && follow.request) {
    const req = follow.request
    body = (
      <>
        <span className='min-w-0 truncate'>
          <span className='font-medium'>{personName(req.name)}</span> asks to present
        </span>
        <ChipButton onClick={() => huddleFollow.handOver(req.socket)} primary data-huddle-handover>
          Hand over
        </ChipButton>
        <ChipButton onClick={() => huddleFollow.decline(req.socket)} data-huddle-keep>
          Keep presenting
        </ChipButton>
      </>
    )
  } else if (follow.presenting) {
    body = (
      <>
        <LiveDot />
        <span className='min-w-0 truncate'>You are presenting — the huddle follows your page</span>
        <ChipButton onClick={() => huddleFollow.stopPresenting()} data-huddle-stop-presenting>
          Stop
        </ChipButton>
      </>
    )
  } else if (follow.presenter && follow.following) {
    body = (
      <>
        <LiveDot />
        <span className='min-w-0 truncate'>
          {follow.asked === 'declined' ? (
            <>
              <span className='font-medium'>{personName(follow.presenter.name)}</span> is still
              presenting
            </>
          ) : (
            <>
              Following <span className='font-medium'>{personName(follow.presenter.name)}</span>
            </>
          )}
        </span>
        <ChipButton onClick={() => huddleFollow.stopFollowing()} data-huddle-stop-following>
          Stop
        </ChipButton>
      </>
    )
  } else if (follow.presenter) {
    body = (
      <>
        <span className='min-w-0 truncate text-slate-600 dark:text-slate-300'>
          <span className='font-medium text-slate-800 dark:text-slate-100'>
            {personName(follow.presenter.name)}
          </span>{' '}
          is presenting
        </span>
        <ChipButton onClick={() => huddleFollow.resume()} data-huddle-resume>
          Follow
        </ChipButton>
      </>
    )
  }
  if (!body) return null
  return (
    // Rendered inside ChatPanel's backdrop in the React tree: clicks must not close the panel.
    // biome-ignore lint/a11y/noStaticElementInteractions: stops bubbling only
    // biome-ignore lint/a11y/useKeyWithClickEvents: stops bubbling only
    <div
      role='status'
      onClick={(e) => e.stopPropagation()}
      className='fixed bottom-5 left-1/2 z-50 flex h-9 max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2 rounded-full border border-slate-200 bg-white pl-3 pr-1 text-[12px] text-slate-800 shadow-[0_4px_16px_rgba(0,0,0,0.10),0_1px_4px_rgba(0,0,0,0.06)] dark:border-border dark:bg-card dark:text-slate-100 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200'
      data-huddle-follow-chip
      data-nvr-dock-aware
    >
      {body}
    </div>
  )
}

function LiveDot() {
  return (
    <span className='relative flex h-2 w-2 shrink-0' aria-hidden>
      <span className='absolute inline-flex h-full w-full rounded-full bg-nvr-cyan opacity-60 motion-safe:animate-ping' />
      <span className='relative inline-flex h-2 w-2 rounded-full bg-nvr-cyan' />
    </span>
  )
}

function ChipButton({
  primary,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type='button'
      {...rest}
      className={cn(
        'inline-flex h-7 shrink-0 items-center justify-center rounded-full px-2.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
        primary
          ? 'bg-nvr-cyan text-white hover:brightness-95'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-slate-100',
        className
      )}
    />
  )
}
