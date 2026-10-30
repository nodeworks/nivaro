import { describe, expect, it } from 'vitest'
import {
  type CbvLinkState,
  decodeListLink,
  encodeListLink,
  LIST_LINK_PARAM,
  listLinkUrl,
  pruneListLinkState,
  type QueueLinkState,
  sanitizeCbvLinkState,
  sanitizeQueueLinkState
} from './list-link'

const cbvState: CbvLinkState = {
  q: 'pump — café',
  f: [
    {
      id: 'f1',
      path: ['vendor', 'name'],
      pathLabels: ['Vendor', 'Name'],
      fieldType: 'string',
      op: '_contains',
      value: 'acme'
    }
  ],
  s: '-date_created',
  c: ['name', { key: 'amount', label: 'Total', width: 140, pin: 'left' }],
  qf: { zone: [3, 7] },
  cf: { status: { kind: 'in', value: ['open'] } },
  lc: [{ path: ['owner'], op: '_eq', value: '$CURRENT_USER', label: 'Mine' }],
  ex: [{ id: 'x', path: ['state'], op: '_neq', value: 'closed', label: 'closed', field: 'state' }],
  g: 'status',
  ps: 50,
  p: 3,
  a: true
}

describe('list link envelope', () => {
  it('round-trips the collection browser view exactly', () => {
    const raw = encodeListLink('cbv:projects', cbvState as Record<string, unknown>)
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sanitizeCbvLinkState(decodeListLink(raw, 'cbv:projects'))).toEqual(cbvState)
  })

  it('round-trips a queue view', () => {
    const q: QueueLinkState = {
      scope: 'mine',
      filters: { owners: ['u1', 'u2'], state: 'open' },
      sort: '-aging_hours',
      group_by: 'state',
      view: 'kanban',
      columns: ['state', 'extra.vendor'],
      pins: { label: 'left' },
      page: 2
    }
    const raw = encodeListLink('queue:12', q as Record<string, unknown>)
    expect(sanitizeQueueLinkState(decodeListLink(raw, 'queue:12'))).toEqual(q)
  })

  it('belongs to one list only', () => {
    const raw = encodeListLink('cbv:projects', { q: 'x' })
    expect(decodeListLink(raw, 'cbv:vendors')).toBeNull()
    expect(decodeListLink(raw, 'queue:projects')).toBeNull()
  })

  it('ignores garbage', () => {
    for (const raw of [null, '', '!!!', 'eyJ2Ijo5fQ', btoa('not json')])
      expect(decodeListLink(raw, 'cbv:projects')).toBeNull()
  })

  it('drops empty values so links stay short', () => {
    expect(pruneListLinkState({ q: '', f: [], qf: {}, s: null, g: undefined, p: 2 })).toEqual({
      p: 2
    })
  })

  it('sets lv and keeps every other parameter', () => {
    const url = new URL(
      listLinkUrl('https://x.test/collections/projects?search=old&tab=a#h', 'cbv:projects', {
        q: 'new'
      })
    )
    expect(url.searchParams.get('tab')).toBe('a')
    expect(url.searchParams.get('search')).toBe('old')
    expect(url.hash).toBe('#h')
    expect(decodeListLink(url.searchParams.get(LIST_LINK_PARAM), 'cbv:projects')).toEqual({
      q: 'new'
    })
  })
})

describe('shape guards (a link is untrusted text)', () => {
  it('drops malformed parts of a collection browser link', () => {
    const out = sanitizeCbvLinkState({
      q: 42,
      f: [{ path: 'nope' }, { path: ['name'], op: '_eq' }],
      s: 'name; DROP TABLE',
      c: [5, 'name', { nokey: true }],
      qf: { zone: [1, { x: 1 }, 'b'], empty: [] },
      cf: { a: { kind: 'text', value: 'x', path: ['a'] }, b: 'bad' },
      ps: 5000,
      p: -1,
      g: 'a b'
    })
    expect(out).toEqual({
      f: [
        {
          id: 'lv-0',
          path: ['name'],
          pathLabels: ['name'],
          fieldType: 'string',
          op: '_eq',
          value: ''
        }
      ],
      c: ['name'],
      qf: { zone: [1, 'b'] },
      cf: { a: { kind: 'text', value: 'x', path: ['a'] } },
      ps: 200
    })
  })

  it('drops malformed parts of a queue link', () => {
    expect(
      sanitizeQueueLinkState({
        scope: 'everyone',
        filters: { a: 'x', b: [1, 'y'], c: 3 },
        view: 'gantt',
        pins: { a: 'middle', b: 'right' },
        columns: 'state'
      })
    ).toEqual({ filters: { a: 'x', b: ['y'] }, pins: { b: 'right' } })
  })
})
