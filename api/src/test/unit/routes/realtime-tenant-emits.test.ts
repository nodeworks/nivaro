import type { Knex } from 'knex'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import { emitJobProgress } from '../../../routes/imports.js'
import { injectFetch, MCP_TENANT_HEADERS } from '../../../routes/mcp.js'

function inTenant<T>(id: string, fn: () => T): T {
  let out: T
  runWithTenantDb(
    {} as Knex,
    `slug-${id}`,
    () => {
      out = fn()
    },
    id
  )
  return out!
}

afterEach(() => vi.unstubAllEnvs())

describe('collection-import progress (H14)', () => {
  function fakeApp() {
    const sent: Array<{ rooms: string[]; event: string; data: unknown }> = []
    const operator = (rooms: string[]) => ({
      to: (r: string) => operator([...rooms, r]),
      emit: (event: string, data: unknown) => sent.push({ rooms, event, data })
    })
    const app = { io: { to: (r: string) => operator([r]), emit: vi.fn() } }
    return { app, sent }
  }

  it("goes to the creator's room and the tenant's imports watch room, never io.emit", () => {
    const { app, sent } = fakeApp()
    inTenant('T1', () => emitJobProgress(app as never, 'U1', 'J9', { jobId: 'J9', processed: 3 }))
    expect(app.io.emit).not.toHaveBeenCalled()
    expect(sent).toEqual([
      {
        rooms: ['t:T1:watch:imports', 'user:U1'],
        event: 'import:progress:J9',
        data: { jobId: 'J9', processed: 3 }
      }
    ])
  })

  it('self-hosted names are the plain ones; no creator = watch room only', () => {
    const { app, sent } = fakeApp()
    emitJobProgress(app as never, null, 'J1', { jobId: 'J1' })
    expect(sent[0].rooms).toEqual(['watch:imports'])
  })
})

describe('MCP in-process calls keep the tenant host (M11)', () => {
  async function forwarded(cloud: boolean) {
    if (cloud) vi.stubEnv('CLOUD_META_DB_URL', 'postgres://meta')
    let headers: Record<string, string> = {}
    const app = {
      inject: vi.fn(async (opts: { headers: Record<string, string> }) => {
        headers = opts.headers
        return { statusCode: 200, headers: {}, rawPayload: Buffer.from('{}') }
      })
    }
    const req = {
      ip: '10.0.0.1',
      headers: {
        authorization: 'Bearer x',
        host: 'acme.nivaro.cloud',
        'x-forwarded-host': 'acme.nivaro.cloud',
        'x-tenant-host': 'acme.nivaro.cloud'
      }
    }
    const f = injectFetch(app as never, req as never, { inner: false })
    await f('http://localhost/api/items/orders')
    return headers
  }

  it('cloud: forwards the host headers the tenant hook reads', async () => {
    const h = await forwarded(true)
    for (const name of MCP_TENANT_HEADERS) expect(h[name]).toBe('acme.nivaro.cloud')
  })

  it('self-hosted: unchanged (no host headers forwarded)', async () => {
    const h = await forwarded(false)
    expect(h.host).toBeUndefined()
    expect(h['x-tenant-host']).toBeUndefined()
  })
})
