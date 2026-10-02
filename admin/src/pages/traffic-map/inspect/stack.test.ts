import { afterEach, describe, expect, it } from 'vitest'
import { inspectables } from '../registry/inspectables'
import { register } from '../registry/registry'
import { viewParams } from '../registry/viewParams'
import type { TrafficEventWire } from '../types'
import { refForEvent, refTitle, shortId } from './format'
import {
  back,
  closeInspect,
  decodeStack,
  encodeStack,
  forwardStep,
  getInspectSnapshot,
  goTo,
  MAX_URL_LEVELS,
  openInspect,
  resetInspectForTests,
  setAnchor,
  setWindow,
  subscribeInspect,
  togglePin
} from './stack'

const RID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const any = () => true

afterEach(() => {
  resetInspectForTests()
  inspectables.splice(0)
})

describe('investigation stack', () => {
  it('pushes, goes back and forward, and drops forward history on a new open', () => {
    openInspect({ kind: 'request', id: RID, at: 1000 }, { root: true })
    openInspect({ kind: 'trace', id: RID })
    openInspect({ kind: 'statement', id: 'abc' })
    let s = getInspectSnapshot()
    expect(s.levels.map((l) => l.kind)).toEqual(['request', 'trace', 'statement'])
    expect(s.index).toBe(2)
    expect(s.anchor).toBe(1000)

    back()
    s = getInspectSnapshot()
    expect(s.index).toBe(1)
    expect(s.forward.map((l) => l.kind)).toEqual(['statement'])

    forwardStep()
    s = getInspectSnapshot()
    expect(s.levels.map((l) => l.kind)).toEqual(['request', 'trace', 'statement'])
    expect(s.forward).toEqual([])

    back()
    back()
    expect(getInspectSnapshot().forward.map((l) => l.kind)).toEqual(['trace', 'statement'])
    back() // no-op at the root
    expect(getInspectSnapshot().index).toBe(0)

    openInspect({ kind: 'record', id: 'workflows:12' })
    s = getInspectSnapshot()
    expect(s.levels.map((l) => l.kind)).toEqual(['request', 'record'])
    expect(s.forward).toEqual([])
  })

  it('opening the current level again is a no-op; root clears the stack', () => {
    let calls = 0
    const off = subscribeInspect(() => {
      calls++
    })
    openInspect({ kind: 'request', id: RID }, { root: true })
    openInspect({ kind: 'request', id: RID, label: 'other label' })
    openInspect({ kind: 'request', id: RID }, { root: true })
    expect(getInspectSnapshot().levels).toHaveLength(1)
    expect(calls).toBe(1)
    openInspect({ kind: 'trace', id: RID })
    openInspect({ kind: 'entity', id: 'items/workflows', at: 5 }, { root: true })
    const s = getInspectSnapshot()
    expect(s.levels).toEqual([{ kind: 'entity', id: 'items/workflows', at: 5 }])
    expect(s.anchor).toBe(5)
    off()
  })

  it('goTo jumps to a crumb and keeps the rest as forward history', () => {
    openInspect({ kind: 'a', id: '1' }, { root: true })
    openInspect({ kind: 'b', id: '2' })
    openInspect({ kind: 'c', id: '3' })
    goTo(0)
    const s = getInspectSnapshot()
    expect(s.levels.map((l) => l.kind)).toEqual(['a'])
    expect(s.forward.map((l) => l.kind)).toEqual(['b', 'c'])
    goTo(5) // out of range: nothing
    expect(getInspectSnapshot().levels).toHaveLength(1)
  })

  it('pins the current level for a split view and unpins', () => {
    openInspect({ kind: 'a', id: '1' }, { root: true })
    togglePin()
    expect(getInspectSnapshot().pinned).toBe(0)
    openInspect({ kind: 'b', id: '2' })
    expect(getInspectSnapshot().pinned).toBe(0)
    expect(getInspectSnapshot().index).toBe(1)
    togglePin()
    expect(getInspectSnapshot().pinned).toBeNull()
    togglePin()
    expect(getInspectSnapshot().pinned).toBe(1)
    back() // the pinned level left the stack
    expect(getInspectSnapshot().pinned).toBeNull()
  })

  it('anchor, window and close', () => {
    openInspect({ kind: 'a', id: '1' }, { root: true })
    setAnchor(42)
    setWindow(60)
    expect(getInspectSnapshot().anchor).toBe(42)
    expect(getInspectSnapshot().windowSec).toBe(60)
    setWindow(1) // clamped
    expect(getInspectSnapshot().windowSec).toBe(10)
    closeInspect()
    const s = getInspectSnapshot()
    expect(s.levels).toEqual([])
    expect(s.anchor).toBeNull()
    expect(s.windowSec).toBe(10)
    expect(getInspectSnapshot().windowSec).toBe(10)
  })
})

