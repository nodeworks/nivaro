import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Watched next" (#1530): successor pairs from fake view rows, the nightly
// rewrite of nivaro_help_video_next, and the read-time ranking.

const fake = vi.hoisted(() => ({
  views: [] as Record<string, unknown>[],
  deleted: 0,
  inserts: [] as Record<string, unknown>[][]
}))

vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    vi.fn(() => {
      const b: any = {
        join: () => b,
        leftJoin: () => b,
        where: () => b,
        orderBy: () => b,
        limit: () => b,
        select: async () => fake.views,
        delete: async () => {
          fake.deleted++
          return 1
        },
        insert: async (rows: Record<string, unknown>[]) => {
          fake.inserts.push(rows)
        }
      }
      return b
    }),
    { raw: vi.fn() }
  )
  return { db }
})
vi.mock('../../../config.js', () => ({ config: { SESSION_SECRET: 'x'.repeat(40) } }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))

import {
  computeNextTable,
  NEXT_WINDOW_MS,
  rankNext,
  successorPairs
} from '../../../services/help-video-next.js'

const A = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
const B = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'
const C = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC'
const R1 = 'R1'
const R2 = 'R2'
const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 0, min))

beforeEach(() => {
  fake.views = []
  fake.deleted = 0
  fake.inserts = []
})

describe('successorPairs', () => {
  it('counts the video each person started next, per role and for any role', () => {
    const rows = successorPairs([
      { user: 'u1', role: R1, video_id: A, first_viewed: t(0) },
      { user: 'u1', role: R1, video_id: B, first_viewed: t(10) },
      { user: 'u2', role: R1, video_id: a(A), first_viewed: t(5) },
      { user: 'u2', role: R1, video_id: B, first_viewed: t(20) },
      { user: 'u3', role: R2, video_id: A, first_viewed: t(0) },
      { user: 'u3', role: R2, video_id: C, first_viewed: t(30) }
    ])
    expect(rows).toEqual([
      { video_id: A, next_video_id: B, role_id: null, score: 2 },
      { video_id: A, next_video_id: B, role_id: R1, score: 2 },
      { video_id: A, next_video_id: C, role_id: null, score: 1 },
      { video_id: A, next_video_id: C, role_id: R2, score: 1 }
    ])
  })
  it('ignores a next video started after the window, and a person without a role counts for any role only', () => {
    const rows = successorPairs([
      { user: 'u1', role: null, video_id: A, first_viewed: t(0) },
      { user: 'u1', role: null, video_id: B, first_viewed: t(10) },
      {
        user: 'u1',
        role: null,
        video_id: C,
        first_viewed: new Date(t(10).getTime() + NEXT_WINDOW_MS + 1)
      }
    ])
    expect(rows).toEqual([{ video_id: A, next_video_id: B, role_id: null, score: 1 }])
  })
  it('orders views by first_viewed whatever order the rows come in, and skips unreadable dates', () => {
    const rows = successorPairs([
      { user: 'u1', role: R1, video_id: B, first_viewed: t(10) },
      { user: 'u1', role: R1, video_id: A, first_viewed: t(0) },
      { user: 'u1', role: R1, video_id: C, first_viewed: 'not a date' }
    ])
    expect(rows.map((r) => [r.video_id, r.next_video_id, r.role_id])).toEqual([
      [A, B, null],
      [A, B, R1]
    ])
  })
  it('a person with one view makes no pair', () => {
    expect(successorPairs([{ user: 'u1', role: R1, video_id: A, first_viewed: t(0) }])).toEqual([])
  })
})

describe('computeNextTable', () => {
  it('rewrites the table from the published videos’ views in chunks', async () => {
    fake.views = [
      { user: 'u1', role: R1, video_id: A, first_viewed: t(0) },
      { user: 'u1', role: R1, video_id: B, first_viewed: t(5) }
    ]
    const now = new Date('2026-10-10T03:20:00Z')
    expect(await computeNextTable(now)).toBe('2 pairs from 2 views')
    expect(fake.deleted).toBe(1)
    expect(fake.inserts.flat()).toEqual([
      { video_id: A, next_video_id: B, role_id: null, score: 1, computed_at: now },
      { video_id: A, next_video_id: B, role_id: R1, score: 1, computed_at: now }
    ])
  })
  it('an empty view table clears the pairs and inserts nothing', async () => {
    expect(await computeNextTable()).toBe('0 pairs from 0 views')
    expect(fake.deleted).toBe(1)
    expect(fake.inserts).toEqual([])
  })
})

describe('rankNext', () => {
  const all = () => true
  it('role rows first, then any-role rows, then same-screen; best score first within a tier', () => {
    const out = rankNext(
      [
        { id: C, tier: 2, score: 3 },
        { id: B, tier: 1, score: 9 },
        { id: 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD', tier: 0, score: 1 },
        { id: 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE', tier: 0, score: 4 }
      ],
      { videoId: A, finished: new Set(), visible: all }
    )
    expect(out).toEqual([
      'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE',
      'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD',
      B,
      C
    ])
  })
  it('a video seen under several tiers appears once, under its best tier', () => {
    const out = rankNext(
      [
        { id: B, tier: 2, score: 5 },
        { id: B, tier: 1, score: 1 },
        { id: C, tier: 1, score: 3 }
      ],
      { videoId: A, finished: new Set(), visible: all }
    )
    expect(out).toEqual([C, B])
  })
  it('leaves out the video itself, finished videos and invisible ones, and stops at the limit', () => {
    const out = rankNext(
      [
        { id: A, tier: 0, score: 9 },
        { id: B, tier: 0, score: 8 },
        { id: C, tier: 0, score: 7 },
        { id: 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD', tier: 1, score: 1 },
        { id: 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE', tier: 1, score: 1 }
      ],
      {
        videoId: a(A),
        finished: new Set([B]),
        visible: (id) => id !== C,
        limit: 1
      }
    )
    expect(out).toEqual(['DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD'])
  })
})

/** The same id in lower case: ids compare case-insensitively everywhere. */
function a(id: string): string {
  return id.toLowerCase()
}
