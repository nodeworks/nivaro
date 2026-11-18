import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GitLab sync sign-in routes (Task 9b): what a create_roles member may send and see, and the
 * read routes the shared UI uses (chip + connections I may create on).
 */

vi.mock('../middleware/authenticate.js', () => ({
  authenticate: async (req: any) => {
    const who = String(req.headers['x-who'] ?? 'person')
    req.user = {
      id: who === 'admin' ? 'A-1' : 'U-1',
      role: who === 'admin' ? 'admin' : 'role-desk'
    }
    req.isAdmin = who === 'admin'
  },
  requireAuth: async () => {},
  requireAdmin: async () => {}
}))
const feature = vi.hoisted(() => ({ on: true }))
vi.mock('../services/trackers/feature.js', () => ({
  FeatureLockedError: class extends Error {},
  requireFeatureOn: async (_req: unknown, reply: any) => {
    if (!feature.on) return reply.code(404).send({ code: 'FEATURE_OFF' })
  },
  setTrackersEnabled: async () => ({}),
  trackersEnabled: async () => feature.on,
  trackersFeature: async () => ({ enabled: feature.on, source: 'setting' })
}))
vi.mock('../db/index.js', () => {
  const db: any = () => {
    const b: any = { where: () => b, first: async () => undefined, select: () => b }
    return b
  }
  db.raw = (sql: string) => ({ __raw: sql })
  return { db }
})
vi.mock('../services/trackers/create-access.js', () => ({
  mayCreateFrom: async () => ({ ok: true })
}))

const fullView = {
  id: 10,
  connection: 1,
  web_url: 'https://gitlab.example.com/g/p/-/issues/12',
  project_path: 'g/p',
  iid: 12,
  remote_state: 'opened',
  remote_title: 'Checkout fails',
  labels: ['secret'],
  assignees: ['ann'],
  milestone: null,
  created_via: 'linked',
  sync_error: null,
  members: [5],
  sources: [{ kind: 'issue', id: '5' }]
}
const linkedView = vi.hoisted(() => ({ title: null as string | null }))
const linkTitle = vi.hoisted(() => ({ value: null as string | null }))
const calls = vi.hoisted(() => ({ create: [] as any[][], link: [] as any[][] }))
vi.mock('../services/trackers/links.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/trackers/links.js')>()
  return {
    ...real,
    requestSourceCreate: async (...a: any[]) => {
      calls.create.push(a)
      return { outboxId: 9 }
    },
    linkSourceExisting: async (...a: any[]) => {
      calls.link.push(a)
      return linkedView.title ? { ...fullView, remote_title: linkedView.title } : fullView
    },
    linksForSource: async () => {
      const v = linkTitle.value ? { ...fullView, remote_title: linkTitle.value } : fullView
      return [v, { ...v, id: 11, connection: 2 }]
    }
  }
})
const conns = vi.hoisted(() => ({ list: [] as any[] }))
vi.mock('../services/trackers/connections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/trackers/connections.js')>()
  return {
    ...real,
    getConnection: async (id: number) => conns.list.find((c) => c.id === id) ?? null,
    listConnections: async () => conns.list
  }
})
const issueRow = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }))
vi.mock('../services/trackers/issue-body.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/trackers/issue-body.js')>()
  return { ...real, loadIssue: async () => issueRow.row }
})
const reads = vi.hoisted(() => ({ ok: true }))
vi.mock('../services/trackers/sources/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/trackers/sources/index.js')>()
  return {
    ...real,
    sourceFor: (kind: string) => ({
      canRead: async () => reads.ok,
      load: async (id: string) => ({
        kind,
        id,
        title: kind === 'ticket' ? 'My printer is broken' : 'Order 7',
        body: null,
        status: null,
        priority: null,
        url: '',
        fingerprint: null,
        vars: {}
      })
    })
  }
})

import { normalizeSync } from '../services/trackers/connections.js'
import { trackerSourceRoutes } from './trackers.js'

async function app() {
  const f = Fastify()
  await f.register(trackerSourceRoutes, { prefix: '/api/trackers' })
  return f
}

const conn = (
  id: number,
  sync: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) => ({
  id,
  name: `GL${id}`,
  is_active: true,
  status: 'ok',
  default_project_id: 7,
  default_project_path: 'g/p',
  sync: normalizeSync(sync),
  ...extra
})

beforeEach(() => {
  feature.on = true
  reads.ok = true
  calls.create.length = 0
  calls.link.length = 0
  conns.list = [
    conn(1, { create_roles: ['ROLE-DESK'] }),
    conn(2, { sources: { ticket: false }, create_roles: ['role-desk'] }),
    conn(3, {}),
    conn(4, { create_roles: ['role-desk'] }, { is_active: false })
  ]
})

