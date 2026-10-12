import { describe, expect, it } from 'vitest'
import {
  INSPECT_IDLE_MS,
  INSPECT_RING,
  inspectedEvents,
  isInspected,
  noteInspected,
  startInspect,
  stopInspect
} from '../../../services/socket-transport.js'

describe('socket inspector (#1731)', () => {
  it('records nothing until started, then keeps the last 100 newest-first', () => {
    noteInspected('s1', 'a', null, 1)
    expect(isInspected('s1')).toBe(false)
    expect(startInspect('s1', 't1')).toBe(true)
    for (let i = 0; i < INSPECT_RING + 5; i++) noteInspected('s1', `e${i}`, 'record:x:1', 10)
    const ev = inspectedEvents('s1', 't1')
    expect(ev).toHaveLength(INSPECT_RING)
    expect(ev?.[0].event).toBe(`e${INSPECT_RING + 4}`)
    stopInspect('s1')
    expect(inspectedEvents('s1', 't1')).toBeNull()
  })

  it('hides other tenants, credential rooms and tenant prefixes', () => {
    startInspect('s2', 't1')
    noteInspected('s2', 'x', 'session:abc', 5)
    noteInspected('s2', 'y', 't:t1:record:c:1', 5)
    expect(inspectedEvents('s2', 't2')).toBeNull()
    const ev = inspectedEvents('s2', 't1')
    expect(ev?.map((e) => e.room)).toEqual(['record:c:1', null])
    stopInspect('s2')
  })

  it('switches itself off when unread', () => {
    const t0 = 1_000_000
    startInspect('s3', null, t0)
    noteInspected('s3', 'z', null, 1, t0 + INSPECT_IDLE_MS + 1)
    expect(isInspected('s3')).toBe(false)
  })
})
