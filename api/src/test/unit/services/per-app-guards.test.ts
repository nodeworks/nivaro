import { beforeEach, describe, expect, it, vi } from 'vitest'

// Ruling P5-14: on a Hub shared deployment an app job runs once per app, often at the same
// moment. A single-flight guard or memo kept for the whole process decided for every app: app B
// got app A's integration-signal cycle, lost its daily report and SQL checks to "already
// running", and warmed from app A's request log. Each is now keyed by the app (tenant id; ''
// self-hosted, so one key there as before).

function deferred<T = unknown>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// A knex stand-in: every chain call returns the chain, awaiting it gives [], first() nothing,
// insert().returning() one id.
function chain(): any {
  const c: any = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => void) => res([])
      if (prop === 'first') return async () => undefined
      if (prop === 'returning') return async () => [{ id: 7 }]
      if (prop === 'toQuery') return () => 'select 1'
      return () => c
    },
    apply: () => c
  })
  return c
}

vi.mock('../../../db/index.js', () => ({ db: () => chain() }))
vi.mock('../../../db/dialect.js', async (orig) => ({
  ...(await orig<object>()),
  isMssql: () => true
}))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))

const sqlSettings = vi.fn()
vi.mock('../../../services/sql-checks/settings.js', () => ({
  readSqlCheckSettings: () => sqlSettings()
}))

const longSql = vi.fn()
vi.mock('../../../services/run-long.js', () => ({
  runLongSql: (...a: unknown[]) => longSql(...a)
}))
vi.mock('../../../services/api-log-instances.js', () => ({
  instanceScope: async () => ({ apply: (qb: unknown) => qb })
}))

vi.mock('../../../services/integration-signal-settings.js', async (orig) => ({
  ...(await orig<object>()),
  resolveThresholds: async () => ({ enabled: true, thresholds: {} })
}))

const digest = vi.fn()
vi.mock('../../../services/ops-report/store.js', async (orig) => ({
  ...(await orig<object>()),
  reportsTableReady: async () => true,
  insertRunning: async () => 1,
  finishReport: async () => undefined,
  latestPerDay: async () => []
}))
vi.mock('../../../services/ops-report/settings.js', () => ({
  getOpsReportSettings: async () => ({ window_start_hour: 0, window_end_hour: 1, notify: false })
}))
vi.mock('../../../services/ops-report/window.js', async (orig) => ({
  ...(await orig<object>()),
  instanceZone: async () => 'UTC'
}))
vi.mock('../../../services/ops-report/digest.js', () => ({ buildDigest: () => digest() }))

const { runWithTenantDb, getTenantId } = await import('../../../db/tenant-context.js')
const { registerIntegrationSignal, runSignalsCycle } = await import(
  '../../../services/integration-signals.js'
)
const { startOpsReport } = await import('../../../services/ops-report/run.js')
const { runSqlChecks, isSqlChecksRunning, SqlChecksBusyError } = await import(
  '../../../services/sql-checks/run.js'
)
const { usageScansForTests } = await import('../../../services/cache-warm.js')

const inApp = <T>(id: string, fn: () => T) =>
  new Promise<T>((resolve) => runWithTenantDb({} as never, id, () => resolve(fn()), id))

beforeEach(() => {
  sqlSettings.mockReset()
  longSql.mockReset()
  digest.mockReset()
})

describe('integration-signals cycle is single-flight per app', () => {
  it('app B runs its own cycle while app A is mid-cycle', async () => {
    const gate = deferred<{ count: number; rows: never[] }>()
    const seen: Array<string | undefined> = []
    registerIntegrationSignal({
      id: 'test:p514-probe',
      label: 'probe',
      description: '',
      tab: 'x',
      severity: 'warn',
      thresholds: [],
      evaluate: () => {
        seen.push(getTenantId())
        return gate.promise
      }
    })
    // wrapped: inApp would otherwise wait for the cycle itself
    const start = (id: string) =>
      inApp(id, () => ({ p: runSignalsCycle({ only: ['test:p514-probe'] }) }))
    const { p: a } = await start('A')
    const { p: a2 } = await start('A')
    const { p: b } = await start('B')
    expect(a2).toBe(a) // still single-flight within one app
    expect(b).not.toBe(a)
    await vi.waitFor(() => expect(seen).toEqual(['A', 'B']))
    gate.resolve({ count: 0, rows: [] })
    await Promise.allSettled([a, b])
  })
})

