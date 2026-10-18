// api/src/services/traffic-chat-card.ts
/**
 * #2277 — share a node card to chat. A node's live figure and a sparkline are posted to a chat
 * room through the one send path (chat-send.ts). While the incident lasts the message text is
 * rewritten every REFRESH_MS with the newest figure (no new message, no new notification); it
 * then freezes with its last values. The sparkline is drawn with block characters so the card is
 * plain text everywhere chat renders — no new message column.
 *
 * A card freezes when: an admin freezes it, the node has had no errors for QUIET_REFRESHES
 * refreshes in a row after the card started on a node that had some ("incident over"), the card
 * reaches MAX_LIVE_MS, or the message is deleted. State is in-memory per store (tapState): a
 * restart freezes the cards it was refreshing, which is the safe direction.
 */
import { tapState } from './traffic-taps.js'

export const REFRESH_MS = 30_000
export const MAX_LIVE_MS = 2 * 3600_000
export const QUIET_REFRESHES = 6
export const MAX_LIVE_CARDS = 10
export const READINGS_CAP = 24

export type CardKind = 'entity' | 'down'
export type FreezeReason = 'manual' | 'recovered' | 'expired' | 'deleted' | 'restart'

export interface Reading {
  label: string
  /** Requests in the last minute. */
  req: number
  error: number
  p95: number
}
export interface Card {
  message: number
  room: string
  kind: CardKind
  node: string
  label: string
  started: number
  /** Epoch ms of the newest reading. */
  updated: number
  /** Requests per refresh window, oldest first. */
  readings: number[]
  last: Reading
  /** The node had errors when the card was posted. */
  startedWithErrors: boolean
  quiet: number
  status: 'live' | 'frozen'
  frozen_at: number | null
  reason: FreezeReason | null
  /** Admin who posted it. */
  by: string
  link: string | null
}

const BARS = '▁▂▃▄▅▆▇█'

/** Block-character sparkline, scaled to the series' own maximum (all zero draws the floor). */
export function sparkText(values: number[]): string {
  if (!values.length) return ''
  const max = Math.max(...values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0)))
  return values
    .map((v) => {
      const x = Number.isFinite(v) && v > 0 ? v : 0
      return BARS[max <= 0 ? 0 : Math.min(7, Math.round((x / max) * 7))]
    })
    .join('')
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16).concat(' UTC')

const FREEZE_WORDS: Record<FreezeReason, string> = {
  manual: 'frozen by an admin',
  recovered: 'incident over, no errors for a while',
  expired: 'stopped refreshing after two hours',
  deleted: 'message deleted',
  restart: 'the server restarted'
}

/** The message text for a card's current state. */
export function renderCard(c: Card): string {
  const r = c.last
  const fig = `${Math.round(r.req).toLocaleString('en-US')} req/min · ${Math.round(r.error).toLocaleString('en-US')} error${Math.round(r.error) === 1 ? '' : 's'} · p95 ${Math.round(r.p95).toLocaleString('en-US')} ms`
  const lines = [`Traffic Map: ${c.label}`, `${sparkText(c.readings)}  ${fig}`]
  if (c.status === 'live') {
    lines.push(
      `Live, refreshed ${clock(c.updated)}, updates every ${REFRESH_MS / 1000} s while the incident lasts.`
    )
  } else {
    lines.push(
      `Frozen at ${clock(c.frozen_at ?? Date.now())} (${FREEZE_WORDS[c.reason ?? 'manual']}). These are its last values.`
    )
  }
  if (c.link) lines.push(c.link)
  return lines.join('\n')
}

/**
 * Pure: fold one new reading (null = the node is not in the snapshot any more, read as zero)
 * into the card. Returns the freeze reason when the card should freeze now.
 */
export function stepCard(c: Card, reading: Reading | null, now: number): FreezeReason | null {
  const r = reading ?? { label: c.label, req: 0, error: 0, p95: 0 }
  c.last = { ...r, label: c.label }
  c.updated = now
  c.readings.push(Math.round(r.req))
  if (c.readings.length > READINGS_CAP) c.readings.splice(0, c.readings.length - READINGS_CAP)
  c.quiet = r.error > 0 ? 0 : c.quiet + 1
  if (now - c.started >= MAX_LIVE_MS) return 'expired'
  if (c.startedWithErrors && c.quiet >= QUIET_REFRESHES) return 'recovered'
  return null
}

export function freezeCard(c: Card, reason: FreezeReason, now: number): void {
  c.status = 'frozen'
  c.frozen_at = now
  c.reason = reason
}

interface State {
  cards: Map<number, Card>
  timers: Map<number, ReturnType<typeof setInterval>>
}
const state = () => tapState<State>('chat-cards', () => ({ cards: new Map(), timers: new Map() }))

export function liveCards(): Card[] {
  return [...state().cards.values()].sort((a, b) => b.started - a.started)
}
export function cardById(message: number): Card | undefined {
  return state().cards.get(message)
}

export interface CardIo {
  /** Newest one-minute figure of the node, null when it has none. */
  read(kind: CardKind, node: string): Reading | null
  /** Rewrite the chat message; false when the message is gone. */
  write(message: number, text: string): Promise<boolean>
}

/** Start refreshing a freshly posted card. Throws when MAX_LIVE_CARDS are already live. */
export function startCard(card: Card, io: CardIo): void {
  const st = state()
  const live = [...st.cards.values()].filter((c) => c.status === 'live').length
  if (live >= MAX_LIVE_CARDS) throw new Error(`At most ${MAX_LIVE_CARDS} live cards at a time`)
  st.cards.set(card.message, card)
  const timer = setInterval(() => void tick(card.message, io), REFRESH_MS)
  timer.unref?.()
  st.timers.set(card.message, timer)
}

async function tick(message: number, io: CardIo): Promise<void> {
  const st = state()
  const card = st.cards.get(message)
  if (!card || card.status !== 'live') return stopTimer(message)
  const now = Date.now()
  const reason = stepCard(card, io.read(card.kind, card.node), now)
  if (reason) freezeCard(card, reason, now)
  const ok = await io.write(message, renderCard(card)).catch(() => true)
  if (!ok) freezeCard(card, 'deleted', now)
  if (reason || !ok) stopTimer(message)
}

function stopTimer(message: number): void {
  const st = state()
  const t = st.timers.get(message)
  if (t) clearInterval(t)
  st.timers.delete(message)
}

/** Freeze now and write the final text. */
export async function freezeNow(message: number, io: CardIo): Promise<Card | null> {
  const card = state().cards.get(message)
  if (!card) return null
  if (card.status === 'live') {
    freezeCard(card, 'manual', Date.now())
    stopTimer(message)
    await io.write(message, renderCard(card)).catch(() => false)
  }
  return card
}

/** Test seam: forget every card and timer in the current store. */
export function resetCards(): void {
  const st = state()
  for (const m of [...st.timers.keys()]) stopTimer(m)
  st.cards.clear()
}
