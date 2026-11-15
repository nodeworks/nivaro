import { beforeEach, describe, expect, it, vi } from 'vitest'

// A chainable stand-in: every builder call returns itself; awaiting answers the table's rows.
const state = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  notified: [] as Array<{ to: string; opts: Record<string, unknown> }>,
  unreadable: new Set<string>(),
  // A shared Redis stand-in: every "process" in a test sees the same keys.
  redis: null as null | {
    store: Map<string, string>
    sets: Map<string, Set<string>>
    down: boolean
  },
  rules: null as unknown,
  calls: [] as Array<[string, string, unknown[]]>,
  gated: [] as string[],
  partial: [] as string[],
  run: { id: 'run-1', current_state: 's', key: 'approved', label: 'Approved', completed_at: null }
}))

vi.mock('../db/index.js', () => {
  const builder = (table: string) => {
    const rows = () => state.tables[table.split(' ')[0]] ?? []
    const target: Record<string, unknown> = {}
    const proxy: unknown = new Proxy(target, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown) => Promise.resolve(rows()).then(res)
        if (prop === 'catch') return () => Promise.resolve(rows())
        if (prop === 'first') return () => Promise.resolve(rows()[0])
        return (...args: unknown[]) => {
          state.calls.push([table.split(' ')[0], String(prop), args])
          return proxy
        }
      }
    })
    return proxy
  }
  const db = Object.assign(builder, { raw: () => ({}) })
  return { db }
})
vi.mock('./collections.js', () => ({
  getCollection: async () => ({ summary_mode_rules: state.rules }),
  getFields: async () => [
    { field: 'id' },
    { field: 'amount', type: 'decimal', label: 'Amount' },
    { field: 'title', type: 'string' }
  ],
  getRelations: async () => []
}))
vi.mock('./edit-lock.js', async () => {
  const real = await vi.importActual<typeof import('./edit-lock.js')>('./edit-lock.js')
  return { ...real, latestRecordRun: async () => state.run }
})
vi.mock('./encryption.js', () => ({ getEncryptedFields: async () => [] }))
vi.mock('./revision-fields.js', () => ({ readableFieldSet: async () => null }))
vi.mock('./io-holder.js', () => ({
  getApp: () => {
    const r = state.redis
    if (!r) return { redis: null }
    const up = () => {
      if (r.down) throw new Error('ECONNREFUSED')
    }
    return {
      redis: {
        set: async (key: string, value: string, _px: string, _ms: number, nx: string) => {
          up()
          if (nx === 'NX' && r.store.has(key)) return null
          r.store.set(key, value)
          return 'OK'
        },
        sadd: async (key: string, ...members: string[]) => {
          up()
          const set = r.sets.get(key) ?? new Set<string>()
          for (const m of members) set.add(m)
          r.sets.set(key, set)
          return members.length
        },
        pexpire: async () => {
          up()
          return 1
        },
        smembers: async (key: string) => {
          up()
          return [...(r.sets.get(key) ?? [])]
        }
      }
    }
  }
}))
vi.mock('./users.js', () => ({
  getUser: async (id: string) => ({ id, status: 'active', email: `${id}@example.test` })
}))
vi.mock('./items.js', () => ({
  readOne: async (user: { id: string }) =>
    state.unreadable.has(user.id) ? null : { id: '7', amount: 150, title: 'A' }
}))
vi.mock('./record-display-ref.js', () => ({ recordDisplayRef: async () => 'REQ-7' }))
vi.mock('./notification-channels.js', () => ({
  notifyUser: async (_app: unknown, to: string, opts: Record<string, unknown>) => {
    state.notified.push({ to, opts })
    return { id: 1 }
  }
}))
vi.mock('./filter-check.js', () => ({ choicesOf: () => null }))
vi.mock('./read-gate.js', () => ({
  withReadGate: async (_w: unknown, fn: () => Promise<unknown>, o?: { label?: string }) => {
    state.gated.push(String(o?.label))
    return fn()
  }
}))
vi.mock('./partial-reads.js', () => ({
  notePartialRead: (what: string) => state.partial.push(what)
}))

import {
  APPROVAL_CHANGED_FIELD,
  APPROVAL_CHANGES_CATEGORY,
  approvalChangedIds,
  approvalChangedWanted,
  approvalChangesFor,
  burstChangers,
  claimOnce,
  LIST_ROW_CAP,
  noticeRecipients,
  resolveApprovalChangedCondition,
  sendApprovalNotices
} from './approval-changes.js'

