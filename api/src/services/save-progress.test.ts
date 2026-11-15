import { describe, expect, it, vi } from 'vitest'

vi.mock('./live-progress.js', () => ({ emitToUser: vi.fn() }))
vi.mock('./record-events.js', () => ({ emitRecordEvent: vi.fn() }))

import { announceRecalc } from './recalc-announce.js'
import {
  openSaveProgress,
  SAVE_PROGRESS_EMIT_MS,
  type SaveProgressEvent,
  saveIdOf
} from './save-progress.js'

const req = (q: Record<string, unknown> = { save_progress: 'svabcdef12' }, id = 'U1') => ({
  query: q,
  user: { id }
})

function harness(total: number, r = req()) {
  const events: SaveProgressEvent[] = []
  let t = 1000
  const p = openSaveProgress(r, total, {
    emit: (_uid, ev) => events.push(ev),
    now: () => t
  })
  return { p, events, tick: (ms: number) => (t += ms), req: r }
}

describe('saveIdOf', () => {
  it('takes a well-formed id only', () => {
    expect(saveIdOf(req())).toBe('svabcdef12')
    expect(saveIdOf(req({ save_progress: 'short' }))).toBeNull()
    expect(saveIdOf(req({ save_progress: 'has spaces in it' }))).toBeNull()
    expect(saveIdOf(req({}))).toBeNull()
    expect(saveIdOf(null)).toBeNull()
  })
})

describe('openSaveProgress', () => {
  it('is a no-op without an id, a person, or enough rows', () => {
    const emit = vi.fn()
    openSaveProgress(req({}), 500, { emit }).step()
    openSaveProgress({ query: { save_progress: 'svabcdef12' }, user: null }, 500, { emit }).step()
    const small = openSaveProgress(req(), 5, { emit })
    small.step()
    small.end()
    expect(emit).not.toHaveBeenCalled()
    expect(small.owner).toBe(false)
  })

  it('says the size first, throttles the middle and always sends the end', () => {
    const h = harness(500)
    expect(h.events).toEqual([{ save: 'svabcdef12', done: 0, total: 500, phase: 'lines' }])
    for (let i = 0; i < 100; i++) h.p.step()
    // Same instant: nothing new.
    expect(h.events).toHaveLength(1)
    h.tick(SAVE_PROGRESS_EMIT_MS)
    h.p.step()
    expect(h.events.at(-1)).toMatchObject({ done: 101, total: 500 })
    h.p.phase('totals')
    expect(h.events.at(-1)).toMatchObject({ phase: 'totals' })
    h.p.end()
    expect(h.events.at(-1)).toMatchObject({ finished: true })
    const n = h.events.length
    h.p.step()
    h.p.end()
    expect(h.events).toHaveLength(n)
  })

  it('grows when a set finds its removals late and never reports past the total', () => {
    const h = harness(20)
    h.p.grow(10)
    for (let i = 0; i < 40; i++) h.p.step()
    h.p.end()
    expect(h.events.at(-1)).toMatchObject({ done: 30, total: 30, finished: true })
  })

  it('lets only the outermost nested set report for one request', () => {
    const h = harness(100)
    const inner = openSaveProgress(h.req, 100, { emit: () => h.events.push({} as never) })
    expect(inner.owner).toBe(false)
    const before = h.events.length
    inner.step()
    inner.end()
    expect(h.events).toHaveLength(before)
    h.p.end()
    // Closed: a later write on the same request may report again.
    expect(openSaveProgress(h.req, 100, { emit: () => {} }).owner).toBe(true)
  })
})

describe('announceRecalc', () => {
  it('sends field names to the record room, and nothing without fields', () => {
    const emit = vi.fn()
    announceRecalc('requests', 7, 'start', ['total'], emit)
    expect(emit).toHaveBeenCalledWith('requests', 7, 'record:recalc', {
      phase: 'start',
      fields: ['total']
    })
    announceRecalc('requests', 7, 'done', [], emit)
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