describe('daily report "already running" is per app', () => {
  it('app B starts its report for the day app A is running', async () => {
    const gate = deferred()
    digest.mockReturnValue(gate.promise)
    const day = '2026-01-05'
    const a = await inApp('A', () => startOpsReport(null, { day, trigger: 'cron' }))
    await expect(inApp('A', () => startOpsReport(null, { day, trigger: 'cron' }))).rejects.toThrow(
      /already running/
    )
    const b = await inApp('B', () => startOpsReport(null, { day, trigger: 'cron' }))
    expect(b.id).toBe(1)
    gate.reject(new Error('stop'))
    await Promise.allSettled([a.done, b.done])
    // both finished: A may start again
    digest.mockImplementation(async () => {
      throw new Error('stop')
    })
    const again = await inApp('A', () => startOpsReport(null, { day, trigger: 'cron' }))
    await again.done
  })
})

describe('SQL checks running flag is per app', () => {
  it('app B is not busy while app A runs, and A is', async () => {
    const gate = deferred()
    sqlSettings.mockReturnValue(gate.promise)
    const a = inApp('A', () => runSqlChecks({ trigger: 'cron' }))
    await vi.waitFor(() => expect(sqlSettings).toHaveBeenCalledTimes(1))
    expect(await inApp('A', () => isSqlChecksRunning())).toBe(true)
    expect(await inApp('B', () => isSqlChecksRunning())).toBe(false)
    expect(isSqlChecksRunning()).toBe(false) // no app ('' key) is not A
    await expect(inApp('A', () => runSqlChecks({ trigger: 'cron' }))).rejects.toBeInstanceOf(
      SqlChecksBusyError
    )
    const b = inApp('B', () => runSqlChecks({ trigger: 'cron' }))
    await vi.waitFor(() => expect(sqlSettings).toHaveBeenCalledTimes(2))
    gate.reject(new Error('stop'))
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.status).toBe('failed')
    expect(rb.status).toBe('failed')
    expect(await inApp('A', () => isSqlChecksRunning())).toBe(false)
  })
})

describe('cache warm request-log memos are per app', () => {
  it('each app scans its own log; a second app does not evict the first', async () => {
    usageScansForTests.reset()
    longSql.mockImplementation(async () => [{ path: `/from/${getTenantId()}`, user: 'u', n: 1 }])
    const since = new Date('2026-01-01T00:00:00Z')
    const a = await inApp('A', () => usageScansForTests.apiLogUsage(since))
    const b = await inApp('B', () => usageScansForTests.apiLogUsage(since))
    expect(a?.[0].path).toBe('/from/A')
    expect(b?.[0].path).toBe('/from/B')
    expect(longSql).toHaveBeenCalledTimes(2)
    const a2 = await inApp('A', () => usageScansForTests.apiLogUsage(since))
    expect(a2?.[0].path).toBe('/from/A')
    expect(longSql).toHaveBeenCalledTimes(2) // memoised, not cleared by B
  })

  it('queue usage scan too', async () => {
    usageScansForTests.reset()
    longSql.mockImplementation(async () => [
      { path: `/from/${getTenantId()}`, query: '', user: 'u', n: 1 }
    ])
    const since = new Date('2026-01-01T00:00:00Z')
    const a = await inApp('A', () => usageScansForTests.queueApiLogUsage(since))
    const b = await inApp('B', () => usageScansForTests.queueApiLogUsage(since))
    expect(a?.[0].path).toBe('/from/A')
    expect(b?.[0].path).toBe('/from/B')
    await inApp('A', () => usageScansForTests.queueApiLogUsage(since))
    expect(longSql).toHaveBeenCalledTimes(2)
  })

  it('self-hosted (no app) keeps one memo', async () => {
    usageScansForTests.reset()
    longSql.mockImplementation(async () => [])
    const since = new Date('2026-01-01T00:00:00Z')
    await usageScansForTests.apiLogUsage(since)
    await usageScansForTests.apiLogUsage(since)
    expect(longSql).toHaveBeenCalledTimes(1)
  })
})
