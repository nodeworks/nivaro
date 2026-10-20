import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeRows,
  dropMetadataL2,
  encodeRows,
  type L2Cell,
  type L2Redis,
  l2KeyOf,
  metadataL2Stats,
  resetMetadataL2ForTests,
  setMetadataL2PrimaryScope,
  setMetadataL2Redis
} from '../../../db/metadata-l2.js'
import {
  attachMetadataQueryCache,
  clearMetadataQueryCache
} from '../../../db/metadata-query-cache.js'
import { runWithTenantDb } from '../../../db/tenant-context.js'

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeRedis implements L2Redis {
  status = 'ready'
  store = new Map<string, Buffer>()
  sets = new Map<string, Set<string>>()
  fail = false
  hang = false
  private guard<T>(v: T): Promise<T> {
    if (this.hang) return new Promise<T>(() => {})
    if (this.fail) return Promise.reject(new Error('ECONNRESET'))
    return Promise.resolve(v)
  }
  getBuffer(key: string) {
    return this.guard(this.store.get(key) ?? null)
  }
  set(key: string, value: Buffer) {
    this.store.set(key, value)
    return this.guard('OK')
  }
  sadd(key: string, member: string) {
    const s = this.sets.get(key) ?? new Set<string>()
    s.add(member)
    this.sets.set(key, s)
    return this.guard(1)
  }
  expire() {
    return this.guard(1)
  }
  smembers(key: string) {
    return this.guard([...(this.sets.get(key) ?? [])])
  }
  del(...keys: string[]) {
    for (const k of keys) {
      this.store.delete(k)
      this.sets.delete(k)
    }
    return this.guard(keys.length)
  }
  dataKeys() {
    return [...this.store.keys()]
  }
}

type RawCell = { value: unknown; metadata: { colName: string } }
type Q = { sql: string; bindings?: unknown[]; response?: unknown }

/** A stand-in for the tedious-backed knex client: answers from `rows`, counts round trips. */
class FakeClient {
  config = { client: 'mssql' }
  connectionSettings = { server: 'sql1', database: 'cfg' }
  calls = 0
  rows: RawCell[][] = []
  /** When set, the database answers only once it resolves. */
  gate: Promise<void> | null = null
  async _query(_conn: unknown, q: Q): Promise<Q> {
    this.calls++
    if (this.gate) await this.gate
    q.response = this.rows.map((r) =>
      r.map((c) => ({ value: c.value, metadata: { colName: c.metadata.colName } }))
    )
    return q
  }
}

const SCOPE = 'sql1/cfg'
const client = new FakeClient()
attachMetadataQueryCache({ client })

function rowsOf(...vals: Array<Record<string, unknown>>): RawCell[][] {
  return vals.map((o) =>
    Object.entries(o).map(([n, v]) => ({ value: v, metadata: { colName: n } }))
  )
}

const SQL = 'select * from [nivaro_fields] where [collection] = @p0 order by [sort] asc'

async function read(bindings: unknown[] = ['projects']): Promise<Record<string, unknown>[]> {
  // A fresh process: nothing in memory.
  clearMetadataQueryCache()
  const q = await client._query(null, { sql: SQL, bindings })
  return (q.response as RawCell[][]).map((r) =>
    Object.fromEntries(r.map((c) => [c.metadata.colName, c.value]))
  )
}

const flush = () => new Promise((r) => setTimeout(r, 5))
/** Stores are fire-and-forget (compression runs on the thread pool): wait for them. */
const stored = (n: number) => vi.waitFor(() => expect(metadataL2Stats().stores).toBe(n))

let epoch: number | null = 7
let redis: FakeRedis

beforeEach(() => {
  epoch = 7
  resetMetadataL2ForTests({ epochs: { forRead: async () => epoch, now: () => epoch } })
  setMetadataL2PrimaryScope(SCOPE)
  redis = new FakeRedis()
  setMetadataL2Redis(redis)
  client.calls = 0
  client.rows = rowsOf(
    { id: 1, field: 'name', created_at: new Date('2026-10-01T12:34:56.789Z'), hidden: false },
    { id: 2, field: 'blob', created_at: null, hidden: true }
  )
})

