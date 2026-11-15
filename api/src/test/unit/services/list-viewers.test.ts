import { describe, expect, it } from 'vitest'
import {
  isListViewTopic,
  listViewerJoinPlan,
  parseListViewTopic
} from '../../../services/list-viewer-topics.js'
import { opsTopicGate } from '../../../services/ops-live.js'
import {
  addTopicViewer,
  removeSocketFromTopics,
  topicViewers
} from '../../../services/presence-topics.js'

// "Beth and 2 others are viewing this list" is for administrators only (Rob's rule): anyone
// who may read the list announces themselves, only administrators join the room the names go
// to, and a View-as socket never announces.

describe('list viewer topics', () => {
  it('names a list or a queue and gates it as a viewer topic', () => {
    expect(opsTopicGate('list-view:workflows')).toEqual({
      topic: 'list-view:workflows',
      gate: 'viewers'
    })
    const q = 'queue-view:3F2A9C1E-0000-4000-8000-000000000001'
    expect(opsTopicGate(q)).toEqual({ topic: q, gate: 'viewers' })
    expect(parseListViewTopic('list-view:inventory_request')).toEqual({
      kind: 'list',
      id: 'inventory_request'
    })
    expect(parseListViewTopic('queue-view:12')).toEqual({ kind: 'queue', id: '12' })
  })

  it('refuses system tables, odd names and other topics', () => {
    expect(isListViewTopic('list-view:nivaro_users')).toBe(false)
    expect(isListViewTopic('list-view:directus_files')).toBe(false)
    expect(isListViewTopic('list-view:9lives')).toBe(false)
    expect(isListViewTopic('list-view:a b')).toBe(false)
    expect(isListViewTopic('list-view:')).toBe(false)
    expect(isListViewTopic('queue-view:../x')).toBe(false)
    expect(opsTopicGate(`list-view:${'a'.repeat(80)}`)).toBeNull()
    // Unchanged neighbours.
    expect(opsTopicGate('layout:4')).toEqual({ topic: 'layout:4', gate: 'admin' })
    expect(opsTopicGate(`ticket:${'1'.repeat(50)}`)).toBeNull()
  })

  it('lets only administrators hear the names', () => {
    expect(listViewerJoinPlan({ isAdmin: false, viewAs: false, mayRead: true })).toEqual({
      listen: false,
      announce: true
    })
    expect(listViewerJoinPlan({ isAdmin: true, viewAs: false, mayRead: true })).toEqual({
      listen: true,
      announce: true
    })
    // Someone who cannot read the list is not counted on it.
    expect(listViewerJoinPlan({ isAdmin: false, viewAs: false, mayRead: false })).toEqual({
      listen: false,
      announce: false
    })
  })

  it('never shows a View-as session — neither the admin behind it nor the person', () => {
    expect(listViewerJoinPlan({ isAdmin: false, viewAs: true, mayRead: true }).announce).toBe(false)
    // Viewing as an administrator: that administrator's own view (listens), still not counted.
    expect(listViewerJoinPlan({ isAdmin: true, viewAs: true, mayRead: true })).toEqual({
      listen: true,
      announce: false
    })
  })

  it('lists each person once, by name only', () => {
    const room = 'ops:list-view:workflows'
    addTopicViewer(room, 's1', { id: 'u-beth', name: 'Beth Ames' })
    addTopicViewer(room, 's2', { id: 'U-BETH', name: 'Beth Ames' })
    addTopicViewer(room, 's3', { id: 'u-ana', name: 'Ana Ruiz' })
    expect(topicViewers(room)).toEqual([
      { id: 'u-beth', name: 'Beth Ames' },
      { id: 'u-ana', name: 'Ana Ruiz' }
    ])
    for (const s of ['s1', 's2', 's3']) removeSocketFromTopics(s)
    expect(topicViewers(room)).toEqual([])
  })
})
