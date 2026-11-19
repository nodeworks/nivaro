import { describe, expect, it } from 'vitest'
import {
  axisTicks,
  browserOf,
  effectLinks,
  effectSentence,
  fmtMs,
  leafExists,
  leafKey,
  nestEffects,
  normalizeRid,
  parseLeaf,
  pathTemplate,
  readableError,
  relatedRefPath,
  signedOffset,
  statusText,
  statusTone,
  trafficMapPath
} from './logic'
import type { Story, StoryEffect } from './types'

const RID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'

const effect = (over: Partial<StoryEffect>): StoryEffect => ({
  key: 'activity:1',
  parent: null,
  kind: 'write',
  at: null,
  offset_ms: null,
  who: null,
  record: null,
  summary: '',
  failed: false,
  reason: null,
  facts: {},
  ...over
})

describe('ids and words', () => {
  it('normalizes request ids', () => {
    expect(normalizeRid(` ${RID.toUpperCase()} `)).toBe(RID)
    expect(normalizeRid('1b4e28ba2fa111d2883f0016d3cca427')).toBe(RID)
    expect(normalizeRid('nope')).toBeNull()
  })
  it('formats durations', () => {
    expect(fmtMs(null)).toBe('—')
    expect(fmtMs(0.4)).toBe('<1 ms')
    expect(fmtMs(29)).toBe('29 ms')
    expect(fmtMs(1140)).toBe('1.14 s')
    expect(fmtMs(12_400)).toBe('12.4 s')
  })
  it('says statuses', () => {
    expect([statusTone(200), statusTone(304), statusTone(409), statusTone(502)]).toEqual([
      'ok',
      'info',
      'warn',
      'bad'
    ])
    expect(statusText(409)).toBe('Conflict')
    expect(statusText(418)).toBe('Refused')
  })
  it('templates a raw path and keeps the ids it hid', () => {
    expect(pathTemplate(`/api/session-recordings/${RID}/events?x=1`)).toEqual({
      template: '/api/session-recordings/:id/events',
      ids: [RID]
    })
    expect(pathTemplate('/api/items/workflows/85607').template).toBe('/api/items/workflows/:id')
  })
  it('names a browser', () => {
    expect(
      browserOf(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      )
    ).toBe('Chrome 131 on macOS')
    expect(browserOf('curl/8.4.0')).toBe('curl 8.4.0')
    expect(browserOf(null)).toBeNull()
  })
})

describe('leaves', () => {
  it('round-trips leaf keys', () => {
    for (const k of ['request', 'caller', 'error', 'phase:3', 'sql:0', 'effect:activity:12'])
      expect(leafKey(parseLeaf(k) as never)).toBe(k)
    expect(parseLeaf('phase:x')).toBeNull()
    expect(parseLeaf('effect:bad key')).toBeNull()
    expect(parseLeaf('')).toBeNull()
  })
  it('knows a leaf that is not part of the story', () => {
    const story = {
      status: 200,
      emits: [],
      caller: null,
      trace: { phases: [{ seq: 2 }], statements: [] },
      effects: [effect({ key: 'activity:9' })]
    } as unknown as Story
    expect(leafExists(story, { type: 'phase', seq: 2 })).toBe(true)
    expect(leafExists(story, { type: 'phase', seq: 3 })).toBe(false)
    expect(leafExists(story, { type: 'error' })).toBe(false)
    expect(leafExists(story, { type: 'effect', key: 'activity:9' })).toBe(true)
  })
})

describe('effects', () => {
  it('nests attempts under their push and keeps orphans at the top', () => {
    const nodes = nestEffects([
      effect({ key: 'submission:1', kind: 'push', parent: 'request:x' }),
      effect({ key: 'activity:2' }),
      effect({ key: 'attempt:3', kind: 'attempt', parent: 'submission:1' })
    ])
    expect(nodes.map((n) => [n.effect.key, n.depth])).toEqual([
      ['submission:1', 0],
      ['attempt:3', 1],
      ['activity:2', 0]
    ])
  })
  it('reads an effect with labels and opens its leaf pages', () => {
    const w = effect({
      key: 'activity:7',
      record: { collection: 'workflows', item: '85607' },
      facts: { id: 7, action: 'update' }
    })
    expect(effectSentence(w, { records: { 'workflows:85607': 'CR26-1' } })).toBe(
      'Updated Workflow CR26-1'
    )
    expect(effectLinks(w).map((l) => l.to)).toEqual(['/collections/workflows/85607', '/activity/7'])
    const n = effect({
      key: 'notification:4',
      kind: 'notify',
      facts: { id: 4, recipient: 'Sam', recipient_id: 'u-2' }
    })
    expect(effectLinks(n).map((l) => l.to)).toEqual([
      '/delivery/analytics?window=30d&leaf=n:4',
      '/users/u-2'
    ])
    const p = effect({
      key: 'submission:5',
      kind: 'push',
      record: { collection: 'workflows', item: '1' },
      facts: { submission_id: 5, api_id: 3 }
    })
    expect(effectLinks(p).map((l) => l.to)).toEqual([
      '/collections/workflows/1',
      '/integration-health?tab=erp&collection=workflows&item=1&submission=5',
      '/external-apis/3'
    ])
  })
  it('opens related refs', () => {
    expect(relatedRefPath({ kind: 'issue', id: '12' })).toBe('/issues/12')
    expect(relatedRefPath({ kind: 'caller', id: 'uABC' })).toBe('/users/abc')
    expect(relatedRefPath({ kind: 'caller', id: 'k4' })).toBe('/api-keys?key=4')
    expect(relatedRefPath({ kind: 'record', id: 'workflows:9' })).toBe('/collections/workflows/9')
    expect(trafficMapPath(RID, { kind: 'statement', id: 'abc' })).toBe(
      `/traffic-map?inspect=${encodeURIComponent(`request:${RID}/statement:abc`)}`
    )
  })
})

describe('words for errors and offsets', () => {
  it('reads a JSON error body', () => {
    expect(readableError('{"error":"Not found","hint":"It may have been deleted."}')).toBe(
      'Not found — It may have been deleted.'
    )
    expect(readableError('{"error":"Locked","code":"EDIT_LOCKED","hint":"x')).toBe('Locked')
    expect(readableError('plain text')).toBe('plain text')
    expect(readableError('  ')).toBeNull()
  })
  it('signs offsets', () => {
    expect(signedOffset(1500, 1000)).toBe('+500 ms')
    expect(signedOffset(0, 12_000)).toBe('−12 s')
    expect(signedOffset(181_000, 1000)).toBe('+3 min')
  })
  it('keeps the status out of a sentence that has its own pill', () => {
    const f = effect({
      key: 'flow_run:x',
      kind: 'flow',
      summary: 'Flow "Notify" · success',
      facts: { status: 'success' }
    })
    expect(effectSentence(f)).toBe('Flow "Notify"')
  })
})

describe('axis', () => {
  it('ticks at round steps', () => {
    expect(axisTicks(1000)).toEqual([0, 200, 400, 600, 800, 1000])
    expect(axisTicks(29)).toEqual([0, 10, 20])
    expect(axisTicks(0)).toEqual([0])
  })
})
