import { beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny fake of the knex calls help-video-views makes: one views row, the
// inserts and updates it wrote, and canned rows for the joined reads.
const fake = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  rowAfterInsertError: undefined as Record<string, unknown> | undefined,
  insertError: null as unknown,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  // what each update reports as rows touched (default 1); a 0 simulates a
  // parallel beat that moved last_viewed first
  updateCounts: [] as number[],
  rowAfterLostUpdate: undefined as Record<string, unknown> | undefined,
  selectRows: [] as Record<string, unknown>[]
}))

vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    vi.fn(() => {
      const b = {
        join: () => b,
        leftJoin: (_t: string, cb: (this: unknown) => void) => {
          const on = { on: () => on, andOn: () => on }
          cb.call(on)
          return b
        },
        where: () => b,
        whereNull: () => b,
        select: async () => fake.selectRows,
        first: async () => fake.row,
        insert: async (r: Record<string, unknown>) => {
          if (fake.insertError) {
            const e = fake.insertError
            fake.insertError = null
            fake.row = fake.rowAfterInsertError
            throw e
          }
          fake.inserts.push(r)
        },
        update: async (r: Record<string, unknown>) => {
          const n = fake.updateCounts.length ? (fake.updateCounts.shift() as number) : 1
          if (n === 0) {
            if (fake.rowAfterLostUpdate) fake.row = fake.rowAfterLostUpdate
            return 0
          }
          fake.updates.push(r)
          // the stored row moves on, like the database would
          if (fake.row) fake.row = { ...fake.row, ...r }
          return n
        }
      }
      return b
    }),
    { raw: vi.fn(() => '?') }
  )
  return { db }
})
vi.mock('../../../config.js', () => ({ config: { SESSION_SECRET: 'x'.repeat(40) } }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))

import {
  countBuckets,
  dropOff,
  isComplete,
  limitNewBuckets,
  mergeBuckets,
  pickStreamFile,
  recordProgress,
  requiredForUser,
  sanitizeBuckets,
  videoAnalytics,
  viewerMayPlaySource
} from '../../../services/help-video-views.js'
import type { VideoRow } from '../../../services/help-videos.js'
import { mediaTicket, sidTag, verifyMediaTicket } from '../../../services/help-videos.js'
import type { User } from '../../../types.js'

describe('buckets', () => {
  it('merges seen sections', () =>
    expect(mergeBuckets('10000000000000000000', '01000000000000000001')).toBe(
      '11000000000000000001'
    ))
  it('sanitizes garbage to 20 zero/one characters', () => {
    expect(sanitizeBuckets('1x1')).toBe('10100000000000000000')
    expect(sanitizeBuckets(null)).toBe('00000000000000000000')
    expect(sanitizeBuckets('1'.repeat(40))).toBe('1'.repeat(20))
  })
  it('counts and judges completion at 18 of 20', () => {
    expect(countBuckets('11100000000000000000')).toBe(3)
    expect(isComplete(`${'1'.repeat(18)}00`)).toBe(true)
    expect(isComplete(`${'1'.repeat(17)}000`)).toBe(false)
  })
  it('computes drop-off per section', () => {
    const d = dropOff(['11110000000000000000', '11000000000000000000'])
    expect(d[0]).toBe(1)
    expect(d[2]).toBe(0.5)
    expect(d[19]).toBe(0)
    expect(dropOff([])).toEqual(new Array(20).fill(0))
  })
  it('keeps existing sections and only the lowest new ones up to the limit', () => {
    expect(limitNewBuckets('10000000000000000000', '1'.repeat(20), 2)).toBe('11100000000000000000')
    expect(limitNewBuckets('0'.repeat(20), '1'.repeat(20), 0)).toBe('0'.repeat(20))
  })
})

