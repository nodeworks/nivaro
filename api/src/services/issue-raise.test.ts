import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Store {
  hits: Array<{ key: string; hour: Date; hits: number }>
  people: Array<{ key: string; day: string; user_id: string }>
  issues: Array<{ id: number; fingerprint: string | null }>
  fail: boolean
}
const store = vi.hoisted(
  () => ({ hits: [], people: [], issues: [], fail: false }) as unknown as Store
)

// A tiny chainable stand-in for the knex calls issue-raise makes.
vi.mock('../db/index.js', () => {
  const db: any = (table: string) => {
    if (store.fail) throw new Error('db down')
    const wh: Record<string, unknown> = {}
    const gte: Record<string, any> = {}
    let sumCol: string | null = null
    let distinct = false
    const rows = () =>
      (table === 'nivaro_issue_hits'
        ? store.hits
        : table === 'nivaro_issue_hit_people'
          ? store.people
          : store.issues) as any[]
    const match = (r: any) =>
      Object.entries(wh).every(([k, v]) =>
        r[k] instanceof Date ? r[k].getTime() === (v as Date).getTime() : r[k] === v
      ) && Object.entries(gte).every(([k, v]) => r[k] >= v)
    const q: any = {
      where(a: any, b?: any, c?: any) {
        if (typeof a === 'object') Object.assign(wh, a)
        else if (c !== undefined) gte[a] = c
        else wh[a] = b
        return q
      },
      orderBy: () => q,
      sum() {
        sumCol = 'hits'
        return q
      },
      countDistinct() {
        distinct = true
        return q
      },
      async first() {
        const m = rows().filter(match)
        if (sumCol) return { n: m.reduce((s, r) => s + r.hits, 0) }
        if (distinct) return { n: new Set(m.map((r) => r.user_id)).size }
        return m[m.length - 1] ? { ...m[m.length - 1] } : undefined
      },
      async update(patch: any) {
        const m = rows().filter(match)
        for (const r of m) r.hits += patch.hits.n
        return m.length
      },
      async insert(row: any) {
        rows().push({ ...row })
      }
    }
    return q
  }
  db.raw = (_s: string, b: unknown[]) => ({ n: b[0] })
  return { db }
})

import { inBackgroundPool } from '../db/pool-context.js'
import { hitCounts, hitKey, noteIssueWrite, onIssueWrite } from './issue-raise.js'

const tick = () => new Promise((r) => setTimeout(r, 20))
const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

beforeEach(() => {
  store.hits.length = 0
  store.people.length = 0
  store.issues.length = 0
  store.fail = false
})

describe('issue-raise', () => {
  it('hitCounts sums hours in window', async () => {
    const h = (iso: string) => new Date(iso)
    store.hits.push(
      { key: 'k', hour: h('2026-11-17T01:00:00Z'), hits: 3 },
      { key: 'k', hour: h('2026-11-17T05:00:00Z'), hits: 4 },
      { key: 'other', hour: h('2026-11-17T05:00:00Z'), hits: 9 }
    )
    const r = await hitCounts('k', h('2026-11-17T03:30:00Z'))
    expect(r.hits).toBe(4)
    expect((await hitCounts('k', h('2026-11-17T00:10:00Z'))).hits).toBe(7)
  })

  it('people counts distinct users per day once', async () => {
    const at = new Date('2026-11-17T10:00:00Z')
    store.issues.push({ id: 5, fingerprint: 'fp' })
    noteIssueWrite(5, 'recurred', {
      fingerprint: 'fp',
      hits: [
        { userId: U1, at },
        { userId: U1, at },
        { userId: U2, at }
      ]
    })
    await tick()
    noteIssueWrite(5, 'recurred', { fingerprint: 'fp', hits: [{ userId: U1, at }] })
    await tick()
    expect(store.people).toHaveLength(2)
    const r = await hitCounts('fp', new Date('2026-11-17T00:00:00Z'))
    expect(r).toEqual({ hits: 4, people: 2 })
  })

  it('resolves a null id by fingerprint, keys by fingerprint and notifies listeners', async () => {
    store.issues.push({ id: 9, fingerprint: 'fp9' })
    const seen: unknown[] = []
    const off = onIssueWrite((e) => void seen.push(e))
    onIssueWrite(() => {
      throw new Error('bad listener')
    })
    noteIssueWrite(null, 'raised', { fingerprint: 'fp9', count: 3 })
    await tick()
    off()
    expect(seen).toEqual([{ issueId: 9, kind: 'raised' }])
    expect(store.hits[0]).toMatchObject({ key: hitKey({ id: 9, fingerprint: 'fp9' }), hits: 3 })
    expect(hitKey({ id: 2 })).toBe('issue:2')
  })

  // final review M2: no id and no fingerprint must not resolve to the newest manual issue
  it('a write with neither id nor fingerprint is dropped, not matched to a fingerprint-less issue', async () => {
    store.issues.push({ id: 3, fingerprint: null })
    const seen: unknown[] = []
    const off = onIssueWrite((e) => void seen.push(e))
    noteIssueWrite(null, 'raised')
    noteIssueWrite(null, 'recurred', { fingerprint: '' })
    await tick()
    off()
    expect(seen).toEqual([])
    expect(store.hits).toEqual([])
  })

  // final review M5: tracker-prune never runs in cloud mode, so no counters grow there
  it('records no hit counters in cloud mode (listeners still hear the write)', async () => {
    const prev = process.env.CLOUD_META_DB_URL
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    try {
      store.issues.push({ id: 7, fingerprint: 'fp7' })
      const seen: unknown[] = []
      const off = onIssueWrite((e) => void seen.push(e))
      noteIssueWrite(7, 'recurred', { fingerprint: 'fp7', hits: [{ userId: U1 }] })
      await tick()
      off()
      expect(store.hits).toEqual([])
      expect(store.people).toEqual([])
      expect(seen).toEqual([{ issueId: 7, kind: 'recurred' }])
    } finally {
      if (prev === undefined) delete process.env.CLOUD_META_DB_URL
      else process.env.CLOUD_META_DB_URL = prev
    }
  })

  // final review M6: the funnel never borrows the request pool
  it('runs the counters and listeners on the background pool', async () => {
    store.issues.push({ id: 8, fingerprint: 'fp8' })
    const pools: boolean[] = []
    const off = onIssueWrite(() => void pools.push(inBackgroundPool()))
    expect(inBackgroundPool()).toBe(false)
    noteIssueWrite(8, 'raised', { fingerprint: 'fp8' })
    await tick()
    off()
    expect(pools).toEqual([true])
  })

  it('noteIssueWrite swallows db errors', async () => {
    store.fail = true
    expect(() => noteIssueWrite(1, 'raised', { fingerprint: 'x' })).not.toThrow()
    await tick()
  })
})
