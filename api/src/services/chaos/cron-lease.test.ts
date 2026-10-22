import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CronLeader } from '../../plugins/cron.js'
import { _resetCatalogForTests } from './catalog.js'
import { analyzeCronOverlap, type JobRunRow } from './cron-overlap.js'
import { _resetRegistryForTests, armFault, CHAOS_NODE, disarm, stopAll } from './registry.js'

/** In-memory Redis with the lease calls (as in cron-leader.test.ts), on a controllable clock. */
class FakeRedis {
  store = new Map<string, { v: string; exp: number }>()
  now = () => Date.now()
  private live(k: string) {
    const e = this.store.get(k)
    if (e && e.exp <= this.now()) this.store.delete(k)
    return this.store.get(k)
  }
  async set(k: string, v: string, _px: 'PX', ms: number, _nx: 'NX') {
    if (this.live(k)) return null
    this.store.set(k, { v, exp: this.now() + ms })
    return 'OK'
  }
  async get(k: string) {
    return this.live(k)?.v ?? null
  }
  async eval(script: string, _n: number, k: string, v: string, ms?: string) {
    const e = this.live(k)
    if (!e || e.v !== v) return 0
    if (script.includes('pexpire')) {
      e.exp = this.now() + Number(ms)
      return 1
    }
    this.store.delete(k)
    return 1
  }
}

function leader(id: string, r: FakeRedis) {
  const l = new CronLeader(id)
  // biome-ignore lint/suspicious/noExplicitAny: test double
  ;(l as any).redis = r
  return l
}

beforeAll(async () => {
  _resetCatalogForTests()
  await import('./faults/cron.js')
})
afterEach(async () => {
  await stopAll('test')
  await _resetRegistryForTests()
})

const here = { kind: 'node', node: CHAOS_NODE }

