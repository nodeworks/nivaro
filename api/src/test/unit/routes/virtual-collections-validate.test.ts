import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// Validate SQL used to run `SET NOEXEC ON; <sql>; SET NOEXEC OFF;` — anything after an
// embedded `SET NOEXEC OFF` executed. It now compiles the text through
// sp_describe_first_result_set with the SQL bound as a parameter, never executed.

const raw = vi.fn(async (_sql: string, _bindings?: unknown[]) => [])
vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    vi.fn(() => ({
      where: () => ({ first: async () => ({ collection: 'v', is_virtual: 1, virtual_sql: 'x' }) })
    })),
    { raw: (sql: string, bindings?: unknown[]) => raw(sql, bindings) }
  )
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(), getAllowedFields: vi.fn() }))
vi.mock('../../../services/user-scopes.js', () => ({ getUserScopes: vi.fn() }))

const { virtualCollectionsRoutes } = await import('../../../routes/virtual-collections.js')

describe('POST /virtual-collections/:collection/validate-sql', () => {
  it('binds the SQL to sp_describe_first_result_set — never runs it', async () => {
    const app = Fastify()
    await app.register(virtualCollectionsRoutes)
    const sql = 'SELECT 1 AS id; SET NOEXEC OFF; DROP TABLE nivaro_users; -- ?'
    const res = await app.inject({
      method: 'POST',
      url: '/v/validate-sql',
      payload: { sql }
    })
    expect(res.json()).toEqual({ valid: true })
    expect(raw).toHaveBeenCalledTimes(1)
    const [text, bindings] = raw.mock.calls[0]
    expect(text).toBe('EXEC sys.sp_describe_first_result_set @tsql = ?')
    expect(text).not.toContain('NOEXEC')
    expect(bindings).toEqual([sql])
    await app.close()
  })

  it('reports a compile error as invalid', async () => {
    raw.mockRejectedValueOnce(new Error("Invalid object name 'nope'"))
    const app = Fastify()
    await app.register(virtualCollectionsRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v/validate-sql',
      payload: { sql: 'SELECT * FROM nope' }
    })
    expect(res.json()).toMatchObject({ valid: false })
    await app.close()
  })
})
