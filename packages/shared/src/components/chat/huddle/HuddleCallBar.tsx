import {
  ChevronLeft,
  Hand,
  Headphones,
  Keyboard,
  Mic,
  MicOff,
  MoreHorizontal,
  PhoneOff,
  PictureInPicture2,
  Presentation,
  ScreenShare,
  UserPlus
} from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { DeviceSettingsButton, ShortcutSheetAnchor } from './HuddleAudioUi'
import { HuddleCameraButton } from './HuddleCamera'
import { HuddleNotesButton, useHuddleCollab } from './HuddleCollab'
import { HuddleInviteButton, HuddleInviteList } from './HuddlePeoplePicker'
import { HuddleStageTools } from './HuddleStageTools'
import { useCloseOnWindowBlur } from './huddle-dismiss'
import type { HuddlePipHandle } from './huddle-pip'
import { raiseHand } from './huddle-reactions'
import { huddleShortcuts } from './huddle-shortcuts'
import { formatElapsed } from './huddle-store'
import type { HuddleHandle } from './useHuddle'
import { useHuddleShortcuts, useHuddleSpeaking } from './useHuddleAudio'

/**
 * The call bar at the top of the huddle stage: what the huddle is (timer),
 * then every control in one row — microphone (its chevron opens the devices),
 * camera, screen, then reactions, hand, notes and add people, a ⋯ menu for
 * the rest (Follow me, pop out, shortcuts) and Leave. The room header stays
 * the room's; this row is the call's.
 *
 * It measures itself: in a slim chat dock or on a phone the "Huddle" word and
 * Leave's label go, and below ~340 px Add people and the hand fold into ⋯, so
 * the row never wraps.
 */

const tool =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40'
const idle =
  'text-slate-500 hover:bg-slate-200/70 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
const pressed = 'bg-nvr-cyan/15 text-slate-900 dark:text-slate-100'

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
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

function MenuRow({
  icon,
  children,
  onClick,
  disabled,
  active,
  tip,
  data
}: {
  icon: React.ReactNode
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  active?: boolean
  tip?: string
  data: string
}) {
  return (
    <button
      type='button'
      role='menuitem'
      onClick={onClick}
      disabled={disabled}
      className='flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-50 disabled:hover:bg-transparent dark:text-slate-200'
      data-tip={tip}
      data-huddle-menu={data}
    >
      <span
        className={cn(
          'grid w-4 shrink-0 place-items-center [&>svg]:h-3.5 [&>svg]:w-3.5',
          active ? 'text-nvr-navy dark:text-nvr-cyan' : 'text-slate-500 dark:text-slate-400'
        )}
      >
        {icon}
      </span>
      <span className='min-w-0 flex-1'>{children}</span>
    </button>
  )
}