const approvedAt = new Date(Date.now() - 3_600_000)
const recent = new Date(Date.now() - 5_000)

beforeEach(() => {
  state.redis = { store: new Map(), sets: new Map(), down: false }
  state.notified = []
  state.unreadable = new Set()
  state.rules = {
    edit_lock: { states: ['review', 'director'], admin_only: { states: ['approved'] } }
  }
  state.tables = {
    nivaro_workflow_history: [
      {
        user: 'creator',
        timestamp: new Date(approvedAt.getTime() - 120_000),
        from_key: 'draft',
        to_key: 'review'
      },
      {
        user: 'mgr',
        timestamp: new Date(approvedAt.getTime() - 60_000),
        from_key: 'review',
        to_key: 'director'
      },
      { user: 'dir', timestamp: approvedAt, from_key: 'director', to_key: 'approved' }
    ],
    nivaro_workflow_bindings: [],
    nivaro_users: [
      { id: 'dir', first_name: 'Dana', last_name: 'Director' },
      { id: 'admin', first_name: 'Ada', last_name: 'Admin' }
    ],
    // revisionsAround: both reads answer from this table — the "after" list and the snapshot.
    nivaro_revisions: [
      {
        delta: JSON.stringify({ amount: 150 }),
        data: JSON.stringify({ id: '7', amount: 100, title: 'A' }),
        timestamp: recent,
        user_id: 'admin',
        first_name: 'Ada',
        last_name: 'Admin'
      }
    ],
    nivaro_activity: []
  }
})

describe('notice recipients', () => {
  it('approvers other than the people who made the burst', () => {
    expect(noticeRecipients(['dir', 'mgr'], ['admin'])).toEqual(['dir', 'mgr'])
    expect(noticeRecipients(['dir', 'mgr'], ['DIR'])).toEqual(['mgr'])
    // An outside write (no person) is news to everyone.
    expect(noticeRecipients(['dir'], [null])).toEqual(['dir'])
    expect(noticeRecipients(['dir'], ['dir', null])).toEqual(['dir'])
  })
})

describe('the badge answer', () => {
  it('approved value → now, who and when, approvers named', async () => {
    const a = await approvalChangesFor({ id: 'viewer' } as never, 'requests', '7', {
      id: '7',
      amount: 150,
      title: 'A'
    })
    expect(a.enabled).toBe(true)
    expect(a.approved?.by.map((p) => p.name)).toEqual(['Dana Director'])
    // (mgr has no row in the users stand-in, so only Dana is named)
    expect(a.changes).toHaveLength(1)
    expect(a.changes[0]).toMatchObject({
      field: 'amount',
      label: 'Amount',
      before: 100,
      after: 150
    })
    expect(a.changes[0].by.name).toBe('Ada Admin')
  })
  it('off where the collection turned it off; empty when not approved', async () => {
    state.rules = { ...(state.rules as object), changed_after_approval: false }
    expect((await approvalChangesFor({ id: 'v' } as never, 'requests', '7', {})).enabled).toBe(
      false
    )
    state.rules = {
      edit_lock: { states: ['review', 'director'], admin_only: { states: ['approved'] } }
    }
    state.run = { ...state.run, key: 'review' }
    const a = await approvalChangesFor({ id: 'v' } as never, 'requests', '7', {})
    expect(a).toMatchObject({ enabled: true, approved: null, total: 0 })
    state.run = { ...state.run, key: 'approved' }
  })
})

describe('approvers notice', () => {
  it('one quiet notice in its own category, never to the person who made the change', async () => {
    const sent = await sendApprovalNotices('requests', '7', new Set(['admin']), recent)
    expect(sent).toBe(2)
    expect(state.notified.map((n) => n.to).sort()).toEqual(['dir', 'mgr'])
    expect(state.notified[0].opts).toMatchObject({
      category: APPROVAL_CHANGES_CATEGORY,
      lane: 'fyi',
      collection: 'requests',
      item: '7'
    })
    expect(String(state.notified[0].opts.message)).toContain('Ada Admin changed Amount')
    expect(String(state.notified[0].opts.subject)).toBe('Changed after approval: REQ-7')
  })
  it('an approver is never told about their own change', async () => {
    const sent = await sendApprovalNotices('requests', '7', new Set(['dir']), recent)
    expect(sent).toBe(1)
    expect(state.notified.map((n) => n.to)).toEqual(['mgr'])
  })
  it('skips an approver who can no longer open the record', async () => {
    state.unreadable.add('mgr')
    await sendApprovalNotices('requests', '7', new Set(['admin']), recent)
    expect(state.notified.map((n) => n.to)).toEqual(['dir'])
  })
  it('a burst that changed nothing new tells nobody', async () => {
    const sent = await sendApprovalNotices('requests', '7', new Set(['admin']), new Date())
    expect(sent).toBe(0)
  })
})

