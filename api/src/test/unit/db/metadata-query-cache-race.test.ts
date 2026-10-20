import { describe, expect, it } from 'vitest'
import {
  attachMetadataQueryCache,
  clearMetadataQueryCache
} from '../../../db/metadata-query-cache.js'

type Q = { sql: string; bindings: unknown[]; response?: unknown }

/** A tedious-shaped driver whose reads wait on a gate the test opens. */
class FakeMssqlClient {
  config = { client: 'mssql' }
  connectionSettings = { server: 'fake', database: 'race' }
  value = 'old'
  gates: Array<() => void> = []
  reads = 0
  async _query(_connection: unknown, query: Q): Promise<Q> {
    this.reads++
    const seen = this.value
    await new Promise<void>((resolve) => this.gates.push(resolve))
    query.response = [[{ value: seen, metadata: { colName: 'admin_access' } }]]
    return query
  }
}

const client = new FakeMssqlClient()
attachMetadataQueryCache({ client })

function read(): Promise<string> {
  const q: Q = { sql: 'select * from [nivaro_roles] where [id] = @p0', bindings: ['r1'] }
  const p = (client._query as (c: unknown, q: Q) => Promise<Q>).call(client, {}, q)
  return p.then((done) => {
    const rows = done.response as Array<Array<{ value: string }>>
    return rows[0][0].value
  })
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('metadata query cache — a write during a shared read', () => {
  it('a caller that joined before the write reads again instead of taking the old rows', async () => {
    clearMetadataQueryCache()
    client.value = 'old'
    const leader = read()
    await flush()
    const follower = read() // joins the leader's in-flight read
    await flush()
    expect(client.reads).toBe(1)
    // The write lands: the driver seam clears the cache (before and after the statement).
    client.value = 'new'
    clearMetadataQueryCache()
    client.gates.shift()?.() // the leader's read finishes with what it saw before the write
    expect(await leader).toBe('old')
    await flush()
    expect(client.reads).toBe(2) // the follower asked again
    client.gates.shift()?.()
    expect(await follower).toBe('new')
  })

  it('a caller arriving after the write never joins the read that started before it', async () => {
    clearMetadataQueryCache()
    client.value = 'old'
    const before = read()
    await flush()
    client.value = 'new'
    clearMetadataQueryCache()
    const after = read()
    await flush()
    expect(client.reads).toBe(4) // its own statement, not the old one
    client.gates.shift()?.()
    client.gates.shift()?.()
    expect(await before).toBe('old')
    expect(await after).toBe('new')
    // And the old read did not store what it saw.
    const again = read()
    await flush()
    if (client.gates.length) client.gates.shift()?.()
    expect(await again).toBe('new')
  })
})