// ── encoding ─────────────────────────────────────────────────────────────────

describe('metadata L2 — encoding', () => {
  it('round-trips strings, numbers, booleans, nulls, dates and buffers exactly', async () => {
    const rows: L2Cell[][] = [
      [
        { n: 'a', v: 'x' },
        { n: 'b', v: 1.5 },
        { n: 'c', v: true },
        { n: 'd', v: null },
        { n: 'e', v: new Date(1_700_000_000_123) },
        { n: 'f', v: Buffer.from([0, 1, 255]) }
      ],
      [
        { n: 'a', v: '{"$d":1}' },
        { n: 'b', v: -0.25 },
        { n: 'c', v: false },
        { n: 'd', v: 'null' },
        { n: 'e', v: null },
        { n: 'f', v: null }
      ]
    ]
    const buf = await encodeRows(rows)
    expect(buf).not.toBeNull()
    expect(await decodeRows(buf as Buffer)).toStrictEqual(rows)
  })

  it('refuses values it cannot carry faithfully instead of changing them', async () => {
    expect(await encodeRows([[{ n: 'a', v: { nested: 1 } }]])).toBeNull()
    expect(await encodeRows([[{ n: 'a', v: Number.NaN }]])).toBeNull()
    expect(await encodeRows([[{ n: 'a', v: BigInt(1) }]])).toBeNull()
    // Rows whose column lists differ are not one result set.
    expect(await encodeRows([[{ n: 'a', v: 1 }], [{ n: 'b', v: 1 }]])).toBeNull()
  })
})

// ── through the driver seam ─────────────────────────────────────────────────

describe('metadata L2 — read-through at the driver seam', () => {
  it('a second process reads what the first stored, without the database', async () => {
    const first = await read()
    expect(client.calls).toBe(1)
    await stored(1)

    const second = await read()
    expect(client.calls).toBe(1) // answered by Redis
    expect(second).toStrictEqual(first)
    expect(second[0].created_at).toBeInstanceOf(Date)
    expect(metadataL2Stats().hits).toBe(1)
  })

  it('a moved epoch is a miss: entries stored before a configuration write are unreachable', async () => {
    await read()
    await stored(1)
    epoch = 8
    client.rows = rowsOf({ id: 1, field: 'renamed', created_at: null, hidden: false })
    const after = await read()
    expect(client.calls).toBe(2)
    expect(after[0].field).toBe('renamed')
    await stored(2)
    // ...and the new answer is what the next process gets.
    expect((await read())[0].field).toBe('renamed')
    expect(client.calls).toBe(2)
  })

  it('no usable epoch (off, unknown, or a local write settling) skips the level entirely', async () => {
    epoch = null
    await read()
    await read()
    await flush()
    expect(client.calls).toBe(2)
    expect(redis.dataKeys()).toHaveLength(0)
    expect(metadataL2Stats().skipped_no_epoch).toBe(2)
  })

  it('does not store an answer whose epoch moved while the database was reading', async () => {
    let release: () => void = () => {}
    client.gate = new Promise<void>((r) => {
      release = r
    })
    try {
      clearMetadataQueryCache()
      const pending = client._query(null, { sql: SQL, bindings: ['projects'] })
      await flush()
      expect(client.calls).toBe(1) // the database is reading
      epoch = 9 // another process (or this one) moved the number mid-read
      release()
      await pending
      await flush()
      expect(redis.dataKeys()).toHaveLength(0)
      expect(metadataL2Stats().skipped_store).toBe(1)
    } finally {
      client.gate = null
    }
  })

  it('Redis erroring reads straight from the database, counted, never thrown', async () => {
    redis.fail = true
    const rows = await read()
    expect(rows[0].field).toBe('name')
    expect(client.calls).toBe(1)
    expect(metadataL2Stats().errors).toBe(1)
    // Backing off: the next read does not even ask.
    redis.fail = false
    await read()
    expect(metadataL2Stats().skipped_unavailable).toBe(1)
  })

  it('Redis hanging times out to the database', async () => {
    redis.hang = true
    const t = Date.now()
    const rows = await read()
    expect(rows[0].field).toBe('name')
    expect(Date.now() - t).toBeLessThan(2_000)
    expect(metadataL2Stats().errors).toBe(1)
  })

  it('Redis not connected is skipped at once', async () => {
    redis.status = 'reconnecting'
    await read()
    expect(client.calls).toBe(1)
    expect(metadataL2Stats().skipped_unavailable).toBe(1)
  })

  it('an entry over the size cap is never stored', async () => {
    client.rows = rowsOf({ id: 1, blob: randomBytes(400_000).toString('hex') })
    await read()
    await flush()
    await vi.waitFor(() => expect(metadataL2Stats().oversize).toBe(1))
    expect(redis.dataKeys()).toHaveLength(0)
  })

  it('a value it cannot carry leaves the statement uncached here', async () => {
    client.rows = rowsOf({ id: 1, odd: { a: 1 } })
    await read()
    await vi.waitFor(() => expect(metadataL2Stats().uncacheable).toBe(1))
    expect(redis.dataKeys()).toHaveLength(0)
  })

  it('reads of another database (a read replica) never use the level', async () => {
    resetMetadataL2ForTests({ epochs: { forRead: async () => epoch, now: () => epoch } })
    setMetadataL2PrimaryScope('replica/cfg')
    setMetadataL2Redis(redis)
    await read()
    await read()
    await flush()
    expect(client.calls).toBe(2)
    expect(redis.dataKeys()).toHaveLength(0)
  })
})

