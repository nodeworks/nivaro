import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  updated: [] as Array<Record<string, unknown>>,
  calls: [] as unknown[][]
}))
vi.mock('../db/index.js', () => ({
  db: () => {
    const q: any = {
      where: () => q,
      update: async (patch: Record<string, unknown>) => {
        h.updated.push(patch)
        return 1
      }
    }
    return q
  }
}))
vi.mock('./activity.js', () => ({ logActivity: async () => 1 }))
vi.mock('./issue-raise.js', () => ({ noteIssueWrite: () => {} }))
vi.mock('./trackers/outbound-sync.js', () => ({
  afterIssueChange: async (...a: unknown[]) => {
    h.calls.push(a)
  }
}))

import { sendToTrackers, setIssueStatus } from './issue-status.js'

beforeEach(() => {
  h.updated = []
  h.calls = []
})

describe('issue writes → GitLab sync', () => {
  it('a change read from GitLab is never sent back', async () => {
    await sendToTrackers([5], { status: 'open' }, { userId: 'BOT', via: 'gitlab' }, 1)
    await setIssueStatus(5, 'open', { userId: 'BOT', via: 'gitlab' })
    await new Promise((r) => setTimeout(r, 0))
    expect(h.calls).toHaveLength(0)
  })

  it("a person's status change is sent with the write time; other fields are not", async () => {
    await sendToTrackers([5], { status: 'resolved' }, { userId: 'U1', via: 'user' }, 123)
    expect(h.calls).toEqual([[[5], { status: 'resolved' }, { userId: 'U1', via: 'user' }, 123]])
    await sendToTrackers([5], { title: 'x' }, { userId: 'U1', via: 'user' }, 124)
    expect(h.calls).toHaveLength(1)
    // through the real write path: the hook gets the same time as updated_at
    await setIssueStatus(5, 'open', { userId: 'U1', via: 'user' })
    await vi.waitFor(() => expect(h.calls).toHaveLength(2))
    expect(h.calls[1][3]).toBe((h.updated[0].updated_at as Date).getTime())
  })
})
