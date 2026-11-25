import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub shared gap `trackers` (0.3.215): GitLab issue sync runs per app on a Hub shared deployment.
// Apps A and B are COPIES (same connection id 1, same instance key): each app's switch, webhook
// secret and connection are read from its own database, the webhook reaches the app its host
// names, and the deployment's ISSUE_TRACKERS=on switches no app on (only `off` applies there).

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  /** tenant id → table → rows: each app's own database. */
  tables: {} as Record<string, Record<string, Row[]>>,
  deliveries: [] as { tenant: string; connection: number; kind: string }[],
  activity: [] as Row[]
}))

vi.mock('../../../db/index.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  const rowsOf = (name: string): Row[] => {
    const app = getTenantId() ?? ''
    h.tables[app] ??= {}
    h.tables[app][name] ??= []
    return h.tables[app][name]
  }
  const db = (name: string) => {
    let where: Row = {}
    const match = (r: Row) => Object.entries(where).every(([k, v]) => r[k] === v)
    const b: Record<string, unknown> = {
      where: (w: Row) => {
        where = w
        return b
      },
      orderBy: () => b,
      first: async () => rowsOf(name).find(match),
      update: async (patch: Row) => {
        for (const r of rowsOf(name)) if (match(r)) Object.assign(r, patch)
        return 1
      },
      insert: (row: Row) => {
        const rows = rowsOf(name)
        const full = { id: rows.length + 1, ...row }
        rows.push(full)
        return { returning: async () => [{ id: full.id }] }
      }
    }
    return b
  }
  return { db }
})
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (o: Row) => {
    h.activity.push(o)
    return 1
  }
}))
vi.mock('../../../services/trackers/inbound.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  return {
    setTrackerRedis: () => {},
    recordDelivery: async (d: { connection: number; kind: string }) => {
      h.deliveries.push({ tenant: getTenantId() ?? '', connection: d.connection, kind: d.kind })
      return h.deliveries.length
    },
    processDelivery: async () => {}
  }
})

import { runWithTenantDb } from '../../../db/tenant-context.js'
import { trackerHookRoutes } from '../../../routes/tracker-hooks.js'
import { registerTrackerCrons, unsubscribeEngine } from '../../../services/trackers/crons.js'
import {
  bustTrackersFeatureCache,
  setTrackersEnabled,
  trackersFeature
} from '../../../services/trackers/feature.js'

const fakeKnex = {} as Knex
const ORIGIN: Record<string, string> = {
  A: 'https://app-a.example.com',
  B: 'https://app-b.example.com'
}
function inApp<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb(
      fakeKnex,
      id.toLowerCase(),
      () => {
        Promise.resolve().then(fn).then(resolve, reject)
      },
      id,
      ORIGIN[id]
    )
  })
}

const ENV_KEYS = [
  'HUB_SHARED_DEPLOYMENT',
  'HUB_URL',
  'HUB_DEPLOYMENT_TOKEN',
  'CLOUD_META_DB_URL',
  'ISSUE_TRACKERS',
  'NIVARO_INSTANCE'
]
const saved: Record<string, string | undefined> = {}
const shared = () =>
  Object.assign(process.env, {
    HUB_SHARED_DEPLOYMENT: 'shared-a',
    HUB_URL: 'https://hub.example.com',
    HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
  })

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
/** App `id`'s own switch (its instance row) and its GitLab connection 1 with its own secret. */
function seedApp(id: string, opts: { on?: boolean; secret: string }) {
  h.tables[id] = {
    nivaro_settings_overrides:
      opts.on === undefined
        ? []
        : [
            {
              id: 1,
              instance_key: 'production',
              data: JSON.stringify({ issue_trackers: { enabled: opts.on } })
            }
          ],
    nivaro_tracker_connections: [
      {
        id: 1,
        name: `GitLab ${id}`,
        base_url: 'https://gitlab.example.com',
        is_active: true,
        sync: '{}',
        status: 'ok',
        webhook_secret_hash: sha(opts.secret)
      }
    ]
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.NIVARO_INSTANCE = 'production'
  h.tables = {}
  h.deliveries = []
  h.activity = []
  bustTrackersFeatureCache()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  bustTrackersFeatureCache()
})

