import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION

vi.mock('../../config.js', () => ({
  config: {
    NODE_ENV: 'test',
    DB_CLIENT: process.env.DB_CLIENT ?? 'mssql',
    DB_DATABASE: process.env.DB_DATABASE ?? 'testdb',
    DB_HOST: process.env.DB_HOST ?? 'localhost',
    DB_PORT: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_ENCRYPT: process.env.DB_ENCRYPT === 'true',
    DB_TRUST_SERVER_CERT: process.env.DB_TRUST_SERVER_CERT !== 'false',
    DB_POOL_MAX: 10,
    ENCRYPTION_KEY: null
  }
}))
// setup.ts mocks the db globally; these tests need the real, migrated database.
vi.unmock('../../db/index.js')
vi.mock('../../services/pipeline-engine.js', () => ({ resolveStateOwners: vi.fn(async () => []) }))
vi.mock('../../services/branch-instances.js', () => ({ findRecordInstance: vi.fn(async () => null) }))
vi.mock('../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async () => {}),
  authenticate: vi.fn(async () => {})
}))
vi.mock('../../services/activity.js', () => ({ logActivity: vi.fn().mockResolvedValue(1) }))
vi.mock('../../services/record-events.js', () => ({ announceRecordAspect: vi.fn() }))
vi.mock('../../services/permissions.js', () => ({ can: vi.fn().mockResolvedValue(true) }))

import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { db } from '../../db/index.js'
import { commentsRoutes } from '../../routes/comments.js'

// Needs a migrated Postgres: RUN_INTEGRATION=1 plus the usual DB_* env.
describe.skipIf(!RUN_INTEGRATION)('Integration: comment edit/delete concurrency', () => {
  const userId = randomUUID()
  const commentIds: string[] = []

  async function app() {
    const a = Fastify()
    a.addHook('onRequest', async (req: any) => {
      req.user = { id: userId }
      req.isAdmin = true
    })
    await a.register(commentsRoutes, { prefix: '/comments' })
    return a
  }

  async function makeComment(text: string) {
    const id = randomUUID()
    commentIds.push(id)
    await db('nivaro_comments').insert({ id, collection: 'cc_test', item: '1', user: userId, text })
    return id
  }

  beforeAll(async () => {
    await db.migrate.latest()
    await db('nivaro_users').insert({ id: userId, email: `cc-${userId}@test.local`, status: 'active' })
  })

  afterAll(async () => {
    await db('nivaro_comments').whereIn('id', commentIds).del()
    await db('nivaro_users').where({ id: userId }).del()
    await db.destroy()
  })

  it('concurrent edits get distinct contiguous versions', async () => {
    const a = await app()
    const id = await makeComment('v0')
    const res = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((t) =>
        a.inject({ method: 'PATCH', url: `/comments/${id}`, payload: { text: t } })
      )
    )
    expect(res.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200])
    const versions = await db('nivaro_comment_versions').where({ comment: id }).orderBy('version')
    expect(versions.map((v: any) => v.version)).toEqual([1, 2, 3, 4, 5])
    // Each snapshot is the text the previous edit left behind: a chain, no duplicates
    const texts = versions.map((v: any) => v.text)
    expect(new Set(texts).size).toBe(5)
    expect(texts[0]).toBe('v0')
  })

  it('concurrent edit + delete never leaves a deleted comment with text', async () => {
    const a = await app()
    for (let i = 0; i < 10; i++) {
      const id = await makeComment('orig')
      const [p, d] = await Promise.all([
        a.inject({ method: 'PATCH', url: `/comments/${id}`, payload: { text: 'edited' } }),
        a.inject({ method: 'DELETE', url: `/comments/${id}` })
      ])
      expect([200, 400]).toContain(p.statusCode)
      expect(d.statusCode).toBe(204)
      const row = await db('nivaro_comments').where({ id }).first()
      expect(row.deleted_at).not.toBeNull()
      expect(row.text).toBe('')
      const versions = await db('nivaro_comment_versions').where({ comment: id }).orderBy('version')
      expect(versions.map((v: any) => v.version)).toEqual(versions.map((_: any, j: number) => j + 1))
    }
  })
})
