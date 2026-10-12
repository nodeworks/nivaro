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

export interface TopicViewer {
  id: string
  name: string
}

/** Topics whose room also keeps a viewer list. */
const PRESENCE_TOPIC = /^(ticket|issue-view):\d{1,12}$/

export function isPresenceTopic(topic: string): boolean {
  return PRESENCE_TOPIC.test(topic)
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

/** One entry per person, whatever the number of tabs. */
export function topicViewers(room: string): TopicViewer[] {
  const seen = new Set<string>()
  const out: TopicViewer[] = []
  for (const v of viewersByRoom.get(room)?.values() ?? []) {
    const key = v.id.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}