describe('media tickets', () => {
  const t0 = Date.UTC(2026, 9, 8, 10, 0, 0)
  it('round-trips for the same video', () => {
    const t = mediaTicket('ABC', 'user-1', 'p', t0)
    expect(verifyMediaTicket(t, 'abc', t0 + 1000)).toEqual({ userId: 'USER-1', scope: 'p' })
  })
  it('is stable inside its window', () =>
    expect(mediaTicket('abc', 'u', 'p', t0)).toBe(mediaTicket('abc', 'u', 'p', t0 + 60_000)))
  it('refuses another video, a tampered scope and an expired ticket', () => {
    const t = mediaTicket('abc', 'u', 'p', t0)
    expect(verifyMediaTicket(t, 'other', t0)).toBeNull()
    expect(verifyMediaTicket(t.replace('.P.', '.D.').replace('.p.', '.d.'), 'abc', t0)).toBeNull()
    expect(verifyMediaTicket(t, 'abc', t0 + 7 * 3_600_000)).toBeNull()
    expect(verifyMediaTicket('garbage', 'abc', t0)).toBeNull()
  })
  it('binds an opaque session tag into the signature and the token', () => {
    const sid = 'AbCdEf_123-xyzSESSION'
    const tag = sidTag(sid)
    expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const t = mediaTicket('abc', 'u', 'p', t0, tag)
    expect(t).not.toContain(sid)
    expect(t.split('.')).toHaveLength(5)
    expect(verifyMediaTicket(t, 'abc', t0)).toEqual({ userId: 'U', scope: 'p', tag })
    // swapping the tag (or dropping it) breaks the signature
    expect(verifyMediaTicket(t.replace(tag, sidTag('Another_session_id')), 'abc', t0)).toBeNull()
    const parts = t.split('.')
    expect(
      verifyMediaTicket([parts[0], parts[1], parts[2], parts[4]].join('.'), 'abc', t0)
    ).toBeNull()
    // a raw sid in the tag slot is refused outright (not 22 base64url chars)
    expect(mediaTicket('abc', 'u', 'p', t0, sid).split('.')).toHaveLength(4)
  })
})

const src = 100_000
const editsJson = (o: Record<string, unknown>) =>
  JSON.stringify({ v: 1, segments: [{ start_ms: 0, end_ms: src, speed: 1 }], ...o })
const blur = { id: 'b1', start_ms: 1000, end_ms: 3000, rect: { x: 0, y: 0, w: 0.2, h: 0.2 } }

describe('viewerMayPlaySource', () => {
  it('allows untouched edits', () => expect(viewerMayPlaySource(editsJson({}), src)).toBe(true))
  it('allows no stored edits at all', () => expect(viewerMayPlaySource(null, src)).toBe(true))
  it('refuses a blur', () =>
    expect(viewerMayPlaySource(editsJson({ blurs: [blur] }), src)).toBe(false))
  it('refuses a box annotation (it can mask content); a callout is fine', () => {
    const ann = (type: string) => ({
      id: 'a1',
      type,
      start_ms: 1000,
      end_ms: 3000,
      rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
      text: 'x'
    })
    expect(viewerMayPlaySource(editsJson({ annotations: [ann('box')] }), src)).toBe(false)
    expect(viewerMayPlaySource(editsJson({ annotations: [ann('callout')] }), src)).toBe(true)
  })
  it('refuses a cut', () =>
    expect(
      viewerMayPlaySource(
        editsJson({
          segments: [
            { start_ms: 0, end_ms: 40_000, speed: 1 },
            { start_ms: 50_000, end_ms: src, speed: 1 }
          ]
        }),
        src
      )
    ).toBe(false))
  it('refuses a trimmed start and a trimmed end', () => {
    expect(
      viewerMayPlaySource(editsJson({ segments: [{ start_ms: 2000, end_ms: src, speed: 1 }] }), src)
    ).toBe(false)
    expect(
      viewerMayPlaySource(editsJson({ segments: [{ start_ms: 0, end_ms: 90_000, speed: 1 }] }), src)
    ).toBe(false)
  })
  it('allows a speed change with no gap', () =>
    expect(
      viewerMayPlaySource(
        editsJson({
          segments: [
            { start_ms: 0, end_ms: 40_000, speed: 1 },
            { start_ms: 40_000, end_ms: src, speed: 2 }
          ]
        }),
        src
      )
    ).toBe(true))
  it('refuses unreadable edits or an unknown length', () => {
    expect(viewerMayPlaySource('{not json', src)).toBe(false)
    expect(viewerMayPlaySource(editsJson({}), null)).toBe(false)
  })
})

