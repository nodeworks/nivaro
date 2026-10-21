import { describe, expect, it } from 'vitest'
import { opsTopicGate } from '../../../services/ops-live.js'
import {
  addTopicViewer,
  cleanSelectionKey,
  isPresenceTopic,
  isSelectionTopic,
  removeSocketFromTopics,
  setTopicViewerSelection,
  topicViewers
} from '../../../services/presence-topics.js'

describe('layout editor presence (#2651)', () => {
  it('layout:<id> is an admin topic with a viewer list and selections', () => {
    expect(opsTopicGate('layout:42')).toEqual({ topic: 'layout:42', gate: 'admin' })
    expect(opsTopicGate('layout:abc')).toBeNull()
    expect(isPresenceTopic('layout:42')).toBe(true)
    expect(isSelectionTopic('layout:42')).toBe(true)
    expect(isSelectionTopic('ticket:42')).toBe(false)
  })

  it('accepts design target keys only', () => {
    expect(cleanSelectionKey('field:status:main')).toBe('field:status:main')
    expect(cleanSelectionKey('group:__ungrouped__')).toBe('group:__ungrouped__')
    expect(cleanSelectionKey('header:title')).toBe('header:title')
    expect(cleanSelectionKey('<img src=x>')).toBeNull()
    expect(cleanSelectionKey('field:a b')).toBeNull()
    expect(cleanSelectionKey(`field:${'x'.repeat(300)}`)).toBeNull()
    expect(cleanSelectionKey(12)).toBeNull()
  })

  it('keeps one entry per person, with the latest selection', async () => {
    const room = 'ops:layout:7'
    addTopicViewer(room, 's1', { id: 'u1', name: 'Ana' })
    addTopicViewer(room, 's2', { id: 'U1', name: 'Ana' })
    addTopicViewer(room, 's3', { id: 'u2', name: 'Ben' })
    expect(topicViewers(room)).toEqual([
      { id: 'u1', name: 'Ana' },
      { id: 'u2', name: 'Ben' }
    ])
    expect(setTopicViewerSelection(room, 's1', 'field:a:main')).toBe(true)
    await new Promise((r) => setTimeout(r, 2))
    expect(setTopicViewerSelection(room, 's2', 'group:main')).toBe(true)
    expect(setTopicViewerSelection(room, 'nobody', 'group:main')).toBe(false)
    expect(topicViewers(room)).toEqual([
      { id: 'U1', name: 'Ana', selected: 'group:main' },
      { id: 'u2', name: 'Ben' }
    ])
    for (const s of ['s1', 's2', 's3']) removeSocketFromTopics(s)
    expect(topicViewers(room)).toEqual([])
  })
})