describe('create / link for a create_roles member', () => {
  it('creates only in the default project with a title, description and labels', async () => {
    const f = await app()
    const body = {
      source_kind: 'ticket',
      source_id: '55',
      connection: 1,
      project_id: 99,
      overrides: {
        title: 'Mine',
        description: 'What happened',
        labels: ['x'],
        assignee_ids: [3],
        milestone_id: 4,
        confidential: true,
        weight: 2,
        due_date: '2026-12-01',
        issue_type: 'incident'
      }
    }
    const res = await f.inject({ method: 'POST', url: '/api/trackers/links', payload: body })
    expect(res.statusCode).toBe(202)
    const [, , opts] = calls.create[0]
    expect(opts.project_id).toBeUndefined()
    expect(opts.overrides).toEqual({ title: 'Mine', description: 'What happened', labels: ['x'] })
    // an admin keeps every override and the project
    await f.inject({
      method: 'POST',
      url: '/api/trackers/links',
      headers: { 'x-who': 'admin' },
      payload: body
    })
    expect(calls.create[1][2].project_id).toBe(99)
    expect(calls.create[1][2].overrides).toMatchObject({ assignee_ids: [3], confidential: true })
  })

  it('link-existing is restricted and answers the chip only', async () => {
    const f = await app()
    const payload = {
      source_kind: 'record',
      source_id: 'orders:7',
      connection: 1,
      url: 'https://gitlab.example.com/g/p/-/issues/12'
    }
    const res = await f.inject({ method: 'POST', url: '/api/trackers/links/existing', payload })
    expect(calls.link[0][5]).toEqual({ restricted: true })
    expect(res.json().data).toEqual({
      iid: 12,
      web_url: 'https://gitlab.example.com/g/p/-/issues/12',
      state: 'opened',
      // the record's own label as the caller reads it, never GitLab's title
      title: 'Order 7'
    })
    const admin = await f.inject({
      method: 'POST',
      url: '/api/trackers/links/existing',
      headers: { 'x-who': 'admin' },
      payload
    })
    expect(calls.link[1][5]).toEqual({ restricted: false })
    expect(admin.json().data.labels).toEqual(['secret'])
  })
})

describe('read routes for the shared UI', () => {
  it('links/for: the chip for someone who can read it, on connections that sync it', async () => {
    const f = await app()
    const url = '/api/trackers/links/for?source_kind=ticket&source_id=55'
    const res = await f.inject({ method: 'GET', url })
    // connection 2 has tickets switched off
    expect(res.json().data).toEqual([
      {
        iid: 12,
        web_url: 'https://gitlab.example.com/g/p/-/issues/12',
        state: 'opened',
        title: 'My printer is broken'
      }
    ])
    reads.ok = false
    expect((await f.inject({ method: 'GET', url })).statusCode).toBe(404)
    feature.on = false
    expect((await f.inject({ method: 'GET', url })).json()).toEqual({ code: 'FEATURE_OFF' })
  })

  it('links/for an issue: a non-admin never gets the raw server title through the chip', async () => {
    const raw =
      "[server] GET /api/items/:collection: select top (@p0) [id] from [workflows_divisions] - Ambiguous column name 'id'."
    issueRow.row = { id: 5, source: 'server', title: raw, raised_by: 'U-1' }
    linkTitle.value = raw
    const f = await app()
    const url = '/api/trackers/links/for?source_kind=issue&source_id=5'
    const res = await f.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.json().data[0].title).toBe('A server error on GET /api/items/:collection')
    expect(res.body).not.toMatch(/select top|Ambiguous|workflows_divisions/)
    // an admin reads the mirror as it is
    const admin = await f.inject({ method: 'GET', url, headers: { 'x-who': 'admin' } })
    expect(admin.json().data[0].title).toBe(raw)
    linkTitle.value = null
    issueRow.row = null
  })

  it('a ticket / record sharing a GitLab issue made from a server issue: no GitLab title', async () => {
    const raw =
      "[server] GET /api/items/:collection: select top (@p0) [id] from [workflows_divisions] - Ambiguous column name 'id'."
    linkTitle.value = raw
    conns.list = [conn(1, { sources: { issue: true, ticket: true, record: true } })]
    const f = await app()
    for (const url of [
      '/api/trackers/links/for?source_kind=ticket&source_id=55',
      '/api/trackers/links/for?source_kind=record&source_id=orders:7'
    ]) {
      const res = await f.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.json().data).toHaveLength(1)
      expect(res.body).not.toMatch(/select top|Ambiguous|workflows_divisions|\[server\]/)
    }
    linkedView.title = raw
    for (const payload of [
      { source_kind: 'ticket', source_id: '55' },
      { source_kind: 'record', source_id: 'orders:7' }
    ]) {
      const res = await f.inject({
        method: 'POST',
        url: '/api/trackers/links/existing',
        payload: { ...payload, connection: 1, url: 'https://gitlab.example.com/g/p/-/issues/12' }
      })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toMatch(/select top|Ambiguous|workflows_divisions|\[server\]/)
    }
    linkedView.title = null
    linkTitle.value = null
  })

  it('creatable: create_roles connections for people, every active one for admins', async () => {
    const f = await app()
    const mine = await f.inject({
      method: 'GET',
      url: '/api/trackers/creatable?source_kind=ticket'
    })
    expect(mine.json().data).toEqual([{ id: 1, name: 'GL1', default_project_path: 'g/p' }])
    const issues = await f.inject({
      method: 'GET',
      url: '/api/trackers/creatable?source_kind=issue'
    })
    expect(issues.json().data).toEqual([])
    const admin = await f.inject({
      method: 'GET',
      url: '/api/trackers/creatable?source_kind=ticket',
      headers: { 'x-who': 'admin' }
    })
    expect(admin.json().data.map((c: { id: number }) => c.id)).toEqual([1, 3])
  })
})