describe('pickStreamFile', () => {
  const v = {
    source_file: 'S',
    rendered_file: 'R',
    rendered_hash: 'h',
    edits_hash: 'h',
    edits: editsJson({ blurs: [blur] }),
    source_duration_ms: src
  }
  it('serves the render when it matches the edits', () =>
    expect(pickStreamFile(v, { forceSource: false, author: false })).toEqual({
      fileId: 'R',
      kind: 'rendered'
    }))
  it('author: serves the source when the render is stale or when asked', () => {
    expect(
      pickStreamFile({ ...v, rendered_hash: 'old' }, { forceSource: false, author: true })
    ).toEqual({ fileId: 'S', kind: 'source' })
    expect(pickStreamFile(v, { forceSource: true, author: true })).toEqual({
      fileId: 'S',
      kind: 'source'
    })
  })
  it('viewer: ignores forceSource', () =>
    expect(pickStreamFile(v, { forceSource: true, author: false })).toEqual({
      fileId: 'R',
      kind: 'rendered'
    }))
  it('viewer: no current render and a blur → nothing (still being prepared)', () =>
    expect(
      pickStreamFile({ ...v, rendered_hash: 'old' }, { forceSource: true, author: false })
    ).toBeNull())
  it('viewer: no current render but nothing hidden → the source', () =>
    expect(
      pickStreamFile(
        { ...v, rendered_file: null, edits: editsJson({}) },
        { forceSource: false, author: false }
      )
    ).toEqual({ fileId: 'S', kind: 'source' }))
})

const USER = { id: 'U1', role: 'R1' } as unknown as User
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const video = (o: Record<string, unknown> = {}) =>
  ({
    id: 'V1',
    title: 't',
    status: 'published',
    visibility: null,
    published_version_id: 'P1',
    draft_version_id: 'D1',
    duration_ms: 100_000,
    required_since: null,
    ...o
  }) as unknown as VideoRow

