import { describe, expect, it } from 'vitest'
import { applySignal, type SignalPeers, typistsByThread } from './presence-signals'

const beth = { id: 'b-1', name: 'Beth' }
const kim = { id: 'k-1', name: 'Kim' }

describe('field-comment typing peers', () => {
  it('keeps the record thread and each field thread apart, record first', () => {
    let p: SignalPeers = new Map()
    p = applySignal(p, { kind: 'note', state: 'start', user: kim, field: 'amount' }, 0)
    p = applySignal(p, { kind: 'note', state: 'start', user: beth }, 0)
    p = applySignal(p, { kind: 'note', state: 'start', user: beth, field: 'amount' }, 0)
    expect(typistsByThread(p)).toEqual([
      { field: null, names: ['Beth'] },
      { field: 'amount', names: ['Kim', 'Beth'] }
    ])
  })
  it('a stop on one thread leaves the other', () => {
    let p: SignalPeers = new Map()
    p = applySignal(p, { kind: 'note', state: 'start', user: beth }, 0)
    p = applySignal(p, { kind: 'note', state: 'start', user: beth, field: 'amount' }, 0)
    p = applySignal(p, { kind: 'note', state: 'stop', user: beth, field: 'amount' }, 0)
    expect(typistsByThread(p)).toEqual([{ field: null, names: ['Beth'] }])
  })
  it('never lists the viewer themself', () => {
    const p = applySignal(new Map(), { state: 'start', user: beth, field: 'x' }, 0, 'B-1')
    expect(p.size).toBe(0)
  })
})
