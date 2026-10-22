import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  closeEventStream,
  encodeStreamEntry,
  eventStreamStats,
  initEventStream
} from '../event-stream.js'
import { setIo } from '../io-holder.js'
import { _resetCatalogForTests } from './catalog.js'
import { comparePartition } from './partition.js'
import {
  _resetPartitionPointForTests,
  notePartitionDelivery,
  partitionCatchUpStats,
  partitionDeliveries,
  probeIdOfRoom,
  streamPausedByPartition
} from './partition-point.js'
import { _resetRegistryForTests, armFault, CHAOS_NODE, stopAll } from './registry.js'

const here = { kind: 'node', node: CHAOS_NODE }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  _resetCatalogForTests()
  await import('./faults/partition.js')
})
afterEach(async () => {
  await stopAll('test')
  await _resetRegistryForTests()
  _resetPartitionPointForTests()
})

describe('partition probe check (#2838)', () => {
  it('compares expected and delivered seqs: lost, doubled, unexpected', () => {
    expect(comparePartition([1, 2, 3, 4], [1, 2, 2, 4, 9])).toEqual({
      lost: [3],
      doubled: [2],
      unexpected: [9]
    })
    expect(comparePartition([1, 2], [2, 1])).toEqual({ lost: [], doubled: [], unexpected: [] })
  })

  it('records deliveries only for probe rooms (tenant prefix allowed)', () => {
    notePartitionDelivery('t:acme:chaos-partition:abc', 7)
    notePartitionDelivery('collection:items', 8)
    notePartitionDelivery('chaos-partition:abc', null)
    expect(probeIdOfRoom('t:acme:chaos-partition:abc')).toBe('abc')
    expect(partitionDeliveries('abc')).toEqual([7])
  })

  it('the stream reader holds only while a pause partition is armed here', async () => {
    expect(streamPausedByPartition()).toBe(false)
    await armFault({ fault_key: 'redis_partition', target: here, params: { stream: 'keep' } })
    expect(streamPausedByPartition()).toBe(false)
    await stopAll('test')
    await armFault({ fault_key: 'redis_partition', target: { kind: 'node', node: 'b·2' } })
    expect(streamPausedByPartition()).toBe(false)
    await stopAll('test')
    await armFault({ fault_key: 'redis_partition', target: here, params: { stream: 'pause' } })
    expect(streamPausedByPartition()).toBe(true)
  })
})

/** A Redis stream in memory: XADD / XREAD (from an id, short block) / XREVRANGE. */
function fakeStreamRedis() {
  const entries: Array<[string, string[]]> = []
  let reads = 0
  let n = 0
  const r = {
    get reads() {
      return reads
    },
    add(fields: string[]) {
      n++
      entries.push([`${n}-0`, fields])
    },
    async xrevrange() {
      return entries.length ? [entries[entries.length - 1]] : []
    },
    async xadd(_k: string, ..._a: unknown[]) {
      return '0-0'
    },
    async xtrim() {
      return 0
    },
    async xread(...args: unknown[]) {
      reads++
      const after = String(args[args.length - 1])
      const seq = (id: string) => Number(id.split('-')[0])
      const out = entries.filter(([id]) => seq(id) > seq(after === '$' ? '0-0' : after))
      if (!out.length) {
        await wait(20)
        return null
      }
      return [['nvr:ev:stream', out.slice(0, 500)]]
    },
    on() {},
    disconnect() {},
    duplicate() {
      return r
    }
  }
  return r
}

describe('stream catch-up after a partition (#2838)', () => {
  it('nothing reaches this replica while cut off; everything arrives once afterwards', async () => {
    const emitted: number[] = []
    setIo({
      local: {
        to: () => ({
          emit: (_ev: string, p: { _seq?: number }) => {
            if (typeof p?._seq === 'number') emitted.push(p._seq)
          }
        })
      }
    } as never)
    const redis = fakeStreamRedis()
    try {
      expect(await initEventStream(redis as never)).toBe(true)
      const room = 'chaos-partition:p1'
      const push = (seq: number) =>
        redis.add(
          encodeStreamEntry(
            { seq, room, event: 'chaos:partition', payload: { n: seq } },
            { node: 'another-replica' }
          )
        )
      push(1)
      await wait(80)
      expect(emitted).toEqual([1])

      await armFault({ fault_key: 'redis_partition', target: here, seconds: 30 })
      await wait(60) // the read in flight returns
      const readsAtCut = redis.reads
      for (let s = 2; s <= 6; s++) push(s)
      await wait(600)
      expect(emitted).toEqual([1])
      expect(redis.reads).toBe(readsAtCut)

      await stopAll('test')
      await wait(400)
      expect(emitted).toEqual([1, 2, 3, 4, 5, 6])
      expect(partitionDeliveries('p1')).toEqual([1, 2, 3, 4, 5, 6])
      expect(comparePartition([1, 2, 3, 4, 5, 6], partitionDeliveries('p1'))).toMatchObject({
        lost: [],
        doubled: []
      })
      expect(partitionCatchUpStats()).toMatchObject({ reads: 1, entries: 5 })
      expect(eventStreamStats().readErrors).toBe(0)
    } finally {
      await closeEventStream()
    }
  })
})
