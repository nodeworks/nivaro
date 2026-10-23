/**
 * Who is looking at a ticket or an issue, and who is typing, right now. Live
 * only: nothing here is stored, and everything names people, never content.
 *
 * Two shapes ride existing rooms:
 *   record signals   `record:signal {collection, item, kind, state, user}` to a
 *                    record room, from a socket already admitted to it.
 *   topic presence   `ops:changed {topic, viewers}` / `{topic, signal}` to the
 *                    `ops:<topic>` room of a ticket or issue page, from a socket
 *                    that passed that topic's join gate.
 */

import { boardPeerTopicViewers } from './realtime-board.js'

export interface TopicViewer {
  id: string
  name: string
  /** Layout editor (#2651): the design target key this person has selected, if any. */
  selected?: string | null
  /** When `selected` last changed (ms) — the newest of one person's tabs wins. */
  at?: number
}

/** Topics whose room also keeps a viewer list. */
const PRESENCE_TOPIC = /^(ticket|issue-view|layout):\d{1,12}$/

export function isPresenceTopic(topic: string): boolean {
  return PRESENCE_TOPIC.test(topic)
}

/** Topics whose viewers may say what they have selected (the layout editor). */
export function isSelectionTopic(topic: string): boolean {
  return /^layout:\d{1,12}$/.test(topic)
}

/**
 * A design target key as the layout editor writes it (`field:<f>:<group>`,
 * `group:<key>`, `slot:…`, `header:<f>`) — identifiers and colons only, short.
 * Anything else is no selection.
 */
export function cleanSelectionKey(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 200) return null
  return /^(field|slot|group|header):[A-Za-z0-9_:.-]*$/.test(v) ? v : null
}

/** Kinds a person may announce on a record they sit in. */
export const RECORD_SIGNAL_KINDS = new Set(['note', 'transition'])
/** Kinds a person may announce on a ticket page. */
export const TOPIC_SIGNAL_KINDS = new Set(['reply'])

export type SignalState = 'start' | 'stop'

export function cleanSignalState(v: unknown): SignalState | null {
  return v === 'start' || v === 'stop' ? v : null
}

// room → socket id → person. Per node, like the record viewer lists.
const viewersByRoom = new Map<string, Map<string, TopicViewer>>()

export function addTopicViewer(room: string, socketId: string, viewer: TopicViewer): void {
  let m = viewersByRoom.get(room)
  if (!m) {
    m = new Map()
    viewersByRoom.set(room, m)
  }
  m.set(socketId, viewer)
}

export function removeTopicViewer(room: string, socketId: string): boolean {
  const m = viewersByRoom.get(room)
  if (!m?.delete(socketId)) return false
  if (m.size === 0) viewersByRoom.delete(room)
  return true
}

/** Drop a socket from every topic it sat in; the rooms whose list changed. */
export function removeSocketFromTopics(socketId: string): string[] {
  const changed: string[] = []
  for (const room of [...viewersByRoom.keys()])
    if (removeTopicViewer(room, socketId)) changed.push(room)
  return changed
}

/** A viewer's selection changed; false when the socket is not a viewer of the room. */
export function setTopicViewerSelection(
  room: string,
  socketId: string,
  selected: string | null
): boolean {
  const v = viewersByRoom.get(room)?.get(socketId)
  if (!v) return false
  v.selected = selected
  v.at = Date.now()
  return true
}

/** This process's viewer lists, one entry per socket (the realtime board publishes them). */
export function localTopicViewerEntries(): Record<string, Array<TopicViewer & { socket: string }>> {
  const out: Record<string, Array<TopicViewer & { socket: string }>> = {}
  for (const [room, m] of viewersByRoom) out[room] = [...m].map(([socket, v]) => ({ socket, ...v }))
  return out
}

/**
 * One entry per person, whatever the number of tabs (the latest selection wins). With several
 * realtime processes the others' viewers come from the realtime board (post-mortem 3.3), a few
 * seconds old; a single process has none.
 */
export function topicViewers(room: string): TopicViewer[] {
  const byPerson = new Map<string, TopicViewer>()
  for (const v of [...(viewersByRoom.get(room)?.values() ?? []), ...boardPeerTopicViewers(room)]) {
    const key = v.id.toUpperCase()
    const cur = byPerson.get(key)
    if (!cur || (v.at ?? 0) > (cur.at ?? 0)) byPerson.set(key, v)
  }
  return [...byPerson.values()].map((v) =>
    v.selected === undefined
      ? { id: v.id, name: v.name }
      : { id: v.id, name: v.name, selected: v.selected }
  )
}
