import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// GitLab issue sync on the issue log (Task 12): the list and the single issue carry `tracker`
// (the linked GitLab issue) only while the feature is on and a connection syncs the issue log;
// admins get the whole link, everyone else the chip (number, link, state, title) only; and
// ?tracker=linked|unlinked|suggested filters the list for admins.

vi.mock('../../../middleware/authenticate.js', () => {
  const requireAuth = vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      const who = req.headers['x-test-user'] ?? 'nobody'
      req.user = { id: who.toUpperCase() }
      req.isAdmin = who === 'admin'
    }
  )
  return { requireAuth, requireAdmin: requireAuth, authenticate: requireAuth }
})
vi.mock('../../../plugins/socketio.js', () => ({ emitNotification: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/client-version.js', () => ({
  CLIENT_HEADER: 'x-nivaro-client',
  parseClientHeader: vi.fn(() => null)
}))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/items.js', () => ({ readOne: vi.fn(async () => null) }))

const state = vi.hoisted(() => ({
  enabled: true,
  connections: [{ id: 1, sync: { sources: { issue: true } } }] as Array<{
    id: number
    sync: { sources: { issue: boolean } }
  }>,
  linkedConnections: [] as Array<Set<number> | undefined>
}))
vi.mock('../../../services/trackers/feature.js', () => ({
  trackersEnabled: vi.fn(async () => state.enabled)
}))
vi.mock('../../../services/trackers/connections.js', () => ({
  listConnections: vi.fn(async () => state.connections)
}))

const LINK = {
  id: 7,
  connection: 1,
  web_url: 'https://gitlab.example.com/team/app/-/issues/482',
  project_path: 'team/app',
  iid: 482,
  remote_state: 'opened',
  remote_title: 'Totals wrong',
  labels: ['bug'],
  assignees: ['kim'],
  milestone: null,
  created_via: 'manual',
  sync_error: null,
  members: [1],
  sources: [{ kind: 'issue', id: '1' }]
}
vi.mock('../../../services/trackers/links.js', () => ({
  linksForIssues: vi.fn(async (ids: number[], opts?: { connections?: Set<number> }) => {
    state.linkedConnections.push(opts?.connections)
    const out = new Map()
    if (ids.includes(1)) out.set(1, LINK)
    return out
  }),
  chipOf: (v: typeof LINK, title: string | null) => ({
    iid: v.iid,
    web_url: v.web_url,
    state: v.remote_state,
    title: title ?? ''
  })
}))

const ISSUES: Record<number, Record<string, unknown>> = {
  1: { id: 1, source: 'manual', title: 'One', raised_by: 'PAUL', tracker_suggested_rule: null },
  2: { id: 2, source: 'manual', title: 'Two', raised_by: 'PAUL', tracker_suggested_rule: 4 }
}
const sql = vi.hoisted(() => ({ ran: [] as FakeQuery[] }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      sql.ran.push(q)
      if (q.sql.includes('nivaro_tracker')) return []
      if (q.method === 'first') return ISSUES[Number(q.bindings.at(-1))]
      return Object.values(ISSUES).map((r) => ({ ...r }))
    })
  }
})

import { issuesRoutes } from '../../../routes/issues.js'

async function buildApp() {
  const app = Fastify()
  await app.register(issuesRoutes, { prefix: '/issues' })
  await app.ready()
  return app
}

const listSql = () => sql.ran.find((q) => q.sql.includes('from [nivaro_issues] as [i]'))!

beforeEach(() => {
  sql.ran.length = 0
  state.enabled = true
  state.connections = [{ id: 1, sync: { sources: { issue: true } } }]
  state.linkedConnections.length = 0
})