describe('stack URL form', () => {
  it('round-trips, URI-encoding ids', () => {
    const levels = [
      { kind: 'request', id: RID, at: 1_700_000_000_123 },
      { kind: 'record', id: 'workflows:12' },
      { kind: 'page', id: '/collections/:c/:id@x' }
    ]
    const s = encodeStack(levels)
    expect(s).toBe(
      `request:${RID}@1700000000123/record:workflows%3A12/page:%2Fcollections%2F%3Ac%2F%3Aid%40x`
    )
    expect(decodeStack(s, any)).toEqual(levels)
  })

  it('drops malformed and unknown segments', () => {
    const known = (k: string) => k !== 'nope'
    expect(
      decodeStack(
        `request:${RID}/nope:1/:noKind/UPPER:1/record:/trace:${RID}@notanumber/bad%:x/entity:items%2Fworkflows`,
        known
      )
    ).toEqual([
      { kind: 'request', id: RID },
      { kind: 'entity', id: 'items/workflows' }
    ])
    expect(decodeStack('', any)).toEqual([])
    expect(decodeStack(null, any)).toEqual([])
  })

  it('keeps a slash inside an id that a hand-written link left single-encoded', () => {
    // URLSearchParams decodes `items%2Fworkflows` to `items/workflows` before we see it.
    expect(decodeStack(`entity:items/workflows/request:${RID}`, any)).toEqual([
      { kind: 'entity', id: 'items/workflows' },
      { kind: 'request', id: RID }
    ])
    expect(decodeStack('entity:items/workflows@1700000000123', any)).toEqual([
      { kind: 'entity', id: 'items/workflows', at: 1_700_000_000_123 }
    ])
    // Round trip of what the page itself writes still works.
    const enc = encodeStack([{ kind: 'entity', id: 'items/workflows' }]) as string
    expect(decodeStack(enc, any)).toEqual([{ kind: 'entity', id: 'items/workflows' }])
  })

  it('unknown kinds default to "no registered inspectable"', () => {
    register(inspectables, { id: 'request', label: 'Request', Panel: () => null })
    expect(decodeStack(`request:${RID}/trace:${RID}`)).toEqual([{ kind: 'request', id: RID }])
  })

  it(`caps at ${MAX_URL_LEVELS} levels both ways`, () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'kk', id: String(i) }))
    const enc = encodeStack(many) as string
    expect(enc.split('/')).toHaveLength(MAX_URL_LEVELS)
    expect(enc.startsWith('kk:4/')).toBe(true) // the newest levels are kept
    const long = many.map((r) => `${r.kind}:${r.id}`).join('/')
    expect(decodeStack(long, any)).toHaveLength(MAX_URL_LEVELS)
    expect(encodeStack([])).toBeNull()
  })

  it('registers the inspect view param, which drives the stack', () => {
    register(inspectables, { id: 'request', label: 'Request', Panel: () => null })
    const p = viewParams.find((v) => v.id === 'inspect')
    expect(p?.param).toBe('inspect')
    p?.set(`request:${RID}@99`)
    expect(getInspectSnapshot().levels).toEqual([{ kind: 'request', id: RID, at: 99 }])
    expect(getInspectSnapshot().anchor).toBe(99)
    expect(p?.get()).toBe(`request:${RID}@99`)
    p?.set(null)
    expect(getInspectSnapshot().levels).toEqual([])
    expect(p?.get()).toBeNull()
  })
})

describe('format helpers', () => {
  const base: TrafficEventWire = {
    t: 1000,
    lane: 'items',
    entity: 'workflows',
    kind: 'update',
    caller: 'k7',
    route: 'PATCH /api/items/workflows/:id'
  }
  it('refForEvent picks the most specific level', () => {
    expect(refForEvent({ ...base, rid: RID, record: '12' })).toMatchObject({
      kind: 'request',
      id: RID,
      at: 1000
    })
    expect(refForEvent({ ...base, record: '12' })).toMatchObject({
      kind: 'record',
      id: 'workflows:12'
    })
    // a read with a record is not a write: the entity
    expect(refForEvent({ ...base, kind: 'read', record: '12' })).toEqual({
      kind: 'entity',
      id: 'items/workflows',
      at: 1000
    })
  })
  it('titles fall back to label, then `<Label> <short id>`', () => {
    expect(shortId(RID)).toBe('0f8fad5b')
    expect(refTitle({ kind: 'trace', id: RID })).toBe('Trace 0f8fad5b')
    register(inspectables, {
      id: 'trace',
      label: 'Slow trace',
      Panel: () => null
    })
    expect(refTitle({ kind: 'trace', id: RID })).toBe('Slow trace 0f8fad5b')
    expect(refTitle({ kind: 'trace', id: RID, label: 'GET /x' })).toBe('GET /x')
  })
})
