import Fastify from 'fastify'
import { afterAll, describe, expect, it } from 'vitest'
import { hubLinkRoutes } from '../../../routes/hub-link.js'
import { hubModeEnabled } from '../../../services/hub/mode.js'

// Batch E (everything else): every classified site is multiTenant (T3/T4/T6/T7). Cloud and
// self-hosted behave as before; a shared Hub deployment behaves like cloud.
const SELF: NodeJS.ProcessEnv = {}
const CLOUD: NodeJS.ProcessEnv = { CLOUD_META_DB_URL: 'postgres://meta' }
const SHARED: NodeJS.ProcessEnv = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example.com',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
}

describe('batch E: classified cloud-flag sites', () => {
  it('hubModeEnabled (T4): on for a Hub, never on cloud or shared', () => {
    expect(hubModeEnabled({ ...SELF, HUB: 'on' })).toBe(true)
    expect(hubModeEnabled({ ...CLOUD, HUB: 'on' })).toBe(false)
    expect(hubModeEnabled({ ...SHARED, HUB: 'on' })).toBe(false)
  })

  describe('hub-link routes are not mounted on cloud or shared (T4)', () => {
    const saved = { ...process.env }
    const mounted = async (env: NodeJS.ProcessEnv) => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
      delete process.env.CLOUD_META_DB_URL
      delete process.env.HUB_SHARED_DEPLOYMENT
      Object.assign(process.env, { HUB_TOKEN: 'h'.repeat(40) }, env)
      const app = Fastify()
      await app.register(hubLinkRoutes, { prefix: '/api/hub-link' })
      await app.ready()
      const res = await app.inject({ method: 'GET', url: '/api/hub-link/status' })
      await app.close()
      return res.statusCode !== 404
    }

    it('self-hosted: mounted', async () => {
      expect(await mounted(SELF)).toBe(true)
    })
    it('cloud: not mounted', async () => {
      expect(await mounted(CLOUD)).toBe(false)
    })
    it('shared: not mounted', async () => {
      expect(await mounted(SHARED)).toBe(false)
    })
    afterAll(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    })
  })
})
