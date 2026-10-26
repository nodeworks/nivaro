import { describe, expect, it, vi } from 'vitest'

// chat-records.ts keeps no room-type cache of its own: it reads chat.ts's per-tenant
// registry (cleared on every replica) and clearRoomTypeCache clears that registry.
const { clearChatCaches } = vi.hoisted(() => ({ clearChatCaches: vi.fn() }))
vi.mock('./chat.js', () => ({
  activeRoomTypeRows: async () => [
    {
      id: 1,
      prefix: 'wf',
      collection: 'workflows',
      match_field: 'id',
      label: 'Workflow',
      is_active: 1,
      post_activity: 0,
      owners_follow: 1
    }
  ],
  canSeeRoom: async () => true,
  clearChatCaches,
  parseRoom: (room: string) => ({ kind: 'entity', room })
}))

import { clearRoomTypeCache, roomTypes } from './chat-records.js'

describe('chat-records room types', () => {
  it('reads the registry rows and normalizes the flags', async () => {
    expect(await roomTypes()).toEqual([
      {
        id: 1,
        prefix: 'wf',
        collection: 'workflows',
        match_field: 'id',
        label: 'Workflow',
        is_active: true,
        post_activity: false,
        owners_follow: true
      }
    ])
  })

  it('clearRoomTypeCache clears the shared registry (and so every replica)', () => {
    clearRoomTypeCache()
    expect(clearChatCaches).toHaveBeenCalledTimes(1)
  })
})
