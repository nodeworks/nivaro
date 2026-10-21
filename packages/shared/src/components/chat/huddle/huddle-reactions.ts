import { type HuddleExtension, type HuddlePeer, huddleStore } from './huddle-store'

/**
 * Reactions and raised hands (#2857). A reaction floats up over the stage for
 * everyone in the huddle (`huddle:react`, one a second — the server drops
 * faster ones too); a raised hand is participant state (`huddle:state {hand}`)
 * that comes back in the roster as `hand_at`, so the queue is the roster sorted
 * by it. Anyone may lower every hand (`huddle:hands_down`) — no host in v1.
 */

/** Twin of HUDDLE_REACTIONS in api/src/services/huddle-stage.ts. */
export const HUDDLE_REACTIONS = ['👍', '👏', '😂', '🎉', '❤️', '🤔'] as const
export type HuddleReaction = (typeof HUDDLE_REACTIONS)[number]

const MIN_GAP_MS = 1000
/** How long one reaction floats before it is gone. */
export const REACTION_LIFE_MS = 2600
const MAX_FLOATING = 24

export interface FloatingReaction {
  id: number
  user: string
  emoji: string
  at: number
  /** Horizontal position, 0–1, so a burst spreads out instead of stacking. */
  lane: number
}

export function isHuddleReaction(v: unknown): v is HuddleReaction {
  return typeof v === 'string' && (HUDDLE_REACTIONS as readonly string[]).includes(v)
}

/** Raised hands in the order they went up (the people with hand_at). */
export function handQueue<T extends Pick<HuddlePeer, 'socket' | 'hand_at'>>(roster: T[]): T[] {
  return roster
    .filter((p) => typeof p.hand_at === 'number' && p.hand_at > 0)
    .sort((a, b) => (a.hand_at as number) - (b.hand_at as number) || (a.socket < b.socket ? -1 : 1))
}

type Listener = () => void

class ReactionFeed {
  private items: FloatingReaction[] = []
  private listeners = new Set<Listener>()
  private seq = 0
  private lastSent = 0
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  getSnapshot = () => this.items
  private emit() {
    for (const l of this.listeners) l()
  }

  push(user: string, emoji: string, now = Date.now()) {
    const id = ++this.seq
    // Golden-ratio steps spread consecutive reactions across the width.
    const lane = 0.12 + ((id * 0.618) % 1) * 0.76
    this.items = [...this.items.slice(-(MAX_FLOATING - 1)), { id, user, emoji, at: now, lane }]
    this.emit()
    setTimeout(() => {
      this.items = this.items.filter((r) => r.id !== id)
      this.emit()
    }, REACTION_LIFE_MS)
  }

  clear() {
    if (!this.items.length) return
    this.items = []
    this.emit()
  }

  /** Send one (and show it at once); false when throttled or not in a huddle. */
  send(emoji: HuddleReaction, selfUser: string, now = Date.now()): boolean {
    if (now - this.lastSent < MIN_GAP_MS) return false
    if (!huddleStore.send('huddle:react', { emoji })) return false
    this.lastSent = now
    this.push(selfUser, emoji, now)
    return true
  }
}

export const reactionFeed = new ReactionFeed()

export function raiseHand(raised: boolean): boolean {
  return huddleStore.send('huddle:state', { hand: raised })
}

export function lowerAllHands(): boolean {
  return huddleStore.send('huddle:hands_down')
}

const reactionsExt: HuddleExtension = {
  attach: (t) => [
    t.on('huddle:react', (p: { room?: string; from?: string; user?: string; emoji?: unknown }) => {
      const s = huddleStore.getSnapshot()
      if (!p || p.room !== s.room || s.status !== 'live') return
      // My own came back from the server: it is already floating.
      if (p.from === s.self || !isHuddleReaction(p.emoji) || typeof p.user !== 'string') return
      reactionFeed.push(p.user, p.emoji)
    })
  ],
  joined: () => {
    // The server forgets a hand on rejoin; put it back.
    if (huddleStore.getSnapshot().handAt) raiseHand(true)
  },
  teardown: () => reactionFeed.clear()
}

export function installHuddleReactions() {
  huddleStore.use(reactionsExt)
}
