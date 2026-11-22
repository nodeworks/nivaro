import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 5, ruling P5-7: on a shared deployment, run now and dry run of a job that runs once
// for the whole deployment ('process') are refused from an app, like pausing it: 409
// SCHEDULE_IS_DEPLOYMENT_WIDE. An app job still runs for the caller's app. Self-hosted and
// Nivaro Cloud run both as before.

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async () => {}),
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'admin-1' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: vi.fn(async () => ({
    id: 1,
    complete: async () => {},
    fail: async () => {},
    progress: () => {}
  }))
}))
vi.mock('../../../db/index.js', () => {
  const chain = { where: () => chain, first: async () => undefined }
  const db = () => chain
  return { db, _backgroundDb: null, _staticDb: null, resolveDb: () => db }
})

const { CronManager } = await import('../../../plugins/cron.js')
const { cronRoutes } = await import('../../../routes/cron.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { ERROR_HINTS } = await import('../../../lib/error-hints.js')

const ran: string[] = []
const dried: string[] = []
let manager: InstanceType<typeof CronManager>
const apps: FastifyInstance[] = []

async function build(): Promise<FastifyInstance> {
  manager = new CronManager({ ticksEnabled: () => false, onIssue: () => {} })
  manager.schedule('pool-monitor', '*/5 * * * *', async () => void ran.push('pool-monitor'), {
    dryRun: async () => {
      dried.push('pool-monitor')
      return { ok: true }
    }
  })
  manager.schedule('outbox-worker', '* * * * *', async () => void ran.push('outbox-worker'), {
    dryRun: async () => {
      dried.push('outbox-worker')
      return { ok: true }
    }
  })
  const app = Fastify()
  app.decorate('cron', manager)
  app.addHook('onRequest', (req, _reply, done) => {
    const appId = req.headers['x-app']
    if (typeof appId === 'string') runWithTenantDb({} as never, appId.toLowerCase(), done, appId)
    else done()
  })
  await app.register(cronRoutes, { prefix: '/cron' })
  await app.ready()
  apps.push(app)
  return app
}

const saved = { ...process.env }
beforeEach(() => {
  ran.length = 0
  dried.length = 0
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
})
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
  manager?.stopAll()
  process.env = { ...saved }
})

const DEPLOYMENT_WIDE = {
  error:
    'This app runs on a shared deployment; its job schedules are set for the whole deployment.',
  code: 'SCHEDULE_IS_DEPLOYMENT_WIDE'
}

describe('shared deployment: run now / dry run of a process job', () => {
  beforeEach(() => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
  })

  it('the refusal has its own hint, not the generic "Reload" 409 one', () => {
    expect(ERROR_HINTS.SCHEDULE_IS_DEPLOYMENT_WIDE).toBe(
      'This job is set for every app on the shared deployment. Ask whoever runs the deployment to change or run it.'
    )
  })

  for (const action of ['run', 'dry-run'] as const) {
    it(`${action} of a process job from an app answers 409 and runs nothing`, async () => {
      const app = await build()
      const res = await app.inject({
        method: 'POST',
        url: `/cron/pool-monitor/${action}`,
        headers: { 'x-app': 'A' }
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual(DEPLOYMENT_WIDE)
      expect(ran).toEqual([])
      expect(dried).toEqual([])
    })

    it(`${action} of an app job runs for the caller's app`, async () => {
      const app = await build()
      const res = await app.inject({
        method: 'POST',
        url: `/cron/outbox-worker/${action}`,
        headers: { 'x-app': 'A' }
      })
      expect(res.statusCode).toBe(200)
      expect(action === 'run' ? ran : dried).toEqual(['outbox-worker'])
    })
  }
})

for (const [name, env] of [
  ['self-hosted', {}],
  ['cloud', { CLOUD_META_DB_URL: 'postgres://meta/x' }]
] as const) {
  describe(`${name}: run now and dry run are unchanged`, () => {
    beforeEach(() => Object.assign(process.env, env))

    it('run and dry-run of pool-monitor both run', async () => {
      const app = await build()
      const run = await app.inject({ method: 'POST', url: '/cron/pool-monitor/run' })
      const dry = await app.inject({ method: 'POST', url: '/cron/pool-monitor/dry-run' })
      expect(run.statusCode).toBe(200)
      expect(dry.statusCode).toBe(200)
      expect(ran).toEqual(['pool-monitor'])
      expect(dried).toEqual(['pool-monitor'])
    })
  })
}
