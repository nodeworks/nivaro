import { toast } from 'sonner'
import type { HuddleTransport } from './huddle-store'

/**
 * A ring the server would not place (security review 2026-10-21, finding 1): the server keeps
 * a cooldown after a declined, missed or cancelled call, caps how often one person may ring
 * another, and how many calls one person may start a minute. `huddle:ring-refused` tells the
 * caller who was not rung and for how long, and this turns it into one toast — a refusal is
 * never silent.
 *
 * Payload: {room, reason?: 'rate', retry_in?, users: [{id, name, reason, retry_in}]}.
 */

export interface RingRefusedPerson {
  id: string
  name: string | null
  reason: 'cooldown' | 'limit'
  retry_in: number
}

export interface RingRefused {
  room: string
  reason?: 'rate'
  retry_in?: number
  users?: RingRefusedPerson[]
}

/** Pure: "25 s", "2 min", "10 min". */
export function waitWords(seconds: number): string {
  const s = Math.max(1, Math.ceil(Number(seconds) || 0))
  return s < 60 ? `${s} s` : `${Math.ceil(s / 60)} min`
}

function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? 'them'
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
}

/** Pure: the toast for a refusal, or null when there is nothing to say. */
export function ringRefusedText(p: RingRefused): { title: string; description?: string } | null {
  if (p.reason === 'rate') {
    return {
      title: `You can start another call in ${waitWords(p.retry_in ?? 60)}`,
      description: 'Too many calls in a short time.'
    }
  }
  const users = (p.users ?? []).filter((u) => u && typeof u.id === 'string')
  if (!users.length) return null
  const wait = Math.max(...users.map((u) => Number(u.retry_in) || 0))
  const who = names(users.map((u) => u.name || 'Someone'))
  const title = `You can call ${who} again in ${waitWords(wait)}`
  const limited = users.some((u) => u.reason === 'limit')
  return {
    title,
    description: limited
      ? 'You have rung them several times in the last few minutes.'
      : 'They just declined or missed a call from you.'
  }
}

/** Listen for refusals on the host's transport; returns the unsubscribe. */
export function watchRingRefused(transport: HuddleTransport): () => void {
  return transport.on('huddle:ring-refused', (p: RingRefused) => {
    if (typeof p?.room !== 'string') return
    const text = ringRefusedText(p)
    if (text)
      toast(text.title, { id: `huddle-ring-refused-${p.room}`, description: text.description })
  })
}