/** The ⋯ of the call bar: folded buttons first, then Follow me, pop out and shortcuts. */
function MoreMenu({
  room,
  huddle,
  pip,
  fold,
  followAction,
  renderAvatar
}: {
  room: string
  huddle: HuddleHandle
  pip: HuddlePipHandle
  fold: boolean
  followAction: ReturnType<typeof useHuddleCollab>['followAction']
  renderAvatar: (id: string, name: string | null) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'menu' | 'invite'>('menu')
  useCloseOnWindowBlur(open, () => {
    setOpen(false)
    setView('menu')
  })
  const toShortcuts = useRef(false)
  const joining = huddle.state.status === 'joining'
  const raised = !!huddle.state.handAt
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setView('menu')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(tool, open ? pressed : idle)}
          aria-label='More huddle actions'
          data-tip='More'
          data-huddle-more
        >
          <MoreHorizontal className='h-3.5 w-3.5' strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className={cn(
          'p-1',
          view === 'invite' ? 'w-[280px] max-w-[calc(100vw-16px)]' : 'w-[232px]'
        )}
        onCloseAutoFocus={(e) => {
          // Handing over to the cheat-sheet: focus going back to ⋯ would dismiss it.
          if (!toShortcuts.current) return
          toShortcuts.current = false
          e.preventDefault()
          huddleShortcuts.setHelpOpen(true)
        }}
        data-huddle-more-menu
      >
        {view === 'invite' ? (
          <div>
            <button
              type='button'
              onClick={() => setView('menu')}
              className='mb-1 flex items-center gap-1 rounded px-1 py-0.5 text-[11.5px] font-medium text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-400 dark:hover:text-slate-100'
            >
              <ChevronLeft className='h-3.5 w-3.5' strokeWidth={2} />
              Back
            </button>
            <HuddleInviteList
              room={room}
              renderAvatar={renderAvatar}
              onDone={() => setOpen(false)}
            />
          </div>
        ) : (
          <div role='menu' aria-label='More huddle actions' className='flex flex-col'>
            {fold && !joining && (
              <MenuRow icon={<UserPlus />} onClick={() => setView('invite')} data='invite'>
                Add people…
              </MenuRow>
            )}
            {fold && (
              <MenuRow
                icon={<Hand />}
                onClick={run(() => raiseHand(!raised))}
                disabled={joining}
                active={raised}
                data='hand'
              >
                {raised ? 'Lower your hand' : 'Raise your hand'}
              </MenuRow>
            )}
            {followAction && (
              <MenuRow
                icon={<Presentation />}
                onClick={run(followAction.run)}
                disabled={followAction.disabled}
                active={followAction.active}
                tip={followAction.tip}
                data='follow'
              >
                {followAction.label}
              </MenuRow>
            )}
            {pip.supported && (
              <MenuRow
                icon={<PictureInPicture2 />}
                onClick={run(pip.toggle)}
                active={pip.open}
                tip={pip.open ? undefined : 'A small window that stays on top of other windows'}
                data='pip'
              >
                {pip.open ? 'Close the mini-player' : 'Pop out a mini-player'}
              </MenuRow>
            )}
            <MenuRow
              icon={<Keyboard />}
              onClick={() => {
                toShortcuts.current = true
                setOpen(false)
              }}
              data='shortcuts'
            >
              <span className='flex items-center justify-between gap-2'>
                Keyboard shortcuts
                <kbd className='inline-flex h-5 min-w-5 items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 font-sans text-[10.5px] font-medium text-slate-600 dark:border-border dark:bg-muted dark:text-slate-300'>
                  ?
                </kbd>
              </span>
            </MenuRow>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function HuddleCallBar({
  room,
  me,
  huddle,
  pip,
  renderAvatar
}: {
  room: string
  me: { id: string; name: string } | null
  huddle: HuddleHandle
  pip: HuddlePipHandle
  renderAvatar: (id: string, name: string | null) => React.ReactNode
}) {
  const { state, support } = huddle
  const bar = useRef<HTMLDivElement>(null)
  const width = useWidth(bar)
  // 0 = not measured yet: lay out as the slim dock does.
  const roomy = width >= 460
  const fold = width > 0 && width < 340
  const speaking = useHuddleSpeaking()
  const { talking } = useHuddleShortcuts()
  const collab = useHuddleCollab(room, huddle)
  const joining = state.status === 'joining'

  return (
    <div ref={bar} className='flex min-w-0 items-center gap-1.5 text-[11px]' data-huddle-callbar>
      <span
        className='inline-flex min-w-0 items-center gap-1 font-medium text-slate-700 dark:text-slate-200'
        data-tip={roomy || joining ? undefined : 'Huddle — time since it started'}
      >
        <Headphones className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' strokeWidth={2} aria-hidden />
        {joining ? (
          <span className='truncate'>Connecting…</span>
        ) : (
          <>
            <span className={roomy ? undefined : 'sr-only'}>Huddle</span>
            <Elapsed since={state.startedAt} />
          </>
        )}
      </span>
      <div
        role='toolbar'
        aria-label='Huddle controls'
        className='ml-auto flex shrink-0 items-center gap-0.5'
        data-huddle-controls
      >
        <span className='inline-flex items-center rounded'>
          <button
            type='button'
            onClick={huddle.toggleMute}
            disabled={joining}
            className={cn(
              tool,
              state.muted
                ? 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300'
                : talking || speaking.selfSpeaking
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : 'text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-white/10'
            )}
            aria-pressed={state.muted}
            aria-label={state.muted ? 'Unmute microphone' : 'Mute microphone'}
            data-tip={
              talking
                ? 'Talking — let go of Space to mute'
                : state.muted
                  ? 'Unmute (M)'
                  : 'Mute (M)'
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
          {!joining && <DeviceSettingsButton muted={state.muted} variant='chevron' />}
        </span>
        {/* #2858 — optional camera, off by default. */}
        <HuddleCameraButton disabled={joining} />
        {support.screen && (
          <button
            type='button'
            onClick={huddle.toggleShare}
            disabled={joining}
            className={cn(tool, state.sharing ? pressed : idle)}
            aria-pressed={state.sharing}
            aria-label={state.sharing ? 'Stop sharing your screen' : 'Share your screen'}
            data-tip={state.sharing ? 'Stop sharing (Shift+S)' : 'Share screen (Shift+S)'}
            data-huddle-share={state.sharing ? 'on' : 'off'}
          >
            <ScreenShare className='h-3.5 w-3.5' strokeWidth={2} />
          </button>
        )}
        <span className='mx-1 h-3.5 w-px bg-slate-200 dark:bg-border' aria-hidden />
        {/* #2857 reactions + hand, #2854 notes, #2844 add people */}
        <HuddleStageTools me={me} handAt={state.handAt} disabled={joining} showHand={!fold}>
          {collab.live && (
            <HuddleNotesButton open={collab.notes.open} unseen={collab.notes.unseen} />
          )}
          {!fold && !joining && <HuddleInviteButton room={room} renderAvatar={renderAvatar} />}
        </HuddleStageTools>
        <MoreMenu
          room={room}
          huddle={huddle}
          pip={pip}
          fold={fold}
          followAction={collab.followAction}
          renderAvatar={renderAvatar}
        />
        <ShortcutSheetAnchor />
        <button
          type='button'
          onClick={huddle.leave}
          className={cn(
            'ml-1 flex h-6 shrink-0 items-center justify-center gap-1 rounded bg-red-50 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:bg-red-500/15 dark:text-red-300 dark:hover:bg-red-500/25',
            roomy ? 'px-2' : 'w-7'
          )}
          aria-label='Leave the huddle'
          data-tip={roomy ? 'Leave (L)' : 'Leave the huddle (L)'}
          data-huddle-leave
        >
          <PhoneOff className='h-3.5 w-3.5' strokeWidth={2} />
          {roomy && 'Leave'}
        </button>
      </div>
    </div>
  )
}
