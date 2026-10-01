import { describe, expect, it } from 'vitest'
import { deadLetterCount } from './dead-letters'
import { msText, resolverLabel } from './graphql-resolvers'
import { colourSlot } from './ownership'
import { queueCacheVisible, syncsByCollection } from './queue-cache'
import { ageText, type OwnershipData, ownerOfNodeId, sharesOf } from './store'

describe('traffic map platform features', () => {
  it('reads an outright owner off the node id', () => {
    expect(ownerOfNodeId('extension/efp-ops')).toBe('efp-ops')
    expect(ownerOfNodeId('cron:ext:efp-ops:reforecasting')).toBe('efp-ops')
    expect(ownerOfNodeId('x:efp-ops.mwf')).toBe('efp-ops')
    expect(ownerOfNodeId('cron:rollup-drift-sweep')).toBeNull()
    expect(ownerOfNodeId('items/workflows')).toBeNull()
  })

  it('turns ownership figures into shares, biggest first', () => {
    const data: OwnershipData = {
      window_s: 60,
      extensions: ['efp-ops'],
      nodes: { 'items/workflows': { ms: { core: 75, 'efp-ops': 25 }, n: {}, total_ms: 100 } }
    }
    expect(sharesOf('items/workflows', data)).toEqual([
      { owner: 'core', ms: 75, share: 0.75 },
      { owner: 'efp-ops', ms: 25, share: 0.25 }
    ])
    expect(sharesOf('cron:ext:efp-ops:x', data)).toEqual([{ owner: 'efp-ops', ms: 0, share: 1 }])
    expect(sharesOf('items/regions', data)).toEqual([])
    expect(colourSlot('efp-ops', ['efp-ops'])).toBe(0)
  })

  it('formats ages and labels', () => {
    expect(ageText(null)).toBe('never')
    expect(ageText(42)).toBe('42 s')
    expect(ageText(3 * 3600 + 720)).toBe('3 h 12 m')
    expect(ageText(3 * 86_400)).toBe('3 d')
    expect(resolverLabel('gate:workflows')).toBe('access check on workflows')
    expect(resolverLabel('workflows.project')).toBe('workflows.project')
    expect(msText(0.1)).toBe('<1 ms')
    expect(msText(0)).toBe('0 ms')
    expect(msText(1500)).toBe('1.5 s')
  })

  it('shows the queue cache and dead letter nodes only when there is something to show', () => {
    expect(queueCacheVisible(null)).toBe(false)
    const q = {
      window_s: 60,
      lookups: [],
      queues: [
        {
          id: 'A',
          name: 'Q',
          materialized: false,
          rows: null,
          syncs: 3,
          sync_ms: 9,
          avg_ms: 3,
          max_ms: 4,
          failed: 0,
          collections: ['workflows'],
          last_sync_at: null,
          backfill: {
            runs: 0,
            last_status: null,
            last_started_at: null,
            last_duration_ms: null,
            running: false
          },
          since_rebuild_s: null
        }
      ]
    }
    expect(queueCacheVisible(q)).toBe(true)
    expect([...syncsByCollection(q)]).toEqual([['workflows', 3]])
    expect(deadLetterCount(null)).toBe(0)
    expect(
      deadLetterCount({
        flow_runs: { count: 2, items: [], by_flow: {} },
        deliveries: { hours: 24, count: 1, items: [] }
      })
    ).toBe(3)
  })
})
