import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { id: '11111111-1111-1111-1111-111111111111' }
  }
}))
vi.mock('../services/chaos/what-if.js', async (orig) => {
  const real = await orig<typeof import('../services/chaos/what-if.js')>()
  return {
    ...real,
    whatIf: vi.fn(async (dep: string) => {
      if (dep === 'moon') throw new real.WhatIfError('Unknown dependency "moon"')
      return { dependency: { key: 'redis' }, draft_only: true }
    })
  }
})

import { chaosWhatIfRoutes } from './chaos-what-if.js'

async function build() {
  const app = Fastify()
  await app.register(chaosWhatIfRoutes, { prefix: '/chaos/what-if' })
  await app.ready()
  return app
}

describe('GET /chaos/what-if (#2860)', () => {
  it('lists the dependencies without a query', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/chaos/what-if' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.dependencies.map((d: { key: string }) => d.key)).toContain('redis')
  })

  it('answers one dependency and refuses an unknown one with 400', async () => {
    const app = await build()
    const ok = await app.inject({ method: 'GET', url: '/chaos/what-if?dependency=redis' })
    expect(ok.json().data).toEqual({ dependency: { key: 'redis' }, draft_only: true })
    const bad = await app.inject({ method: 'GET', url: '/chaos/what-if?dependency=moon' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('CHAOS_WHAT_IF')
  })
})
