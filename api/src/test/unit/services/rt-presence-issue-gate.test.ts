import { beforeEach, describe, expect, it, vi } from 'vitest'

const issueRow: { current: Record<string, unknown> | undefined } = { current: undefined }
vi.mock('../../../auth/session.js', () => ({ REVOKED_PREFIX: 'sess:revoked:' }))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({
    where: () => ({ first: async () => issueRow.current })
  }))
}))
const readOne = vi.fn(async (): Promise<unknown> => null)
vi.mock('../../../services/items.js', () => ({ readOne }))

const { canJoinIssueTopic, roomStillAllowed } = await import('../../../services/socket-access.js')
const { opsTopicGate } = await import('../../../services/ops-live.js')

const amy = { id: 'u-amy', role: 'r-staff' } as never

describe('M6 — issue-view presence admits only people who may open the issue', () => {
  beforeEach(() => {
    readOne.mockReset()
    readOne.mockResolvedValue(null)
    issueRow.current = {
      id: 57,
      raised_by: 'U-BEN',
      assigned_to: null,
      source: 'system',
      collection: null,
      item: null
    }
  })

  it('the topic carries its own gate, not plain sign-in', () => {
    expect(opsTopicGate('issue-view:57')).toEqual({ topic: 'issue-view:57', gate: 'issue' })
  })

  it('administrators, the reporter and the assignee; nobody else', async () => {
    expect(await canJoinIssueTopic(amy, 57, true)).toBe(true)
    expect(await canJoinIssueTopic(amy, 57, false)).toBe(false)
    issueRow.current = { ...issueRow.current, raised_by: 'U-AMY' }
    expect(await canJoinIssueTopic(amy, 57, false)).toBe(true)
    issueRow.current = { ...issueRow.current, raised_by: null, assigned_to: 'u-amy' }
    expect(await canJoinIssueTopic(amy, 57, false)).toBe(true)
  })

  it('a manual issue on a record the person can read; a system table never', async () => {
    issueRow.current = { id: 57, source: 'manual', collection: 'workflows', item: '9' }
    expect(await canJoinIssueTopic(amy, 57, false)).toBe(false)
    readOne.mockResolvedValue({ id: 9 })
    expect(await canJoinIssueTopic(amy, 57, false)).toBe(true)
    issueRow.current = { id: 57, source: 'manual', collection: 'nivaro_users', item: '9' }
    expect(await canJoinIssueTopic(amy, 57, false)).toBe(false)
  })

  it('a missing issue or a junk id is refused; the room re-check runs the same gate', async () => {
    issueRow.current = undefined
    expect(await canJoinIssueTopic(amy, 57, false)).toBe(false)
    expect(await canJoinIssueTopic(amy, -1, true)).toBe(false)
    issueRow.current = { id: 57, raised_by: 'u-ben' }
    expect(await roomStillAllowed(amy, 'ops:issue-view:57', async () => false)).toBe(false)
    expect(await roomStillAllowed(amy, 'ops:issue-view:57', async () => true)).toBe(true)
  })
})
