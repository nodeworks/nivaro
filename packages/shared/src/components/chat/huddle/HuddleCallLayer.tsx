import { useQuery } from '@tanstack/react-query'
import { CalendarClock, Headphones, PhoneIncoming, PhoneOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useOptionalNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { isDndActive } from '../../../lib/dnd'
import { playNotificationSound, soundForCategory } from '../../../lib/notification-sound'
import { useOptionalRealtime } from '../../../lib/realtime'
import { cn } from '../../../lib/utils'
import { UserAvatar } from '../../UserAvatar'
import { canOpenChatRoom, chatAvatarColor, chatInitials, openChatRoom } from '../chat-core'
import { huddleCalls, INCOMING_TTL_MS, type IncomingCall } from './huddle-calls'
import { heldSummary, onHeldRelease, watchHuddleForRelease } from './huddle-hold'
import { huddleStore, type IceConfig } from './huddle-store'

/**
 * The incoming-call layer (#2843): mounted ONCE at the app level, like the
 * help-video recorder, above every page, inside the host's RealtimeContext
 * (and a NivaroProvider for the person's preferences). It shows a call card
 * for every ring addressed to this person, rings with their own notification
 * sound, and holds its tongue under do not disturb. Accept opens the room
 * (when the host registered a room opener) and joins the huddle; Decline
 * tells the caller. Nothing renders while nobody is calling.
 *
 * It also owns the "held during your huddle" release toast (#2852).
 */

let mounted = 0
/** Hosts whose own bell toasts `notification:new` skip category `huddle` while this is mounted. */
export function huddleCallLayerMounted(): boolean {
  return mounted > 0
}

const RING_EVERY_MS = 2500

function roomWords(room: string): string {
  if (room.startsWith('dm:')) return 'Direct message'
  if (room === 'global') return 'General'
  if (room.startsWith('ch:')) return `#${room.slice(3)}`
  return 'Record room'
}

function CallCard({
  call,
  onAccept,
  onDecline,
  index
}: {
  call: IncomingCall
  onAccept: () => void
  onDecline: () => void
  index: number
}) {
  const name = call.name ?? 'Someone'
  const disc = (
    <span
      className='flex h-10 w-10 items-center justify-center rounded-full text-[14px] font-semibold text-[#04263b]'
      style={{ backgroundColor: chatAvatarColor(call.from) }}
      aria-hidden
    >
      {chatInitials(name)}
    </span>
  )
  const left = Math.max(0, INCOMING_TTL_MS - (Date.now() - call.at))
  return (
    <section
      className={cn(
        'w-[328px] max-w-[calc(100vw-32px)] overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-900 shadow-[0_4px_16px_rgba(0,0,0,0.10),0_1px_4px_rgba(0,0,0,0.06)] dark:border-border dark:bg-card dark:text-slate-100',
        'motion-safe:animate-in motion-safe:slide-in-from-top-2 motion-safe:fade-in motion-safe:duration-200'
      )}
      style={{ animationDelay: `${index * 40}ms` }}
      role='alertdialog'
      aria-labelledby={`huddle-call-${call.room}`}
      data-huddle-call={call.room}
    >
      <div className='flex items-center gap-3 px-3.5 pt-3.5'>
        <span className='relative shrink-0'>
          <span
            className='absolute -inset-1 rounded-full border-2 border-nvr-cyan/60 motion-safe:animate-ping'
            aria-hidden
          />
          <UserAvatar userId={call.from} fallback={disc} className='h-10 w-10 rounded-full' />
        </span>
        <div className='min-w-0 flex-1'>
          <p id={`huddle-call-${call.room}`} className='truncate text-[13px] font-semibold'>
            {call.scheduled != null ? 'Scheduled huddle starting' : `${name} is calling`}
          </p>
          <p className='mt-0.5 flex items-center gap-1 truncate text-[11.5px] text-slate-500 dark:text-slate-400'>
            {call.scheduled != null ? (
              <CalendarClock className='h-3 w-3 shrink-0' strokeWidth={2} />
            ) : (
              <PhoneIncoming className='h-3 w-3 shrink-0' strokeWidth={2} />
            )}
            <span className='truncate'>
              {call.scheduled != null ? `${name} · ` : ''}
              {roomWords(call.room)}
            </span>
          </p>
        </div>
      </div>
      <div className='flex items-center gap-2 px-3.5 pb-3.5 pt-3'>
        <button
          type='button'
          onClick={onDecline}
          className='flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-200 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:text-slate-200 dark:hover:bg-white/5'
          data-huddle-call-decline
        >
          <PhoneOff className='h-3.5 w-3.5' strokeWidth={2} />
          Decline
        </button>
        <button
          type='button'
          onClick={onAccept}
          className='flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-nvr-cyan text-[12.5px] font-medium text-white transition-colors hover:bg-[#00b8e0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 dark:ring-offset-card'
          data-huddle-call-accept
        >
          <Headphones className='h-3.5 w-3.5' strokeWidth={2} />
          Accept
        </button>
      </div>
      {/* The time left to answer, draining left to right; the card closes on its own after. */}
      <div className='h-0.5 w-full bg-slate-100 dark:bg-white/10' aria-hidden>
        <div
          className='h-full origin-left bg-nvr-cyan motion-reduce:hidden'
          style={{
            animation: `nvr-huddle-drain ${left}ms linear forwards`
          }}
        />
      </div>
    </section>
  )
}

export function HuddleCallLayer() {
  const realtime = useOptionalRealtime()
  const client = useOptionalNivaroClient()
  const { data: prefs } = useQuery({
    queryKey: ['nvr-profile-prefs'],
    queryFn: () =>
      client!
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>),
    enabled: !!client,
    staleTime: 60_000
  })
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  const fetchIce = useCallback(
    (room: string): Promise<IceConfig> =>
      client
        ? client.request<{ data: IceConfig }>(get('/chat/huddle/ice', { room })).then((r) => r.data)
        : Promise.resolve({ enabled: true, iceServers: [], ttl_s: 0, max_participants: 8 }),
    [client]
  )

  useEffect(() => {
    if (!realtime) return
    huddleCalls.attach(realtime)
    huddleStore.attach(realtime, fetchIce)
  }, [realtime, fetchIce])

  useEffect(() => {
    mounted++
    const offWatch = watchHuddleForRelease()
    const offRelease = onHeldRelease((items) => {
      const text = heldSummary(items)
      if (!text) return
      toast(text, { description: 'Open the bell or the chat to see them.' })
      playNotificationSound(soundForCategory(prefsRef.current, 'other'))
    })
    return () => {
      mounted--
      offWatch()
      offRelease()
    }
  }, [])

  const state = useSyncExternalStore(huddleCalls.subscribe, huddleCalls.getSnapshot)
  const dnd = isDndActive(prefs)
  const incoming = dnd ? [] : state.incoming

  // The ringtone: the person's own notification sound, repeated while a call waits.
  const ringing = incoming.length > 0
  useEffect(() => {
    if (!ringing) return
    const play = () => playNotificationSound(soundForCategory(prefsRef.current, 'huddle'))
    play()
    const t = setInterval(play, RING_EVERY_MS)
    return () => clearInterval(t)
  }, [ringing])

  if (!incoming.length || typeof document === 'undefined') return null
  const accept = (call: IncomingCall) => {
    huddleCalls.answer(call.room, true)
    if (canOpenChatRoom()) openChatRoom(call.room)
    void huddleStore.join(call.room)
  }
  return createPortal(
    <div
      className='pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-4'
      data-huddle-call-layer
    >
      <style>
        {'@keyframes nvr-huddle-drain{from{transform:scaleX(1)}to{transform:scaleX(0)}}'}
      </style>
      {incoming.map((call, i) => (
        <div key={call.room} className='pointer-events-auto'>
          <CallCard
            call={call}
            index={i}
            onAccept={() => accept(call)}
            onDecline={() => huddleCalls.answer(call.room, false)}
          />
        </div>
      ))}
    </div>,
    document.body
  )
}
