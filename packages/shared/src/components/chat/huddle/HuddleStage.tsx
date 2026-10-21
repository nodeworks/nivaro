import {
  BellOff,
  CircleAlert,
  Maximize2,
  MicOff,
  PhoneOutgoing,
  ScreenShare,
  X
} from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { cn } from '../../../lib/utils'
import { MutedTalkingHint, PoorConnectionBanner, QualityBars, SpeakingRing } from './HuddleAudioUi'
import { HuddleCallBar } from './HuddleCallBar'
import { HuddleVideoGrid } from './HuddleCamera'
import { HuddleNotesPanel } from './HuddleCollab'
import { HuddleDrawOverlay } from './HuddleDraw'
import { HuddleCameraNotice, HuddleHands, HuddleReactionLayer } from './HuddleStageTools'
import type { PeerQuality } from './huddle-audio-logic'
import { huddleCalls, type RingingPerson } from './huddle-calls'
import { getHeldSnapshot, subscribeHeld } from './huddle-hold'
import { HuddlePipOffer, useHuddlePip } from './huddle-pip'
import type { LivePeer } from './huddle-store'
import type { HuddleHandle } from './useHuddle'
import { useHuddleQuality, useHuddleSpeaking } from './useHuddleAudio'

const NO_RINGING: RingingPerson[] = []

/** Someone I rang (#2843/#2844): ringing, or how they answered (fades after a moment). */
function Ringing({ p, onCancel }: { p: RingingPerson; onCancel: () => void }) {
  const text =
    p.state === 'ringing'
      ? `Ringing ${p.name ?? 'someone'}…`
      : p.state === 'accepted'
        ? `${p.name ?? 'Someone'} is joining`
        : p.state === 'declined'
          ? `${p.name ?? 'Someone'} declined`
          : `No answer from ${p.name ?? 'someone'}`
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full border border-dashed px-2 text-[11px]',
        p.state === 'ringing'
          ? 'border-nvr-cyan/60 text-slate-700 dark:text-slate-200'
          : 'border-slate-300 text-slate-500 dark:border-border dark:text-slate-400'
      )}
      data-huddle-ringing={p.id}
      data-state={p.state}
    >
      {p.state === 'ringing' && (
        <PhoneOutgoing
          className='h-3 w-3 text-nvr-cyan motion-safe:animate-pulse'
          strokeWidth={2}
        />
      )}
      {text}
      {p.state === 'ringing' && (
        <button
          type='button'
          onClick={onCancel}
          className='ml-0.5 grid h-4 w-4 place-items-center rounded-full text-slate-500 hover:bg-slate-200 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-white/10 dark:hover:text-slate-100'
          aria-label='Stop ringing'
          data-tip='Stop ringing'
        >
          <X className='h-3 w-3' strokeWidth={2} />
        </button>
      )}
    </span>
  )
}

/** #2852 — notifications held while I talk; released as one summary when I leave. */
function HeldChip() {
  const n = useSyncExternalStore(subscribeHeld, getHeldSnapshot, () => 0)
  if (!n) return null
  return (
    <span
      className='inline-flex h-6 items-center gap-1 rounded-full bg-slate-200/70 px-2 text-[11px] text-slate-600 dark:bg-white/10 dark:text-slate-300'
      data-tip={`${n} held until you leave — the inbox already has ${n === 1 ? 'it' : 'them'}`}
      data-huddle-held={n}
    >
      <BellOff className='h-3 w-3' strokeWidth={2} />
      {n} held
    </span>
  )
}

