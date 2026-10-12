// Keeping assistant ops posts with administrators (#1967 review O3/O4) and the
// approval dispatch's host forwarding (O2).
import knexFactory from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))

import { db } from '../../../db/index.js'
import { ChatSendError, upsertMembership } from '../../../services/chat-send.js'
import { isActiveAdmin } from '../../../services/ops-assistant.js'
import { approvalHeaders } from '../../../services/ops-proposals.js'
import {
  activeAdminIds,
  bustOpsGuard,
  isOpsGuardedRoom,
  nonAdminsFor,
  OPS_ONLY_CODE,
  opsOnlyHider,
  patchOpensOpsRoom
} from '../../../services/ops-room-guard.js'

const mssql = knexFactory({ client: 'mssql' })

interface Calls {
  where: unknown[][]
  inserts: unknown[]
}

/**
 * A fake db: per table a result for `.first()` / awaiting, and a record of
 * every `.where(...)` call. User rows are filtered by the status the query
 * asks for, so "status = 'active'" is checked, not assumed.
 */
function fakeDb(tables: {
  settings?: { ops_channel?: string | null }
  opsPost?: boolean
  users?: Array<{ id: string; status: string; admin: boolean }>
  membership?: Record<string, unknown> | undefined
  role?: { admin_access: boolean }
}): Calls {
  const calls: Calls = { where: [], inserts: [] }
  vi.mocked(db).mockImplementation(((name: string) => {
    const table = String(name).split(' ')[0]
    const wheres: unknown[][] = []
    let ids: string[] = []
    const result = () => {
      if (table === 'nivaro_users') {
        const statusWanted = wheres.find((w) => w[0] === 'u.status')?.[1]
        return (tables.users ?? [])
          .filter((u) => ids.map((i) => i.toUpperCase()).includes(u.id.toUpperCase()))
          .filter((u) => u.admin && (statusWanted === undefined || u.status === statusWanted))
          .map((u) => ({ id: u.id }))
      }
      if (table === 'nivaro_settings') return tables.settings
      if (table === 'chat_messages') return tables.opsPost ? { id: 1 } : undefined
      if (table === 'nivaro_chat_memberships') return tables.membership
      if (table === 'nivaro_roles') return tables.role
      return undefined
    }
    const b = Object.assign(
      Promise.resolve().then(() => result()),
      {}
    ) as Promise<unknown> & Record<string, unknown>
    const self = () => b
    b.where = vi.fn((...args: unknown[]) => {
      if (typeof args[0] === 'function') (args[0] as (x: unknown) => void)(b)
      else {
        wheres.push(args)
        calls.where.push(args)
      }
      return b
    })
    b.orWhereNull = vi.fn(self)
    b.join = vi.fn(self)
    b.orderBy = vi.fn(self)
    b.whereIn = vi.fn((_c: string, v: string[]) => {
      ids = v
      return b
    })
    b.select = vi.fn(async () => result())
    b.first = vi.fn(async () => result())
    b.insert = vi.fn(async (row: unknown) => {
      calls.inserts.push(row)
      return [1]
    })
    b.update = vi.fn(async () => 1)
    return b
  }) as never)
  return calls
}

beforeEach(() => bustOpsGuard())
afterEach(() => vi.clearAllMocks())

describe('O4 — an administrator is an ACTIVE account', () => {
  it('activeAdminIds asks for status = active, and a pending admin is not one', async () => {
    const calls = fakeDb({
      users: [
        { id: 'ANA', status: 'active', admin: true },
        { id: 'PAT', status: 'pending', admin: true },
        { id: 'SUE', status: 'suspended', admin: true },
        { id: 'BOB', status: 'active', admin: false }
      ]
    })
    const out = await activeAdminIds(['ana', 'PAT', 'SUE', 'BOB'])
    expect([...out]).toEqual(['ANA'])
    expect(calls.where).toContainEqual(['u.status', 'active'])
    expect(await isActiveAdmin('PAT')).toBe(false)
    expect(await isActiveAdmin('ANA')).toBe(true)
  })
})

