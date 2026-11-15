import { beforeEach, describe, expect, it, vi } from 'vitest'

// Realtime round 7: marking read in a View-as tab never stamps read_at — acknowledging included.

const updates: Array<Record<string, unknown>> = []
const row = { id: 7, detail: JSON.stringify({ ack_required: true }) }

vi.mock('../../../db/index.js', () => {
  const builder = () => {
    const b: Record<string, unknown> = {}
    b.where = () => b
    b.first = async () => row
    b.update = async (v: Record<string, unknown>) => {
      updates.push(v)
      return 1
    }
    return b
  }
  return { db: Object.assign(vi.fn(builder), { schema: {} }) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

import { acknowledgeNotification } from '../../../services/notification-ack.js'
import { readMark } from '../../../services/notification-read-mark.js'

const viewAs = { authMethod: 'masquerade', masqueradeAdminId: 'ADMIN-1' }
const own = { authMethod: 'session' }

describe('readMark', () => {
  it('stamps read_at for the person, never for View-as', () => {
    expect(readMark(own)).toMatchObject({ status: 'read' })
    expect(readMark(own).read_at).toBeInstanceOf(Date)
    expect(readMark(undefined).read_at).toBeInstanceOf(Date)
    expect(readMark(viewAs)).toEqual({ status: 'read' })
  })
})

describe('acknowledging a notification', () => {
  beforeEach(() => {
    updates.length = 0
  })
  const user = { id: 'U-1' } as never

  it('as the person: read with read_at', async () => {
    const r = await acknowledgeNotification({} as never, user, 7, own as never)
    expect(r.status).toBe(200)
    expect(updates[0].status).toBe('read')
    expect(updates[0].read_at).toBeInstanceOf(Date)
  })

  it('in a View-as tab: read, acknowledged, but no read_at', async () => {
    const r = await acknowledgeNotification({} as never, user, 7, viewAs as never)
    expect(r.status).toBe(200)
    expect(updates[0].status).toBe('read')
    expect('read_at' in updates[0]).toBe(false)
    expect(String(updates[0].detail)).toContain('ack_at')
  })
})
