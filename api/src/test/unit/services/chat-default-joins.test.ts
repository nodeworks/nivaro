import { beforeEach, describe, expect, it, vi } from 'vitest'

// Default channels per role (#960, 2026-11-08): a person joins their role's default channels
// when they are GIVEN the role (and when an admin saves a channel's default roles), not only
// when they first open Chat. Leaving sticks (nivaro_chat_auto_joins), the ops-room guard still
// admits administrators only, and the request safety net never runs for keys or View-as.

const h = vi.hoisted(() => {
  const tables: Record<string, Array<Record<string, unknown>>> = {}
  const state = { fail: false }
  const same = (a: unknown, b: unknown) => String(a).toUpperCase() === String(b).toUpperCase()
  /** A tiny in-memory reading of the statements chat.ts sends (mssql dialect). */
  function answer(q: { method: string; sql: string; bindings: unknown[] }): unknown {
    if (state.fail) throw new Error('Connection lost')
    const table = /(?:from|into)\s+\[(\w+)\]/i.exec(q.sql)?.[1] ?? ''
    tables[table] ??= []
    const rows = tables[table]
    if (q.method === 'insert') {
      const cols = (/\(([^)]*)\)\s*values/i.exec(q.sql)?.[1] ?? '')
        .split(',')
        .map((c) => c.trim().replace(/[[\]]/g, ''))
      const fresh: Array<Record<string, unknown>> = []
      for (let i = 0; i < q.bindings.length; i += cols.length)
        fresh.push(Object.fromEntries(cols.map((c, j) => [c, q.bindings[i + j]])))
      const unique = table === 'nivaro_chat_auto_joins' || table === 'nivaro_chat_memberships'
      if (unique && fresh.some((r) => rows.some((x) => same(x.user, r.user) && x.room === r.room)))
        throw new Error('Violation of UNIQUE KEY constraint')
      rows.push(...fresh)
      return []
    }
    const where = q.sql.split(/\swhere\s/i)[1] ?? ''
    const conds: Array<[string, unknown[]]> = []
    for (const m of where.matchAll(/\[(\w+)\]\s*(=|in)\s*(?:\(([^)]*)\)|@p(\d+))/gi)) {
      if (m[2].toLowerCase() === 'in')
        conds.push([m[1], m[3].split(',').map((s) => q.bindings[Number(s.trim().slice(2))])])
      else conds.push([m[1], [q.bindings[Number(m[4])]]])
    }
    const hits = rows.filter((r) => conds.every(([c, vs]) => vs.some((v) => same(v, r[c]))))
    if (q.method === 'first') return hits[0]
    if (q.method === 'pluck') {
      const col = /select\s+\[(\w+)\]/i.exec(q.sql)?.[1] ?? 'id'
      return hits.map((r) => r[col])
    }
    return hits
  }
  return { tables, answer, state, opsRooms: new Set<string>() }
})

vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return { db: makeFakeDb((q) => h.answer(q)) }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../services/items.js', () => ({ readItems: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn() }))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => '' }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/ops-room-guard.js', () => ({
  // The ops channel admits administrators only; nobody in these tests is one.
  nonAdminsFor: vi.fn(async (room: string, ids: string[]) => (h.opsRooms.has(room) ? ids : []))
}))

import { clearChatCaches } from '../../../services/chat.js'
import {
  autoJoinDue,
  autoJoinOnRequest,
  backfillDefaultRolesSoon,
  joinDefaultChannelsSoon,
  requestMayAutoJoin,
  resetAutoJoinMemo
} from '../../../services/chat-default-joins.js'

const R1 = 'AAAAAAAA-0000-0000-0000-000000000001'
const R2 = 'AAAAAAAA-0000-0000-0000-000000000002'
const A = 'BBBBBBBB-0000-0000-0000-00000000000A'
const B = 'BBBBBBBB-0000-0000-0000-00000000000B'
const C = 'BBBBBBBB-0000-0000-0000-00000000000C'
const D = 'BBBBBBBB-0000-0000-0000-00000000000D'

const channel = (key: string, roles: string[], extra: Record<string, unknown> = {}) => ({
  id: key.length,
  key,
  name: key,
  visibility: 'open',
  is_archived: false,
  is_direct: false,
  default_roles: JSON.stringify(roles),
  ...extra
})

const membersOf = (room: string) =>
  (h.tables.nivaro_chat_memberships ?? [])
    .filter((m) => m.room === room)
    .map((m) => String(m.user).toUpperCase())
    .sort()

beforeEach(() => {
  for (const k of Object.keys(h.tables)) delete h.tables[k]
  h.opsRooms.clear()
  h.state.fail = false
  h.tables.nivaro_settings = [
    { id: 1, chat_general: JSON.stringify({ default_roles: [R1.toLowerCase()] }) }
  ]
  h.tables.nivaro_chat_channels = [
    channel('eng', [R1]),
    channel('sales', [R2]),
    channel('old', [R1], { is_archived: true })
  ]
  h.tables.nivaro_users = [
    { id: A, role: R1, status: 'active', account_kind: null },
    { id: B, role: R1, status: 'suspended', account_kind: null },
    { id: C, role: R2, status: 'active', account_kind: null },
    { id: D, role: R1, status: 'active', account_kind: 'bot' }
  ]
  h.tables.nivaro_chat_auto_joins = []
  h.tables.nivaro_chat_memberships = []
  resetAutoJoinMemo()
  clearChatCaches()
})

