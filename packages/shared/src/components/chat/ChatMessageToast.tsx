// The card a new chat message arrives as (replaces the plain "New message from …"
// toast that cut the message at 90 characters). One card per conversation: more
// messages from the same room stack inside it instead of piling up toasts. The
// whole message reads in the card, and a short reply goes from the card itself,
// so a person answers without leaving what they were doing. It never takes
// focus, makes no extra sound and goes away on its own — sooner for a channel,
// later for a direct message or an @mention, never while the person is reading
// or typing in it, and at once when the conversation is read anywhere.

import { Check, CornerDownLeft, MessageSquare, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { htmlToText } from '../../lib/sanitize-html'
import { cn } from '../../lib/utils'

export interface ChatCardMessage {
  id: number
  sender: string
  sender_name: string | null
  message: string
  date_created: string
}

export interface ChatCardRoom {
  room: string
  label: string
  kind: 'global' | 'dm' | 'channel' | 'entity'
  /** The new messages name this person. */
  mentioned: boolean
}

export interface ChatCardActions {
  reply: (text: string) => void
  markRead: () => void
  /** Absent when the host has nowhere to open a conversation. */
  open?: () => void
}

interface CardState {
  room: ChatCardRoom
  messages: ChatCardMessage[]
  actions: ChatCardActions
}

/** Messages kept per card; older ones fold into "N earlier". */
const KEEP = 3
/** How long a card stays when nobody touches it. */
const LIFE_DIRECT_MS = 30_000
const LIFE_CHANNEL_MS = 10_000

const cards = new Map<string, CardState & { total: number; pinned: boolean }>()
const toastId = (room: string) => `nvr-chat-card:${room}`

/** Add a message to its room's card (opening the card when there is none). */
export function showChatMessageCard(
  room: ChatCardRoom,
  message: ChatCardMessage,
  actions: ChatCardActions
): void {
  const prev = cards.get(room.room)
  if (prev?.messages.some((m) => m.id === message.id)) return
  const messages = [...(prev?.messages ?? []), message].slice(-KEEP)
  const state = {
    room: { ...room, mentioned: room.mentioned || !!prev?.room.mentioned },
    messages,
    actions,
    total: (prev?.total ?? 0) + 1,
    pinned: prev?.pinned ?? false
  }
  cards.set(room.room, state)
  render(room.room)
}

/** The conversation was read (here or anywhere): its card goes. */
export function dismissChatCard(room: string): void {
  if (!cards.has(room)) return
  cards.delete(room)
  toast.dismiss(toastId(room))
}

export function hasChatCard(room: string): boolean {
  return cards.has(room)
}

function life(s: CardState & { pinned: boolean }): number {
  if (s.pinned) return Number.POSITIVE_INFINITY
  return s.room.kind === 'dm' || s.room.mentioned ? LIFE_DIRECT_MS : LIFE_CHANNEL_MS
}

function render(room: string) {
  const s = cards.get(room)
  if (!s) return
  toast.custom(
    () => (
      <ChatMessageCard
        state={s}
        onPin={() => {
          const cur = cards.get(room)
          if (!cur || cur.pinned) return
          cur.pinned = true
          render(room)
        }}
        onClose={() => dismissChatCard(room)}
      />
    ),
    {
      id: toastId(room),
      duration: life(s),
      unstyled: true,
      // Top right, under the header: clear of the chat composer and the page's
      // own bottom-right toasts (Rob, 2026-11-11).
      position: 'top-right',
      onDismiss: () => cards.delete(room),
      onAutoClose: () => cards.delete(room)
    }
  )
}

function initials(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

function plain(text: string): string {
  return htmlToText(String(text ?? ''))
    .replace(/\s+\n/g, '\n')
    .trim()
}

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'now'
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function ChatMessageCard({
  state,
  onPin,
  onClose
}: {
  state: CardState & { total: number; pinned: boolean }
  onPin: () => void
  onClose: () => void
}) {
  const { room, messages, actions, total } = state
  const last = messages[messages.length - 1] as ChatCardMessage
  const from = last.sender_name?.trim() || 'Someone'
  const earlier = total - messages.length
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when messages change
  useEffect(() => {
    const el = bodyRef.current
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 2)
  }, [messages.length, expanded])

  const context =
    room.kind === 'dm'
      ? 'Direct message'
      : room.kind === 'entity'
        ? room.label
        : `#${room.label.replace(/^#/, '')}`

  const send = () => {
    const text = draft.trim()
    if (!text) return
    actions.reply(text)
    setDraft('')
    setSent(true)
    window.setTimeout(onClose, 1100)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <section
      data-chat-card={room.room}
      aria-label={`${total > 1 ? `${total} new messages` : 'New message'} from ${from}`}
      onPointerDown={onPin}
      className='nvr-chat-card pointer-events-auto mt-7 w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_10px_30px_-12px_rgba(15,23,42,0.35),0_2px_6px_-2px_rgba(15,23,42,0.12)]'
    >
      <header className='flex items-start gap-3 px-3.5 pb-2 pt-3'>
        <span className='relative mt-0.5 shrink-0'>
          <span
            aria-hidden
            className='grid h-9 w-9 place-items-center rounded-full bg-nvr-cyan/15 text-[12.5px] font-semibold text-sky-800 dark:text-nvr-cyan'
          >
            {initials(last.sender_name)}
          </span>
          <span
            aria-hidden
            className='absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full bg-nvr-cyan text-white ring-2 ring-popover'
          >
            <MessageSquare className='h-2.5 w-2.5' />
          </span>
        </span>
        <div className='min-w-0 flex-1'>
          <div className='flex items-baseline gap-2'>
            <p className='truncate text-[13.5px] font-semibold leading-tight'>{from}</p>
            <span className='shrink-0 text-[11px] tabular-nums text-muted-foreground'>
              {when(last.date_created)}
            </span>
          </div>
          <p className='mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-muted-foreground'>
            <span className='truncate'>{context}</span>
            {room.mentioned && room.kind !== 'dm' && (
              <span className='shrink-0 rounded-full bg-amber-100 px-1.5 text-[10.5px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'>
                mentioned you
              </span>
            )}
            {total > 1 && (
              <span className='shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] font-medium tabular-nums text-foreground'>
                {total} new
              </span>
            )}
          </p>
        </div>
        <button
          type='button'
          aria-label='Dismiss'
          onClick={onClose}
          className='-mr-1 -mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </header>

      <div className='px-3.5'>
        {earlier > 0 && (
          <p className='mb-1 text-[11px] text-muted-foreground'>
            {earlier} earlier {earlier === 1 ? 'message' : 'messages'}
          </p>
        )}
        <div
          ref={bodyRef}
          className={cn(
            'space-y-1.5 text-[13px] leading-snug',
            expanded
              ? 'max-h-56 overflow-y-auto overscroll-contain pr-1'
              : 'max-h-[5.6em] overflow-hidden'
          )}
        >
          {messages.map((m, i) => {
            const showName = room.kind !== 'dm' && i > 0 && messages[i - 1]?.sender !== m.sender
            return (
              <p key={m.id} className='whitespace-pre-wrap break-words'>
                {showName && (
                  <span className='font-medium text-foreground'>
                    {m.sender_name ?? 'Someone'}:{' '}
                  </span>
                )}
                {plain(m.message) || (
                  <span className='italic text-muted-foreground'>Sent a file</span>
                )}
              </p>
            )
          })}
        </div>
        {(overflows || expanded) && (
          <button
            type='button'
            onClick={() => {
              onPin()
              setExpanded((v) => !v)
            }}
            className='mt-1 text-[11.5px] font-medium text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-nvr-cyan'
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>

      <footer className='mt-2.5 border-t border-border bg-muted/40 px-2.5 py-2'>
        {sent ? (
          <p
            role='status'
            className='flex items-center gap-1.5 px-1 py-1 text-[12.5px] font-medium text-emerald-700 dark:text-emerald-400'
          >
            <Check className='h-3.5 w-3.5' aria-hidden />
            Reply sent
          </p>
        ) : (
          <div className='flex items-center gap-1.5'>
            <label className='sr-only' htmlFor={`chat-card-reply-${room.room}`}>
              Reply to {from}
            </label>
            <input
              id={`chat-card-reply-${room.room}`}
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={onPin}
              onKeyDown={onKey}
              placeholder={room.kind === 'dm' ? `Reply to ${from.split(' ')[0]}…` : 'Reply…'}
              autoComplete='off'
              className='h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[12.5px] placeholder:text-muted-foreground focus-visible:border-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/30'
            />
            {draft.trim() ? (
              <button
                type='button'
                onClick={send}
                aria-label='Send reply'
                className='inline-flex h-8 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
              >
                <CornerDownLeft className='h-3.5 w-3.5' aria-hidden />
                Send
              </button>
            ) : (
              <>
                <button
                  type='button'
                  onClick={() => {
                    actions.markRead()
                    onClose()
                  }}
                  className='h-8 shrink-0 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
                >
                  Mark read
                </button>
                {actions.open && (
                  <button
                    type='button'
                    onClick={() => {
                      actions.open?.()
                      onClose()
                    }}
                    className='h-8 shrink-0 rounded-md border border-border bg-background px-2.5 text-[12px] font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
                  >
                    Open
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </footer>
    </section>
  )
}
