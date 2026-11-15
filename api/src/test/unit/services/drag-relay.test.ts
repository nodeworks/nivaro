import { describe, expect, it } from 'vitest'
import { createDragThrottle, parseDragMessage } from '../../../services/drag-relay.js'

describe('parseDragMessage', () => {
  it('keeps a calendar move: ids, view, phase and the day only', () => {
    expect(
      parseDragMessage({
        collection: 'jobs',
        item: 7,
        view: 'calendar:due_date',
        phase: 'move',
        at: '2026-12-04',
        title: 'secret',
        value: 'x'
      })
    ).toEqual({
      collection: 'jobs',
      item: '7',
      view: 'calendar:due_date',
      phase: 'move',
      at: '2026-12-04'
    })
  })
  it('keeps a Gantt move with start and end days', () => {
    expect(
      parseDragMessage({
        collection: 'jobs',
        item: 'a1',
        view: 'gantt:start_date,end_date',
        phase: 'end',
        start: '2026-12-01',
        end: '2026-12-09'
      })
    ).toMatchObject({ start: '2026-12-01', end: '2026-12-09' })
  })
  it('a cancel needs no days', () => {
    expect(
      parseDragMessage({ collection: 'jobs', item: '1', view: 'calendar:d', phase: 'cancel' })
    ).toEqual({ collection: 'jobs', item: '1', view: 'calendar:d', phase: 'cancel' })
  })
  it('drops malformed or system-table messages', () => {
    const ok = {
      collection: 'jobs',
      item: '1',
      view: 'calendar:d',
      phase: 'move',
      at: '2026-01-02'
    }
    expect(parseDragMessage({ ...ok, collection: 'nivaro_users' })).toBeNull()
    expect(parseDragMessage({ ...ok, collection: 'a b' })).toBeNull()
    expect(parseDragMessage({ ...ok, view: 'list:x' })).toBeNull()
    expect(parseDragMessage({ ...ok, phase: 'jump' })).toBeNull()
    expect(parseDragMessage({ ...ok, at: 'tomorrow' })).toBeNull()
    expect(parseDragMessage({ ...ok, item: '' })).toBeNull()
    expect(
      parseDragMessage({
        collection: 'jobs',
        item: '1',
        view: 'gantt:s,e',
        phase: 'move',
        start: '2026-01-05',
        end: '2026-01-01'
      })
    ).toBeNull()
    expect(parseDragMessage(null)).toBeNull()
  })
})

describe('createDragThrottle', () => {
  it('passes one move per record per window; end and cancel always pass', () => {
    const allow = createDragThrottle(60)
    expect(allow('jobs:1', 'move', 1000)).toBe(true)
    expect(allow('jobs:1', 'move', 1030)).toBe(false)
    expect(allow('jobs:2', 'move', 1030)).toBe(true)
    expect(allow('jobs:1', 'move', 1061)).toBe(true)
    expect(allow('jobs:1', 'end', 1062)).toBe(true)
    // After an end the next drag starts fresh.
    expect(allow('jobs:1', 'move', 1063)).toBe(true)
    expect(allow('jobs:1', 'cancel', 1064)).toBe(true)
  })
})
