import { describe, expect, it } from 'vitest'
import {
  computeFirstOpen,
  type FirstOpenEntry,
  firstViewIn,
  parseFirstOpenParams
} from '../../../services/first-open.js'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)

const entry = (over: Partial<FirstOpenEntry>): FirstOpenEntry => ({
  id: 'e1',
  item: '7',
  stateKey: 'review',
  stateLabel: 'Review',
  at: T0,
  leftAt: T0 + 600 * MIN,
  actor: 'ACTOR',
  ...over
})

describe('firstViewIn', () => {
  it('takes the earliest watermark inside the stay', () => {
    expect(firstViewIn({ last: T0 + 90 * MIN, prev: T0 + 30 * MIN }, T0, T0 + 600 * MIN)).toBe(
      T0 + 30 * MIN
    )
  })
  it('ignores views before entry or after exit', () => {
    expect(firstViewIn({ last: T0 + 900 * MIN, prev: T0 - 5 * MIN }, T0, T0 + 600 * MIN)).toBeNull()
    expect(firstViewIn(undefined, T0, T0 + MIN)).toBeNull()
  })
})

describe('computeFirstOpen', () => {
  const names = new Map([['OWNER1', 'Ada']])

  it('waits until the earliest owner view and reports minutes', () => {
    const views = new Map([['7|OWNER1', { last: T0 + 45 * MIN, prev: null }]])
    const out = computeFirstOpen([entry({})], new Map([['e1', ['owner1']]]), views, names, T0 + 1e9)
    expect(out.by_state[0]).toMatchObject({
      key: 'review',
      entries: 1,
      opened: 1,
      median_minutes: 45
    })
    expect(out.by_owner[0]).toMatchObject({ key: 'OWNER1', label: 'Ada', median_minutes: 45 })
  })

  it('does not count the actor who moved the record in as an owner', () => {
    const views = new Map([['7|ACTOR', { last: T0 + MIN, prev: null }]])
    const out = computeFirstOpen(
      [entry({})],
      new Map([['e1', ['actor']]]),
      views,
      new Map(),
      T0 + 1e9
    )
    expect(out.no_owner).toBe(1)
    expect(out.by_state).toEqual([])
  })

  it('separates never-opened from still-waiting', () => {
    const owners = new Map([
      ['e1', ['owner1']],
      ['e2', ['owner1']]
    ])
    const out = computeFirstOpen(
      [entry({}), entry({ id: 'e2', item: '8', leftAt: null })],
      owners,
      new Map(),
      names,
      T0 + 1000 * MIN
    )
    expect(out.by_state[0]).toMatchObject({
      entries: 2,
      opened: 0,
      never_opened: 1,
      still_waiting: 1
    })
    expect(out.by_state[0].median_minutes).toBeNull()
  })

  it('scores each owner on their own open; the state uses the earliest', () => {
    const views = new Map([
      ['7|OWNER1', { last: T0 + 100 * MIN, prev: null }],
      ['7|OWNER2', { last: T0 + 20 * MIN, prev: null }]
    ])
    const out = computeFirstOpen(
      [entry({})],
      new Map([['e1', ['owner1', 'owner2']]]),
      views,
      new Map(),
      T0 + 1e9
    )
    expect(out.by_state[0].median_minutes).toBe(20)
    expect(out.by_owner.map((o) => o.median_minutes).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      20, 100
    ])
  })
})

describe('parseFirstOpenParams', () => {
  it('requires a collection and a sane range', () => {
    expect(parseFirstOpenParams({}).ok).toBe(false)
    expect(parseFirstOpenParams({ collection: 'x', from: '2020-01-01', to: '2026-01-01' }).ok).toBe(
      false
    )
    const r = parseFirstOpenParams({ collection: 'x', from: '2026-01-01', to: '2026-01-02' })
    expect(r.ok && r.to.getTime() - r.from.getTime()).toBe(2 * 86_400_000)
  })
})