describe('recordProgress', () => {
  beforeEach(() => {
    fake.row = undefined
    fake.rowAfterInsertError = undefined
    fake.insertError = null
    fake.inserts = []
    fake.updates = []
    fake.updateCounts = []
    fake.rowAfterLostUpdate = undefined
  })

  it('a first beat claiming every section gets one', async () => {
    const r = await recordProgress(
      USER,
      video(),
      { buckets: '1'.repeat(20), watched_ms_delta: 60_000 },
      NOW
    )
    expect(r.completed).toBe(false)
    expect(fake.inserts[0].buckets).toBe(`1${'0'.repeat(19)}`)
    expect(fake.inserts[0].watched_ms).toBe(5000)
  })

  it('20 rapid beats 1 ms apart on a fresh row reach at most 1 section', async () => {
    for (let i = 0; i < 20; i++) {
      await recordProgress(
        USER,
        video(),
        { buckets: '1'.repeat(20), watched_ms_delta: 60_000 },
        NOW + i
      )
      // the first beat inserts; the fake row is what the insert stored
      if (i === 0) fake.row = { id: 1, ...fake.inserts[0] }
    }
    expect(countBuckets(String(fake.row?.buckets))).toBe(1)
    expect(Number(fake.row?.watched_ms)).toBeLessThanOrEqual(5000 + 19 * 4)
  })

  it('a row whose watching began 10 s ago on a 100 s video holds at most 9 sections, however many beats', async () => {
    fake.row = {
      id: 1,
      buckets: '0'.repeat(20),
      watched_ms: 0,
      first_viewed: new Date(NOW - 10_000),
      last_viewed: new Date(NOW - 1)
    }
    for (let i = 0; i < 25; i++) {
      await recordProgress(
        USER,
        video(),
        { buckets: '1'.repeat(20), watched_ms_delta: 60_000 },
        NOW
      )
    }
    expect(fake.row.buckets).toBe(`${'1'.repeat(9)}${'0'.repeat(11)}`)
    expect(fake.row.watched_ms).toBe(45_000)
  })

  it('a beat that loses the conditional update re-reads and retries once', async () => {
    fake.row = {
      id: 1,
      buckets: '10000000000000000000',
      watched_ms: 0,
      first_viewed: new Date(NOW - 60_000),
      last_viewed: new Date(NOW - 2000)
    }
    fake.updateCounts = [0, 1]
    fake.rowAfterLostUpdate = {
      ...fake.row,
      buckets: '11000000000000000000',
      last_viewed: new Date(NOW - 500)
    }
    await recordProgress(USER, video(), { buckets: '00100000000000000000' }, NOW)
    expect(fake.updates).toHaveLength(1)
    // merged onto what the parallel beat had written
    expect(fake.updates[0].buckets).toBe('11100000000000000000')
  })

  it('a beat that loses twice is dropped silently', async () => {
    fake.row = {
      id: 1,
      buckets: '10000000000000000000',
      watched_ms: 0,
      first_viewed: new Date(NOW - 60_000),
      last_viewed: new Date(NOW - 2000)
    }
    fake.updateCounts = [0, 0]
    const r = await recordProgress(USER, video(), { buckets: '1'.repeat(20) }, NOW)
    expect(r.completed).toBe(false)
    expect(fake.updates).toHaveLength(0)
  })

  it('merges with sections seen before', async () => {
    fake.row = {
      id: 1,
      buckets: '11000000000000000000',
      watched_ms: 1000,
      first_viewed: new Date(NOW - 60_000),
      last_viewed: new Date(NOW - 10_000)
    }
    await recordProgress(USER, video(), { buckets: '00110000000000000000' }, NOW)
    expect(fake.updates[0].buckets).toBe('11110000000000000000')
  })

  it('completes on the 18th section', async () => {
    fake.row = {
      id: 1,
      buckets: `${'1'.repeat(17)}000`,
      watched_ms: 0,
      first_viewed: new Date(NOW - 120_000),
      last_viewed: new Date(NOW - 10_000),
      completed_at: null
    }
    const r = await recordProgress(USER, video(), { buckets: '1'.repeat(20) }, NOW)
    expect(r.completed).toBe(true)
    expect(fake.updates[0].completed_at).toEqual(new Date(NOW))
  })

  it('clamps the position to the video length (31 min when unknown)', async () => {
    await recordProgress(USER, video(), { position_ms: 1e12 }, NOW)
    expect(fake.inserts[0].position_ms).toBe(100_000)
    fake.inserts = []
    await recordProgress(USER, video({ duration_ms: null }), { position_ms: 1e12 }, NOW)
    expect(fake.inserts[0].position_ms).toBe(31 * 60_000)
    fake.inserts = []
    await recordProgress(USER, video(), { position_ms: -5 }, NOW)
    expect(fake.inserts[0].position_ms).toBe(0)
  })

  it('keeps a version id only when it belongs to the video', async () => {
    await recordProgress(USER, video(), { version_id: 'someone-elses-version' }, NOW)
    expect(fake.inserts[0].version_id).toBeNull()
    fake.inserts = []
    await recordProgress(USER, video(), { version_id: 'p1' }, NOW)
    expect(fake.inserts[0].version_id).toBe('p1')
  })

  it('a duplicate first beat takes the update path instead of being lost', async () => {
    fake.insertError = Object.assign(new Error('dup'), { errors: [{ number: 2627 }] })
    fake.rowAfterInsertError = {
      id: 7,
      buckets: '10000000000000000000',
      watched_ms: 0,
      first_viewed: new Date(NOW - 5000),
      last_viewed: new Date(NOW - 5000)
    }
    await recordProgress(USER, video(), { buckets: '01000000000000000000' }, NOW)
    expect(fake.updates).toHaveLength(1)
    expect(fake.updates[0].buckets).toBe('11000000000000000000')
  })

  it('rethrows any other insert error', async () => {
    fake.insertError = Object.assign(new Error('boom'), { number: 547 })
    await expect(recordProgress(USER, video(), {}, NOW)).rejects.toThrow('boom')
  })

  it('a re-arm restarts the section map and clears the old completion', async () => {
    fake.row = {
      id: 1,
      buckets: '1'.repeat(20),
      watched_ms: 0,
      last_viewed: new Date(NOW - 3 * 86_400_000),
      completed_at: new Date(NOW - 3 * 86_400_000)
    }
    const r = await recordProgress(
      USER,
      video({ required_since: new Date(NOW - 86_400_000) }),
      { buckets: '10000000000000000000' },
      NOW
    )
    expect(r.completed).toBe(false)
    expect(fake.updates[0].buckets).toBe('10000000000000000000')
    expect(fake.updates[0].completed_at).toBeNull()
    // the watch period restarts with the fresh section map
    expect(fake.updates[0].first_viewed).toEqual(new Date(NOW))
    expect(fake.updates[0].watched_ms).toBe(0)
  })

  it('a beat that raced the re-arm still loses its pre-requirement completion', async () => {
    // last beat AFTER required_since, but the completion is from BEFORE it
    fake.row = {
      id: 1,
      buckets: '1'.repeat(20),
      watched_ms: 0,
      first_viewed: new Date(NOW - 3 * 86_400_000),
      last_viewed: new Date(NOW - 86_400_000 + 5),
      completed_at: new Date(NOW - 86_400_000 - 5)
    }
    const r = await recordProgress(
      USER,
      video({ required_since: new Date(NOW - 86_400_000) }),
      { buckets: '' },
      NOW
    )
    expect(r.completed).toBe(false)
    expect(fake.updates[0].buckets).toBe('0'.repeat(20))
    expect(fake.updates[0].completed_at).toBeNull()
    expect(fake.updates[0].first_viewed).toEqual(new Date(NOW))
  })

  it('sections seen before a re-arm do not count, even without a completion', async () => {
    fake.row = {
      id: 1,
      buckets: `${'1'.repeat(17)}000`,
      watched_ms: 0,
      last_viewed: new Date(NOW - 3 * 86_400_000),
      completed_at: null
    }
    const r = await recordProgress(
      USER,
      video({ required_since: new Date(NOW - 86_400_000) }),
      { buckets: `${'0'.repeat(17)}100` },
      NOW
    )
    expect(r.completed).toBe(false)
    expect(fake.updates[0].buckets).toBe(`${'0'.repeat(17)}100`)
  })

  it('keeps a completion made after the requirement', async () => {
    const done = new Date(NOW - 3600_000)
    fake.row = {
      id: 1,
      buckets: '1'.repeat(20),
      watched_ms: 0,
      first_viewed: new Date(NOW - 7200_000),
      last_viewed: done,
      completed_at: done
    }
    await recordProgress(
      USER,
      video({ required_since: new Date(NOW - 86_400_000) }),
      { buckets: '' },
      NOW
    )
    expect(fake.updates[0].buckets).toBe('1'.repeat(20))
    expect(fake.updates[0].completed_at).toBe(done)
  })
})

