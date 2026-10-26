import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
let owners: Array<{ id: string }> = []
let nextId = 1
// The record the thread hangs on is visible unless a test hides it.
const record = vi.hoisted(() => ({ visible: true }))
vi.mock('../../../services/socket-access.js', () => ({
  canSeeRecordRoom: vi.fn(async () => record.visible),
  visibleRecordIds: vi.fn(async (_u: unknown, _c: string, ids: string[]) =>
    record.visible ? ids : []
  )
}))
// Write-time file check (army v3 round 2): the helper is unit-tested in
// file-access.test.ts; here only that comments refuse what it refuses.
const files = vi.hoisted(() => ({ refused: new Set<string>() }))
vi.mock('../../../services/file-access.js', () => ({
  assertFileIdsReadable: vi.fn(
    async (field: string, value: unknown, req: { user: { id: string } }, previous?: unknown) => {
      const fresh =
        String(value).includes('F-SECRET') && !String(previous ?? '').includes('F-SECRET')
      if (fresh && files.refused.has(req.user.id))
        throw Object.assign(new Error('Text names a file you cannot open, so it cannot be saved'), {
          statusCode: 400,
          code: 'FILE_NOT_READABLE',
          field
        })
    }
  )
}))
vi.mock('../../../services/record-notes.js', () => ({ loadRecordNotes: vi.fn(async () => []) }))

vi.mock('../../../config.js', () => ({
  config: { NODE_ENV: 'test', DB_DATABASE: 'testdb', DB_HOST: 'localhost', ENCRYPTION_KEY: null }
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async () => {}),
  authenticate: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn().mockResolvedValue(1) }))
vi.mock('../../../services/record-events.js', () => ({ announceRecordAspect: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn().mockResolvedValue(true) }))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwners: vi.fn(async () => owners)
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => ({ id: 'i1', current_state: 's', completed_at: null }))
}))

vi.mock('../../../db/index.js', () => {
  function builder(rawName: string) {
    const name = rawName.split(' as ')[0]
    const t = () => (tables[name] ??= [])
    const filters: Array<(r: Row) => boolean> = []
    let order: [string, string] | null = null
    const strip = (c: string) => c.split('.').pop()!
    const rows = () => {
      let r = t().filter((x) => filters.every((f) => f(x)))
      if (order)
        r = [...r].sort((a, b) => (a[order![0]] - b[order![0]]) * (order![1] === 'asc' ? 1 : -1))
      return r
    }
    const b: any = {
      where(c: any, v?: any) {
        if (typeof c === 'object')
          for (const [k, val] of Object.entries(c)) filters.push((r) => r[strip(k)] === val)
        else filters.push((r) => r[strip(c)] === v)
        return b
      },
      whereNull: (c: string) => (filters.push((r) => r[strip(c)] == null), b),
      leftJoin: () => b,
      forUpdate: () => b,
      orderBy: (c: string, d: string) => ((order = [strip(c), d]), b),
      max(o: any) {
        const [alias, col] = Object.entries(o)[0] as [string, string]
        b._max = [alias, col]
        return b
      },
      first() {
        if (b._max) {
          const vals = rows().map((r) => r[b._max[1]])
          return Promise.resolve({ [b._max[0]]: vals.length ? Math.max(...vals) : null })
        }
        return Promise.resolve(rows()[0])
      },
      select: () => Promise.resolve(rows()),
      insert(v: Row) {
        const row = { id: name === 'nivaro_comment_versions' ? nextId++ : v.id, ...v }
        if (
          name === 'nivaro_comment_versions' &&
          t().some((r) => r.comment === v.comment && r.version === v.version)
        )
          return Promise.reject(new Error('unique violation'))
        t().push(row)
        return Promise.resolve([row.id])
      },
      update(v: Row) {
        for (const r of rows()) Object.assign(r, v)
        return Promise.resolve(1)
      },
      del() {
        const rs = new Set(rows())
        tables[name] = t().filter((r) => !rs.has(r))
        return Promise.resolve(rs.size)
      }
    }
    return b
  }
  const db: any = vi.fn((n: string) => builder(n))
  db.transaction = async (fn: any) => fn(db)
  db.raw = vi.fn()
  return { db }
})

import Fastify from 'fastify'
import { commentsRoutes } from '../../../routes/comments.js'

async function app(user: string, admin = false) {
  const a = Fastify()
  a.addHook('onRequest', async (req: any) => {
    req.user = { id: user }
    req.isAdmin = admin
  })
  await a.register(commentsRoutes, { prefix: '/comments' })
  return a
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.nivaro_comments = [
    {
      id: 'c1',
      collection: 'x',
      item: '1',
      user: 'author',
      text: 'v0',
      deleted_at: null,
      deleted_by: null
    }
  ]
  owners = [{ id: 'owner' }]
  record.visible = true
})

