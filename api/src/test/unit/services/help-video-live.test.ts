// api/src/test/unit/services/help-video-live.test.ts — #1832 #1879 #1880 #1978
import { afterEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => ({
  rooms: [] as Array<{ room: string; event: string; payload: Record<string, unknown> }>,
  tenant: [] as Array<{ tenant: string; event: string; payload: Record<string, unknown> }>
}))

vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) =>
        sent.rooms.push({ room, event, payload })
    })
  })
}))
vi.mock('../../../services/record-events.js', () => ({
  // run the fire callback on the next tick, like the real keyed throttle's first fire
  keyedThrottle: (_d: number, _g: number, fire: (key: string) => void) => (key: string) =>
    fire(key),
  emitToTenant: (tenant: string, event: string, payload: Record<string, unknown>) =>
    sent.tenant.push({ tenant, event, payload })
}))

import {
  announceHelpVideoChanged,
  announceHelpVideoQuestion
} from '../../../services/help-video-live.js'

afterEach(() => {
  sent.rooms.length = 0
  sent.tenant.length = 0
})

describe('help video live signals', () => {
  it('a change goes to the tenant with ids and the kind only', () => {
    announceHelpVideoChanged('ABC-123', 'render')
    expect(sent.tenant).toHaveLength(1)
    expect(sent.tenant[0].event).toBe('help-video:changed')
    expect(Object.keys(sent.tenant[0].payload).sort()).toEqual(['at', 'kind', 'video_id'])
    expect(sent.tenant[0].payload).toMatchObject({ video_id: 'abc-123', kind: 'render' })
  })

  it('a question signal reaches each named person once, on their own room, with ids only', () => {
    announceHelpVideoQuestion(['U1', 'U2', 'U1'], 'VID', 'Q1', 'answered')
    expect(sent.rooms.map((r) => r.room)).toEqual(['user:U1', 'user:U2'])
    for (const r of sent.rooms) {
      expect(r.event).toBe('help-video:question')
      expect(Object.keys(r.payload).sort()).toEqual(['at', 'kind', 'question_id', 'video_id'])
    }
  })
})
