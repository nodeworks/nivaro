/**
 * Chat "X is typing…" as a socket signal (realtime gaps P2 / P10, 2026-11-17).
 *
 * It used to be a column on the person's presence row (`user_presence.typing_room`): anyone who
 * could read presence rows learned who was writing to whom (`dm:<A>:<B>`, private channels), the
 * indicator stuck when the typing tab died while another tab kept the row fresh, and every start
 * or stop was a `collection:update` to every holder of the collection (every open composer
 * refetched — N²).
 *
 *   client → `chat:typing {room, state: 'start' | 'stop'}`   (start repeats while typing)
 *   server → `chat:typing {room, state, user: {id, name}}`   to `chat-typing:<room>` only
 *
 * `chat-typing:<room>` is joined beside `chat:<room>` by `chat:join`, under the same canSeeRoom
 * gate (and the socket-access recheck), and only by a person at a screen — never a machine
 * account or an API-key socket. Only a person on their own sign-in says they are typing (never
 * View-as). Nothing is stored: the receiver drops a name CHAT_TYPING_TTL_MS after its last
 * `start`, so a dead tab's indicator fades by itself.
 */

/** A receiver forgets "X is typing" this long after X's last `start`. */
export const CHAT_TYPING_TTL_MS = 6_000
/** A sender repeats `start` this often while typing (under the TTL). */
export const CHAT_TYPING_REPEAT_MS = 2_500
/** One socket's `start` for one room is relayed at most this often. */
export const CHAT_TYPING_MIN_GAP_MS = 1_000

export function chatTypingRoomName(room: string): string {
  return `chat-typing:${room}`
}

export interface ChatTypingSignal {
  room: string
  state: 'start' | 'stop'
}

export function parseChatTyping(payload: unknown): ChatTypingSignal | null {
  const p = payload as { room?: unknown; state?: unknown } | null | undefined
  const room = p?.room
  if (typeof room !== 'string' || !room || room.length > 200) return null
  return { room, state: p?.state === 'stop' ? 'stop' : 'start' }
}

/** Per-socket throttle: true = relay this signal now. A `stop` always goes. */
export function createChatTypingThrottle(now: () => number = Date.now) {
  const last = new Map<string, number>()
  return (s: ChatTypingSignal): boolean => {
    if (s.state === 'stop') {
      last.delete(s.room)
      return true
    }
    const t = now()
    if (t - (last.get(s.room) ?? Number.NEGATIVE_INFINITY) < CHAT_TYPING_MIN_GAP_MS) return false
    if (last.size > 100) last.clear()
    last.set(s.room, t)
    return true
  }
}
