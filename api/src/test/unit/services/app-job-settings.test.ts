import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 5 Task 11: on a shared deployment an app's pause lives in that app's own
// nivaro_settings.paused_crons, read through a 60 s per-app cache. Pausing in one app never
// stops the job in another app, and never touches the process-wide paused set.

/** Each app's settings row (paused_crons JSON), and how often each app's row was read. */
const state = vi.hoisted(() => ({
  rows: new Map<string, string | null>(),
  reads: new Map<string, number>(),
  writes: [] as Array<{ tenant: string; patch: unknown }>
}))

vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const db = (table: string) => {
    const tenant = tc.getTenantId() ?? ''
    const chain = {
      orderBy: () => chain,
      where: () => chain,
      first: async () => {
        state.reads.set(tenant, (state.reads.get(tenant) ?? 0) + 1)
        if (table !== 'nivaro_settings') return undefined
        return { id: 1, paused_crons: state.rows.get(tenant) ?? null }
      },
      update: async (patch: { paused_crons: string }) => {
        state.writes.push({ tenant, patch })
        state.rows.set(tenant, patch.paused_crons)
        return 1
      }
    }
    return chain
  }
  return { db, _backgroundDb: null, _staticDb: null, resolveDb: () => db }
})

const settings = await import('../../../services/app-job-settings.js')
const { appPaused } = await import('../../../services/app-jobs.js')
const { CronManager } = await import('../../../plugins/cron.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')

function asApp<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb({} as never, id.toLowerCase(), () => void fn().then(resolve, reject), id)
  })
}

const saved = { ...process.env }
beforeEach(() => {
  state.rows.clear()
  state.reads.clear()
  state.writes.length = 0
  for (const t of ['A', 'B', '']) settings.forgetAppJobSettings(t)
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
})
afterEach(() => {
  vi.useRealTimers()
  process.env = { ...saved }
})

describe('appPausedCrons / appPaused (per app)', () => {
  it('a pause in app A stops the job in A only; the process roster is untouched', async () => {
    state.rows.set('A', JSON.stringify(['nightly-sync']))
    const m = new CronManager({ ticksEnabled: () => true, onIssue: () => {} })
    m.schedule('nightly-sync', '0 3 * * *', async () => {})
    expect(await asApp('A', () => appPaused('nightly-sync'))).toBe(true)
    expect(await asApp('B', () => appPaused('nightly-sync'))).toBe(false)
    expect(await asApp('A', () => appPaused('other-job'))).toBe(false)
    expect(m.isPaused('nightly-sync')).toBe(false)
    expect(m.list().find((j) => j.id === 'nightly-sync')?.paused).toBe(false)
    m.stopAll()
  })

  it('caches each app for 60 s, and forgetting an app reads it again at once', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T03:00:00Z'), toFake: ['Date'] })
    state.rows.set('A', JSON.stringify(['nightly-sync']))
    expect(await asApp('A', () => appPaused('nightly-sync'))).toBe(true)
    state.rows.set('A', JSON.stringify([]))
    expect(await asApp('A', () => appPaused('nightly-sync'))).toBe(true) // cached
    expect(state.reads.get('A')).toBe(1)
    settings.forgetAppJobSettings('A')
    expect(await asApp('A', () => appPaused('nightly-sync'))).toBe(false)
    expect(state.reads.get('A')).toBe(2)
    state.rows.set('A', JSON.stringify(['nightly-sync']))
    vi.setSystemTime(new Date('2026-11-21T03:01:01Z'))
    expect(await asApp('A', () => appPaused('nightly-sync'))).toBe(true) // 60 s passed
    // B's cache was never touched by A's forget
    expect(state.reads.get('B')).toBeUndefined()
  })

  it('reads bad JSON or a missing row as nothing paused', async () => {
    state.rows.set('A', '{not json')
    expect([...(await asApp('A', () => settings.appPausedCrons()))]).toEqual([])
    state.rows.set('B', JSON.stringify({ x: 1 }))
    expect([...(await asApp('B', () => settings.appPausedCrons()))]).toEqual([])
  })

  it('setAppJobPaused stores the same JSON as before in that app and forgets its cache', async () => {
    await asApp('A', async () => {
      expect(await appPaused('nightly-sync')).toBe(false)
      await settings.setAppJobPaused('nightly-sync', true)
      expect(await appPaused('nightly-sync')).toBe(true)
      await settings.setAppJobPaused('other', true)
      await settings.setAppJobPaused('nightly-sync', false)
      expect(await appPaused('nightly-sync')).toBe(false)
    })
    expect(state.writes).toEqual([
      { tenant: 'A', patch: { paused_crons: JSON.stringify(['nightly-sync']) } },
      { tenant: 'A', patch: { paused_crons: JSON.stringify(['nightly-sync', 'other']) } },
      { tenant: 'A', patch: { paused_crons: JSON.stringify(['other']) } }
    ])
    expect(await asApp('B', () => appPaused('other'))).toBe(false)
  })
})

describe('miss detector skips jobs the app paused (Task 10 review carry)', () => {
  function manager() {
    const m = new CronManager({ ticksEnabled: () => true, onIssue: () => {} })
    m.schedule('nightly-sync', '0 3 * * *', async () => {})
    m.schedule('fk-integrity-sweep', '40 3 * * *', async () => {})
    return m
  }

  it('shared: a job paused in app A is not checked in A, still checked in B', async () => {
    state.rows.set('A', JSON.stringify(['nightly-sync']))
    const m = manager()
    const inA = (await asApp('A', () => m.missCheckJobs())).map((j) => j.id)
    const inB = (await asApp('B', () => m.missCheckJobs())).map((j) => j.id)
    expect(inA).toEqual(['fk-integrity-sweep'])
    expect(inB.sort()).toEqual(['fk-integrity-sweep', 'nightly-sync'])
    m.stopAll()
  })

  for (const [label, env] of [
    ['self-hosted', {}],
    ['cloud', { CLOUD_META_DB_URL: 'mssql://meta' }]
  ] as const) {
    it(`${label}: the process paused set only, no settings read`, async () => {
      delete process.env.HUB_SHARED_DEPLOYMENT
      Object.assign(process.env, env)
      state.rows.set('', JSON.stringify(['nightly-sync']))
      const m = manager()
      m.pause('fk-integrity-sweep')
      expect((await m.missCheckJobs()).map((j) => j.id)).toEqual(['nightly-sync'])
      expect(state.reads.size).toBe(0)
      m.stopAll()
    })
  }
})