describe('comment history', () => {
  it('two edits → versions 1,2 with earlier texts and editor id', async () => {
    const a = await app('author')
    let r = await a.inject({ method: 'PATCH', url: '/comments/c1', payload: { text: 'v1' } })
    expect(r.json().data).toMatchObject({ edited: true, version_count: 1 })
    r = await a.inject({ method: 'PATCH', url: '/comments/c1', payload: { text: 'v2' } })
    expect(r.json().data).toMatchObject({ text: 'v2', edited: true, version_count: 2 })
    expect(tables.nivaro_comment_versions.map((v) => [v.version, v.text, v.user])).toEqual([
      [1, 'v0', 'author'],
      [2, 'v1', 'author']
    ])
    expect(tables.nivaro_comment_versions.every((v) => v.created_at instanceof Date)).toBe(true)
  })

  it('delete keeps row as tombstone, snapshots text, blocks later edit', async () => {
    const a = await app('author')
    const r = await a.inject({ method: 'DELETE', url: '/comments/c1' })
    expect(r.statusCode).toBe(204)
    expect(tables.nivaro_comments[0]).toMatchObject({ text: '', deleted_by: 'author' })
    expect(tables.nivaro_comments[0].deleted_at).toBeInstanceOf(Date)
    expect(tables.nivaro_comment_versions[0]).toMatchObject({ version: 1, text: 'v0' })
    const e = await a.inject({ method: 'PATCH', url: '/comments/c1', payload: { text: 'z' } })
    expect(e.statusCode).toBe(400)
  })

  it('delete 403 for non-author non-admin', async () => {
    const a = await app('other')
    expect((await a.inject({ method: 'DELETE', url: '/comments/c1' })).statusCode).toBe(403)
    expect(tables.nivaro_comments[0].deleted_at).toBeNull()
  })

  it.each([
    ['admin', 'admin', true, 200],
    ['author', 'author', false, 200],
    ['owner', 'owner', false, 200],
    ['stranger', 'stranger', false, 403]
  ])('history access: %s', async (_n, user, admin, status) => {
    tables.nivaro_comment_versions = [
      { id: 1, comment: 'c1', version: 1, text: 'old', user: 'author', created_at: new Date() }
    ]
    const a = await app(user, admin)
    const r = await a.inject({ method: 'GET', url: '/comments/c1/history' })
    expect(r.statusCode).toBe(status)
    if (status === 200) expect(r.json().data[0]).toMatchObject({ version: 1, text: 'old' })
  })

  it('a record the caller cannot open has no thread: list, notes, history and create answer 404', async () => {
    record.visible = false
    const a = await app('author')
    for (const url of [
      '/comments?collection=x&item=1',
      '/comments/related?collection=x&item=1',
      '/comments/c1/history'
    ]) {
      expect((await a.inject({ method: 'GET', url })).statusCode).toBe(404)
    }
    const post = await a.inject({
      method: 'POST',
      url: '/comments',
      payload: { collection: 'x', item: '1', text: '@owners probe' }
    })
    expect(post.statusCode).toBe(404)
    expect(tables.nivaro_comments).toHaveLength(1)
    const counts = await a.inject({ method: 'GET', url: '/comments/counts?collection=x&ids=1' })
    expect(counts.json()).toEqual({ data: {} })
  })

  it('a caller who can open the record reads its notes', async () => {
    const a = await app('reader')
    const r = await a.inject({ method: 'GET', url: '/comments/related?collection=x&item=1' })
    expect(r.statusCode).toBe(200)
  })
})

describe('comments only link files their writer can open', () => {
  it('a writer naming a file they cannot read is refused on create and edit', async () => {
    files.refused = new Set(['stranger', 'author'])
    const a = await app('stranger')
    const post = await a.inject({
      method: 'POST',
      url: '/comments',
      payload: { collection: 'x', item: '1', text: 'see /api/files/F-SECRET' }
    })
    expect(post.statusCode).toBe(400)
    expect(post.json()).toMatchObject({ code: 'FILE_NOT_READABLE', field: 'text' })
    expect(tables.nivaro_comments).toHaveLength(1)
    const b = await app('author')
    const edit = await b.inject({
      method: 'PATCH',
      url: '/comments/c1',
      payload: { text: 'now with F-SECRET' }
    })
    expect(edit.statusCode).toBe(400)
    expect(tables.nivaro_comments[0].text).toBe('v0')
  })

  it('the uploader (or anyone who can read the file) passes', async () => {
    files.refused = new Set()
    const a = await app('author')
    const post = await a.inject({
      method: 'POST',
      url: '/comments',
      payload: { collection: 'x', item: '1', text: 'see /api/files/F-SECRET' }
    })
    expect(post.statusCode).toBeLessThan(300)
    const edit = await a.inject({
      method: 'PATCH',
      url: '/comments/c1',
      payload: { text: 'now with F-SECRET' }
    })
    expect(edit.statusCode).toBe(200)
  })
})
