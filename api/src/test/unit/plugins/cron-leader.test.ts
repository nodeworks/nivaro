import { Cron } from 'croner'
import { afterEach, describe, expect, it } from 'vitest'
import { CronLeader, scheduledFireTime } from '../../../plugins/cron.js'

/** In-memory Redis with just the calls the lease uses (SET NX PX, GET, the
 *  two compare scripts). Expiry is checked against a controllable clock. */
class FakeRedis {
  store = new Map<string, { v: string; exp: number }>()
  now = () => Date.now()
  down = false
  private live(k: string) {
    const e = this.store.get(k)
    if (e && e.exp <= this.now()) this.store.delete(k)
    return this.store.get(k)
  }
  async set(k: string, v: string, _px: 'PX', ms: number, _nx: 'NX') {
    if (this.down) throw new Error('down')
    if (this.live(k)) return null
    this.store.set(k, { v, exp: this.now() + ms })
    return 'OK'
  }
  async get(k: string) {
    if (this.down) throw new Error('down')
    return this.live(k)?.v ?? null
  }
  async eval(script: string, _n: number, k: string, v: string, ms?: string) {
    if (this.down) throw new Error('down')
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

const leaders: CronLeader[] = []
function make(id: string, redis: FakeRedis) {
  const l = new CronLeader(id)
  // biome-ignore lint/suspicious/noExplicitAny: test double
  ;(l as any).redis = redis
  leaders.push(l)
  return l
}
afterEach(async () => {
  for (const l of leaders.splice(0)) await l.stop()
})

describe('CronLeader (#1080)', () => {
  it('exactly one of two processes holds the lease', async () => {
    const r = new FakeRedis()
    const a = make('aaaa', r)
    const b = make('bbbb', r)
    await a.renew()
    await b.renew()
    expect(a.isLeader()).toBe(true)
    expect(b.isLeader()).toBe(false)
    expect(await r.get('nvr:cron:leader')).toBe('aaaa')
  })

  it('the standby takes over once the leader releases', async () => {
    const r = new FakeRedis()
    const a = make('aaaa', r)
    const b = make('bbbb', r)
    await a.renew()
    await b.renew()
    await a.stop()
    await b.renew()
    expect(b.isLeader()).toBe(true)
  })

  it('a leader that cannot reach Redis stops leading before the key could expire', async () => {
    const r = new FakeRedis()
    let t = 1_000_000
    r.now = () => t
    const a = make('aaaa', r)
    const realNow = Date.now
    Date.now = () => t
    try {
      await a.renew()
      expect(a.isLeader()).toBe(true)
      r.down = true
      t += 20_000
      await a.renew() // fails — lease not extended
      expect(a.isLeader()).toBe(true)
      t += 9_000 // 29s after acquire: inside the 2s margin, key not yet expired
      expect(a.isLeader()).toBe(false)
      expect(r.store.get('nvr:cron:leader')?.exp).toBeGreaterThan(t)
    } finally {
      Date.now = realNow
    }
  })

  it('a renew never extends another process’s lease', async () => {
    const r = new FakeRedis()
    const a = make('aaaa', r)
    await a.renew()
    // Someone else took the key (a's expired and b won it).
    r.store.set('nvr:cron:leader', { v: 'bbbb', exp: Date.now() + 30_000 })
    await a.renew()
    expect(a.isLeader()).toBe(false)
    expect(await r.get('nvr:cron:leader')).toBe('bbbb')
  })

  it('a scheduled fire runs once even when two processes try it', async () => {
    const r = new FakeRedis()
    const a = make('aaaa', r)
    const b = make('bbbb', r)
    const fire = new Date('2026-10-01T06:00:00.000Z')
    expect(await a.claimRun('nightly', fire)).toBe(true)
    expect(await b.claimRun('nightly', fire)).toBe(false)
    expect(await b.claimRun('nightly', new Date('2026-10-02T06:00:00.000Z'))).toBe(true)
  })

  it('the run lock fails closed when Redis is down', async () => {
    const r = new FakeRedis()
    r.down = true
    const a = make('aaaa', r)
    expect(await a.claimRun('nightly', new Date())).toBe(false)
  })
})

describe('scheduledFireTime', () => {
  it('returns the scheduled time, not the moment the callback ran', () => {
    const job = new Cron('0 */5 * * * *', { paused: true, timezone: 'UTC' })
    const t = scheduledFireTime(job, new Date('2026-10-01T06:05:00.420Z'))
    job.stop()
    expect(t.toISOString()).toBe('2026-10-01T06:05:00.000Z')
  })
})