describe('metadata L2 — keys', () => {
  it('separates tenants, epochs and databases', () => {
    const plain = l2KeyOf(SCOPE, 7, 'k')
    let a = ''
    let b = ''
    runWithTenantDb(
      {} as never,
      'acme',
      () => {
        a = l2KeyOf(SCOPE, 7, 'k')
      },
      'tenant-a'
    )
    runWithTenantDb(
      {} as never,
      'beta',
      () => {
        b = l2KeyOf(SCOPE, 7, 'k')
      },
      'tenant-b'
    )
    expect(new Set([plain, a, b]).size).toBe(3)
    expect(a).toContain(':tenant-a:')
    expect(l2KeyOf(SCOPE, 8, 'k')).not.toBe(plain)
    expect(l2KeyOf('other/db', 7, 'k')).not.toBe(plain)
  })

  it('a tenant never reads another tenant’s entry', async () => {
    await new Promise<void>((done) =>
      runWithTenantDb({} as never, 'acme', () => void read().then(() => done()), 'tenant-a')
    )
    await stored(1)
    client.calls = 0
    await new Promise<void>((done) =>
      runWithTenantDb({} as never, 'beta', () => void read().then(() => done()), 'tenant-b')
    )
    expect(client.calls).toBe(1)
    // Each tenant keeps its own entry.
    await stored(2)
    expect(redis.dataKeys()).toHaveLength(2)
  })
})

describe('metadata L2 — bust on a local clear', () => {
  it('dropMetadataL2 removes the generations this process keyed on', async () => {
    await read(['projects'])
    await read(['orders'])
    await stored(2)
    expect(redis.dataKeys()).toHaveLength(2)
    await dropMetadataL2()
    expect(redis.dataKeys()).toHaveLength(0)
    await read(['projects'])
    expect(client.calls).toBe(3)
    await stored(3)
  })

  it('clearMetadataCache (a configuration change made here) drops them too', async () => {
    const { clearMetadataCache } = await import('../../../services/collections.js')
    await read()
    await stored(1)
    expect(redis.dataKeys()).toHaveLength(1)
    clearMetadataCache('projects')
    await vi.waitFor(() => expect(redis.dataKeys()).toHaveLength(0))
    expect(metadataL2Stats().drops).toBe(1)
  })
})
