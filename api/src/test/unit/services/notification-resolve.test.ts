import { beforeEach, describe, expect, it, vi } from 'vitest'

// rt4-notify item 1: a notification turns "done" by itself once someone handles what it asked.

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: unknown; patch: Record<string, unknown> }>,
  emitted: [] as Array<{ user: string; event: string; payload: Record<string, unknown> }>,
  read: [] as string[]
}))

vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    let id: unknown = null
    const q: any = {
      where: (a: unknown) => {
        if (a && typeof a === 'object' && 'id' in (a as Record<string, unknown>))
          id = (a as Record<string, unknown>).id
        return q
      },
      whereIn: () => q,
      whereNull: () => q,
      select: () => q,
      limit: async () => store.rows,
      first: async () =>
        table === 'nivaro_users' ? { first_name: 'Beth', last_name: 'Ng', email: null } : undefined,
      update: async (patch: Record<string, unknown>) => {
        store.updates.push({ id, patch })
        return 1
      },
      catch: () => q
    }
    return q
  }
}))
vi.mock('../../../services/user-sync.js', () => ({
  emitToUserRoom: (user: string, event: string, payload: Record<string, unknown>) =>
    store.emitted.push({ user, event, payload }),
  announceNotificationsRead: (user: string) => store.read.push(user)
}))

import {
  eventKey,
  isHandledRow,
  keyLike,
  planResolve,
  type ResolveEvent,
  resolvedText,
  resolveKeyFor,
  resolveNotifications
} from '../../../services/notification-resolve.js'

const BETH = 'B0000000-0000-0000-0000-000000000001'
const AL = 'A0000000-0000-0000-0000-000000000002'
const CY = 'C0000000-0000-0000-0000-000000000003'
const at = new Date('2026-11-14T15:42:00Z')
const before = '2026-11-14T15:00:00Z'

describe('resolveKeyFor — what settles a notification', () => {
  it('an owner ask about a record settles when the record moves on', () => {
    expect(
      resolveKeyFor({
        category: 'workflow',
        lane: 'needs_you',
        target: { kind: 'record', collection: 'workflows', id: 42 }
      })
    ).toBe('step:workflows:42')
    // Any category, when the person owns the record's step.
    expect(
      resolveKeyFor({
        category: 'other',
        lane: 'needs_you',
        owns: true,
        target: { kind: 'record', collection: 'workflows', id: 42 }
      })
    ).toBe('step:workflows:42')
  })

  it('an FYI, a mention, a reply ask and system tables never settle', () => {
    const rec = { kind: 'record', collection: 'workflows', id: 42 }
    expect(resolveKeyFor({ category: 'workflow', lane: 'fyi', target: rec })).toBeNull()
    expect(resolveKeyFor({ category: 'mentions', lane: 'needs_you', target: rec })).toBeNull()
    expect(
      resolveKeyFor({
        category: 'other',
        lane: 'needs_you',
        owns: true,
        target: { ...rec, action: 'reply' }
      })
    ).toBeNull()
    expect(
      resolveKeyFor({
        category: 'workflow',
        lane: 'needs_you',
        target: { kind: 'record', collection: 'nivaro_users', id: 1 }
      })
    ).toBeNull()
  })

  it('tasks, approvals and tickets settle on their own ids', () => {
    expect(
      resolveKeyFor({
        category: 'workflow',
        lane: 'needs_you',
        target: { kind: 'record', collection: 'workflows', id: 42, task_id: 7 }
      })
    ).toBe('task:7')
    expect(resolveKeyFor({ target: { kind: 'my_work' }, source: { kind: 'task', id: 9 } })).toBe(
      'task:9'
    )
    expect(
      resolveKeyFor({
        target: { kind: 'approval', collection: 'workflows', id: 42, instance_id: 5 }
      })
    ).toBe('approval:5')
    expect(resolveKeyFor({ target: { kind: 'support', id: 12 } })).toBe('ticket:12')
  })

  it('"Task done" and acknowledgement requests are never settled for the person', () => {
    expect(
      resolveKeyFor({ subject: 'Task done: Call vendor', source: { kind: 'task', id: 9 } })
    ).toBeNull()
    expect(resolveKeyFor({ ackRequired: true, target: { kind: 'support', id: 12 } })).toBeNull()
  })
})

