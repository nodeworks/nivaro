import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub shared deployments, Task 6: the Monday AI summary runs inside each app's daily-digest
// fan-out; its audience reads that app's own administrators (copied apps, same user id). The
// Traffic Map digest does the same since the per-app Traffic Map (the page and its digest opt-in
// work inside each app); Nivaro Cloud sends neither.

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

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { trafficDigestAudience } = await import('../../../services/traffic-digest.js')
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
  it("the traffic digest reads each app's own opted-in admins, in that app's database", async () => {
    useEnv(SHARED)
    expect(await inApp('A', () => trafficDigestAudience())).toEqual(['ADMIN-1'])
    expect(await inApp('B', () => trafficDigestAudience())).toEqual(['ADMIN-1', 'ADMIN-2'])
    expect(new Set(h.reads.map((r) => r.tenant))).toEqual(new Set(['A', 'B']))
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
})
