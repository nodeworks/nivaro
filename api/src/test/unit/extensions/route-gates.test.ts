import { describe, expect, it } from 'vitest'
import {
  extensionRoutes,
  routeRecordingApp,
  ungatedExtensionRoutes
} from '../../../extensions/loader.js'
import { authenticate, requireAdmin, requireAuth } from '../../../middleware/authenticate.js'

/** A Fastify stand-in: `register` hands the plugin a child scope carrying the
 *  prefix; route methods and hooks are no-ops — the wrapper under test reads
 *  everything off the arguments. */
function fakeScope(prefix = ''): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    prefix,
    addHook: () => scope,
    route: () => scope,
    register: async (plugin: (f: unknown, o: unknown) => unknown, opts?: { prefix?: string }) => {
      await plugin(fakeScope(`${prefix}${opts?.prefix ?? ''}`), opts)
    }
  }
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'all']) scope[m] = () => scope
  return scope
}

type Scope = {
  get: (...a: unknown[]) => void
  post: (...a: unknown[]) => void
  addHook: (n: string, fn: unknown) => void
  register: (p: unknown, o?: unknown) => Promise<void>
}

describe('extension route gates (#813)', () => {
  it('records every route with the gate it carries — route-level, scope-level, nested, or none', async () => {
    extensionRoutes.delete('t')
    const app = routeRecordingApp('t', fakeScope() as never)
    await app.register(
      async (f: unknown) => {
        const s = f as Scope
        s.get('/open', async () => ({}))
        s.get('/signed', { preHandler: requireAuth }, async () => ({}))
        s.get('/auth', { onRequest: [authenticate] }, async () => ({}))
        s.post('/admin', { preHandler: [requireAdmin] }, async () => ({}))
        s.post('/hook', { config: { public: true } }, async () => ({}))
        s.get('/custom', { preHandler: async function myGate() {} }, async () => ({}))
        // a scope-level gate guards the routes after it, and the child scopes
        s.addHook('preHandler', requireAuth)
        s.get('/after-scope-gate', async () => ({}))
        await s.register(
          async (c: unknown) => {
            const cs = c as Scope
            cs.get('/nested', async () => ({}))
            cs.addHook('onRequest', requireAdmin)
            cs.get('/nested-admin', async () => ({}))
          },
          { prefix: '/deep' }
        )
      },
      { prefix: '/api/t' }
    )
    app.get('/root', { preHandler: requireAdmin }, async () => ({}))
    app.route({ method: ['GET', 'HEAD'], url: '/routed', handler: async () => ({}) } as never)

    const list = extensionRoutes.get('t') ?? []
    const gate = (url: string) => list.find((r) => r.url === url)
    expect(gate('/api/t/open')?.gate).toBe('public')
    expect(gate('/api/t/signed')?.gate).toBe('authenticated')
    expect(gate('/api/t/auth')?.gate).toBe('authenticated')
    expect(gate('/api/t/admin')).toMatchObject({ method: 'POST', gate: 'admin' })
    expect(gate('/api/t/hook')?.gate).toBe('public-declared')
    expect(gate('/api/t/custom')).toMatchObject({ gate: 'custom', detail: 'myGate' })
    expect(gate('/api/t/after-scope-gate')?.gate).toBe('authenticated')
    expect(gate('/api/t/deep/nested')?.gate).toBe('authenticated')
    expect(gate('/api/t/deep/nested-admin')?.gate).toBe('admin')
    expect(gate('/root')).toMatchObject({ method: 'GET', gate: 'admin' })
    expect(list.filter((r) => r.url === '/routed').map((r) => r.method)).toEqual(['GET'])
    expect(
      ungatedExtensionRoutes()
        .filter((r) => r.extension === 't')
        .map((r) => r.url)
    ).toEqual(['/api/t/open', '/routed'])
    extensionRoutes.delete('t')
  })
})
