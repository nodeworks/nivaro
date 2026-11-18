import { beforeEach, describe, expect, it, vi } from 'vitest'

const users = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, failInsert: false }))
vi.mock('../../db/index.js', () => ({
  db: () => {
    const q: any = {
      where: () => q,
      orderBy: () => q,
      first: async () => {
        await new Promise((r) => setTimeout(r, 1))
        const sorted = [...users.rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
        return sorted[0] ? { id: sorted[0].id } : undefined
      },
      insert: async (row: Record<string, unknown>) => {
        await new Promise((r) => setTimeout(r, 1))
        if (users.failInsert) {
          users.rows.push({ id: 'AAAA-OTHER' })
          throw new Error('Violation of UNIQUE KEY constraint')
        }
        users.rows.push(row)
      }
    }
    return q
  }
}))

import { TRACKER_EMAIL, trackerUserId } from './identity.js'

beforeEach(() => {
  users.rows = []
  users.failInsert = false
})

describe('trackerUserId (final review: create race)', () => {
  it('concurrent first uses create the machine user once', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => trackerUserId()))
    expect(users.rows).toHaveLength(1)
    expect(new Set(ids).size).toBe(1)
    expect(users.rows[0]).toMatchObject({
      email: TRACKER_EMAIL,
      status: 'suspended',
      account_kind: 'integration'
    })
    expect(await trackerUserId()).toBe(ids[0])
  })

  it('an insert lost to another process reads the winner', async () => {
    users.failInsert = true
    expect(await trackerUserId()).toBe('AAAA-OTHER')
  })
})
