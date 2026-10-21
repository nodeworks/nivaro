import { ChevronDown, Headphones } from 'lucide-react'
import type React from 'react'
import { canOpenChatRoom, openChatRoom } from '../chat-core'
import { PreJoinCheck } from './HuddleAudioUi'
import { peerSummary } from './huddle-store'
import type { HuddleHandle } from './useHuddle'
import { useHuddleSpeaking } from './useHuddleAudio'

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
 * The huddle affordance in a room header (#2457). A quiet headphones button
 * when nobody is talking; a "Join" pill with the faces of who is, when a
 * huddle runs and I am outside it; "In a huddle" while I talk in another
 * room. While I am in this room's huddle the stage's call bar has the controls. Hidden entirely when the browser, host or
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
  const { enabled, state, roster, inThis, inOther } = huddle
  // #2845: who is talking right now (the "In a huddle" pill pulses with it).
  const speaking = useHuddleSpeaking()
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

  // In this room's huddle every control lives in the stage's call bar, so the room name
  // keeps its width in a slim dock.
  if (inThis) return null

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
