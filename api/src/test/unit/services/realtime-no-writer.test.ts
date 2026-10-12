import { beforeEach, describe, expect, it, vi } from 'vitest'

const emitted = vi.hoisted(() => [] as Array<{ room: string; event: string; payload: any }>)

vi.mock('../../../services/event-journal.js', () => ({
  journaledEmit: vi.fn(async (room: string, event: string, payload: unknown) => {
    emitted.push({ room, event, payload })
    return { seq: 1, path: 'adapter', room }
  })
}))
vi.mock('../../../services/item-events.js', () => ({ publishItemEvent: vi.fn() }))
vi.mock('../../../services/sse-hub.js', () => ({ publishSseEvent: vi.fn() }))
vi.mock('../../../services/traffic-map.js', () => ({ noteWrite: vi.fn() }))

import { broadcastCollectionUpdate } from '../../../services/realtime.js'

beforeEach(() => {
  emitted.length = 0
})

describe('collection:update never names the writer', () => {
  it('carries ids, action and field names only, even if a caller passes extra keys', () => {
    broadcastCollectionUpdate(undefined, 'articles', '7', {
      action: 'update',
      changed_fields: ['title'],
      by: 'U1'
    } as never)
    const p = emitted[0].payload
    expect(p).toEqual({
      collection: 'articles',
      item: '7',
      action: 'update',
      changed_fields: ['title']
    })
    expect('by' in p).toBe(false)
  })
})
