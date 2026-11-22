import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 22: module state that held app data in one slot per process is per app now.
// Two apps of one shared-deployment process are copies (same collection names, record, run and
// user ids) with different data: app A's answer, flag or entry must never reach app B, and a
// write in B never overwrites A's. Self-hosted (no app) nothing changes. One block per area; the
// guard (module-state.guard.test.ts) keeps every other site keyed or listed.

const { db } = await import('../../../db/index.js')
const { getTenantDb, runWithTenantDb } = await import('../../../db/tenant-context.js')

type Row = Record<string, unknown>
interface FakeDb {
  (table: string): unknown
  reads: string[]
  writes: Array<{ table: string; op: string; data: unknown }>
  raw: (...a: unknown[]) => unknown
  schema: { hasColumn: () => Promise<boolean>; hasTable: () => Promise<boolean> }
  client: { config: { client: string } }
}

/** A small in-memory database per app: reads filter by where(col, v) / where({...}). */
function fakeDb(tables: Record<string, Row[]> = {}): FakeDb {
  const reads: string[] = []
  const writes: FakeDb['writes'] = []
  const fn = ((table: string) => {
    reads.push(table)
    let rows = [...(tables[table] ?? [])]
    let result: unknown = rows
    const chain: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'then' || prop === 'catch' || prop === 'finally') {
            const p = Promise.resolve(result)
            return (p[prop as 'then'] as (...a: unknown[]) => unknown).bind(p)
          }
          return (...args: unknown[]) => {
            if (prop === 'where' || prop === 'andWhere') {
              const [a, b] = args
              const cond: Row =
                args.length > 2 || typeof a === 'function'
                  ? {}
                  : typeof a === 'string'
                    ? { [a]: b }
                    : a && typeof a === 'object'
                      ? (a as Row)
                      : {}
              rows = rows.filter((r) =>
                Object.entries(cond).every(([k, v]) => !(k in r) || String(r[k]) === String(v))
              )
              result = rows
            } else if (prop === 'first') result = rows[0]
            else if (prop === 'update') {
              writes.push({ table, op: 'update', data: args[0] })
              result = 0
            } else if (prop === 'insert') {
              writes.push({ table, op: 'insert', data: args[0] })
              result = [1]
            } else if (prop === 'whereRaw' || prop === 'whereNull' || prop === 'orWhereNot')
              result = rows
            return chain
          }
        }
      }
    )
    return chain
  }) as FakeDb
  fn.reads = reads
  fn.writes = writes
  fn.raw = (...a: unknown[]) => ({ raw: a })
  fn.schema = { hasColumn: async () => true, hasTable: async () => true }
  fn.client = { config: { client: 'pg' } }
  return fn
}

function asApp<T>(app: string, appDb: FakeDb | null, fn: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb(
      (appDb ?? fakeDb()) as never,
      app,
      () => {
        Promise.resolve().then(fn).then(resolve, reject)
      },
      app
    )
  })
}

const A = 'app-a-e1'
const B = 'app-b-e2'

beforeEach(() => {
  const route = (table: string) => {
    const t = getTenantDb() as unknown as FakeDb | undefined
    if (!t) throw new Error('no app database outside an app')
    return t(table)
  }
  vi.mocked(db).mockImplementation(route as never)
  ;(db as unknown as { raw: unknown }).raw = vi.fn((...a: unknown[]) => ({ raw: a }))
})

afterEach(() => {
  delete process.env.HUB_SHARED_DEPLOYMENT
})

describe('settings caches', () => {
  it('business hours: A’s schedule never answers B', async () => {
    const { getSlaSchedule } = await import('../../../services/business-hours.js')
    const dbA = fakeDb({ nivaro_settings: [{ sla_business_day_start: 7 }] })
    const dbB = fakeDb({ nivaro_settings: [{ sla_business_day_start: 11 }] })
    expect((await asApp(A, dbA, () => getSlaSchedule())).startHour).toBe(7)
    expect((await asApp(B, dbB, () => getSlaSchedule())).startHour).toBe(11)
    expect((await asApp(A, dbA, () => getSlaSchedule())).startHour).toBe(7)
  })

  it('extension settings: each app reads its own saved values', async () => {
    const { readExtensionSettings } = await import('../../../extensions/loader.js')
    const dbA = fakeDb({
      nivaro_extension_settings: [{ extension_id: 'x', key: 'mode', value: 'A' }]
    })
    const dbB = fakeDb({
      nivaro_extension_settings: [{ extension_id: 'x', key: 'mode', value: 'B' }]
    })
    expect((await asApp(A, dbA, () => readExtensionSettings('x'))).mode).toBe('A')
    expect((await asApp(B, dbB, () => readExtensionSettings('x'))).mode).toBe('B')
  })
})

