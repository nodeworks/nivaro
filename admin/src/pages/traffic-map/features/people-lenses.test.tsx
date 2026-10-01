import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventActions } from '../registry/eventActions'
import type { TrafficCatalog, TrafficEventWire } from '../types'
import { replayUrl } from './client-crash-replay'
import { keyBadge } from './credentials'
import { GLOW_MS, glowingEntities, screenText } from './follow-person'
import { peekTarget, prettyBody } from './payload-peek'
import './people-lenses'
import { roleLabel } from './roles'

const cat = {
  callers: {
    uMACHINE: { label: 'LinX', kind: 'machine' },
    uPERSON: { label: 'Beth', kind: 'person' }
  }
} as unknown as TrafficCatalog

describe('#1172 credential badges', () => {
  const v = { name: 'k', expires_at: null, limit: null, used: null, pct: null }
  it('expiry beats the rate, an expired key is an error', () => {
    expect(keyBadge({ ...v, expires_in_days: 3.4, pct: 95 })).toEqual({
      text: 'expires in 3 d',
      tone: 'warn'
    })
    expect(keyBadge({ ...v, expires_in_days: 0.4 })).toEqual({
      text: 'expires in 1 d',
      tone: 'error'
    })
    expect(keyBadge({ ...v, expires_in_days: -0.2 })).toEqual({
      text: 'key expired',
      tone: 'error'
    })
    expect(keyBadge({ ...v, expires_in_days: null, pct: 88 })).toEqual({
      text: 'limit 88%',
      tone: 'warn'
    })
    expect(keyBadge({ ...v, expires_in_days: null, pct: 104 })?.tone).toBe('error')
  })
})

describe('#1178 follow one person', () => {
  const step = (t: number, key: string) => ({
    t,
    key,
    route: 'GET',
    status: 200,
    ms: 1,
    page: '/a',
    app: null
  })
  it('glows each entity once at its newest touch and drops what is older than GLOW_MS', () => {
    const now = 100_000
    const g = glowingEntities(
      [
        step(now - GLOW_MS - 1, 'items/old'),
        step(now - 5000, 'items/a'),
        step(now - 1000, 'items/a')
      ],
      now
    )
    expect([...g.keys()]).toEqual(['items/a'])
    expect(g.get('items/a')).toBeCloseTo(1000 / GLOW_MS)
  })
  it('names a screen with its app', () => {
    expect(screenText('/my-work', 'admin')).toBe('/my-work · admin')
    expect(screenText(null, null)).toMatch(/Unknown screen/)
  })
})

describe('#1181 client crash replay', () => {
  const crash = { issue_id: 7, recording_id: 'abc', offset_ms: 4200.4, message: 'x' }
  it('links the replay seeked to the error and the issue', () => {
    expect(replayUrl(crash)).toBe('/session-replays?recording=abc&t=4200')
    expect(replayUrl({ ...crash, recording_id: null })).toBeNull()
    const ev = {
      t: 1,
      lane: 'other',
      entity: 'issues',
      kind: 'error',
      caller: 'uX',
      route: 'Client crash',
      extra: { client_crash: crash }
    } as TrafficEventWire
    const { container } = render(<EventActions ev={ev} />)
    expect(container.querySelector('[data-tm-crash-replay="abc"]')).not.toBeNull()
    expect(container.querySelector('[data-tm-crash-issue="7"]')?.getAttribute('href')).toBe(
      '/issues/7'
    )
  })
})

describe('#1182 role labels', () => {
  it('names the buckets', () => {
    expect(roleLabel('integration', {})).toBe('Integrations')
    expect(roleLabel('anonymous', {})).toBe('Anonymous')
    expect(roleLabel('abc', { ABC: 'Approver' })).toBe('Approver')
  })
})

describe('#1183 payload peek', () => {
  it('applies to keys and machine accounts, narrows an edge to its entity', () => {
    expect(peekTarget({ kind: 'caller', id: 'k12' }, cat)).toEqual({ caller: 'k12', entity: null })
    expect(peekTarget({ kind: 'caller', id: 'uMACHINE' }, cat)).toEqual({
      caller: 'uMACHINE',
      entity: null
    })
    expect(peekTarget({ kind: 'caller', id: 'uPERSON' }, cat)).toBeNull()
    expect(peekTarget({ kind: 'entity', id: 'items/workflows', caller: 'k1' }, cat)).toEqual({
      caller: 'k1',
      entity: 'workflows'
    })
    expect(peekTarget({ kind: 'entity', id: 'graphql/getThings', caller: 'k1' }, cat)).toEqual({
      caller: 'k1',
      entity: null
    })
  })
  it('pretty-prints JSON and leaves anything else alone', () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyBody('not json')).toBe('not json')
  })
})
