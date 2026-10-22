import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { insiderViews, publicArmed, visibleArmedFor } from './armed-visibility.js'
import {
  _resetBlindForTests,
  BLIND_CHANNEL,
  bindBlindRun,
  closeBlindWindow,
  isBlindRun,
  openBlindWindow,
  revealBlindWindow,
  startBlindCluster
} from './blind.js'
import type { ArmedFault } from './catalog.js'
import { _resetRegistryForTests, stopAll } from './registry.js'

const LEAD = '11111111-1111-4111-8111-111111111111'
const RESP = '33333333-3333-4333-8333-333333333333'

function fault(over: Partial<ArmedFault> = {}): ArmedFault {
  const now = Date.now()
  return {
    id: `f-${Math.random()}`,
    fault_key: 'slow_requests',
    label: 'Slow requests',
    target: { kind: 'all' },
    params: {},
    started_at: now,
    ends_at: now + 60_000,
    started_by: LEAD,
    started_by_name: 'Lead',
    run_id: null,
    node: 'n1',
    ...over
  }
}

const lead = { id: LEAD, operator: false }
const responder = { id: RESP, operator: false }
const operator = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operator: true }

beforeEach(async () => {
  _resetBlindForTests()
  _resetRegistryForTests()
  await startBlindCluster(null)
})
afterEach(() => _resetBlindForTests())

describe('blind mode visibility (#2854)', () => {
  it('without a window every fault is public', () => {
    const f = fault()
    expect(visibleArmedFor(responder, [f])).toEqual([f])
    expect(publicArmed([f])).toEqual([f])
  })

  it('hides the lead’s faults from responders; the lead and operators still see them', async () => {
    await openBlindWindow({ id: 'gd1', kind: 'gameday', lead: LEAD, until: Date.now() + 3600_000 })
    const blind = fault()
    const other = fault({ started_by: operator.id })
    const list = [blind, other]
    expect(visibleArmedFor(responder, list)).toEqual([other])
    expect(visibleArmedFor(lead, list)).toEqual(list)
    expect(visibleArmedFor(operator, list)).toEqual(list)
    expect(publicArmed(list)).toEqual([other])
    expect(insiderViews(list).get(LEAD)).toEqual(list)
    expect(insiderViews(list).has(RESP)).toBe(false)
  })

  it('a fault armed before the window opened stays public', async () => {
    const early = fault({ started_at: Date.now() - 60_000 })
    await openBlindWindow({ id: 'gd1', kind: 'gameday', lead: LEAD, until: Date.now() + 3600_000 })
    expect(visibleArmedFor(responder, [early])).toEqual([early])
  })

  it('a bound run is hidden whoever armed it; isBlindRun answers for the run and the day', async () => {
    await openBlindWindow({ id: 'gd1', kind: 'gameday', lead: LEAD, until: Date.now() + 3600_000 })
    await bindBlindRun('gd1', 'RUN-1')
    const f = fault({ run_id: 'run-1', started_by: operator.id })
    expect(visibleArmedFor(responder, [f])).toEqual([])
    expect(isBlindRun('run-1')).toBe(true)
    expect(isBlindRun('gd1')).toBe(true)
    expect(isBlindRun('other')).toBe(false)
  })

  it('reveal, close, expiry and Stop all make it public again', async () => {
    await openBlindWindow({ id: 'gd1', kind: 'gameday', lead: LEAD, until: Date.now() + 3600_000 })
    const f = fault()
    expect(publicArmed([f])).toEqual([])
    await revealBlindWindow('gd1')
    expect(publicArmed([f])).toEqual([f])
    expect(isBlindRun('gd1')).toBe(false)

    await openBlindWindow({ id: 'gd2', kind: 'gameday', lead: LEAD, until: Date.now() + 3600_000 })
    const g = fault()
    expect(publicArmed([g])).toEqual([])
    await closeBlindWindow('gd2')
    expect(publicArmed([g])).toEqual([g])

    await openBlindWindow({ id: 'gd3', kind: 'gameday', lead: LEAD, until: Date.now() - 1 })
    expect(publicArmed([fault()])).toHaveLength(1)

    await openBlindWindow({ id: 'gd4', kind: 'gameday', lead: LEAD, until: Date.now() + 3600_000 })
    const h = fault()
    expect(publicArmed([h])).toEqual([])
    await stopAll('test')
    expect(publicArmed([h])).toEqual([h])
  })

  it('windows reach other replicas over the channel and the hash', async () => {
    _resetBlindForTests()
    const hash = new Map<string, string>()
    const published: string[] = []
    let onMessage: ((c: string, m: string) => void) | null = null
    const bus = {
      publish: async (_c: string, m: string) => {
        published.push(m)
      },
      hset: async (_k: string, f: string, v: string) => {
        hash.set(f, v)
      },
      hdel: async (_k: string, f: string) => {
        hash.delete(f)
      },
      hgetall: async () => Object.fromEntries(hash),
      expire: async () => {},
      duplicate: () => ({
        subscribe: async () => {},
        on: (_e: 'message', fn: (c: string, m: string) => void) => {
          onMessage = fn
        }
      })
    }
    await startBlindCluster(bus)
    await openBlindWindow({ id: 'gd1', kind: 'gameday', lead: LEAD, until: Date.now() + 3600_000 })
    expect(hash.has('gd1')).toBe(true)
    expect(published).toHaveLength(1)

    // Another replica: starts empty, learns the window from the message.
    const msg = published[0]
    _resetBlindForTests()
    await startBlindCluster(null)
    expect(publicArmed([fault()])).toHaveLength(1)
    _resetBlindForTests()
    await startBlindCluster({ ...bus, hgetall: async () => ({}) })
    ;(onMessage as unknown as (c: string, m: string) => void)(BLIND_CHANNEL, msg)
    expect(publicArmed([fault()])).toHaveLength(0)
  })
})