describe('the GitLab sync switch on a Hub shared deployment', () => {
  it("is each app's own stored switch, cached per app", async () => {
    shared()
    seedApp('A', { on: true, secret: 'a' })
    seedApp('B', { secret: 'b' })
    expect(await inApp('A', trackersFeature)).toEqual({ enabled: true, source: 'setting' })
    // within A's cache window, B still reads its own (none stored: off)
    expect(await inApp('B', trackersFeature)).toEqual({ enabled: false, source: 'default' })
    expect(await inApp('A', trackersFeature)).toEqual({ enabled: true, source: 'setting' })
  })

  it("ISSUE_TRACKERS=on switches no app on; an app's switch stays its own and editable", async () => {
    shared()
    process.env.ISSUE_TRACKERS = 'on'
    seedApp('A', { on: true, secret: 'a' })
    seedApp('B', { secret: 'b' })
    expect(await inApp('A', trackersFeature)).toEqual({ enabled: true, source: 'setting' })
    expect(await inApp('B', trackersFeature)).toEqual({ enabled: false, source: 'default' })
    // not locked: B turns its own on, in its own database only
    expect(await inApp('B', () => setTrackersEnabled(true, 'u1'))).toEqual({
      enabled: true,
      source: 'setting'
    })
    expect(JSON.parse(String(h.tables.B.nivaro_settings_overrides[0].data))).toEqual({
      issue_trackers: { enabled: true }
    })
    expect(await inApp('B', trackersFeature)).toEqual({ enabled: true, source: 'setting' })
    expect(JSON.parse(String(h.tables.A.nivaro_settings_overrides[0].data))).toEqual({
      issue_trackers: { enabled: true }
    })
  })

  it('ISSUE_TRACKERS=off turns every app off and locks the switch', async () => {
    shared()
    process.env.ISSUE_TRACKERS = 'off'
    seedApp('A', { on: true, secret: 'a' })
    expect(await inApp('A', trackersFeature)).toEqual({ enabled: false, source: 'env' })
    await expect(inApp('A', () => setTrackersEnabled(true, 'u1'))).rejects.toMatchObject({
      code: 'FEATURE_LOCKED'
    })
  })

  it('self-hosted keeps the env rule (on wins); Nivaro Cloud is always off', async () => {
    process.env.ISSUE_TRACKERS = 'on'
    h.tables[''] = { nivaro_settings_overrides: [] }
    expect(await trackersFeature()).toEqual({ enabled: true, source: 'env' })
    bustTrackersFeatureCache()
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect(await trackersFeature()).toEqual({ enabled: false, source: 'cloud' })
  })
})

describe('the GitLab webhook on a Hub shared deployment', () => {
  let app: FastifyInstance
  async function hookApp() {
    const f = Fastify()
    // What middleware/tenant.ts does: the request's host names the app (never the path).
    f.addHook('onRequest', (req, _reply, done) => {
      const id = req.hostname.startsWith('app-a') ? 'A' : 'B'
      runWithTenantDb(fakeKnex, id.toLowerCase(), done, id, ORIGIN[id])
    })
    await f.register(trackerHookRoutes, { prefix: '/api/tracker-hooks' })
    return f
  }
  const post = (host: string, token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/tracker-hooks/gitlab/1',
      headers: { host, 'x-gitlab-token': token, 'x-gitlab-event': 'Issue Hook' },
      payload: { object_kind: 'issue' }
    })

  beforeEach(async () => {
    shared()
    seedApp('A', { on: true, secret: 'secret-a' })
    seedApp('B', { on: true, secret: 'secret-b' })
    app = await hookApp()
  })
  afterEach(async () => {
    await app.close()
  })

  it("a delivery reaches the app its host names, checked against that app's own secret", async () => {
    expect((await post('app-a.example.com', 'secret-a')).statusCode).toBe(200)
    expect((await post('app-b.example.com', 'secret-b')).statusCode).toBe(200)
    expect(h.deliveries).toEqual([
      { tenant: 'A', connection: 1, kind: 'Issue Hook' },
      { tenant: 'B', connection: 1, kind: 'Issue Hook' }
    ])
  })

  it("the same connection id never crosses apps: A's secret at B's address is refused", async () => {
    expect((await post('app-b.example.com', 'secret-a')).statusCode).toBe(401)
    expect((await post('app-a.example.com', 'secret-b')).statusCode).toBe(401)
    expect(h.deliveries).toEqual([])
  })

  it('an app with sync off answers 404 whatever the token', async () => {
    h.tables.B.nivaro_settings_overrides[0].data = JSON.stringify({
      issue_trackers: { enabled: false }
    })
    expect((await post('app-b.example.com', 'secret-b')).statusCode).toBe(404)
    expect((await post('app-a.example.com', 'secret-a')).statusCode).toBe(200)
  })
})

describe('the GitLab sync jobs', () => {
  const ids = () => {
    const schedule = vi.fn()
    registerTrackerCrons({ cron: { schedule } } as unknown as FastifyInstance)
    unsubscribeEngine()
    return schedule.mock.calls.map((c) => c[0])
  }

  it('register on a Hub shared deployment (each runs per app by its cron scope)', () => {
    shared()
    expect(ids()).toEqual(['tracker-sweep', 'tracker-outbox', 'tracker-reconcile', 'tracker-prune'])
  })

  it('register self-hosted, never in Nivaro Cloud', () => {
    expect(ids()).toHaveLength(4)
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect(ids()).toEqual([])
  })
})
