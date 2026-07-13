import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { registerResponseConventions } from '../../../plugins/response-conventions.js'

async function buildApp() {
  const app = Fastify({ logger: false })
  const warn = vi.fn()
  const info = vi.fn()
  // @ts-ignore — test shim over the pino instance
  app.log = { ...app.log, warn, info }
  registerResponseConventions(app)

  app.get('/api/good', async () => ({ data: { display_name: 'ok' } }))
  app.get('/api/camel', async () => ({ data: { affectedCount: 2, affectedIds: [] } }))
  app.get('/api/bare', async () => ({ total_views: 1 }))
  app.get('/api/health', async () => ({ status: 'ok' }))
  await app.ready()
  return { app, warn, info }
}

describe('response-conventions plugin', () => {
  it('passes snake_case enveloped responses silently', async () => {
    const { app, warn, info } = await buildApp()
    await app.inject({ method: 'GET', url: '/api/good' })
    expect(warn).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    await app.close()
  })

  it('warns once on camelCase keys, deduped per route', async () => {
    const { app, warn } = await buildApp()
    await app.inject({ method: 'GET', url: '/api/camel' })
    await app.inject({ method: 'GET', url: '/api/camel' })
    expect(warn).toHaveBeenCalledTimes(1)
    const [ctx] = warn.mock.calls[0]
    expect(ctx.keys).toEqual(expect.arrayContaining(['affectedCount', 'affectedIds']))
    await app.close()
  })

  it('notes bare (non-envelope) bodies at info level', async () => {
    const { app, info } = await buildApp()
    await app.inject({ method: 'GET', url: '/api/bare' })
    expect(info).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('skips exempt routes', async () => {
    const { app, warn, info } = await buildApp()
    await app.inject({ method: 'GET', url: '/api/health' })
    expect(warn).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    await app.close()
  })
})
