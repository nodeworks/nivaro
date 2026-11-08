import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  tables: new Map<string, Array<{ id: string | number }>>(),
  admins: [] as Array<{ id: string; email: string; account_kind: string | null }>,
  notified: [] as Array<{ userId: string; opts: Record<string, unknown> }>,
  /** A type-conversion failure for text ids on an int column. */
  failText: false
}))

vi.mock('../db/index.js', () => {
  const builder = (table: string) => {
    let ids: Array<string | number> | null = null
    const b: Record<string, unknown> = {
      join: () => b,
      where: () => b,
      limit: () => b,
      whereIn: (_c: string, v: Array<string | number>) => {
        ids = v
        return b
      },
      select: async () => {
        if (table.startsWith('nivaro_users')) return state.admins
        if (state.failText && ids?.some((v) => typeof v === 'string'))
          throw new Error('Conversion failed')
        const rows = state.tables.get(table) ?? []
        return rows.filter((r) => ids?.some((v) => String(v) === String(r.id)))
      }
    }
    return b
  }
  const db = Object.assign(builder, {
    schema: { hasTable: async (t: string) => state.tables.has(t) }
  })
  return { db }
})
vi.mock('./notification-channels.js', () => ({
  notifyUser: vi.fn(async (_app: unknown, userId: string, opts: Record<string, unknown>) => {
    state.notified.push({ userId, opts })
    return { id: 1 }
  })
}))

import {
  ACCESS_REASON_MAX,
  accessRequestOutcome,
  existingIds,
  mayRequestAccess,
  notifyAdminsOfAccessRequest,
  parseAccessRequestBody,
  sameRequest
} from './portal-access-request.js'

beforeEach(() => {
  state.tables = new Map([
    ['divisions', [{ id: 1 }, { id: 2 }, { id: 3 }]],
    ['vendors', [{ id: 753 }]]
  ])
  state.admins = []
  state.notified = []
  state.failText = false
})

describe('parseAccessRequestBody', () => {
  it('needs a reason and refuses one over the limit instead of cutting it', () => {
    expect(parseAccessRequestBody({ reason: '  ' })).toMatchObject({
      ok: false,
      code: 'REASON_REQUIRED'
    })
    expect(parseAccessRequestBody({ reason: 'x'.repeat(ACCESS_REASON_MAX + 1) })).toMatchObject({
      ok: false,
      code: 'REASON_TOO_LONG'
    })
    expect(parseAccessRequestBody({ reason: 'x'.repeat(ACCESS_REASON_MAX) }).ok).toBe(true)
  })

  it('keeps id-shaped zones only, once each, and drops a vendor object', () => {
    const p = parseAccessRequestBody({
      reason: 'Forecasting',
      divisions: [1, '2', 2, '2', { id: 3 }, '', null],
      vendor: { id: 5 },
      vendor_name: 'X'
    })
    expect(p).toEqual({
      ok: true,
      value: { divisions: [1, '2', 2], vendor: null, vendor_name: null, reason: 'Forecasting' }
    })
  })
})

describe('existingIds', () => {
  it('keeps only ids that exist, junk included', async () => {
    expect(await existingIds('divisions', [2, '3', 'abc', 99])).toEqual([2, '3'])
  })

  it('a text id the column cannot hold never fails the numeric ones', async () => {
    state.failText = true
    expect(await existingIds('divisions', ['abc', 1])).toEqual([1])
  })

  it('a database without the table keeps the ids as given', async () => {
    expect(await existingIds('no_such_table', ['a', 1])).toEqual(['a', 1])
  })
})

describe('sameRequest', () => {
  const base = { divisions: [1, 2], vendor: 753, vendor_name: 'V', reason: 'Need it' }
  it('is the same request whatever the zone order', () => {
    expect(sameRequest({ ...base, divisions: [2, 1], submitted_at: 'x' }, base)).toBe(true)
  })
  it('a changed reason, zone or vendor is a new request; no previous request is never the same', () => {
    expect(sameRequest({ ...base, reason: 'Other' }, base)).toBe(false)
    expect(sameRequest({ ...base, divisions: [1] }, base)).toBe(false)
    expect(sameRequest({ ...base, vendor: null }, base)).toBe(false)
    expect(sameRequest(null, base)).toBe(false)
  })
})

describe('notifyAdminsOfAccessRequest', () => {
  it('tells each active admin person once through notifyUser, never machine accounts', async () => {
    state.admins = [
      { id: 'A1', email: 'ann@example.com', account_kind: null },
      { id: 'A2', email: 'bob@example.com', account_kind: null },
      { id: 'S1', email: 'claude-code-mcp@nivaro.local', account_kind: null },
      { id: 'S2', email: 'deploy@example.com', account_kind: 'service' }
    ]
    const n = await notifyAdminsOfAccessRequest(
      {} as never,
      { id: 'P1', name: 'Pamela Wells' },
      { reason: 'Construction forecasting' }
    )
    expect(n).toBe(2)
    expect(state.notified.map((x) => x.userId)).toEqual(['A1', 'A2'])
    expect(state.notified[0].opts).toMatchObject({
      subject: 'Pamela Wells asked for access to the portal',
      sender: 'P1',
      target: { kind: 'access_request', action: 'review' }
    })
  })
})

describe('accessRequestOutcome', () => {
  const prev = { divisions: [1], vendor: null, vendor_name: null, reason: 'r', submitted_at: 'x' }
  it('first submit from First Access: write, move, tell admins', () => {
    expect(accessRequestOutcome(null, true, true)).toEqual({
      write: true,
      notify: true,
      comment: 'submitted; moved to the review role'
    })
  })
  it('first request from an account already in review (no move): write and tell', () => {
    expect(accessRequestOutcome(null, true, false)).toMatchObject({ write: true, notify: true })
  })
  it('a changed resend writes and logs, but nobody is told again', () => {
    expect(accessRequestOutcome(prev, true, false)).toEqual({
      write: true,
      notify: false,
      comment: 'updated'
    })
  })
  it('an identical resend writes nothing and logs nothing', () => {
    expect(accessRequestOutcome(prev, false, false)).toMatchObject({ write: false, notify: false })
  })
})

describe('mayRequestAccess (army9 b10)', () => {
  const START = 'aaaa-start'
  const REVIEW = 'bbbb-review'
  it('lets an account in the new-user flow (or with no role) file a request', () => {
    expect(mayRequestAccess(null, START, REVIEW, false)).toBe(true)
    expect(mayRequestAccess(START.toUpperCase(), START, REVIEW, false)).toBe(true)
    expect(mayRequestAccess(REVIEW, START, REVIEW, false)).toBe(true)
  })
  it('refuses an authorized account, an administrator, and any role when the flow is off', () => {
    expect(mayRequestAccess('cccc-approver', START, REVIEW, false)).toBe(false)
    expect(mayRequestAccess(START, START, REVIEW, true)).toBe(false)
    expect(mayRequestAccess('cccc-approver', null, null, false)).toBe(false)
  })
})