describe('several API replicas', () => {
  it('two processes gathering the same burst send each approver ONE notice', async () => {
    // Replica A and replica B both reached the send step for record 7 (e.g. both opened the
    // burst while Redis blinked): the per-approver SET NX PX lets only the first one through.
    const a = await sendApprovalNotices('requests', '7', new Set(['admin']), recent, 't:requests:7')
    const b = await sendApprovalNotices('requests', '7', new Set(['admin']), recent, 't:requests:7')
    expect(a).toBe(2)
    expect(b).toBe(0)
    expect(state.notified.map((n) => n.to).sort()).toEqual(['dir', 'mgr'])
    expect([...(state.redis?.store.keys() ?? [])].sort()).toEqual([
      'nvr:cab:sent:t:requests:7:dir',
      'nvr:cab:sent:t:requests:7:mgr'
    ])
  })
  it('only one process opens a burst; changers from every process are merged', async () => {
    expect(await claimOnce('open:t:requests:7', 600_000)).toBe(true)
    expect(await claimOnce('open:t:requests:7', 600_000)).toBe(false)
    state.redis?.sets.set('nvr:cab:chg:t:requests:7', new Set(['admin', '~']))
    const all = await burstChangers('t:requests:7', new Set(['dir']))
    expect([...all].sort((x, y) => String(x).localeCompare(String(y)))).toEqual([
      'admin',
      'dir',
      null
    ])
  })
  it('falls back to a per-process gate while Redis is down', async () => {
    if (state.redis) state.redis.down = true
    expect(await claimOnce('open:t:requests:99', 600_000)).toBe(true)
    expect(await claimOnce('open:t:requests:99', 600_000)).toBe(false)
    const first = await sendApprovalNotices('requests', '7', new Set(['admin']), recent, 't:r:98')
    const again = await sendApprovalNotices('requests', '7', new Set(['admin']), recent, 't:r:98')
    expect(first).toBe(2)
    expect(again).toBe(0)
    // Changers: the local set alone.
    expect([...(await burstChangers('t:r:98', new Set(['x'])))]).toEqual(['x'])
  })
})

describe('list condition', () => {
  it('reads its value like a presence filter', () => {
    expect(approvalChangedWanted({ op: '_eq', value: true })).toBe(true)
    expect(approvalChangedWanted({ op: '_eq', value: false })).toBe(false)
    expect(approvalChangedWanted({ op: '_neq', value: true })).toBe(false)
  })
})

describe('list condition read (security review 2026-11-15)', () => {
  const wire = (n: number) => {
    state.tables.nivaro_workflow_bindings = [{ template: 't' }]
    state.tables.nivaro_workflow_states = [{ id: 's-approved' }]
    state.tables.nivaro_revisions = Array.from({ length: n }, (_, i) => ({
      item: String(i + 1),
      delta: JSON.stringify({ amount: i }),
      timestamp: recent,
      moment: approvedAt
    }))
    state.calls = []
    state.gated = []
    state.partial = []
  }

  it('is gated, newest first in a fixed order, and complete under the cap', async () => {
    wire(3)
    const out = await approvalChangedIds('requests', null, 'U1')
    expect(out).toEqual({ ids: ['1', '2', '3'], partial: false })
    expect(state.gated).toEqual(['approval-changed-filter'])
    const orders = state.calls.filter(([t, m]) => t === 'nivaro_revisions' && m === 'orderBy')
    expect(orders.map(([, , a]) => a)).toEqual([
      ['a.timestamp', 'desc'],
      ['r.id', 'desc']
    ])
  })

  it('says partial when more rows match than the cap, and the list is told', async () => {
    wire(LIST_ROW_CAP + 1)
    const out = await approvalChangedIds('requests', null, 'U1')
    expect(out.partial).toBe(true)
    expect(out.ids).toHaveLength(LIST_ROW_CAP)
    const ids = await resolveApprovalChangedCondition({}, 'requests', 'U1')
    expect(ids).toHaveLength(LIST_ROW_CAP)
    expect(state.partial).toEqual([APPROVAL_CHANGED_FIELD])
  })
})