describe('given a role → joins its default channels', () => {
  it('a role change joins General and the role’s channels, never archived or other roles’', async () => {
    await joinDefaultChannelsSoon([A], 'test')
    expect(membersOf('global')).toEqual([A])
    expect(membersOf('ch:eng')).toEqual([A])
    expect(membersOf('ch:sales')).toEqual([])
    expect(membersOf('ch:old')).toEqual([])
    // The memo is set for the new role, so the lazy path does not repeat the work.
    expect(autoJoinDue(A, R1)).toBe(false)
  })

  it('moving to another role joins that role’s channels', async () => {
    h.tables.nivaro_users[0].role = R2
    await joinDefaultChannelsSoon([A], 'test')
    expect(membersOf('ch:sales')).toEqual([A])
    expect(membersOf('ch:eng')).toEqual([])
  })

  it('skips suspended and machine accounts', async () => {
    await joinDefaultChannelsSoon([B, D], 'test')
    expect(membersOf('ch:eng')).toEqual([])
    expect(membersOf('global')).toEqual([])
  })

  it('never rejects, even when the database fails', async () => {
    h.state.fail = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(joinDefaultChannelsSoon([A], 'test')).resolves.toBeUndefined()
      await expect(backfillDefaultRolesSoon([R1], 'test')).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      h.state.fail = false
      warn.mockRestore()
    }
  })
})

describe('leaving sticks', () => {
  it('a channel the person left is not rejoined by a later trigger', async () => {
    await joinDefaultChannelsSoon([A], 'first')
    // They leave #eng: the membership goes, the auto-join record stays.
    h.tables.nivaro_chat_memberships = h.tables.nivaro_chat_memberships.filter(
      (m) => m.room !== 'ch:eng'
    )
    resetAutoJoinMemo()
    await joinDefaultChannelsSoon([A], 'second')
    await backfillDefaultRolesSoon([R1], 'saved')
    expect(membersOf('ch:eng')).toEqual([])
    expect(membersOf('global')).toEqual([A])
  })
})

describe('default roles saved → backfill', () => {
  it('joins only ACTIVE human people in the listed roles', async () => {
    await backfillDefaultRolesSoon([R1], 'saved')
    expect(membersOf('ch:eng')).toEqual([A])
    expect(membersOf('global')).toEqual([A])
    expect(membersOf('ch:sales')).toEqual([])
  })

  it('a person already in the room is left as they are', async () => {
    h.tables.nivaro_chat_memberships.push({ user: A, room: 'ch:eng', joined_at: new Date(0) })
    await backfillDefaultRolesSoon([R1], 'saved')
    expect(h.tables.nivaro_chat_memberships.filter((m) => m.room === 'ch:eng')).toHaveLength(1)
  })
})

describe('ops-room guard', () => {
  it('a non-admin is never added to the ops channel by default role', async () => {
    h.tables.nivaro_chat_channels.push(channel('ops', [R1]))
    h.opsRooms.add('ch:ops')
    await joinDefaultChannelsSoon([A], 'test')
    expect(membersOf('ch:ops')).toEqual([])
    expect(membersOf('ch:eng')).toEqual([A])
    // Recorded, so the refused join is not retried on every trigger.
    expect(h.tables.nivaro_chat_auto_joins.some((r) => r.room === 'ch:ops' && r.user === A)).toBe(
      true
    )
  })
})

describe('authenticate safety net', () => {
  const person = { id: A, role: R1, status: 'active', account_kind: null }

  it('runs for a person signed in by session or the phone app', () => {
    expect(requestMayAutoJoin({ authMethod: 'session', user: person })).toBe(true)
    expect(requestMayAutoJoin({ authMethod: 'device', user: person })).toBe(true)
  })

  it('never runs for keys, tokens, connected apps, MCP calls, View-as or machine accounts', () => {
    expect(requestMayAutoJoin({ authMethod: 'api_key', apiKeyId: 3, user: person })).toBe(false)
    expect(requestMayAutoJoin({ authMethod: 'key_sim', user: person })).toBe(false)
    expect(requestMayAutoJoin({ authMethod: 'token', user: person })).toBe(false)
    expect(requestMayAutoJoin({ authMethod: 'oauth', user: person })).toBe(false)
    expect(requestMayAutoJoin({ authMethod: 'masquerade', user: person })).toBe(false)
    expect(
      requestMayAutoJoin({ authMethod: 'session', masqueradeAdminId: 'X', user: person })
    ).toBe(false)
    expect(requestMayAutoJoin({ authMethod: 'session', mcpInner: true, user: person })).toBe(false)
    expect(
      requestMayAutoJoin({ authMethod: 'session', user: { ...person, account_kind: 'bot' } })
    ).toBe(false)
    expect(requestMayAutoJoin({ authMethod: 'session', user: null })).toBe(false)
  })

  it('an API key or View-as request leaves the memo untouched; a session marks it once', () => {
    autoJoinOnRequest({ authMethod: 'api_key', apiKeyId: 1, user: person })
    autoJoinOnRequest({ authMethod: 'masquerade', masqueradeAdminId: 'X', user: person })
    expect(autoJoinDue(A, R1)).toBe(true)
    autoJoinOnRequest({ authMethod: 'session', user: person })
    expect(autoJoinDue(A, R1)).toBe(false)
  })

  it('a session request joins the person in the background', async () => {
    autoJoinOnRequest({ authMethod: 'session', user: person })
    await vi.waitFor(() => expect(membersOf('ch:eng')).toEqual([A]))
  })
})
