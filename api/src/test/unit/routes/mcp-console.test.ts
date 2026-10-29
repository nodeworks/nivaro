import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'

// The console signs in like the admin app: a session cookie here; admins only.
vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = async (req: {
    headers: Record<string, string>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const cookie = req.headers.cookie ?? ''
    if (cookie.includes('sid=admin')) {
      req.user = { id: 'A1' }
      req.isAdmin = true
    } else if (cookie.includes('sid=pat')) {
      req.user = { id: 'U1' }
      req.isAdmin = false
    } else throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  }
  return {
    authenticate,
    requireAdmin: async (req: never, reply: never) => {
      await authenticate(req)
      if (!(req as { isAdmin?: boolean }).isAdmin)
        throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
      void reply
    }
  }
})

const { mcpConsoleRoutes } = await import('../../../routes/mcp-console.js')

let app: FastifyInstance
const reached: Array<{ method: string; url: string; auth?: string; app?: string }> = []

beforeAll(async () => {
  app = Fastify()
  await app.register(
    async (api) => {
      api.addHook('onRequest', async (req) => {
        if (!req.url.startsWith('/api/mcp-console'))
          reached.push({
            method: req.method,
            url: req.url,
            auth: req.headers.authorization,
            app: req.headers['x-nivaro-app'] as string | undefined
          })
      })
      await api.register(mcpConsoleRoutes, { prefix: '/mcp-console' })
      api.get('/auth/me', async (req) => {
        if (!String(req.headers.cookie).includes('sid=admin')) throw new Error('no session')
        return { data: { id: 'A1', email: 'ada@example.com', is_admin: true } }
      })
      api.post('/items/:collection', async (req) => ({
        data: { would_create: true, dry_run: (req.query as { dry_run?: string }).dry_run }
      }))
      api.patch('/items/:collection/:id', async () => ({ data: { id: 1 } }))
      api.post('/comments', async () => ({ data: { id: 3, created_at: 't', mentions: [] } }))
      api.get('/mcp/capabilities', async () => ({
        data: { admin_tools: true, chat: 'none', update_preview: true }
      }))
    },
    { prefix: '/api' }
  )
  await app.ready()
})
afterAll(() => app.close())

const asAdmin = { cookie: 'sid=admin' }

describe('/api/mcp-console (#2468)', () => {
  it('is for administrators only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/mcp-console/tools',
      headers: { cookie: 'sid=pat' }
    })
    expect(res.statusCode).toBe(403)
  })

  it("lists the admin's tools with their schemas and write flags", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/mcp-console/tools', headers: asAdmin })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.admin_tools).toBe(true)
    const byName = Object.fromEntries(body.tools.map((t: { name: string }) => [t.name, t]))
    expect(byName.whoami.write).toBe(false)
    expect(byName.health).toBeTruthy() // an admin tool
    expect(byName.create_item).toMatchObject({ write: true, dry_run_arg: true })
    // update_item previews with its own dry_run (#3222); add_comment cannot rehearse.
    expect(byName.update_item).toMatchObject({ write: true, dry_run_arg: true })
    expect(byName.add_comment).toMatchObject({ write: true, dry_run_arg: false })
    expect(byName.read_items.input_schema.properties.collection).toBeTruthy()
  })

  it('runs a read as the signed-in admin and reports timing, size and calls', async () => {
    reached.length = 0
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-console/run',
      headers: asAdmin,
      payload: { tool: 'whoami', arguments: {} }
    })
    const body = res.json()
    expect(body.is_error).toBe(false)
    expect(body.compact).toMatchObject({ email: 'ada@example.com' })
    expect(body.chars).toBeGreaterThan(0)
    expect(typeof body.ms).toBe('number')
    expect(body.dry_run).toBe('not_needed')
    expect(body.calls[0]).toMatchObject({ method: 'GET', path: '/api/auth/me', status: 200 })
    // The session cookie went through, not the SDK's placeholder bearer.
    expect(reached[0]).toMatchObject({ auth: undefined, app: 'mcp-console' })
  })

  it('rehearses a tool with its own dry_run argument', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-console/run',
      headers: asAdmin,
      payload: { tool: 'create_item', arguments: { collection: 'articles', data: { title: 'x' } } }
    })
    const body = res.json()
    expect(body.dry_run).toBe('tool')
    expect(body.arguments.dry_run).toBe(true)
    expect(body.calls[0].path).toContain('dry_run=1')
  })

  it('holds the writes of a tool that cannot rehearse, and sends them when dry run is off', async () => {
    reached.length = 0
    const held = await app.inject({
      method: 'POST',
      url: '/api/mcp-console/run',
      headers: asAdmin,
      payload: {
        tool: 'add_comment',
        arguments: { collection: 'articles', id: '1', text: 'y' }
      }
    })
    const body = held.json()
    expect(body.dry_run).toBe('held')
    expect(body.is_error).toBe(true)
    expect(body.calls.find((c: { held?: boolean }) => c.held)).toMatchObject({
      method: 'POST',
      path: '/api/comments',
      body: { collection: 'articles', item: '1', text: 'y' }
    })
    expect(reached.some((r) => r.method === 'POST')).toBe(false)

    const real = await app.inject({
      method: 'POST',
      url: '/api/mcp-console/run',
      headers: asAdmin,
      payload: {
        tool: 'add_comment',
        arguments: { collection: 'articles', id: '1', text: 'y' },
        dry_run: false
      }
    })
    expect(real.json().dry_run).toBe('off')
    expect(reached.some((r) => r.method === 'POST' && r.url === '/api/comments')).toBe(true)
  })

  it('previews update_item through its own dry_run, never a real PATCH', async () => {
    reached.length = 0
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-console/run',
      headers: asAdmin,
      payload: {
        tool: 'update_item',
        arguments: { collection: 'articles', id: '1', data: { title: 'y' } }
      }
    })
    const body = res.json()
    expect(body.dry_run).toBe('tool')
    expect(body.arguments.dry_run).toBe(true)
    // The capability check the stdio server makes before a preview.
    expect(reached.some((r) => r.url === '/api/mcp/capabilities')).toBe(true)
    expect(reached.some((r) => r.method === 'PATCH' && r.url.includes('dry_run=1'))).toBe(true)
    expect(reached.some((r) => r.method === 'PATCH' && !r.url.includes('dry_run=1'))).toBe(false)
  })

  it('refuses a tool the admin does not have', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp-console/run',
      headers: asAdmin,
      payload: { tool: 'drop_database' }
    })
    expect(res.statusCode).toBe(404)
  })
})