/** A live MediaStream in a <video>; muted because audio plays through the store's own elements. */
function ScreenView({
  stream,
  label,
  mirror,
  screen
}: {
  stream: MediaStream
  label: string
  /** My own share: a quiet preview, not a second copy at full size. */
  mirror?: boolean
  /** #2856 — the sharer's socket id: marks drawn on this screen show over it. */
  screen?: string | null
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const box = useRef<HTMLDivElement>(null)
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
      ref={box}
      className={cn(
        'group relative overflow-hidden rounded-lg bg-[#0f172a] [&:fullscreen]:flex [&:fullscreen]:max-h-none [&:fullscreen]:items-center [&:fullscreen]:rounded-none',
        mirror ? 'max-h-[120px]' : 'max-h-[280px]'
      )}
      data-huddle-screen={mirror ? 'mine' : 'peer'}
    >
      <video
        ref={ref}
        muted
        playsInline
        className='mx-auto block max-h-[inherit] w-auto max-w-full [:fullscreen>&]:h-full [:fullscreen>&]:max-h-full'
      />
      {screen && <HuddleDrawOverlay screen={screen} videoRef={ref} presenter={mirror} />}
      <span className='absolute bottom-1.5 left-2 rounded bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white'>
        {label}
      </span>
      {!mirror && (
        <button
          type='button'
          onClick={() => void (box.current ?? ref.current)?.requestFullscreen?.()}
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

function Person({
  id,
  name,
  muted,
  screen,
  connection,
  speaking = false,
  quality,
  renderAvatar
}: {
  id: string
  name: string | null
  muted: boolean
  screen: boolean
  connection?: LivePeer['connection']
  /** #2845 */
  speaking?: boolean
  /** #2848 — peers only; absent for me. */
  quality?: PeerQuality | null
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
      <SpeakingRing speaking={speaking && !muted}>{renderAvatar(id, name)}</SpeakingRing>
      <span className='max-w-[120px] truncate'>{name ?? 'Someone'}</span>
      {connection === 'connected' && quality !== null && (
        <QualityBars name={name ?? 'Someone'} quality={quality} />
      )}
      {muted && <MicOff className='h-3 w-3 text-slate-400' strokeWidth={2} aria-label='muted' />}
      {screen && (
        <ScreenShare className='h-3 w-3 text-nvr-cyan' strokeWidth={2} aria-label='sharing' />
      )}
    </span>
  )
}

/**
 * The strip under a room header while I am in its huddle (#2457): the call bar
 * (every control), who is here, and whoever's screen or camera is on. Also where a failed join
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
  // #2845 speaking + order, #2848 link quality
  const speaking = useHuddleSpeaking()
  const quality = useHuddleQuality()
  const orderedPeers = useMemo(() => {
    const at = new Map(speaking.order.map((s, i) => [s, i]))
    return [...state.peers].sort(
      (a, b) =>
        (at.get(a.socket) ?? Number.MAX_SAFE_INTEGER) -
        (at.get(b.socket) ?? Number.MAX_SAFE_INTEGER)
    )
  }, [state.peers, speaking.order])
  // #2853 — the mini-player and its one-time offer.
  const pip = useHuddlePip(inThis, me)
  const calls = useSyncExternalStore(huddleCalls.subscribe, huddleCalls.getSnapshot)
  const ringing = calls.outgoing[room] ?? NO_RINGING
  // Leaving the room's huddle forgets who I was ringing (the server hung up for me).
  useEffect(() => {
    if (!inThis) huddleCalls.clearOutgoing(room)
  }, [inThis, room])
  if (state.status === 'error' && (state.room === room || !state.room)) {
    return (
      <div
        className='flex items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 text-[11.5px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
        role='alert'
        data-huddle-error
      >
        <CircleAlert className='h-3.5 w-3.5 shrink-0' strokeWidth={2} aria-hidden />
        <span className='min-w-0 flex-1'>{state.error}</span>
        <button
          type='button'
          onClick={huddle.clearError}
          className='flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-red-500/20'
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
      className='relative shrink-0 border-b border-slate-200 bg-slate-50 px-3 py-1.5 dark:border-border dark:bg-background motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200'
      data-huddle-stage
      data-huddle-mode={state.mode}
    >
      <HuddleCallBar room={room} me={me} huddle={huddle} pip={pip} renderAvatar={renderAvatar} />
      <div className='mt-1.5 flex flex-wrap items-center gap-1 text-[11px]' data-huddle-people>
        {me && (
          <Person
            id={me.id}
            name={me.name}
            muted={state.muted}
            screen={state.sharing}
            speaking={speaking.selfSpeaking}
            quality={null}
            renderAvatar={renderAvatar}
          />
        )}
        {speaking.mutedTalking && <MutedTalkingHint />}
        {orderedPeers.map((p) => (
          <Person
            key={p.socket}
            id={p.user}
            name={p.name}
            muted={p.muted}
            screen={p.screen}
            connection={p.connection}
            speaking={!!speaking.speaking[p.socket]}
            quality={quality.peers[p.socket]}
            renderAvatar={renderAvatar}
          />
        ))}
        {ringing.map((p) => (
          <Ringing key={p.id} p={p} onCancel={() => huddleCalls.cancel(room)} />
        ))}
        {!joining && state.peers.length === 0 && ringing.length === 0 && (
          <span className='px-1 text-slate-500 dark:text-slate-400'>
            Only you so far — people in the room see a Join button.
          </span>
        )}
        <HeldChip />
      </div>
      <HuddleNotesPanel room={room} />
      {quality.poor && <PoorConnectionBanner sharing={state.sharing} />}
      <HuddleHands roster={huddle.roster} self={state.self} />
      <HuddlePipOffer pip={pip} />
      <HuddleCameraNotice />
      <HuddleVideoGrid peers={state.peers} roster={huddle.roster} muted={state.muted} />
      {sharedByPeer?.video && (
        <div className='mt-1.5'>
          <ScreenView
            stream={sharedByPeer.video}
            label={`${sharedByPeer.name ?? 'Someone'}'s screen`}
            screen={sharedByPeer.socket}
          />
        </div>
      )}
      {state.sharing && state.localScreen && (
        <div className='mt-1.5'>
          <ScreenView
            stream={state.localScreen}
            label='You are sharing your screen'
            mirror
            screen={state.self}
          />
        </div>
      )}
      <HuddleReactionLayer roster={huddle.roster} me={me} />
    </div>
  )
}
