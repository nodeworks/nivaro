import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** GitLab sync admin routes: the connection list's webhook URL and the template sample. */

vi.mock('../middleware/authenticate.js', () => ({
  authenticate: async () => {},
  requireAuth: async () => {},
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
    req.isAdmin = true
  }
}))
const featureState = vi.hoisted(() => ({ enabled: true }))
vi.mock('../services/trackers/feature.js', () => ({
  FeatureLockedError: class extends Error {},
  requireFeatureOn: async () => {},
  setTrackersEnabled: async (enabled: boolean) => {
    featureState.enabled = enabled
    return { enabled, source: 'setting' }
  },
  trackersEnabled: async () => true,
  trackersFeature: async () => ({ enabled: featureState.enabled, source: 'setting' })
}))
const clocks = vi.hoisted(() => ({ restarts: 0 }))
vi.mock('../db/index.js', () => {
  const db: any = () => {
    const b: any = { where: () => b, first: async () => undefined, select: () => b }
    return b
  }
  db.raw = (sql: string) => ({ __raw: sql })
  return { db }
})
vi.mock('../admin-base.js', () => ({ adminBaseUrl: () => 'https://admin.example.com' }))
vi.mock('../services/trackers/connections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/trackers/connections.js')>()
  return {
    ...real,
    restartImportClocks: async () => {
      clocks.restarts++
      return 0
    },
    listConnections: async () => [
      { id: 3, name: 'GL', token_set: true },
      { id: 8, name: 'Other', token_set: false }
    ]
  }
})
const loads = vi.hoisted(() => ({ calls: [] as unknown[][], view: null as any }))
vi.mock('../services/trackers/sources/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/trackers/sources/index.js')>()
  return {
    ...real,
    sourceFor: (kind: string) => ({
      kind,
      load: async (...a: unknown[]) => {
        loads.calls.push([kind, ...a])
        return loads.view
      }
    })
  }
})

import { runWithTenantDb } from '../db/tenant-context.js'
import { trackerRoutes } from './trackers.js'

async function app() {
  const f = Fastify()
  await f.register(trackerRoutes, { prefix: '/api/trackers' })
  return f
}

beforeEach(() => {
  loads.calls = []
  loads.view = {
    kind: 'issue',
    id: '41',
    title: 'Checkout fails',
    vars: { title: 'Checkout fails', severity: 'high', total_hits: 20, route: 'checkout' }
  }
})

describe('connection list', () => {
  it('GET / gives every connection its webhook URL from the admin address', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/api/trackers' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([
      expect.objectContaining({
        id: 3,
        webhook_url: 'https://admin.example.com/api/tracker-hooks/gitlab/3'
      }),
      expect.objectContaining({
        id: 8,
        webhook_url: 'https://admin.example.com/api/tracker-hooks/gitlab/8'
      })
    ])
  })

  it("on a Hub shared deployment the webhook URL is the app's own origin, never the process's", async () => {
    const keys = ['HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'HUB_DEPLOYMENT_TOKEN'] as const
    const before = keys.map((k) => process.env[k])
    Object.assign(process.env, {
      HUB_SHARED_DEPLOYMENT: 'shared-a',
      HUB_URL: 'https://hub.example.com',
      HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
    })
    try {
      const f = Fastify()
      // middleware/tenant.ts: the request's host names the app and its verified origin
      f.addHook('onRequest', (_req, _reply, done) =>
        runWithTenantDb({} as never, 'a', done, 'A', 'https://app-a.example.com')
      )
      await f.register(trackerRoutes, { prefix: '/api/trackers' })
      const res = await f.inject({ method: 'GET', url: '/api/trackers' })
      expect(res.json().data.map((c: { webhook_url: string }) => c.webhook_url)).toEqual([
        'https://app-a.example.com/api/tracker-hooks/gitlab/3',
        'https://app-a.example.com/api/tracker-hooks/gitlab/8'
      ])
      await f.close()
    } finally {
      keys.forEach((k, i) => {
        if (before[i] === undefined) delete process.env[k]
        else process.env[k] = before[i]
      })
    }
  })
})

describe('POST /rules/sample', () => {
  it('renders the title, body and labels for a chosen issue', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/trackers/rules/sample',
      payload: {
        applies_to: 'issue',
        source_id: 41,
        title_template: '[{{ severity }}] {{ title }}',
        body_template: 'Seen {{ total_hits }} times on {{ route }}',
        labels: ['sev::{{ severity }}', 'bug'],
        include_details: false
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({
      title: '[high] Checkout fails',
      body: 'Seen 20 times on checkout',
      labels: ['sev::high', 'bug']
    })
    expect(loads.calls[0][0]).toBe('issue')
    expect(loads.calls[0][1]).toBe('41')
    expect(loads.calls[0][2]).toMatchObject({ includeDetails: false })
  })

  it('reads a support ticket for a ticket rule, and empty templates use the defaults', async () => {
    loads.view = { kind: 'ticket', id: '7', title: 'Printer', vars: { title: 'Printer' } }
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/trackers/rules/sample',
      payload: { applies_to: 'ticket', source_id: '7', title_template: '', body_template: '' }
    })
    expect(res.statusCode).toBe(200)
    expect(loads.calls[0][0]).toBe('ticket')
    expect(res.json().data.title).toBe('Printer')
  })

  it('answers 404 for an unknown source and 400 for a broken template', async () => {
    const f = await app()
    loads.view = null
    const missing = await f.inject({
      method: 'POST',
      url: '/api/trackers/rules/sample',
      payload: { applies_to: 'issue', source_id: 99, title_template: '{{ title }}' }
    })
    expect(missing.statusCode).toBe(404)
    loads.view = { kind: 'issue', id: '41', title: 'x', vars: {} }
    const broken = await f.inject({
      method: 'POST',
      url: '/api/trackers/rules/sample',
      payload: { applies_to: 'issue', source_id: 41, title_template: '{% if %}' }
    })
    expect(broken.statusCode).toBe(400)
    expect(broken.json().code).toBe('TEMPLATE_ERROR')
    const bad = await f.inject({
      method: 'POST',
      url: '/api/trackers/rules/sample',
      payload: { applies_to: 'issue', source_id: 'abc' }
    })
    expect(bad.statusCode).toBe(400)
  })
})

describe('PUT /feature', () => {
  it('turning GitLab sync back on restarts the import clocks (no back-import of the gap)', async () => {
    const f = await app()
    featureState.enabled = true
    clocks.restarts = 0
    const put = (enabled: boolean) =>
      f.inject({ method: 'PUT', url: '/api/trackers/feature', payload: { enabled } })
    expect((await put(true)).statusCode).toBe(200)
    expect(clocks.restarts).toBe(0) // already on
    await put(false)
    expect(clocks.restarts).toBe(0)
    await put(true)
    expect(clocks.restarts).toBe(1)
    await f.close()
  })
})