describe('O3a — the ops channel only gains administrators', () => {
  const users = [
    { id: 'ANA', status: 'active', admin: true },
    { id: 'BOB', status: 'active', admin: false }
  ]
  it('the configured ops channel is guarded; other rooms are not', async () => {
    fakeDb({ settings: { ops_channel: 'ch:ops' }, users })
    expect(await isOpsGuardedRoom('ch:ops')).toBe(true)
    expect(await nonAdminsFor('ch:ops', ['ANA', 'BOB'])).toEqual(['BOB'])
    expect(await isOpsGuardedRoom('dm:A:B')).toBe(false)
    expect(await nonAdminsFor('dm:A:B', ['BOB'])).toEqual([])
  })
  it('a channel that already holds assistant ops posts is guarded too', async () => {
    fakeDb({ settings: { ops_channel: null }, opsPost: true, users })
    expect(await isOpsGuardedRoom('ch:old-ops')).toBe(true)
    fakeDb({ settings: { ops_channel: null }, opsPost: false, users })
    bustOpsGuard()
    expect(await isOpsGuardedRoom('ch:random')).toBe(false)
  })
  it('the membership backstop refuses a non-admin with a clear error', async () => {
    const calls = fakeDb({ settings: { ops_channel: 'ch:ops' }, users, membership: undefined })
    const err = await upsertMembership('BOB', 'ch:ops', {}).catch((e) => e)
    expect(err).toBeInstanceOf(ChatSendError)
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe(OPS_ONLY_CODE)
    expect(calls.inserts).toEqual([])
    await upsertMembership('ANA', 'ch:ops', {})
    expect(calls.inserts).toHaveLength(1)
  })
  it('an existing membership is updated, never re-judged (no lock-out of the watermark)', async () => {
    const calls = fakeDb({
      settings: { ops_channel: 'ch:ops' },
      users,
      membership: { id: 5, user: 'ANA' }
    })
    await upsertMembership('ANA', 'ch:ops', { last_read_at: new Date() })
    expect(calls.inserts).toEqual([])
  })
  it('the channel cannot be opened to everyone or to a non-admin role', async () => {
    fakeDb({ settings: { ops_channel: 'ch:ops' }, users, role: { admin_access: false } })
    expect(await patchOpensOpsRoom('ch:ops', { visibility: 'open' })).toBe(true)
    expect(await patchOpensOpsRoom('ch:ops', { visibility: 'role', role: 'R1' })).toBe(true)
    expect(await patchOpensOpsRoom('ch:ops', { visibility: 'private' })).toBe(false)
    expect(await patchOpensOpsRoom('ch:ops', {})).toBe(false)
    fakeDb({ settings: { ops_channel: 'ch:ops' }, users, role: { admin_access: true } })
    expect(await patchOpensOpsRoom('ch:ops', { visibility: 'role', role: 'ADMINS' })).toBe(false)
  })
})

describe('O3b — ops posts are hidden from non-admin readers', () => {
  it('adds the ops_only filter for a non-admin, nothing for an admin', async () => {
    const asUser = await opsOnlyHider(false)
    const sql = asUser(mssql('chat_messages').where({ room: 'ch:ops' })).toSQL().sql
    expect(sql).toContain('[ops_only] is null or [ops_only] = ?')
    const joined = asUser(
      mssql('nivaro_chat_pins as p').join('chat_messages as m', 'm.id', 'p.message_id'),
      'm.ops_only'
    ).toSQL().sql
    expect(joined).toContain('[m].[ops_only] is null')
    const asAdmin = await opsOnlyHider(true)
    expect(asAdmin(mssql('chat_messages')).toSQL().sql).not.toContain('ops_only')
  })
})

describe('O2 — the approval dispatch keeps the approver’s host', () => {
  it('forwards credential and host headers, nothing else', () => {
    expect(
      approvalHeaders(
        {
          authorization: 'Bearer t',
          cookie: 'sid=1',
          host: 'acme.nivaro.cloud',
          'x-forwarded-host': 'acme.nivaro.cloud',
          'x-forwarded-proto': 'https',
          'x-evil': 'x',
          'content-length': '10'
        },
        'P1'
      )
    ).toEqual({
      'content-type': 'application/json',
      'x-nivaro-ops-proposal': 'P1',
      authorization: 'Bearer t',
      cookie: 'sid=1',
      host: 'acme.nivaro.cloud',
      'x-forwarded-host': 'acme.nivaro.cloud',
      'x-forwarded-proto': 'https'
    })
  })
})
