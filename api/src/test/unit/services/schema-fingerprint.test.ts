import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * schemaInputsFingerprint (post-mortem 3.3, final review): on SQL Server the server returns one
 * row per table (count + checksums) — nothing is shipped or hashed on the event loop; other
 * dialects, or a failing checksum query, hash the rows here.
 */
const state = vi.hoisted(() => ({
  mssql: true,
  raw: [] as Array<Record<string, unknown>>,
  rawFails: false,
  rawCalls: 0,
  selects: 0
}))

vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    (table: string) => ({
      select: async () => {
        state.selects++
        return [{ table, id: 1 }]
      }
    }),
    {
      raw: async () => {
        state.rawCalls++
        if (state.rawFails) throw new Error('BINARY_CHECKSUM not allowed')
        return state.raw
      }
    }
  )
  return { db, dbRead: db, isMssql: () => state.mssql }
})
vi.mock('../../../services/record-instance.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/record-instance.js')>()),
  boundCollections: async () => new Set(['projects'])
}))

const rows = (f: number) => [
  { t: 'c', n: 10, h: 111, s: 999 },
  { t: 'f', n: 200, h: f, s: 5000 },
  { t: 'r', n: 30, h: 333, s: 777 }
]

describe('schemaInputsFingerprint', () => {
  beforeEach(() => {
    state.mssql = true
    state.rawFails = false
    state.rawCalls = 0
    state.selects = 0
  })

  it('reads one checksum row per table on SQL Server and moves when a field changed', async () => {
    const { schemaInputsFingerprint } = await import('../../../services/schema-builder.js')
    state.raw = rows(222)
    const a = await schemaInputsFingerprint()
    state.raw = [...rows(222)].reverse()
    expect(await schemaInputsFingerprint()).toBe(a)
    state.raw = rows(223)
    expect(await schemaInputsFingerprint()).not.toBe(a)
    expect(state.rawCalls).toBe(3)
    expect(state.selects).toBe(0)
  })

  it('hashes the rows itself on other dialects, or when the checksum query fails', async () => {
    const { schemaInputsFingerprint } = await import('../../../services/schema-builder.js')
    state.mssql = false
    const a = await schemaInputsFingerprint()
    expect(state.rawCalls).toBe(0)
    expect(state.selects).toBe(3)
    state.mssql = true
    state.rawFails = true
    expect(await schemaInputsFingerprint()).toBe(a)
    expect(state.selects).toBe(6)
  })
})
