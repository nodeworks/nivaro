import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The peek is read as the caller (readOne null = 404), and the people block lists only the
 * people the presence answer gives this viewer — what they have open is named only when the
 * viewer's own read resolved its label.
 */
type Row = Record<string, unknown>
const presenceRows: Row[] = [
  { user_id: 'aaaa', current_path: '/collections/orders/5' },
  { user_id: 'bbbb', current_path: '/collections/orders/6' }
]

function builder(table: string) {
  let rows: Row[] = table === 'user_presence' ? [...presenceRows] : []
  const b: Record<string, unknown> = {
    select: () => b,
    where: () => b,
    whereNotNull: () => b,
    whereIn(c: string, ids: string[]) {
      rows = rows.filter((r) =>
        ids.map((i) => i.toUpperCase()).includes(String(r[c]).toUpperCase())
      )
      return b
    },
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then(res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve(rows).then(res, rej)
    }
  }
  return b
}

const calls: unknown[][] = []
let readImpl: (...a: unknown[]) => Promise<unknown> = async () => null
vi.mock('../../db/index.js', () => ({ db: (t: string) => builder(t) }))
vi.mock('../items.js', () => ({
  readOne: (...a: unknown[]) => {
    calls.push(a)
    return readImpl(...a)
  }
}))
vi.mock('../../routes/presence.js', () => ({
  // The presence boundary already applied: this viewer sees aaaa only.
  presenceOnlineFor: async () => ({
    data: [{ user_id: 'aaaa', display_name: 'Ann Able', is_idle: false, page: 'Orders › ORD-5' }],
    config: {}
  }),
  // Label for order 5 resolves (viewer can read it); order 6 does not.
  resolveRecordLabels: async () => new Map([['orders:5', 'ORD-5']])
}))
vi.mock('./regions.js', () => ({
  resolveRegionSource: async () => null,
  readableRegions: async () => [],
  regionCentroids: async () => [],
  userRegionMap: async () => null,
  userIdsInRegion: async () => null,
  readableName: (c: string) => c
}))

import { peekRecord } from './peek.js'
import { recordFromPath, snapshotPeople } from './people.js'

const user = { id: 'viewer', role: 'r1' } as never

describe('peekRecord', () => {
  beforeEach(() => {
    calls.length = 0
    readImpl = async () => null
  })
  it('answers null (route 404) when the caller cannot read the row', async () => {
    expect(await peekRecord(user, false, 'orders', '5')).toBeNull()
    expect(calls).toEqual([[user, 'orders', '5']])
  })
  it('answers null when the read is refused outright', async () => {
    readImpl = async () => {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    }
    expect(await peekRecord(user, false, 'orders', '5')).toBeNull()
  })
  it('never reads system tables', async () => {
    expect(await peekRecord(user, true, 'nivaro_users', '1')).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('people visibility boundary', () => {
  it('lists only the people the presence answer shows this viewer, with what they have open', async () => {
    const block = await snapshotPeople({} as never, { user, isAdmin: false } as never, {
      region: null,
      at: null
    })
    expect(block.online_count).toBe(1)
    const people = block.regions.flatMap((g) => g.people)
    expect(people.map((p) => p.user_id)).toEqual(['AAAA'])
    expect(people[0]).toMatchObject({
      name: 'Ann Able',
      page_label: 'Orders › ORD-5',
      record: { collection: 'orders', id: '5', label: 'ORD-5' }
    })
  })

  it('never names a record the viewer could not label', () => {
    const labels = new Map([['orders:5', 'ORD-5']])
    expect(recordFromPath('/collections/orders/6', labels)).toBeNull()
    expect(recordFromPath('/collections/orders/new', labels)).toBeNull()
    expect(recordFromPath('/records/orders/5?tab=x', labels)).toEqual({
      collection: 'orders',
      id: '5',
      label: 'ORD-5'
    })
  })
})