describe('resolvedText', () => {
  const step: ResolveEvent = {
    on: 'step',
    collection: 'workflows',
    item: '42',
    at,
    actorId: BETH,
    stateLabel: "PUB'd"
  }
  it('names who handled it, or "you"', () => {
    expect(resolvedText(step, { self: false, name: 'Beth' })).toBe("Moved to PUB'd by Beth")
    expect(resolvedText(step, { self: true, name: 'Beth' })).toBe("Moved to PUB'd by you")
    expect(
      resolvedText(
        { on: 'approval', id: 5, at, actorId: BETH, decision: 'approved' },
        { self: false, name: 'Beth' }
      )
    ).toBe('Approved by Beth')
    expect(
      resolvedText(
        { on: 'approval', id: 5, at, actorId: BETH, decision: 'rejected' },
        { self: false, name: 'Beth' }
      )
    ).toBe('Rejected by Beth')
    expect(
      resolvedText({ on: 'task', id: 7, at, actorId: null }, { self: false, name: null })
    ).toBe('Done')
    expect(
      resolvedText(
        { on: 'ticket', id: 1, at, actorId: BETH, status: 'cancelled' },
        { self: false, name: 'Beth' }
      )
    ).toBe('Cancelled by Beth')
  })
})

describe('planResolve', () => {
  const ev: ResolveEvent = {
    on: 'step',
    collection: 'workflows',
    item: '42',
    at,
    actorId: BETH,
    stateLabel: 'Review',
    keepOpenFor: [CY]
  }
  const key = eventKey(ev)
  const row = (over: Record<string, unknown>) => ({
    id: 1,
    recipient: AL,
    status: 'inbox',
    timestamp: before,
    detail: JSON.stringify({ resolve_key: key }),
    ...over
  })

  it('settles open rows written before the event that carry its key', () => {
    const rows = [
      row({ id: 1 }),
      row({ id: 2, status: 'read' }),
      row({ id: 3, status: 'archived' }),
      row({ id: 4, timestamp: '2026-11-14T16:00:00Z' }),
      row({ id: 5, detail: JSON.stringify({ resolve_key: 'step:workflows:43' }) }),
      row({ id: 6, detail: JSON.stringify({ resolve_key: key, resolved: { text: 'x' } }) }),
      row({ id: 7, detail: JSON.stringify({ resolve_key: key, ack_required: true }) }),
      row({ id: 8, recipient: CY.toLowerCase() }),
      row({ id: 9, detail: null })
    ]
    expect(planResolve(rows, ev).map((r) => r.id)).toEqual([1, 2])
  })

  it('the LIKE prefilter escapes MSSQL wildcards', () => {
    expect(keyLike('step:inventory_request:5')).toBe('%"resolve_key":"step:inventory[_]request:5"%')
  })
})

describe('resolveNotifications', () => {
  beforeEach(() => {
    store.rows = []
    store.updates = []
    store.emitted = []
    store.read = []
  })

  it('stamps the done line, marks read and tells only the recipient (ids only)', async () => {
    store.rows = [
      {
        id: 11,
        recipient: AL,
        status: 'inbox',
        timestamp: before,
        detail: JSON.stringify({ resolve_key: 'approval:5', why: { kind: 'rules' } })
      },
      {
        id: 12,
        recipient: BETH,
        status: 'inbox',
        timestamp: before,
        detail: JSON.stringify({ resolve_key: 'approval:5' })
      }
    ]
    const ids = await resolveNotifications({
      on: 'approval',
      id: 5,
      at,
      actorId: BETH,
      decision: 'approved',
      collection: 'workflows',
      item: '42'
    })
    expect(ids.sort()).toEqual([11, 12])
    const first = store.updates.find((u) => u.id === 11 && u.patch.detail)!
    expect(first.patch.status).toBe('read')
    const d = JSON.parse(String(first.patch.detail))
    expect(d.why).toEqual({ kind: 'rules' })
    expect(d.resolved).toMatchObject({ on: 'approval', by: BETH, text: 'Approved by Beth Ng' })
    const own = store.updates.find((u) => u.id === 12 && u.patch.detail)!
    expect(JSON.parse(String(own.patch.detail)).resolved.text).toBe('Approved by you')
    expect(store.emitted.map((e) => e.user).sort()).toEqual([AL, BETH].sort())
    for (const e of store.emitted) {
      expect(e.event).toBe('notification:retired')
      expect(Object.keys(e.payload).sort()).toEqual(['collection', 'ids', 'item', 'resolved'])
    }
    expect(store.read.sort()).toEqual([AL, BETH].sort())
  })

  it('nothing to settle = no writes, no emits', async () => {
    store.rows = [{ id: 1, recipient: AL, status: 'inbox', timestamp: before, detail: null }]
    expect(await resolveNotifications({ on: 'task', id: 7, at, actorId: BETH })).toEqual([])
    expect(store.updates).toEqual([])
    expect(store.emitted).toEqual([])
  })
})

describe('isHandledRow', () => {
  it('settled or archived rows are handled; open ones are not', () => {
    expect(isHandledRow({ status: 'archived', detail: null })).toBe(true)
    expect(isHandledRow({ status: 'read', detail: '{"resolved":{"text":"Done"}}' })).toBe(true)
    expect(isHandledRow({ status: 'read', detail: '{"why":{}}' })).toBe(false)
    expect(isHandledRow({ status: 'inbox', detail: null })).toBe(false)
  })
})