describe('requiredForUser and videoAnalytics', () => {
  it('lists required videos not completed since they became required', async () => {
    fake.selectRows = [
      { id: 'a', required_since: null, completed_at: null },
      { id: 'b', required_since: null, completed_at: new Date(NOW) },
      { id: 'c', required_since: new Date(NOW), completed_at: new Date(NOW - 1000) },
      { id: 'd', required_since: new Date(NOW - 1000), completed_at: new Date(NOW) }
    ]
    expect(await requiredForUser(USER)).toEqual(['A', 'C'])
    expect(await requiredForUser({ id: 'U1', role: null } as unknown as User)).toEqual([])
  })

  it('reports people, completion rate, drop-off and hours', async () => {
    fake.selectRows = [
      { buckets: '1'.repeat(20), completed_at: new Date(NOW), watched_ms: 3_600_000 },
      { buckets: `11${'0'.repeat(18)}`, completed_at: null, watched_ms: 0 }
    ]
    const a = await videoAnalytics(video())
    expect(a.views).toBe(2)
    expect(a.unique_viewers).toBe(2)
    expect(a.completion_rate).toBe(0.5)
    expect(a.drop_off[0]).toBe(1)
    expect(a.drop_off[5]).toBe(0.5)
    expect(a.watched_hours).toBe(1)
  })
})
