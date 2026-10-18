import { describe, expect, it } from 'vitest'
import { MinuteCounter } from '../traffic-ring.js'
import { groupRefs, heatRows, queueRef } from './business-heat.js'

const mk = () => ({
  queue: [] as Array<{ collection: string; id: string; write: boolean; sec: number }>,
  counts: new MinuteCounter(50),
  lastFrameAt: 0,
  lastFlushAt: 0,
  flushing: false,
  dropped: 0,
  attributed: 0
})

describe('business heat', () => {
  it('queues nothing while nobody watches, and drops past the cap', () => {
    const s = mk()
    const ref = { collection: 'orders', id: '1', write: false, sec: 1 }
    expect(queueRef(s, ref, 1_000_000)).toBe(false)
    s.lastFrameAt = 1_000_000
    expect(queueRef(s, ref, 1_000_100)).toBe(true)
    for (let i = 0; i < 400; i++) queueRef(s, ref, 1_000_200)
    expect(s.queue.length).toBe(200)
    expect(s.dropped).toBeGreaterThan(0)
  })

  it('groups refs per collection, reads apart from writes', () => {
    const g = groupRefs([
      { collection: 'orders', id: '1', write: false, sec: 1 },
      { collection: 'orders', id: '1', write: false, sec: 1 },
      { collection: 'orders', id: '2', write: true, sec: 1 }
    ])
    expect(g.get('orders')?.reads.get('1')).toBe(2)
    expect(g.get('orders')?.writes.get('2')).toBe(1)
  })

  it('ranks dimension values by reads and weighted writes', () => {
    const s = mk()
    const sec = 6000
    s.counts.bump('region\u00011\u0001r', sec, 10)
    s.counts.bump('region\u00012\u0001r', sec, 2)
    s.counts.bump('region\u00012\u0001w', sec, 5)
    const rows = heatRows(s, 300, sec)
    expect(rows[0]).toMatchObject({ dimension: 'region', id: '2', reads: 2, writes: 5 })
    expect(rows[1]).toMatchObject({ id: '1', reads: 10, writes: 0 })
  })
})
