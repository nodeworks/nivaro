import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub shared deployments, Task 6: the Traffic Map digest and the Monday AI summary run inside each
// app's daily-digest fan-out. Their audiences read that app's own administrators (copied apps,
// same user id), the traffic section is cached per app, and Nivaro Cloud still sends neither.

const h = vi.hoisted(() => ({
  users: new Map<string, Array<{ id: string; preferences: string }>>(),
  reads: [] as Array<{ tenant: string; table: string }>
}))

vi.mock('../../../db/index.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  const db = Object.assign(
    (table: string) => {
      const tenant = getTenantId() ?? ''
      h.reads.push({ tenant, table })
      const builder: Record<string | symbol, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then' || prop === 'catch' || prop === 'finally') {
              const out = table.startsWith('nivaro_users') ? (h.users.get(tenant) ?? []) : []
              const p = Promise.resolve(out)
              return (p[prop as 'then'] as (...a: unknown[]) => unknown).bind(p)
            }
            return () => builder
          }
        }
      )
      return builder
    },
    { raw: (s: string) => s }
  )
  return { db }
})
vi.mock('../../../services/traffic-window.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  return {
    readWindowGrouped: async () => ({ rows: [], truncated: false }),
    summarizeWindow: () => {
      const app = getTenantId() ?? ''
      return {
        callers: [{ key: `u${app}-CALLER`, req: 10, error: 0 }],
        entities: [],
        totals: { req: 10, error: 0 }
      }
    },
    labelCallers: async () => ({})
  }
})

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { buildTrafficDigestSection, trafficDigestAudience } = await import(
  '../../../services/traffic-digest.js'
)
const { weeklyAudience } = await import('../../../services/ai-explain-weekly.js')

function inApp<T>(app: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((res, rej) => {
    runWithTenantDb({} as Knex, app, () => void fn().then(res, rej), app)
  })
}

const SHARED: Record<string, string> = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
}
const CLOUD: Record<string, string> = { CLOUD_META_DB_URL: 'postgres://meta/x' }
const KEYS = ['CLOUD_META_DB_URL', ...Object.keys(SHARED)]
const saved = { ...process.env }
function useEnv(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
}

const optedIn = (id: string) => ({
  id,
  preferences: JSON.stringify({ traffic_digest: true, ai_weekly_summary: true })
})

beforeEach(() => {
  h.reads.length = 0
  h.users.set('A', [optedIn('ADMIN-1')])
  h.users.set('B', [optedIn('ADMIN-1'), optedIn('ADMIN-2')])
  // Monday (the weekly summary goes out on Mondays only)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 23, 9, 0, 0))
})
afterEach(() => {
  vi.useRealTimers()
  process.env = { ...saved }
})

describe('digest audiences on a shared deployment', () => {
  it("the traffic digest reads each app's own opted-in admins", async () => {
    useEnv(SHARED)
    expect(await inApp('A', () => trafficDigestAudience())).toEqual(['ADMIN-1'])
    expect(await inApp('B', () => trafficDigestAudience())).toEqual(['ADMIN-1', 'ADMIN-2'])
    expect(h.reads.every((r) => r.tenant === 'A' || r.tenant === 'B')).toBe(true)
  })

  it("the Monday AI summary reads each app's own opted-in admins", async () => {
    useEnv(SHARED)
    expect(await inApp('A', () => weeklyAudience())).toEqual(['ADMIN-1'])
    expect(await inApp('B', () => weeklyAudience())).toEqual(['ADMIN-1', 'ADMIN-2'])
  })

  it('Nivaro Cloud: both audiences stay empty without touching a database', async () => {
    useEnv(CLOUD)
    expect(await inApp('A', () => trafficDigestAudience())).toEqual([])
    expect(await inApp('A', () => weeklyAudience())).toEqual([])
    expect(h.reads).toEqual([])
  })

  it("the traffic section is cached per app: B never gets A's section", async () => {
    useEnv(SHARED)
    const a = await inApp('A', () => buildTrafficDigestSection())
    const b = await inApp('B', () => buildTrafficDigestSection())
    expect(JSON.stringify(a)).toContain('uA-CALLER')
    expect(JSON.stringify(b)).toContain('uB-CALLER')
    expect(JSON.stringify(b)).not.toContain('uA-CALLER')
    // and A's cache still answers A
    expect(await inApp('A', () => buildTrafficDigestSection())).toEqual(a)
  })
})
