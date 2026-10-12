import { EyeOff, Square, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { useOptionalRealtime } from '../../lib/realtime'
import { cn } from '../../lib/utils'
import { canOpenChatRoom, openChatRoom } from './chat-core'

/**
 * The assistant's answer as it is written (#1810). The server streams
 * `chat:bot-stream` events to the room's socket room while the answer may be
 * read by everyone in it, and to the asker's own sockets once it may not
 * (services/chat-bot-stream.ts). This renders the live bubble at the foot of
 * the room; the finished answer arrives as an ordinary `chat:message` and
 * replaces it. Only the person who asked sees Stop.
 *
 * A host without a RealtimeContext simply never shows the bubble — the
 * "…is thinking" line and the finished message still work.
 */

export interface BotStreamEvent {
  stream_id: string
  seq: number
  room: string
  asker: string
  audience: 'room' | 'private'
  phase: 'start' | 'delta' | 'status' | 'private' | 'end' | 'error'
  text?: string
  round?: number
  message_id?: number | null
  private_room?: string | null
  stopped?: boolean
}

export interface LiveBotAnswer {
  id: string
  asker: string
  mine: boolean
  private: boolean
  text: string
  round: number
  status: string | null
  /** Finished privately: the bubble stays for the asker, pointing at the DM. */
  done: boolean
  privateRoom: string | null
  stopping: boolean
}

const SILENCE_MS = 120_000

/** Fold one event into the live answer (pure — unit-tested). */
export function applyBotStreamEvent(
  live: LiveBotAnswer | null,
  ev: BotStreamEvent,
  meId: string | null
): LiveBotAnswer | null {
  const mine = !!meId && ev.asker.toUpperCase() === meId.toUpperCase()
  if (ev.phase === 'start' || !live || live.id !== ev.stream_id) {
    if (ev.phase === 'end' || ev.phase === 'error') return live?.id === ev.stream_id ? null : live
    live = {
      id: ev.stream_id,
      asker: ev.asker,
      mine,
      private: ev.audience === 'private',
      text: '',
      round: 0,
      status: null,
      done: false,
      privateRoom: null,
      stopping: false
    }
    if (ev.phase === 'start') return live
  }
  switch (ev.phase) {
    case 'delta': {
      const round = ev.round ?? 0
      // A new round starts its own text: what a tool round said was narration.
      const text = round === live.round ? live.text + (ev.text ?? '') : (ev.text ?? '')
      return { ...live, text, round, status: null }
    }
    case 'status':
      return { ...live, status: ev.text ?? null }
    case 'private':
      // Everyone else just stops seeing it; the room gets a notice message.
      return mine ? { ...live, private: true } : null
    case 'end':
      if (live.private && mine && ev.private_room) {
        return {
          ...live,
          text: ev.text ?? live.text,
          status: null,
          done: true,
          privateRoom: ev.private_room
        }
      }
      return null
    case 'error':
      return null
    default:
      return live
  }
}

/** The live answer in `room`, plus Stop / dismiss. */
export function useBotStream(room: string, meId: string | null) {
  const realtime = useOptionalRealtime()
  const client = useNivaroClient()
  const [live, setLive] = useState<LiveBotAnswer | null>(null)
  const seen = useRef(new Map<string, number>())
  const lastAt = useRef(0)

  useEffect(() => {
    setLive(null)
    seen.current.clear()
    if (!realtime) return
    return realtime.on('chat:bot-stream', (raw: BotStreamEvent) => {
      if (!raw || raw.room !== room || typeof raw.stream_id !== 'string') return
      // The same event can reach a socket through two rooms (a DM): keep one.
      const last = seen.current.get(raw.stream_id) ?? 0
      if (raw.seq <= last) return
      seen.current.set(raw.stream_id, raw.seq)
      lastAt.current = Date.now()
      setLive((cur) => applyBotStreamEvent(cur, raw, meId))
    })
  }, [realtime, room, meId])

  // A stream whose node died never sends `end` — let it go quietly.
  useEffect(() => {
    if (!live || live.done) return
    const t = setInterval(() => {
      if (Date.now() - lastAt.current > SILENCE_MS) setLive(null)
    }, 10_000)
    return () => clearInterval(t)
  }, [live])

  const stop = useCallback(() => {
    if (!live?.mine || live.done) return
    setLive((cur) => (cur ? { ...cur, stopping: true } : cur))
    void client
      .request(post(`/chat/bot/streams/${live.id}/stop`, {}))
      .catch(() => setLive((cur) => (cur ? { ...cur, stopping: false } : cur)))
  }, [client, live])

  const dismiss = useCallback(() => setLive(null), [])
  return { live, stop, dismiss }
}

export function BotStreamBubble({
  live,
  botName,
  bubbleClass,
  accentClass,
  onStop,
  onDismiss
}: {
  live: LiveBotAnswer
  botName: string
  bubbleClass: string
  accentClass: string
  onStop: () => void
  onDismiss: () => void
}) {
  const writing = !live.done
  return (
    <div className='flex gap-2' data-chat-bot-stream={live.done ? 'done' : 'live'}>
      <div className='max-w-[78%]'>
        <p className='mb-0.5 flex items-center gap-1.5 text-[10.5px] font-semibold text-slate-500'>
          {botName}
          {live.private && (
            <span
              className='inline-flex items-center gap-0.5 font-normal text-slate-500'
              data-chat-bot-private
            >
              <EyeOff className='h-3 w-3' /> Only you can see this
            </span>
          )}
        </p>
        <div
          className={cn(
            'inline-block whitespace-pre-wrap rounded-2xl rounded-bl-md px-3 py-1.5 text-[12.5px] leading-snug',
            bubbleClass
          )}
          aria-live='polite'
        >
          {live.text || <span className='italic text-slate-500'>{live.status ?? 'Thinking…'}</span>}
          {writing && live.text && (
            <span className='ml-0.5 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-slate-400 align-middle' />
          )}
        </div>
        <p className='mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500'>
          {writing && live.text && live.status && <span className='italic'>{live.status}</span>}
          {writing && live.mine && (
            <button
              type='button'
              onClick={onStop}
              disabled={live.stopping}
              className='inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 font-medium text-slate-600 hover:bg-muted disabled:opacity-60 dark:border-border dark:text-slate-300'
              data-chat-bot-stop
            >
              <Square className='h-2.5 w-2.5 fill-current' />
              {live.stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {live.done && live.privateRoom && (
            <>
              <span>Saved in your conversation with {botName}.</span>
              {canOpenChatRoom() && (
                <button
                  type='button'
                  onClick={() => openChatRoom(live.privateRoom as string, botName)}
                  className={cn('font-medium', accentClass)}
                >
                  Open
                </button>
              )}
              <button
                type='button'
                onClick={onDismiss}
                className='inline-flex items-center gap-0.5 hover:text-slate-700 dark:hover:text-slate-200'
                aria-label='Dismiss'
              >
                <X className='h-3 w-3' />
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
