import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Config epochs per app on a Hub shared deployment: each app's configuration writes are announced
// on Redis (leading + trailing edge per app), and every other process clears its caches inside
// that app only. The driver seam notes the write on every engine's app pool.

const ready = vi.hoisted(() => new Set<string>())
vi.mock('../../../services/tenancy/app-migrations.js', () => ({
  appReadyForRequests: (id: string) => ready.has(id)
}))

const { attachAppConfigWriteSeam, onConfigWrite } = await import('../../../db/config-epoch.js')
const { getOrCreateTenantPool, runWithTenantDb, onTenantPoolCreated } = await import(
  '../../../db/tenant-context.js'
)
const { currentTenantKey } = await import('../../../services/tenant-rooms.js')
const epochs = await import('../../../services/app-config-epoch.js')

const SHARED: Record<string, string> = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example.test',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
}
const KEYS = ['CLOUD_META_DB_URL', 'CACHE_EPOCH', ...Object.keys(SHARED)]
let saved: Record<string, string | undefined> = {}

function inApp<T>(app: string, fn: () => T): T {
  let out!: T
  runWithTenantDb(
    {} as Knex,
    app,
    () => {
      out = fn()
    },
    app
  )
  return out
}

const sent: string[] = []
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, SHARED)
  sent.length = 0
  ready.clear()
  epochs._setAppConfigWiringForTests({
    publish: async (_ch, msg) => {
      sent.push(msg)
    },
    instance: 'node-1'
  })
})
afterEach(() => {
  vi.useRealTimers()
  epochs._setAppConfigWiringForTests(null)
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('announcing an app configuration write', () => {
  it('announces at once, then again 2 s after the last write of the run', () => {
    vi.useFakeTimers()
    inApp('A', () => epochs.noteAppConfigWrite())
    expect(sent).toEqual(['A|node-1'])
    vi.advanceTimersByTime(1_000)
    inApp('A', () => epochs.noteAppConfigWrite())
    // inside the 10 s gap: no second leading announcement
    expect(sent).toEqual(['A|node-1'])
    vi.advanceTimersByTime(2_000)
    expect(sent).toEqual(['A|node-1', 'A|node-1'])
  })

  it('keeps each app to its own run', () => {
    vi.useFakeTimers()
    inApp('A', () => epochs.noteAppConfigWrite())
    inApp('B', () => epochs.noteAppConfigWrite())
    expect(sent).toEqual(['A|node-1', 'B|node-1'])
  })

  it('outside any app, or with CACHE_EPOCH=off, announces nothing', () => {
    epochs.noteAppConfigWrite()
    process.env.CACHE_EPOCH = 'off'
    inApp('A', () => epochs.noteAppConfigWrite())
    inApp('A', () => epochs.announceAppConfigChange())
    expect(sent).toEqual([])
  })
})

describe('hearing another process announce', () => {
  const app = (id: string, status = 'active') =>
    ({ id, slug: id.toLowerCase(), status }) as unknown as Parameters<
      Parameters<typeof epochs.onAppConfigMessage>[2]['inApp']
    >[0]

  const deps = (apps: Record<string, ReturnType<typeof app>>, busted: string[]) => ({
    resolve: async (id: string) => apps[id] ?? null,
    inApp: <T>(t: { id: string }, fn: () => Promise<T>) =>
      new Promise<T>((res, rej) => {
        runWithTenantDb({} as Knex, t.id, () => void fn().then(res, rej), t.id)
      }),
    bust: () => {
      busted.push(currentTenantKey())
      return ['collection-metadata']
    }
  })

  it("clears that app's caches inside the app", async () => {
    ready.add('A')
    const busted: string[] = []
    const out = await epochs.onAppConfigMessage('A|node-2', 'node-1', deps({ A: app('A') }, busted))
    expect(out).toEqual(['collection-metadata'])
    expect(busted).toEqual(['A'])
  })

  it('skips its own announcement, an unknown app, one not active and one not ready', async () => {
    ready.add('A')
    const busted: string[] = []
    const d = deps({ A: app('A'), B: app('B', 'maintenance'), C: app('C') }, busted)
    expect(await epochs.onAppConfigMessage('A|node-1', 'node-1', d)).toBeNull()
    expect(await epochs.onAppConfigMessage('Z|node-2', 'node-1', d)).toBeNull()
    expect(await epochs.onAppConfigMessage('B|node-2', 'node-1', d)).toBeNull()
    expect(await epochs.onAppConfigMessage('C|node-2', 'node-1', d)).toBeNull()
    expect(await epochs.onAppConfigMessage('garbage', 'node-1', d)).toBeNull()
    expect(busted).toEqual([])
  })
})

describe('the app pool write seam', () => {
  /** A fake knex whose driver prototype records statements. */
  function fakePool() {
    const ran: string[] = []
    class Client {
      _query(_c: unknown, q: { sql?: string }) {
        ran.push(q.sql ?? '')
        return Promise.resolve(q)
      }
    }
    const client = new Client()
    return { pool: { client } as unknown as Knex, client, ran }
  }

  it('notes a configuration write in the app it runs in, never a read', async () => {
    const { pool, client } = fakePool()
    attachAppConfigWriteSeam(pool)
    const heard: string[] = []
    const off = onConfigWrite(() => heard.push(currentTenantKey()))
    try {
      await inApp('A', () =>
        client._query(null, { sql: 'update [nivaro_fields] set [note] = ? where [id] = ?' })
      )
      await inApp('A', () => client._query(null, { sql: 'select * from [nivaro_fields]' }))
      await inApp('B', () =>
        client._query(null, { sql: 'insert into "nivaro_collections" ("collection") values ($1)' })
      )
    } finally {
      off()
    }
    expect(heard).toEqual(['A', 'B'])
  })

  it('leaves a prototype another seam already patched alone', () => {
    const { pool, client } = fakePool()
    const proto = Object.getPrototypeOf(client) as Record<symbol, unknown>
    proto[Symbol.for('nivaro.metadataQueryCache')] = true
    const before = (proto as { _query?: unknown })._query
    attachAppConfigWriteSeam(pool)
    expect((proto as { _query?: unknown })._query).toBe(before)
  })

  it('reaches pools made after the hook was registered, and ones that existed before', async () => {
    const early: unknown[] = []
    const offEarly = onTenantPoolCreated((p) => early.push(p))
    const pool = getOrCreateTenantPool('postgres://u@127.0.0.1:1/app_seam_test', 'pg', 1)
    const late: unknown[] = []
    const offLate = onTenantPoolCreated((p) => late.push(p))
    try {
      expect(early).toContain(pool)
      expect(late).toContain(pool)
      // the same connection string answers the same pool, the hooks do not run again
      getOrCreateTenantPool('postgres://u@127.0.0.1:1/app_seam_test', 'pg', 1)
      expect(early.filter((p) => p === pool)).toHaveLength(1)
    } finally {
      offEarly()
      offLate()
      await pool.destroy()
    }
  })
})