describe('encryption (I-1)', () => {
  it('A’s encrypted-field list never answers B (same collection name)', async () => {
    const { getEncryptedFields } = await import('../../../services/encryption.js')
    const dbA = fakeDb({
      nivaro_fields: [{ collection: 'orders', field: 'card', is_encrypted: true }]
    })
    const dbB = fakeDb({
      nivaro_fields: [{ collection: 'orders', field: 'ssn', is_encrypted: true }]
    })
    expect(await asApp(A, dbA, () => getEncryptedFields('orders'))).toEqual(['card'])
    expect(await asApp(B, dbB, () => getEncryptedFields('orders'))).toEqual(['ssn'])
    expect(await asApp(A, dbA, () => getEncryptedFields('orders'))).toEqual(['card'])
  })
})

describe('in-flight flags and run state', () => {
  it('a cancel asked in A never cancels run 5 of B', async () => {
    const { requestCancel, isCancelled } = await import('../../../services/job-cancel.js')
    await asApp(A, null, () => requestCancel(5))
    expect(await asApp(A, null, () => isCancelled(5))).toBe(true)
    expect(await asApp(B, null, () => isCancelled(5))).toBe(false)
  })

  it('import run rows of run 1 in A are not B’s run 1', async () => {
    const { rememberRunRows, runRows } = await import('../../../services/import-run-rows.js')
    await asApp(A, null, () => rememberRunRows(1, [{ name: 'A row' }]))
    expect(await asApp(B, null, () => runRows(1))).toBeNull()
    expect(await asApp(A, null, () => runRows(1))).toEqual([{ name: 'A row' }])
  })

  it('field-rule stats count per app', async () => {
    const { recordRuleEvalSample, ruleEvalStats } = await import(
      '../../../services/field-rules-stats.js'
    )
    await asApp(A, null, () =>
      recordRuleEvalSample('workflows', { at: Date.now(), ms: 5 } as never)
    )
    const b = (await asApp(B, null, () => ruleEvalStats())) as unknown
    expect(JSON.stringify(b)).not.toContain('workflows')
    const a = (await asApp(A, null, () => ruleEvalStats())) as unknown
    expect(JSON.stringify(a)).toContain('workflows')
  })
})

describe('people', () => {
  it('a person’s socket in A does not keep the same id online in B', async () => {
    const { addPresenceSocket, hasPresenceSocket, removePresenceSocket } = await import(
      '../../../services/presence-sockets.js'
    )
    await asApp(A, null, () => addPresenceSocket('u1', 's-a'))
    expect(await asApp(B, null, () => hasPresenceSocket('u1'))).toBe(false)
    await asApp(B, null, () => addPresenceSocket('u1', 's-b'))
    // B's last socket goes: B's person is offline, A's still online.
    expect(await asApp(B, null, () => removePresenceSocket('u1', 's-b'))).toBe(true)
    expect(await asApp(A, null, () => hasPresenceSocket('u1'))).toBe(true)
  })
})

