import { beforeEach, describe, expect, it, vi } from 'vitest'

// Throughput counts only records the caller can open (row filter / User Scopes), the same gates
// /flow applies — not every transition of every collection the caller may read.

const h = vi.hoisted(() => ({
  gates: {} as Record<string, unknown>,
  visible: new Set<string>(),
  candidates: ['1', '2', '3', '4'],
  idQueries: [] as string[][],
  gated: 0
}))

const BUCKET = new Date('2026-10-30T10:00:00Z')

vi.mock('../../db/index.js', () => {
  const builder = () => {
    let ids: string[] | null = null
    let distinct = false
    let grouped = false
    const b: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              if (distinct) return resolve(h.candidates.map((item) => ({ item })))
              if (grouped) {
                if (ids) {
                  h.idQueries.push(ids)
                  return resolve([{ bucket: BUCKET, collection: 'wo', n: ids.length }])
                }
                return resolve([{ bucket: BUCKET, collection: 'wo', n: 5 }])
              }
              return resolve([])
            }
          }
          return (...args: unknown[]) => {
            if (prop === 'whereIn' && Array.isArray(args[1])) ids = args[1] as string[]
            if (prop === 'distinct') distinct = true
            if (prop === 'groupByRaw') grouped = true
            return b
          }
        }
      }
    )
    return b
  }
  return { db: Object.assign(() => builder(), { raw: (s: string) => s }) }
})
vi.mock('../instance-start.js', () => ({ excludeStartRows: vi.fn() }))
vi.mock('../overview/data.js', () => ({
  memo: (_k: string, _t: number, fn: () => unknown) => fn()
}))
vi.mock('../permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../read-gate.js', () => ({
  sharedGatedRead: async (_k: string, _w: string, fn: () => unknown) => ({ value: await fn() }),
  withReadGate: async (_w: string, fn: () => unknown) => {
    h.gated++
    return fn()
  }
}))
vi.mock('../record-access.js', () => ({
  compileAccessGates: vi.fn(async (_u: unknown, c: string) => h.gates[c]),
  visibleIds: vi.fn(
    async (_g: unknown, ids: string[]) => new Set(ids.filter((i) => h.visible.has(i)))
  )
}))
vi.mock('./regions.js', () => ({ recordIdsInRegion: vi.fn(async () => null) }))

import type { User } from '../../types.js'
import { readThroughput } from './throughput.js'

const user = { id: 'U-1' } as unknown as User
const NOW = Date.parse('2026-10-30T15:30:00Z')

beforeEach(() => {
  h.gates = {}
  h.visible = new Set()
  h.idQueries = []
  h.gated = 0
})

describe('throughput honours row filters and User Scopes', () => {
  it('an unrestricted caller keeps the shared counts (no per-record work)', async () => {
    h.gates = {
      wo: { collection: 'wo', rowFilter: null, scopes: [], strict: null, permitted: true }
    }
    const t = await readThroughput(user, { region: null, at: null }, 'UTC', NOW)
    expect(t.today_total).toBe(5)
    expect(h.gated).toBe(0)
  })

  it('a caller with a row filter counts only the records they can open', async () => {
    h.gates = {
      wo: { collection: 'wo', rowFilter: { owner: 1 }, scopes: [], strict: null, permitted: true }
    }
    h.visible = new Set(['1', '2'])
    const t = await readThroughput(user, { region: null, at: null }, 'UTC', NOW)
    expect(t.today_total).toBe(2)
    expect(h.idQueries.flat().sort()).toEqual(['1', '2'])
    // The per-record read went through the read gate.
    expect(h.gated).toBe(1)
  })

  it('a strict scope that cannot reach the collection counts nothing of it', async () => {
    h.gates = {
      wo: {
        collection: 'wo',
        rowFilter: null,
        scopes: [],
        strict: { dimension: 'd', label: 'D' },
        permitted: true
      }
    }
    h.visible = new Set()
    const t = await readThroughput(user, { region: null, at: null }, 'UTC', NOW)
    expect(t.today_total).toBe(0)
  })

  it('gates that cannot be compiled fail closed', async () => {
    h.gates = { wo: null }
    const t = await readThroughput(user, { region: null, at: null }, 'UTC', NOW)
    expect(t.today_total).toBe(0)
  })
})
