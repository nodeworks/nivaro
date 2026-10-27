import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/users.js', () => ({ canSignIn: () => true, getUser: vi.fn() }))

import { db } from '../../../db/index.js'
import {
  readConnectToken,
  resolveTeamsUser,
  signConnectToken
} from '../../../services/teams-bot/links.js'
import { buildTeamsNotificationCard } from '../../../services/teams-bot/notification-card.js'
import { getUser } from '../../../services/users.js'

afterEach(() => vi.useRealTimers())

describe('connect token', () => {
  it('round-trips and lowercases the object id', () => {
    const t = signConnectToken('ABC-123', 'tenant-1')
    expect(readConnectToken(t)).toEqual({ aadObjectId: 'abc-123', tenantId: 'tenant-1' })
  })
  it('rejects tampering and expiry', () => {
    const t = signConnectToken('abc', 'tenant')
    expect(readConnectToken(`${t}x`)).toBeNull()
    expect(readConnectToken(`x${t}`)).toBeNull()
    expect(readConnectToken('')).toBeNull()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    expect(readConnectToken(t)).toBeNull()
  })
})

describe('notification card actions', () => {
  const base = {
    userId: 'u',
    notificationId: 7,
    subject: 's',
    message: 'm',
    category: 'workflow' as const,
    openUrl: 'https://x.test'
  }
  const exec = (c: { actions?: Array<Record<string, any>> }) =>
    (c.actions ?? []).filter((a) => a.type === 'Action.Execute')

  it('an approval step pending for the recipient gets Approve and Reject', async () => {
    const card = await buildTeamsNotificationCard({
      ...base,
      target: { kind: 'approval', collection: 'pos', id: '5', instance_id: 12, action: 'review' }
    })
    const a = exec(card)
    expect(a.map((x) => x.data.action)).toEqual(['approved', 'rejected'])
    expect(a.every((x) => x.data.ref === '12')).toBe(true)
    expect(a[1].associatedInputs).toBe('auto')
    expect(new Set(a.map((x) => x.data.nonce)).size).toBe(2)
  })

  it('ack_required adds Acknowledge; nothing else adds no buttons', async () => {
    const ack = await buildTeamsNotificationCard({ ...base, target: null, ackRequired: true })
    expect(exec(ack).map((x) => x.data)).toMatchObject([{ kind: 'ack', ref: '7', action: 'ack' }])
    const plain = await buildTeamsNotificationCard({ ...base, target: null })
    expect(exec(plain)).toHaveLength(0)
  })
})

describe('resolveTeamsUser', () => {
  it('matches the stored oid with plain (index-friendly) equality on the lowercased ids', async () => {
    const calls: Array<[string, string, unknown[]]> = []
    vi.mocked(db).mockImplementation(((table: string) => {
      const p: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') return undefined
            if (prop === 'first')
              return async () => (table === 'nivaro_users' ? { id: 'u1' } : undefined)
            return (...a: unknown[]) => {
              calls.push([table, prop, a])
              return p
            }
          }
        }
      )
      return p
    }) as never)
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', status: 'active' } as never)
    const r = await resolveTeamsUser(' ABC-DEF ', 'TENANT-1')
    expect(r.user?.id).toBe('u1')
    const users = calls.filter(([t]) => t === 'nivaro_users')
    expect(users.some(([, m]) => m === 'whereRaw')).toBe(false)
    expect(users).toContainEqual(['nivaro_users', 'where', [{ entra_oid: 'abc-def' }]])
    expect(users).toContainEqual(['nivaro_users', 'where', [{ entra_tid: 'tenant-1' }]])
  })
})