describe('diagnostics an app admin reads', () => {
  it('log ring: an app reads its own lines only', async () => {
    const { pushLog, readLog } = await import('../../../services/log-ring.js')
    await asApp(A, fakeDb({ nivaro_log_alert_rules: [] }), () => pushLog(50, 'A secret line'))
    const b = await asApp(B, fakeDb({ nivaro_log_alert_rules: [] }), () => readLog({}))
    expect(b.map((l) => l.msg)).not.toContain('A secret line')
    const a = await asApp(A, fakeDb({ nivaro_log_alert_rules: [] }), () => readLog({}))
    expect(a.map((l) => l.msg)).toContain('A secret line')
  })

  it('chat health: A’s failures (room names) never show in B', async () => {
    const { recordChatSendFailure, chatHealth } = await import('../../../services/chat-health.js')
    await asApp(A, null, () => recordChatSendFailure('room A-secret refused'))
    expect((await asApp(B, null, () => chatHealth(0))).failed_sends).toBe(0)
    expect((await asApp(A, null, () => chatHealth(0))).failed_sends).toBe(1)
  })

  it('slow traces (full URL, user, SQL for Explain): listed and opened in their own app only', async () => {
    const rt = await import('../../../services/request-trace.js')
    const stop = rt.keepNext('t22', () => true)
    await asApp(A, null, () =>
      rt.runInTrace('/api/items/secret', null, async () => {
        rt.finishTrace({
          method: 'GET',
          route: '/api/items/:c',
          url: '/api/items/secret?filter=A',
          status: 200,
          user: 'u1',
          app: A
        })
      })
    )
    stop()
    const inB = await asApp(B, null, () => rt.listTraces(200))
    expect(inB.some((t) => t.url.includes('filter=A'))).toBe(false)
    const inA = await asApp(A, null, () => rt.listTraces(200))
    const mine = inA.find((t) => t.url.includes('filter=A'))
    expect(mine).toBeDefined()
    expect(await asApp(B, null, () => rt.getTrace(mine?.id as string))).toBeNull()
    expect(await asApp(A, null, () => rt.getTrace(mine?.id as string))).not.toBeNull()
  })
})

describe('session replay counts', () => {
  it('each app’s counted uploads are written to its own database', async () => {
    const cost = await import('../../../services/session-replay-cost.js')
    cost.resetReplayCostState()
    const dbA = fakeDb()
    const dbB = fakeDb()
    const meta = { route: '/r', build: 'b', retries: 0 } as never
    await asApp(A, dbA, () => cost.noteChunk('accepted', meta, 100))
    await asApp(B, dbB, () => cost.noteChunk('accepted', meta, 7))
    await cost.flushReplayUsage() // outside any app (the flush timer)
    const bytesOf = (d: FakeDb) =>
      d.writes
        .filter((w) => w.table === 'nivaro_session_replay_daily' && w.op === 'insert')
        .map((w) => (w.data as { bytes?: number }).bytes)
    expect(bytesOf(dbA)).toEqual([100])
    expect(bytesOf(dbB)).toEqual([7])
  })
})

describe('carried items', () => {
  it('audit dedupe (actlog:) names the app on a shared deployment', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    const { logActivityThrottled } = await import('../../../services/activity.js')
    const keys: string[] = []
    const redis = {
      set: async (k: string) => {
        keys.push(k)
        return null // "already logged": no activity write is attempted
      }
    }
    await asApp(A, null, () => logActivityThrottled(redis, 'login:u1', 60, {} as never))
    await asApp(B, null, () => logActivityThrottled(redis, 'login:u1', 60, {} as never))
    expect(keys).toEqual([`actlog:app:${A}:login:u1`, `actlog:app:${B}:login:u1`])
  })

  it('audit dedupe key is unchanged self-hosted', async () => {
    const { logActivityThrottled } = await import('../../../services/activity.js')
    const keys: string[] = []
    const redis = {
      set: async (k: string) => {
        keys.push(k)
        return null
      }
    }
    await logActivityThrottled(redis, 'login:u1', 60, {} as never)
    expect(keys).toEqual(['actlog:login:u1'])
  })

  it('app-links: the address cache is per app and bounded', async () => {
    const links = await import('../../../services/app-links.js')
    const dbA = fakeDb({ nivaro_users: [{ id: 'user-A' }] })
    const dbB = fakeDb({ nivaro_users: [{ id: 'user-B' }] })
    expect(await asApp(A, dbA, () => links.userIdForEmail('x@example.com'))).toBe('user-A')
    expect(await asApp(B, dbB, () => links.userIdForEmail('x@example.com'))).toBe('user-B')
    // Fill past the cap: the oldest address is read again from the database.
    const before = dbA.reads.length
    await asApp(A, dbA, async () => {
      for (let i = 0; i < links.LINK_CACHE_MAX + 1; i++)
        await links.userIdForEmail(`p${i}@example.com`)
      await links.userIdForEmail('x@example.com')
    })
    expect(dbA.reads.length - before).toBe(links.LINK_CACHE_MAX + 2)
  })
})
