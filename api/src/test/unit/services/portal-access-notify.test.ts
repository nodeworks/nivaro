import { describe, expect, it, vi } from 'vitest'

// army7 b10: access-request notices to admins carried no category, so they
// landed under "Everything else" and could not be routed or muted on their own.

const sent = vi.hoisted(() => [] as Array<{ userId: string; opts: Record<string, unknown> }>)

vi.mock('../../../db/index.js', () => {
  const admins = [
    { id: 'A1', email: 'a1@example.com', account_kind: null },
    { id: 'A2', email: 'a2@example.com', account_kind: null }
  ]
  const db = () => {
    const qb: any = {
      join: () => qb,
      where: () => qb,
      limit: () => qb,
      select: async () => admins
    }
    return qb
  }
  return { db: Object.assign(db, { schema: { hasTable: async () => true } }) }
})
vi.mock('../../../services/machine-accounts.js', () => ({ isMachineAccount: () => false }))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: async (_app: unknown, userId: string, opts: Record<string, unknown>) => {
    sent.push({ userId, opts })
    return { id: 1 }
  }
}))

const { notifyAdminsOfAccessRequest, ACCESS_REQUEST_NOTIFY_CATEGORY } = await import(
  '../../../services/portal-access-request.js'
)

describe('notifyAdminsOfAccessRequest', () => {
  it('files every notice under a real category, never "other"', async () => {
    const told = await notifyAdminsOfAccessRequest(
      {} as never,
      { id: 'REQ', name: 'Sophie' },
      { reason: 'Need forecasting access' }
    )
    expect(told).toBe(2)
    expect(ACCESS_REQUEST_NOTIFY_CATEGORY).not.toBe('other')
    for (const s of sent) expect(s.opts.category).toBe(ACCESS_REQUEST_NOTIFY_CATEGORY)
  })

  it('emails every admin, whatever their own rules say (Rob 2026-11-10)', async () => {
    sent.length = 0
    await notifyAdminsOfAccessRequest(
      {} as never,
      { id: 'REQ', name: 'Sophie' },
      { reason: 'Need forecasting access' }
    )
    expect(sent.length).toBeGreaterThan(0)
    for (const s of sent) expect(s.opts.channels).toEqual({ email: true })
  })
})
