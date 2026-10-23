import { beforeEach, describe, expect, it, vi } from 'vitest'

const emitted = vi.hoisted(() => [] as Array<{ room: string; event: string; payload: any }>)

vi.mock('../../../services/event-journal.js', () => ({
  journaledEmit: vi.fn(async (room: string, event: string, payload: unknown) => {
    emitted.push({ room, event, payload })
    return { seq: 1, path: 'adapter', room }
  })
}))
vi.mock('../../../services/item-events.js', () => ({
  publishItemEvent: vi.fn(),
  publishCollectionTouched: vi.fn()
}))
vi.mock('../../../services/sse-hub.js', () => ({ publishSseEvent: vi.fn() }))
vi.mock('../../../services/traffic-map.js', () => ({ noteWrite: vi.fn() }))
vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))

import { isQuietPresenceWrite } from '../../../services/collection-live-mode.js'
import { broadcastCollectionUpdate } from '../../../services/realtime.js'

beforeEach(() => {
  emitted.length = 0
})

describe('user_presence heartbeats send nothing live', () => {
  it('a heartbeat PATCH or first-beat create is quiet', () => {
    broadcastCollectionUpdate(undefined, 'user_presence', 5, {
      action: 'update',
      changed_fields: ['last_seen', 'is_online', 'current_path', 'is_idle', 'last_active']
    })
    broadcastCollectionUpdate(undefined, 'user_presence', 6, {
      action: 'create',
      changed_fields: ['user_id', 'last_seen']
    })
    broadcastCollectionUpdate(undefined, 'user_presence', 7)
    expect(emitted).toEqual([])
  })

  it('typing changes and deletes still go out', () => {
    broadcastCollectionUpdate(undefined, 'user_presence', 5, {
      action: 'update',
      changed_fields: ['typing_room']
    })
    broadcastCollectionUpdate(undefined, 'user_presence', 5, { action: 'delete' })
    expect(emitted.map((e) => [e.room, e.payload.action])).toEqual([
      ['collection:user_presence', 'update'],
      ['collection:user_presence', 'delete']
    ])
  })

  it('other collections are untouched', () => {
    expect(isQuietPresenceWrite('articles', { action: 'update', changed_fields: ['x'] })).toBe(
      false
    )
    broadcastCollectionUpdate(undefined, 'articles', 1, {
      action: 'update',
      changed_fields: ['last_seen']
    })
    expect(emitted).toHaveLength(1)
  })
})
