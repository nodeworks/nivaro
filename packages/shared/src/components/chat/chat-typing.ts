/**
 * Chat "X is typing…" (realtime gaps P2 / P10, 2026-11-17): the pure half of the socket signal
 * `chat:typing {room, state}` (chat-core.ts useTypingIndicator; server services/chat-typing.ts).
 */

/** Repeat `start` this often while typing (under the receivers' TTL). */
export const TYPING_REPEAT_MS = 2_500
/** A receiver drops "X is typing" this long after X's last `start` (a dead tab fades). */
export const TYPING_TTL_MS = 6_000

export interface TypingPeer {
  name: string
  until: number
}

/** Apply one `chat:typing` event to the peers typing in `room`. Pure — exported for tests. */
export function applyTypingEvent(
  peers: ReadonlyMap<string, TypingPeer>,
  ev: { room?: unknown; state?: unknown; user?: { id?: unknown; name?: unknown } | null },
  room: string,
  me: string | null | undefined,
  now = Date.now()
): Map<string, TypingPeer> | null {
  if (ev?.room !== room || ev.user?.id == null) return null
  const id = String(ev.user.id).toUpperCase()
  if (me && id === me.toUpperCase()) return null
  const next = new Map(peers)
  if (ev.state === 'stop') {
    if (!next.delete(id)) return null
  } else {
    const name = typeof ev.user.name === 'string' && ev.user.name ? ev.user.name : 'Someone'
    next.set(id, { name, until: now + TYPING_TTL_MS })
  }
  return next
}

/** The sentence for the people still typing at `now`. Pure — exported for tests. */
export function typingSentence(peers: ReadonlyMap<string, TypingPeer>, now = Date.now()) {
  const names = [...peers.values()].filter((p) => p.until > now).map((p) => p.name)
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return `${names.length} people are typing…`
}
