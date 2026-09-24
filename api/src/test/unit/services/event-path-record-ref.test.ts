import { beforeEach, describe, expect, it, vi } from 'vitest'

// Each db() call gets its own call log; awaiting yields that table's rows.
const queries: Array<{ table: string; calls: Array<{ method: string; args: unknown[] }> }> = []
const rowsFor: Record<string, unknown[]> = {}

function builder(table: string): unknown {
  const q = { table, calls: [] as Array<{ method: string; args: unknown[] }> }
  queries.push(q)
  const target = {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rowsFor[table] ?? []).then(resolve)
  }
  const proxy: unknown = new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return t.then
      return (...args: unknown[]) => {
        q.calls.push({ method: String(prop), args })
        return proxy
      }
    }
  })
  return proxy
}

vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    vi.fn((t: string) => builder(String(t).split(' ')[0])),
    { schema: { hasColumn: vi.fn(async () => true) } }
  )
}))

import { resetChainColumnProbe } from '../../../services/chain-columns.js'
import { chainsTouchingRecord } from '../../../services/event-path/record-ref.js'

beforeEach(() => {
  queries.length = 0
  for (const k of Object.keys(rowsFor)) delete rowsFor[k]
  resetChainColumnProbe()
})

describe('chainsTouchingRecord', () => {
  it('orders each table newest-first before capping, and merges the ids', async () => {
    rowsFor.nivaro_activity = [{ chain_id: 'a', newest: 9 }]
    rowsFor.nivaro_erp_submissions = [{ chain_id: 'b', newest: 3 }]
    rowsFor.nivaro_workflow_history = [{ chain_id: 'a', newest: 4 }]
    expect(await chainsTouchingRecord('workflows', '7')).toEqual(['a', 'b'])
    const reads = queries.filter((q) => q.calls.some((c) => c.method === 'limit'))
    expect(reads).toHaveLength(3)
    for (const q of reads) {
      const methods = q.calls.map((c) => c.method)
      const order = methods.indexOf('orderBy')
      expect(order).toBeGreaterThan(-1)
      expect(order).toBeLessThan(methods.indexOf('limit'))
      expect(q.calls[order].args).toEqual(['newest', 'desc'])
    }
  })
})