describe('scheduler lease split drill (#2833)', () => {
  it('unarmed: the holder renews and keeps the lease', async () => {
    const r = new FakeRedis()
    const a = leader('aaaa', r)
    await a.renew()
    await a.renew()
    expect(a.isLeader()).toBe(true)
    expect(await r.get('nvr:cron:leader')).toBe('aaaa')
  })

  it('drop: the lease goes at once and another replica takes it', async () => {
    const r = new FakeRedis()
    const a = leader('aaaa', r)
    await a.renew()
    const f = await armFault({
      fault_key: 'cron_lease_split',
      target: here,
      params: { mode: 'drop' }
    })
    await a.renew()
    expect(a.isLeader()).toBe(false)
    expect(await r.get('nvr:cron:leader')).toBeNull()
    // The other replica's renew round (it is not cut off).
    await disarm(f.id)
    const b = leader('bbbb', r)
    await b.renew()
    expect(b.isLeader()).toBe(true)
    // After the window the old holder competes again and stays a follower.
    await a.renew()
    expect(a.isLeader()).toBe(false)
  })

  it('split: the old holder goes on believing it leads while another holds the key', async () => {
    const r = new FakeRedis()
    const a = leader('aaaa', r)
    await a.renew()
    const f = await armFault({
      fault_key: 'cron_lease_split',
      target: here,
      params: { mode: 'split' }
    })
    await a.renew()
    expect(a.isLeader()).toBe(true)
    expect(a.isLeader(f.ends_at - 1)).toBe(true)
    await r.set('nvr:cron:leader', 'bbbb', 'PX', 30_000, 'NX')
    expect(await r.get('nvr:cron:leader')).toBe('bbbb')
    // The window ends: belief ends with it; the per-fire run lock was the only guard meanwhile.
    expect(a.isLeader(f.ends_at + 1)).toBe(false)
  })

  it('expire: renewal stops and the lease lapses before the key does', async () => {
    const r = new FakeRedis()
    let t = 1_000_000
    r.now = () => t
    const realNow = Date.now
    Date.now = () => t
    try {
      const a = leader('aaaa', r)
      await a.renew()
      await armFault({ fault_key: 'cron_lease_split', target: here, params: { mode: 'expire' } })
      t += 10_000
      await a.renew()
      expect(await r.get('nvr:cron:leader')).toBe('aaaa')
      t += 18_500
      expect(a.isLeader()).toBe(false)
      t += 2_000
      expect(await r.get('nvr:cron:leader')).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it('a drill aimed at another replica leaves this one alone', async () => {
    const r = new FakeRedis()
    const a = leader('aaaa', r)
    await a.renew()
    await armFault({
      fault_key: 'cron_lease_split',
      target: { kind: 'node', node: 'other·x' },
      params: { mode: 'drop' }
    })
    await a.renew()
    expect(a.isLeader()).toBe(true)
  })

  it('Stop all ends the drill: the next round competes again', async () => {
    const r = new FakeRedis()
    const a = leader('aaaa', r)
    await armFault({ fault_key: 'cron_lease_split', target: here, params: { mode: 'drop' } })
    await a.renew()
    expect(a.isLeader()).toBe(false)
    await stopAll('test')
    await a.renew()
    expect(a.isLeader()).toBe(true)
  })
})

describe('cron-overlap check (#2833)', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, s)).toISOString()
  const row = (
    id: number,
    job: string,
    start: number,
    end: number | null,
    inst: string,
    status = end == null ? 'running' : 'completed'
  ): JobRunRow => ({
    id,
    job_id: job,
    status,
    started_at: at(start),
    finished_at: end == null ? null : at(end),
    instance_id: inst
  })

  it('finds the same job running twice at once, across replicas', () => {
    const rep = analyzeCronOverlap(
      [row(1, 'poll', 0, 12, 'A'), row(2, 'poll', 10, 22, 'B'), row(3, 'poll', 30, 32, 'B')],
      [{ id: 'poll', idempotent: 'unknown', budget_ms: 60_000 }],
      { since: at(0), until: at(40), now: Date.parse(at(40)) }
    )
    expect(rep.overlaps).toHaveLength(1)
    expect(rep.overlaps[0]).toMatchObject({
      job_id: 'poll',
      overlap_ms: 2000,
      same_instance: false
    })
    expect(rep.unsafe[0]).toMatchObject({ job_id: 'poll', overlapped: true })
  })

  it('reports runs left running past their budget', () => {
    const rep = analyzeCronOverlap(
      [row(1, 'nightly', 0, null, 'A')],
      [{ id: 'nightly', idempotent: 'safe', budget_ms: 5_000 }],
      { since: at(0), until: at(60), now: Date.parse(at(60)) }
    )
    expect(rep.stuck).toEqual([
      expect.objectContaining({ id: 1, job_id: 'nightly', budget_ms: 5_000, running_ms: 60_000 })
    ])
    expect(rep.unsafe).toEqual([])
  })

  it('names every job not declared safe, overlapped ones first', () => {
    const rep = analyzeCronOverlap(
      [row(1, 'b', 0, 5, 'A'), row(2, 'b', 1, 6, 'B')],
      [
        { id: 'a', idempotent: 'unsafe', budget_ms: 1000 },
        { id: 'b', idempotent: 'safe', budget_ms: 1000 },
        { id: 'c', idempotent: 'safe', budget_ms: 1000 },
        { id: 'd', budget_ms: 1000 }
      ],
      { since: at(0), until: at(10), now: Date.parse(at(10)) }
    )
    expect(rep.unsafe.map((u) => u.job_id)).toEqual(['b', 'a', 'd'])
    expect(rep.unsafe[0].why).toMatch(/Declared safe, but it ran twice/)
  })

  it('ignores overlaps that ended before the window', () => {
    const rep = analyzeCronOverlap(
      [row(1, 'p', 0, 10, 'A'), row(2, 'p', 5, 12, 'B')],
      [{ id: 'p', idempotent: 'safe', budget_ms: 60_000 }],
      { since: at(20), until: at(40), now: Date.parse(at(40)) }
    )
    expect(rep.overlaps).toEqual([])
  })
})
