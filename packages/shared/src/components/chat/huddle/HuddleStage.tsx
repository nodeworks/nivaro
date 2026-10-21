import { Headphones, Maximize2, MicOff, ScreenShare, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'
import { formatElapsed, type LivePeer } from './huddle-store'
import type { HuddleHandle } from './useHuddle'

/** A live MediaStream in a <video>; muted because audio plays through the store's own elements. */
function ScreenView({
  stream,
  label,
  mirror
}: {
  stream: MediaStream
  label: string
  /** My own share: a quiet preview, not a second copy at full size. */
  mirror?: boolean
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = stream
    void el.play().catch(() => null)
    return () => {
      el.srcObject = null
    }
  }, [stream])
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-lg bg-[#0f172a]',
        mirror ? 'max-h-[120px]' : 'max-h-[280px]'
      )}
      data-huddle-screen={mirror ? 'mine' : 'peer'}
    >
      <video ref={ref} muted playsInline className='mx-auto block max-h-[inherit] w-auto' />
      <span className='absolute bottom-1.5 left-2 rounded bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white'>
        {label}
      </span>
      {!mirror && (
        <button
          type='button'
          onClick={() => void ref.current?.requestFullscreen?.()}
          className='absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded bg-black/55 text-white opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan group-hover:opacity-100'
          aria-label='View the shared screen full size'
          data-tip='Full screen'
        >
          <Maximize2 className='h-3.5 w-3.5' strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

function Elapsed({ since }: { since: number | null }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  if (!since) return null
  return (
    <span className='tabular-nums text-slate-500 dark:text-slate-400' data-huddle-elapsed>
      {formatElapsed(Date.now() - since)}
    </span>
  )
}

function Person({
  id,
  name,
  muted,
  screen,
  connection,
  renderAvatar
}: {
  id: string
  name: string | null
  muted: boolean
  screen: boolean
  connection?: LivePeer['connection']
  renderAvatar: (id: string, name: string | null) => React.ReactNode
}) {
  const connecting = connection === 'new' || connection === 'connecting'
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full bg-slate-100 pl-0.5 pr-2 text-[11px] text-slate-700 dark:bg-muted dark:text-slate-200',
        connecting && 'opacity-60',
        connection === 'failed' && 'text-red-600 dark:text-red-300'
      )}
      data-tip={
        connection === 'failed'
          ? `${name ?? 'Someone'} — connection failed`
          : connecting
            ? `${name ?? 'Someone'} — connecting`
            : undefined
      }
      data-huddle-person={id}
    >
      <span style={{ lineHeight: 0 }}>{renderAvatar(id, name)}</span>
      <span className='max-w-[120px] truncate'>{name ?? 'Someone'}</span>
      {muted && <MicOff className='h-3 w-3 text-slate-400' strokeWidth={2} aria-label='muted' />}
      {screen && (
        <ScreenShare className='h-3 w-3 text-nvr-cyan' strokeWidth={2} aria-label='sharing' />
      )}
    </span>
  )
}

/**
 * The strip under a room header while I am in its huddle (#2457): who is here,
 * how long, and whoever's screen is being shared. Also where a failed join
 * explains itself. Nothing renders in rooms I am not talking in — the header
 * pill already says who is.
 */
export function HuddleStage({
  room,
  me,
  huddle,
  renderAvatar
}: {
  room: string
  me: { id: string; name: string } | null
  huddle: HuddleHandle
  renderAvatar: (id: string, name: string | null) => React.ReactNode
}) {
  const { state, inThis } = huddle
  if (state.status === 'error' && (state.room === room || !state.room)) {
    return (
      <div
        className='flex items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 text-[11.5px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
        role='alert'
        data-huddle-error
      >
        <span className='min-w-0 flex-1'>{state.error}</span>
        <button
          type='button'
          onClick={huddle.clearError}
          className='flex h-5 w-5 items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-500/20'
          aria-label='Dismiss'
        >
          <X className='h-3 w-3' strokeWidth={2} />
        </button>
      </div>
    )
  }
  if (!inThis) return null
  const sharedByPeer = state.peers.find((p) => p.video)
  const joining = state.status === 'joining'
  return (
    <div
      className='shrink-0 border-b border-slate-200 bg-slate-50 px-3 py-1.5 dark:border-border dark:bg-background motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200'
      data-huddle-stage
      data-huddle-mode={state.mode}
    >
      <div className='flex flex-wrap items-center gap-1.5 text-[11px]'>
        <span className='inline-flex items-center gap-1 font-medium text-slate-700 dark:text-slate-200'>
          <Headphones className='h-3.5 w-3.5 text-nvr-cyan' strokeWidth={2} />
          {joining ? 'Connecting…' : 'Huddle'}
        </span>
        {!joining && <Elapsed since={state.startedAt} />}
        <span className='mx-0.5 h-3 w-px bg-slate-200 dark:bg-border' aria-hidden />
        {me && (
          <Person
            id={me.id}
            name={me.name}
            muted={state.muted}
            screen={state.sharing}
            renderAvatar={renderAvatar}
          />
        )}
        {state.peers.map((p) => (
          <Person
            key={p.socket}
            id={p.user}
            name={p.name}
            muted={p.muted}
            screen={p.screen}
            connection={p.connection}
            renderAvatar={renderAvatar}
          />
        ))}
        {!joining && state.peers.length === 0 && (
          <span className='text-slate-500 dark:text-slate-400'>
            Only you so far — people in the room see a Join button.
          </span>
        )}
      </div>
      {sharedByPeer?.video && (
        <div className='mt-1.5'>
          <ScreenView
            stream={sharedByPeer.video}
            label={`${sharedByPeer.name ?? 'Someone'}'s screen`}
          />
        </div>
      )}
      {state.sharing && state.localScreen && (
        <div className='mt-1.5'>
          <ScreenView stream={state.localScreen} label='You are sharing your screen' mirror />
        </div>
      )}
    </div>
  )
}
