import { describe, expect, it } from 'vitest'
import { MASK } from '../secret-mask.js'
import {
  aiRequestParts,
  aiResponseText,
  bodyWasMasked,
  COVER_TOLERANCE_MS,
  isDigitsId,
  isUuid,
  maskedBody,
  NEAREST_MAX_MS,
  parseRunSource,
  pickCoveringRun,
  shapeAttempts
} from './background-logic.js'

describe('id shapes', () => {
  it('accepts positive integer ids only', () => {
    expect(isDigitsId('42')).toBe(true)
    expect(isDigitsId('0')).toBe(false)
    expect(isDigitsId('012')).toBe(false)
    expect(isDigitsId('1;drop')).toBe(false)
    expect(isDigitsId('99999999999999999999')).toBe(false)
  })
  it('accepts uuids in either case', () => {
    expect(isUuid('54B4CB84-EBDA-420F-8185-EACD4FCD64DB')).toBe(true)
    expect(isUuid('54b4cb84-ebda-420f-8185-eacd4fcd64db')).toBe(true)
    expect(isUuid('54b4cb84')).toBe(false)
  })
})

describe('parseRunSource', () => {
  it('reads cron jobs, extension cron jobs included', () => {
    expect(parseRunSource('cron:staged-imports')).toEqual({ kind: 'cron', job: 'staged-imports' })
    expect(parseRunSource('cron:ext:efp-ops:invoice-approval-notifications')).toEqual({
      kind: 'cron',
      job: 'ext:efp-ops:invoice-approval-notifications'
    })
  })
  it('reads flow sources by flow id', () => {
    expect(parseRunSource('flow:AD021B2E-E6F0-4864-BDDA-960A71E56899')).toEqual({
      kind: 'flow',
      flowId: 'AD021B2E-E6F0-4864-BDDA-960A71E56899'
    })
  })
  it('refuses everything else', () => {
    expect(parseRunSource('import:worker')).toBeNull()
    expect(parseRunSource('flow:not-a-uuid')).toBeNull()
    expect(parseRunSource("cron:x' or 1=1")).toBeNull()
    expect(parseRunSource(undefined)).toBeNull()
    expect(parseRunSource('cron:')).toBeNull()
  })
})

describe('pickCoveringRun (job-for selection)', () => {
  const t0 = Date.parse('2026-10-01T10:00:00Z')
  const runs = [
    { id: 1, started: t0, finished: t0 + 13 },
    { id: 2, started: t0 + 10_000, finished: t0 + 10_013 },
    { id: 3, started: t0 + 20_000, finished: null }
  ]

  it('picks the run whose window contains the moment', () => {
    expect(pickCoveringRun(runs, t0 + 5)).toMatchObject({ id: '1', covering: true })
    expect(pickCoveringRun(runs, t0 + 10_010)).toMatchObject({ id: '2', covering: true })
  })

  it('allows a small clock tolerance past the finish', () => {
    expect(pickCoveringRun(runs, t0 + 13 + COVER_TOLERANCE_MS - 1)).toMatchObject({
      id: '1',
      covering: true
    })
  })

  it('an open run covers everything after its start', () => {
    expect(pickCoveringRun(runs, t0 + 600_000)).toMatchObject({ id: '3', covering: true })
  })

  it('falls back to the closest earlier run, marked not covering', () => {
    expect(pickCoveringRun(runs.slice(0, 2), t0 + 15_000)).toMatchObject({
      id: '2',
      covering: false
    })
  })

  it('never picks a run that started after the moment, nor one too far before', () => {
    expect(pickCoveringRun(runs, t0 - 60_000)).toBeNull()
    expect(pickCoveringRun(runs.slice(0, 1), t0 + NEAREST_MAX_MS + 60_000)).toBeNull()
  })

  it('prefers the newest of overlapping runs', () => {
    const overlap = [
      { id: 'a', started: t0, finished: t0 + 60_000 },
      { id: 'b', started: t0 + 30_000, finished: t0 + 90_000 }
    ]
    expect(pickCoveringRun(overlap, t0 + 45_000)?.id).toBe('b')
  })
})

describe('maskedBody', () => {
  it('masks credential-looking keys at any depth, from text or a value', () => {
    const out = maskedBody({ user: 'a', token: 'abc', nested: [{ client_secret: 'x', n: 1 }] })
    expect(out).toEqual({ user: 'a', token: MASK, nested: [{ client_secret: MASK, n: 1 }] })
    expect(bodyWasMasked(out)).toBe(true)
    expect(maskedBody('{"password":"p","ok":true}')).toEqual({ password: MASK, ok: true })
  })
  it('leaves non-JSON text and clean bodies alone', () => {
    expect(maskedBody('<xml>token</xml>')).toBe('<xml>token</xml>')
    expect(maskedBody({ amount: 5 })).toEqual({ amount: 5 })
    expect(bodyWasMasked({ amount: 5 })).toBe(false)
    expect(maskedBody(null)).toBeNull()
  })
})

describe('shapeAttempts', () => {
  it('orders newest first, masks bodies, drops bad rows and keeps unrecorded', () => {
    const shaped = shapeAttempts({
      attempts: [
        {
          attempt: 1,
          status: 'failed',
          http_status: 401,
          error: 'HTTP 401',
          source: 'call-log',
          at: '2026-10-01T10:00:00Z',
          payload: { api_key: 'k', po: 'PO1' },
          response: '{"error":"no"}'
        },
        { attempt: 3, status: 'accepted', source: 'current', at: '2026-10-01T10:05:00Z' },
        { attempt: 'x', status: 'junk' },
        { attempt: 3, status: 'duplicate' }
      ],
      total: 3,
      unrecorded: 1
    })
    expect(shaped.attempts.map((a) => a.attempt)).toEqual([3, 1])
    expect(shaped.attempts[0].status).toBe('accepted')
    expect(shaped.attempts[1]).toMatchObject({
      http_status: 401,
      source: 'call-log',
      payload: { api_key: MASK, po: 'PO1' },
      response: { error: 'no' },
      masked: true
    })
    expect(shaped.total).toBe(3)
    expect(shaped.unrecorded).toBe(1)
  })

  it('copes with an empty or malformed answer', () => {
    expect(shapeAttempts({})).toEqual({ attempts: [], total: 0, unrecorded: 0 })
    const s = shapeAttempts({ attempts: [{ attempt: 2, status: 'pending' }], unrecorded: -4 })
    expect(s.total).toBe(2)
    expect(s.unrecorded).toBe(0)
  })
})

describe('AI call bodies', () => {
  it('splits the stored prompt into system, tools and messages', () => {
    const parts = aiRequestParts({
      system: [{ type: 'text', text: 'Be brief' }],
      tools: ['lookup'],
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'lookup', input: {} }] }
      ]
    })
    expect(parts.system).toBe('Be brief')
    expect(parts.tools).toEqual(['lookup'])
    expect(parts.messages).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: '[tool call: lookup]' }
    ])
  })
  it('joins the answer text', () => {
    expect(aiResponseText([{ type: 'text', text: 'Done' }])).toBe('Done')
    expect(aiResponseText(null)).toBeNull()
  })
})
