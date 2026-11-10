import { describe, expect, it } from 'vitest'
import {
  CARRIED_SEQ,
  carriedOpening,
  chainMetaOf,
  chainReadOrder,
  chainSummary,
  isContinuationPart,
  type PartRow,
  rollsOver,
  stripChainKeys
} from '../../../services/session-recording-chain.js'

const H = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const P3 = '33333333-3333-4333-8333-333333333333'

describe('chainMetaOf', () => {
  it('reads the server-written keys and ignores junk', () => {
    expect(chainMetaOf(JSON.stringify({ chain: H, continues: P2, part: 3 }))).toEqual({
      chain: H,
      continues: P2,
      part: 3
    })
    expect(chainMetaOf(JSON.stringify({ parts: 2, user_agent: 'x' }))).toEqual({ parts: 2 })
    expect(chainMetaOf(JSON.stringify({ chain: 'not-a-uuid', part: 1, parts: 1 }))).toEqual({})
    expect(chainMetaOf('not json')).toEqual({})
    expect(chainMetaOf(null)).toEqual({})
  })

  it('tells a later part from a first part', () => {
    expect(isContinuationPart(JSON.stringify({ chain: H, part: 2 }))).toBe(true)
    expect(isContinuationPart(JSON.stringify({ parts: 2 }))).toBe(false)
    expect(isContinuationPart(null)).toBe(false)
  })
})

describe('stripChainKeys', () => {
  it('keeps the client environment and drops the chain', () => {
    const raw = JSON.stringify({ user_agent: 'UA', chain: H, continues: P2, part: 2, parts: 3 })
    expect(JSON.parse(stripChainKeys(raw) as string)).toEqual({ user_agent: 'UA' })
  })

  it('answers null when nothing else was there, and leaves plain meta alone', () => {
    expect(stripChainKeys(JSON.stringify({ chain: H, part: 2 }))).toBeNull()
    const plain = JSON.stringify({ viewport: '1280x800' })
    expect(stripChainKeys(plain)).toBe(plain)
    expect(stripChainKeys(null)).toBeNull()
  })
})

describe('rollsOver', () => {
  it('rolls full and auto recordings over, never a one-shot clip', () => {
    expect(rollsOver('efp')).toBe(true)
    expect(rollsOver(null)).toBe(true)
    expect(rollsOver('auto:rage-click')).toBe(true)
    expect(rollsOver('error-clip')).toBe(false)
    expect(rollsOver('support-clip')).toBe(false)
    expect(rollsOver('clip')).toBe(false)
  })
})

describe('carriedOpening', () => {
  const ev = (type: number, timestamp: number) => ({ type, timestamp })

  it('starts at the Meta before the last full snapshot and keeps everything after it', () => {
    const events = [
      ev(4, 1),
      ev(2, 2),
      ev(3, 3),
      ev(4, 10),
      ev(2, 11),
      ev(3, 12),
      ev(3, 13),
      ev(5, 14)
    ]
    expect(carriedOpening(events)).toEqual([ev(4, 10), ev(2, 11), ev(3, 12), ev(3, 13), ev(5, 14)])
  })

  it('works without a Meta and answers nothing without a snapshot', () => {
    expect(carriedOpening([ev(2, 1), ev(3, 2)])).toEqual([ev(2, 1), ev(3, 2)])
    expect(carriedOpening([ev(3, 1), ev(3, 2)])).toEqual([])
  })
})

describe('chainReadOrder', () => {
  const c = (recording: string, seq: number) => ({ recording, seq })
  const chunks = [
    c(P2, 4),
    c(H, 1),
    c(P2, CARRIED_SEQ),
    c(H, 0),
    c(P3, CARRIED_SEQ),
    c(P3, 6),
    c(P2, 5)
  ]

  it('reads parts in order as one stream, without their copied openings', () => {
    expect(chainReadOrder([H, P2, P3], chunks)).toEqual([
      c(H, 0),
      c(H, 1),
      c(P2, 4),
      c(P2, 5),
      c(P3, 6)
    ])
  })

  it('keeps the opening of the first part read when the parts before it are gone', () => {
    expect(chainReadOrder([P2, P3], chunks)).toEqual([
      c(P2, CARRIED_SEQ),
      c(P2, 4),
      c(P2, 5),
      c(P3, 6)
    ])
  })

  it('live follow reads only newer recorder seqs, across parts', () => {
    expect(chainReadOrder([H, P2, P3], chunks, { afterSeq: 4 })).toEqual([c(P2, 5), c(P3, 6)])
  })
})

describe('chainSummary', () => {
  const part = (over: Partial<PartRow>): PartRow => ({
    id: H,
    user: 'U',
    app: 'efp',
    meta: null,
    started_at: null,
    ended_at: null,
    last_event_at: null,
    event_count: 0,
    byte_size: 0,
    truncated: false,
    ...over
  })

  it('spans the chain: first start, newest end and activity, summed figures', () => {
    const s = chainSummary([
      part({
        started_at: '2026-11-09T10:00:00Z',
        ended_at: '2026-11-09T11:00:00Z',
        last_event_at: '2026-11-09T11:00:00Z',
        event_count: 10,
        byte_size: 15_000_000,
        active_ms: 1000
      }),
      part({
        id: P2,
        started_at: '2026-11-09T11:00:00Z',
        ended_at: null,
        last_event_at: '2026-11-09T11:30:00Z',
        event_count: 5,
        byte_size: 2_000_000,
        active_ms: 500
      })
    ])
    expect(s.parts).toBe(2)
    expect(s.started_at).toBe('2026-11-09T10:00:00Z')
    expect(s.ended_at).toBeNull()
    expect(new Date(s.last_event_at as Date).toISOString()).toBe('2026-11-09T11:30:00.000Z')
    expect(s.event_count).toBe(15)
    expect(s.byte_size).toBe(17_000_000)
    expect(s.active_ms).toBe(1500)
  })
})
