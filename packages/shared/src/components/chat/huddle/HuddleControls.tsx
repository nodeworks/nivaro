import {
  ChevronDown,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff
} from 'lucide-react'
import type React from 'react'
import { cn } from '../../../lib/utils'
import { canOpenChatRoom, openChatRoom } from '../chat-core'
import { DeviceSettingsButton, PreJoinCheck, ShortcutSheetAnchor } from './HuddleAudioUi'
import { peerSummary } from './huddle-store'
import type { HuddleHandle } from './useHuddle'
import { useHuddleShortcuts, useHuddleSpeaking } from './useHuddleAudio'

const ghost =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'

const prejoinChevron =
  'flex h-7 w-4 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-100'

/** #2847: the small chevron beside Start / Join that opens the pre-join microphone check. */
function CheckFirst({ onJoin }: { onJoin: () => void }) {
  return (
    <PreJoinCheck onJoin={onJoin}>
      <button
        type='button'
        className={prejoinChevron}
        aria-label='Check your microphone before joining'
        data-tip='Check your microphone first'
        data-huddle-prejoin
      >
        <ChevronDown className='h-3 w-3' strokeWidth={2} />
      </button>
    </PreJoinCheck>
  )
}

/**
 * The huddle affordance in a room header (#2457). Three faces: a quiet
 * headphones button when nobody is talking; a "Join" pill with the faces of
 * who is, when a huddle runs and I am outside it; and the live controls (mute,
 * share, leave) while I am in. Hidden entirely when the browser, host or
 * instance cannot do it — a button that could only fail is noise.
 */
export function HuddleControls({
  room,
  roomLabel,
  huddle,
  renderAvatar
}: {
  room: string
  roomLabel: string
  huddle: HuddleHandle
  renderAvatar: (id: string, name: string | null) => React.ReactNode
}) {
  const { enabled, support, state, roster, inThis, inOther } = huddle
  // #2845 / #2846: who is talking right now, and whether Space holds my mic open.
  const speaking = useHuddleSpeaking()
  const { talking } = useHuddleShortcuts()
  if (!enabled) return null
  const anyoneSpeaking = speaking.selfSpeaking || Object.keys(speaking.speaking).length > 0

  if (inOther && state.room) {
    const other = state.room
    return (
      <button
        type='button'
        onClick={() => (canOpenChatRoom() ? openChatRoom(other) : huddle.leave())}
        className='flex h-7 items-center gap-1.5 rounded-md bg-nvr-cyan/10 px-2 text-[11px] font-medium text-slate-700 transition-colors hover:bg-nvr-cyan/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-100'
        data-tip={canOpenChatRoom() ? 'Back to the room you are talking in' : 'Leave that huddle'}
        data-huddle-elsewhere
      >
        <span className='relative flex h-2 w-2' data-huddle-elsewhere-speaking={anyoneSpeaking}>
          {anyoneSpeaking && (
            <span className='absolute inline-flex h-full w-full rounded-full bg-nvr-cyan opacity-60 motion-safe:animate-ping' />
          )}
          <span className='relative inline-flex h-2 w-2 rounded-full bg-nvr-cyan' />
        </span>
        In a huddle
      </button>
    )
  }

  if (inThis) {
    const joining = state.status === 'joining'
    return (
      <fieldset
        className='m-0 flex h-7 min-w-0 items-center gap-0.5 rounded-md border border-slate-200 bg-white p-0 px-0.5 dark:border-border dark:bg-card'
        data-huddle-controls
      >
        <legend className='sr-only'>Huddle controls</legend>
        <button
          type='button'
          onClick={huddle.toggleMute}
          disabled={joining}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40',
            state.muted
              ? 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300'
              : talking || speaking.selfSpeaking
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10'
          )}
          aria-pressed={state.muted}
          aria-label={state.muted ? 'Unmute microphone' : 'Mute microphone'}
          data-tip={
            talking ? 'Talking — let go of Space to mute' : state.muted ? 'Unmute (M)' : 'Mute (M)'
          }
          data-huddle-mute={state.muted ? 'on' : 'off'}
          data-huddle-ptt={talking ? 'on' : undefined}
        >
          {state.muted ? (
            <MicOff className='h-3.5 w-3.5' strokeWidth={2} />
          ) : (
            <Mic className='h-3.5 w-3.5' strokeWidth={2} />
          )}
        </button>
        {support.screen && (
          <button
            type='button'
            onClick={huddle.toggleShare}
            disabled={joining}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40',
              state.sharing
                ? 'bg-nvr-cyan/15 text-slate-900 dark:text-slate-100'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10'
            )}
            aria-pressed={state.sharing}
            aria-label={state.sharing ? 'Stop sharing your screen' : 'Share your screen'}
            data-tip={state.sharing ? 'Stop sharing (Shift+S)' : 'Share screen (Shift+S)'}
            data-huddle-share={state.sharing ? 'on' : 'off'}
          >
            {state.sharing ? (
              <ScreenShareOff className='h-3.5 w-3.5' strokeWidth={2} />
            ) : (
              <ScreenShare className='h-3.5 w-3.5' strokeWidth={2} />
            )}
          </button>
        )}
        {!joining && <DeviceSettingsButton muted={state.muted} />}
        <button
          type='button'
          onClick={huddle.leave}
          className='flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-red-300 dark:hover:bg-red-500/15'
          aria-label='Leave the huddle'
          data-huddle-leave
        >
          <PhoneOff className='h-3.5 w-3.5' strokeWidth={2} />
          Leave
        </button>
        <ShortcutSheetAnchor />
      </fieldset>
    )
  }

  if (roster.length > 0) {
    const shown = roster.slice(0, 3)
    return (
      <span className='flex items-center'>
        <button
          type='button'
          onClick={huddle.join}
          className='flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white pl-1 pr-2 text-[11px] font-medium text-slate-700 transition-colors hover:border-nvr-cyan hover:bg-nvr-cyan/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:text-slate-100'
          data-tip={`${peerSummary(roster)} in a huddle — join`}
          aria-label={`Join the huddle in ${roomLabel} (${peerSummary(roster)})`}
          data-huddle-join
        >
          <span className='flex -space-x-1.5'>
            {shown.map((p) => (
              <span
                key={p.socket}
                className='rounded-full ring-2 ring-white dark:ring-card'
                style={{ lineHeight: 0 }}
              >
                {renderAvatar(p.user, p.name)}
              </span>
            ))}
          </span>
          {roster.length > 3 && (
            <span className='text-slate-500 dark:text-slate-400'>+{roster.length - 3}</span>
          )}
          <Headphones className='h-3.5 w-3.5 text-nvr-cyan' strokeWidth={2} />
          Join
        </button>
        <CheckFirst onJoin={huddle.join} />
      </span>
    )
  }

  return (
    <span className='flex items-center'>
      <button
        type='button'
        onClick={huddle.join}
        className={ghost}
        aria-label={`Start a huddle in ${roomLabel}`}
        data-tip='Start a huddle — talk with whoever is here'
        data-huddle-start
        data-room={room}
      >
        <Headphones className='h-4 w-4' strokeWidth={2} />
      </button>
      <CheckFirst onJoin={huddle.join} />
    </span>
  )
}
