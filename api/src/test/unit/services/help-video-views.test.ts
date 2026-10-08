import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../config.js', () => ({ config: { SESSION_SECRET: 'x'.repeat(40) } }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))

import {
  countBuckets,
  dropOff,
  isComplete,
  mergeBuckets,
  pickStreamFile,
  sanitizeBuckets
} from '../../../services/help-video-views.js'
import { mediaTicket, verifyMediaTicket } from '../../../services/help-videos.js'

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
})

describe('pickStreamFile', () => {
  const v = { source_file: 'S', rendered_file: 'R', rendered_hash: 'h', edits_hash: 'h' }
  it('serves the render when it matches the edits', () =>
    expect(pickStreamFile(v, { forceSource: false })).toEqual({ fileId: 'R', kind: 'rendered' }))
  it('serves the source when the render is stale', () =>
    expect(pickStreamFile({ ...v, rendered_hash: 'old' }, { forceSource: false })).toEqual({
      fileId: 'S',
      kind: 'source'
    }))
  it('serves the source when asked', () =>
    expect(pickStreamFile(v, { forceSource: true })).toEqual({ fileId: 'S', kind: 'source' }))
})