describe('GET /issues — GitLab', () => {
  it('list includes tracker for linked issues', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/issues', headers: { 'x-test-user': 'admin' } })
    expect(res.statusCode).toBe(200)
    const rows = res.json().data as Array<Record<string, unknown>>
    const one = rows.find((r) => r.id === 1)!
    const two = rows.find((r) => r.id === 2)!
    expect((one.tracker as { iid: number }).iid).toBe(482)
    expect((one.tracker as { labels: string[] }).labels).toEqual(['bug'])
    expect(two.tracker).toBeNull()
    expect(two.tracker_suggested_rule).toBe(4)
    // only links on connections that sync the issue log
    expect([...(state.linkedConnections[0] ?? [])]).toEqual([1])
    await app.close()
  })

  it('filter tracker=unlinked excludes linked', async () => {
    const app = await buildApp()
    await app.inject({ url: '/issues?tracker=unlinked', headers: { 'x-test-user': 'admin' } })
    const list = listSql()
    expect(list.sql).toMatch(/not exists \(select 1 from \[nivaro_tracker_link_members\] as \[tm\]/)
    expect(list.sql).toContain('CAST([i].[id] AS NVARCHAR(100))')
    // the total counts the same rows
    const count = sql.ran.find((q) => q.sql.includes('count(*)'))!
    expect(count.sql).toMatch(/not exists \(select 1 from \[nivaro_tracker_link_members\]/)
    await app.close()
  })

  it('filter tracker=linked and suggested', async () => {
    const app = await buildApp()
    await app.inject({ url: '/issues?tracker=linked', headers: { 'x-test-user': 'admin' } })
    expect(listSql().sql).toMatch(/where exists \(select 1 from \[nivaro_tracker_link_members\]/)
    sql.ran.length = 0
    await app.inject({ url: '/issues?tracker=suggested', headers: { 'x-test-user': 'admin' } })
    expect(listSql().sql).toContain('[i].[tracker_suggested_rule] is not null')
    expect(listSql().sql).toMatch(/not exists \(select 1 from \[nivaro_tracker_link_members\]/)
    await app.close()
  })

  it('a non-admin gets the chip only, no suggested rule, and no tracker filter', async () => {
    const app = await buildApp()
    const res = await app.inject({
      url: '/issues?tracker=unlinked',
      headers: { 'x-test-user': 'paul' }
    })
    const one = (res.json().data as Array<Record<string, unknown>>).find((r) => r.id === 1)!
    expect(one.tracker).toEqual({
      iid: 482,
      web_url: LINK.web_url,
      state: 'opened',
      // the title the reader sees on the row, never the GitLab mirror's
      title: 'One'
    })
    expect(one).not.toHaveProperty('tracker_suggested_rule')
    expect(listSql().sql).not.toContain('nivaro_tracker_link_members')
    expect(listSql().sql).not.toContain('tracker_suggested_rule')
    await app.close()
  })

  it('feature off: no tracker fields, no filter, no tracker reads', async () => {
    state.enabled = false
    const app = await buildApp()
    const res = await app.inject({
      url: '/issues?tracker=linked',
      headers: { 'x-test-user': 'admin' }
    })
    for (const r of res.json().data as Array<Record<string, unknown>>) {
      expect(r).not.toHaveProperty('tracker')
      expect(r).not.toHaveProperty('tracker_suggested_rule')
    }
    expect(listSql().sql).not.toContain('tracker')
    expect(state.linkedConnections).toHaveLength(0)
    await app.close()
  })

  it('no connection syncs the issue log: same as off', async () => {
    state.connections = [{ id: 1, sync: { sources: { issue: false } } }]
    const app = await buildApp()
    const res = await app.inject({ url: '/issues', headers: { 'x-test-user': 'admin' } })
    for (const r of res.json().data as Array<Record<string, unknown>>)
      expect(r).not.toHaveProperty('tracker')
    await app.close()
  })
})

describe('server issue titles stay redacted through the chip', () => {
  it('a non-admin reading a linked server issue gets no raw server title anywhere', async () => {
    const raw =
      "[server] GET /api/items/:collection: select top (@p0) [id] from [workflows_divisions] - Ambiguous column name 'id'."
    const saved = { ...ISSUES[1] }
    const savedTitle = LINK.remote_title
    ISSUES[1] = { ...saved, source: 'server', title: raw, details: 'select top (@p0) …' }
    LINK.remote_title = raw
    try {
      const app = await buildApp()
      const list = await app.inject({ url: '/issues', headers: { 'x-test-user': 'paul' } })
      const one = await app.inject({ url: '/issues/1', headers: { 'x-test-user': 'paul' } })
      for (const res of [list, one]) {
        expect(res.statusCode).toBe(200)
        expect(res.body).not.toMatch(/select top|Ambiguous|workflows_divisions/)
      }
      expect(one.json().data.tracker.title).toBe('A server error on GET /api/items/:collection')
      expect(one.json().data.tracker.iid).toBe(482)
      await app.close()
    } finally {
      ISSUES[1] = saved
      LINK.remote_title = savedTitle
    }
  })
})

describe('GET /issues/:id — GitLab', () => {
  it('admin gets the link; feature off strips the stored suggestion', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/issues/1', headers: { 'x-test-user': 'admin' } })
    expect(res.json().data.tracker.iid).toBe(482)
    state.enabled = false
    const off = await app.inject({ url: '/issues/2', headers: { 'x-test-user': 'admin' } })
    expect(off.json().data).not.toHaveProperty('tracker')
    expect(off.json().data).not.toHaveProperty('tracker_suggested_rule')
    await app.close()
  })

  it('a non-admin reading their own issue gets the chip only', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/issues/1', headers: { 'x-test-user': 'paul' } })
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.json().data.tracker).sort()).toEqual([
      'iid',
      'state',
      'title',
      'web_url'
    ])
    expect(res.json().data).not.toHaveProperty('tracker_members')
    await app.close()
  })
})
