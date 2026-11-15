import { beforeEach, describe, expect, it, vi } from 'vitest'

// A chainable stand-in: every builder call returns itself; awaiting answers the table's rows.
const state = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  notified: [] as Array<{ to: string; opts: Record<string, unknown> }>,
  unreadable: new Set<string>(),
  rules: null as unknown,
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
        return () => proxy
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
vi.mock('./io-holder.js', () => ({ getApp: () => ({ redis: null }) }))
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

import {
  APPROVAL_CHANGES_CATEGORY,
  approvalChangedWanted,
  approvalChangesFor,
  noticeRecipients,
  sendApprovalNotices
} from './approval-changes.js'

const approvedAt = new Date(Date.now() - 3_600_000)
const recent = new Date(Date.now() - 5_000)

beforeEach(() => {
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

describe('list condition', () => {
  it('reads its value like a presence filter', () => {
    expect(approvalChangedWanted({ op: '_eq', value: true })).toBe(true)
    expect(approvalChangedWanted({ op: '_eq', value: false })).toBe(false)
    expect(approvalChangedWanted({ op: '_neq', value: true })).toBe(false)
  })
})
