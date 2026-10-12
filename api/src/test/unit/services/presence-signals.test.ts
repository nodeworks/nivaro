import { describe, expect, it } from 'vitest'
import { seenAt } from '../../../services/mention-receipts.js'
import { opsTopicGate } from '../../../services/ops-live.js'
import { dndActive } from '../../../services/presence-stuck.js'
import {
  addTopicViewer,
  cleanSignalState,
  isPresenceTopic,
  RECORD_SIGNAL_KINDS,
  removeSocketFromTopics,
  removeTopicViewer,
  TOPIC_SIGNAL_KINDS,
  topicViewers
} from '../../../services/presence-topics.js'
import { movesNotificationState } from '../../../services/user-sync.js'

describe('topic presence', () => {
  it('knows which topics keep a viewer list', () => {
    expect(isPresenceTopic('ticket:12')).toBe(true)
    expect(isPresenceTopic('issue-view:7')).toBe(true)
    expect(isPresenceTopic('issues')).toBe(false)
    expect(isPresenceTopic('issue:7')).toBe(false)
    expect(isPresenceTopic('ticket:abc')).toBe(false)
  })

  it('gates the topics: tickets by ticket visibility, issue pages for anyone signed in', () => {
    expect(opsTopicGate('ticket:12')).toEqual({ topic: 'ticket:12', gate: 'ticket' })
    expect(opsTopicGate('issue-view:3')).toEqual({ topic: 'issue-view:3', gate: 'auth' })
    // The occurrence stream still names people, so it stays admin-only.
    expect(opsTopicGate('issue:3')).toEqual({ topic: 'issue:3', gate: 'admin' })
    expect(opsTopicGate('ticket:../x')).toBeNull()
  })

  it('lists one entry per person across tabs and drops a socket everywhere', () => {
    const room = 'ops:ticket:1'
    addTopicViewer(room, 's1', { id: 'U1', name: 'Kim' })
    addTopicViewer(room, 's2', { id: 'u1', name: 'Kim' })
    addTopicViewer(room, 's3', { id: 'U2', name: 'Beth' })
    expect(topicViewers(room).map((v) => v.name)).toEqual(['Kim', 'Beth'])
    expect(removeTopicViewer(room, 's1')).toBe(true)
    expect(topicViewers(room)).toHaveLength(2)
    expect(removeSocketFromTopics('s2')).toEqual([room])
    expect(topicViewers(room).map((v) => v.name)).toEqual(['Beth'])
    expect(removeSocketFromTopics('s3')).toEqual([room])
    expect(topicViewers(room)).toEqual([])
  })

  it('accepts only known signal kinds and states', () => {
    expect(RECORD_SIGNAL_KINDS.has('note')).toBe(true)
    expect(RECORD_SIGNAL_KINDS.has('transition')).toBe(true)
    expect(RECORD_SIGNAL_KINDS.has('reply')).toBe(false)
    expect(TOPIC_SIGNAL_KINDS.has('reply')).toBe(true)
    expect(cleanSignalState('start')).toBe('start')
    expect(cleanSignalState('stop')).toBe('stop')
    expect(cleanSignalState('x')).toBeNull()
  })
})

describe('do not disturb', () => {
  it('is on without an end, until the end passes, and off when unset', () => {
    const now = Date.parse('2026-10-12T12:00:00Z')
    expect(dndActive({}, now)).toBe(false)
    expect(dndActive({ dnd: null }, now)).toBe(false)
    expect(dndActive({ dnd: { until: null } }, now)).toBe(true)
    expect(dndActive({ dnd: { until: '2026-10-12T13:00:00Z' } }, now)).toBe(true)
    expect(dndActive({ dnd: { until: '2026-10-12T11:00:00Z' } }, now)).toBe(false)
  })
})

describe('read state sync', () => {
  it('fires for the routes that move unread state, not for reads', () => {
    expect(movesNotificationState('POST', '/12/read')).toBe(true)
    expect(movesNotificationState('POST', '/read-all')).toBe(true)
    expect(movesNotificationState('POST', '/mark-read?x=1')).toBe(true)
    expect(movesNotificationState('POST', '/bulk-action')).toBe(true)
    expect(movesNotificationState('DELETE', '/12')).toBe(true)
    expect(movesNotificationState('GET', '/12')).toBe(false)
    expect(movesNotificationState('POST', '/message-stakeholders')).toBe(false)
  })
})

describe('mention read receipts', () => {
  const wrote = new Date('2026-10-12T10:00:00Z')
  it('is unseen with no watermark', () => {
    expect(seenAt(wrote, null, [])).toBeNull()
  })
  it('counts a record open after the note', () => {
    const opened = new Date('2026-10-12T10:05:00Z')
    expect(seenAt(wrote, opened, [])?.toISOString()).toBe(opened.toISOString())
  })
  it('ignores a record open before the note', () => {
    expect(seenAt(wrote, new Date('2026-10-12T09:00:00Z'), [])).toBeNull()
  })
  it('counts a read mention notification and takes the earliest sign', () => {
    const read = new Date('2026-10-12T10:02:00Z')
    const opened = new Date('2026-10-12T10:30:00Z')
    expect(seenAt(wrote, opened, [read])?.toISOString()).toBe(read.toISOString())
  })
})
