import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const h = vi.hoisted(() => ({ tables: {} as Record<string, any[]>, seq: 0, notified: [] as any[], isAdmin: false }))

vi.mock('../../../db/index.js', () => {
  const run = (name: string) => {
    const preds: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'count' = 'select'
    let ord: Array<[string, string]> = []
    let lim = Infinity
    const rows = () => (h.tables[name] ??= [])
    const filtered = () => {
      let out = rows().filter((r) => preds.every((p) => p(r)))
      for (const [c, d] of [...ord].reverse()) out = [...out].sort((a, b) => (a[c] - b[c]) * (d === 'desc' ? -1 : 1))
      return out.slice(0, lim)
    }
    const q: any = {
      where(c: Row) { preds.push((r) => Object.entries(c).every(([k, v]) => r[k] === v)); return q },
      whereNull(c: string) { preds.push((r) => r[c] == null); return q },
      whereIn(c: string, v: any[]) { preds.push((r) => v.includes(r[c])); return q },
      whereNotIn(c: string, sub: any) {
        const vals: any[] = Array.isArray(sub) ? sub : sub.__rows().map((s: Row) => s[c])
        preds.push((r) => !vals.includes(r[c])); return q },
      orderBy(c: string, d = 'asc') { ord.push([c, d]); return q },
      limit(n: number) { lim = n; return q },
      select() { return q },
      count() { mode = 'count'; return q },
      first() { return Promise.resolve(mode === 'count' ? { n: filtered().length } : filtered()[0]) },
      __rows: () => filtered(),
      async insert(row: Row) { rows().push({ id: ++h.seq, ...row }) },
      async update(patch: Row) { filtered().forEach((r) => Object.assign(r, patch)) },
      async delete() { const keep = rows().filter((r) => !preds.every((p) => p(r))); h.tables[name] = keep },
      then(res: any, rej: any) {
        const v = mode === 'count' ? [{ n: filtered().length }] : filtered()
        return Promise.resolve(v).then(res, rej)
      }
    }
    return q
  }
  const db: any = (n: string) => run(n.split(' ')[0])
  db.transaction = async (fn: any) => fn((n: string) => run(n))
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: any) => { if (!h.isAdmin) { const e: any = new Error('Forbidden'); e.statusCode = 403; throw e } })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/embeddings.js', () => ({
  embeddingProvider: async () => ({ provider: 'local', model: null }),
  embedText: vi.fn(), searchEmbeddings: vi.fn()
}))
vi.mock('../../../services/items.js', () => ({
  ForbiddenError: class extends Error {},
  createOne: vi.fn(async (_u: any, c: string, data: Row) => {
    const row = { id: ++h.seq, merged_into: null, created_at: 'x', ...data }
    ;(h.tables[c] ??= []).push(row); return row
  }),
  updateOne: vi.fn(async (_u: any, c: string, id: number, data: Row) => {
    Object.assign(h.tables[c].find((r) => r.id === id), data)
  })
}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_a: any, userId: string, p: any) => { h.notified.push({ userId, ...p }) })
}))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/queues.js', () => ({ getLabels: vi.fn(async () => ({})) }))

import { ideasRoutes } from '../../../routes/ideas.js'

async function app(userId: string) {
  const a = Fastify()
  a.decorateRequest('user', null as any)
  a.addHook('onRequest', async (req: any) => { req.user = { id: userId } })
  await a.register(ideasRoutes, { prefix: '/ideas' })
  return a
}

beforeEach(() => { h.tables = {}; h.seq = 0; h.notified = []; h.isAdmin = false })

describe('ideas routes (fake db)', () => {
  it('creates with auto vote, votes once, unvotes, similar ranks and hides merged', async () => {
    const alice = await app('alice'); const bob = await app('bob')
    const mk = async (t: string) => (await alice.inject({ method: 'POST', url: '/ideas', payload: { title: t } })).json().data
    const a = await mk('Dark mode for dashboards')
    const b = await mk('Export reports to PDF')
    expect(a.vote_count).toBe(1); expect(a.voted).toBe(true)
    expect((await alice.inject({ method: 'POST', url: `/ideas/${a.id}/vote` })).json().data.vote_count).toBe(1)
    expect((await bob.inject({ method: 'POST', url: `/ideas/${a.id}/vote` })).json().data.vote_count).toBe(2)
    expect((await bob.inject({ method: 'POST', url: `/ideas/${a.id}/vote` })).json().data.vote_count).toBe(2)
    expect((await bob.inject({ method: 'DELETE', url: `/ideas/${a.id}/vote` })).json().data.vote_count).toBe(1)
    await bob.inject({ method: 'POST', url: `/ideas/${a.id}/vote` })

    const sim = (await bob.inject({ method: 'GET', url: '/ideas/similar?q=dark%20mode' })).json().data
    expect(sim.map((s: any) => s.id)).toEqual([a.id])

    // non-admin 403
    expect((await bob.inject({ method: 'PATCH', url: `/ideas/${a.id}/status`, payload: { status: 'planned' } })).statusCode).toBe(403)
    h.isAdmin = true
    const r = await bob.inject({ method: 'PATCH', url: `/ideas/${a.id}/status`, payload: { status: 'planned', note: 'Q3 work' } })
    expect(r.statusCode).toBe(200)
    expect(h.notified.map((n) => n.userId).sort()).toEqual(['alice', 'bob'])
    for (const n of h.notified) { expect(n.message).toContain('Planned'); expect(n.message).toContain('Q3 work') }

    // merge b (voter alice) into a (alice, bob): alice must not be double-counted
    h.notified = []
    const m = await bob.inject({ method: 'POST', url: `/ideas/${b.id}/merge`, payload: { into: a.id } })
    expect(m.json().data.vote_count).toBe(2)
    expect(h.tables.nivaro_idea_votes.filter((v) => v.idea_id === a.id)).toHaveLength(2)
    expect(h.tables.nivaro_idea_votes.filter((v) => v.idea_id === b.id)).toHaveLength(0)
    expect(h.tables.ideas.find((i) => i.id === b.id).merged_into).toBe(a.id)
    expect(h.notified.map((n) => n.userId)).toEqual(['alice'])
    const sim2 = (await bob.inject({ method: 'GET', url: '/ideas/similar?q=export%20reports' })).json().data
    expect(sim2).toEqual([])
  })

  it('admin links an idea to a backlog record; non-admin 403; duplicate 409', async () => {
    const bob = await app('bob')
    const idea = (await bob.inject({ method: 'POST', url: '/ideas', payload: { title: 'Bulk edit' } })).json().data
    h.tables.nivaro_collections = [{ id: 1, collection: 'backlog' }]
    h.tables.backlog = [{ id: '7' }]
    const url = `/ideas/${idea.id}/link`
    expect((await bob.inject({ method: 'POST', url, payload: { collection: 'backlog', id: 7 } })).statusCode).toBe(403)
    h.isAdmin = true
    const ok = await bob.inject({ method: 'POST', url, payload: { collection: 'backlog', id: 7 } })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().data.links).toEqual([expect.objectContaining({ collection: 'backlog', item: '7', type: 'relates to' })])
    expect(h.tables.nivaro_record_links[0]).toMatchObject({ from_collection: 'ideas', to_collection: 'backlog', to_item: '7' })
    expect((await bob.inject({ method: 'POST', url, payload: { collection: 'backlog', id: 7 } })).statusCode).toBe(409)
    expect((await bob.inject({ method: 'POST', url, payload: { collection: 'nivaro_users', id: 1 } })).statusCode).toBe(400)
  })
})
