import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
const notify = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 1 }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: notify }))
vi.mock('../../../services/chaos/drill-alerts.js', () => ({
  drillAlert: vi.fn().mockResolvedValue(null),
  tellDrillParticipants: vi.fn(),
  withDrillNote: (m: string) => m
}))

import { db } from '../../../db/index.js'
import { normalizeTarget } from '../../../services/notification-target.js'
import { MONITOR_NOTICE_TARGET, raiseIssueForTests } from '../../../services/ops-monitors.js'

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PLAIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** nivaro_issues (no open issue yet), the subscriber list, and the admin lookup. */
function mockDb(adminIds: string[]) {
  vi.mocked(db).mockImplementation(((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'join', 'whereNot']) chain[m] = () => chain
    chain.first = async () => null
    chain.insert = async () => [1]
    chain.update = async () => 1
    chain.pluck = async () => (table === 'nivaro_monitor_subscribers' ? [ADMIN, PLAIN] : [])
    // The admin lookup: users joined to roles. SQL Server answers uuids in upper case.
    chain.select = () =>
      Promise.resolve(
        String(table).startsWith('nivaro_users')
          ? adminIds.map((id) => ({ id: id.toUpperCase() }))
          : []
      )
    return chain
  }) as never)
}

beforeEach(() => notify.mockClear())

describe('a "Monitor failing" notice opens the Monitors page', () => {
  it('for an administrator it carries the Monitors target; for anyone else none', async () => {
    mockDb([ADMIN])
    await raiseIssueForTests(
      { id: 20, name: 'Live updates late', type: 'delivery_node', created_by: null } as never,
      'Realtime delivery under 95%',
      {} as never
    )
    const byUser = new Map(notify.mock.calls.map((c) => [c[1] as string, c[2]]))
    expect(byUser.get(ADMIN)).toMatchObject({
      subject: 'Monitor failing: Live updates late',
      target: MONITOR_NOTICE_TARGET
    })
    // Someone who cannot open the page gets the notice as plain text, never a dead link.
    expect(byUser.get(PLAIN)?.subject).toBe('Monitor failing: Live updates late')
    expect(byUser.get(PLAIN)?.target ?? null).toBeNull()
  })

  it('still tells everyone when the admin lookup fails', async () => {
    mockDb([])
    vi.mocked(db).mockImplementation(((table: string) => {
      if (String(table).startsWith('nivaro_users')) throw new Error('lookup down')
      const chain: Record<string, unknown> = {}
      for (const m of ['where', 'whereIn']) chain[m] = () => chain
      chain.first = async () => null
      chain.insert = async () => [1]
      chain.pluck = async () => (table === 'nivaro_monitor_subscribers' ? [ADMIN, PLAIN] : [])
      return chain
    }) as never)
    await raiseIssueForTests(
      { id: 20, name: 'Live updates late', type: 'delivery_node', created_by: null } as never,
      'down',
      {} as never
    )
    expect(notify.mock.calls.map((c) => c[1]).sort()).toEqual([ADMIN, PLAIN])
    expect(notify.mock.calls.every((c) => c[2].target == null)).toBe(true)
  })

  it('names the admin page as a path the notification layer makes absolute', () => {
    const t = normalizeTarget(MONITOR_NOTICE_TARGET)
    expect(t?.kind).toBe('external')
    expect(t?.url).toMatch(/^https?:\/\/.+\/health\/monitors$/)
  })
})
