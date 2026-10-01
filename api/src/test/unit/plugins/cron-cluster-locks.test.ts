import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: async () => ({ complete: async () => {}, fail: async () => {} })
}))

import { CronManager, JobBusyError } from '../../../plugins/cron.js'

/** In-memory Redis with the calls the cluster locks use. */
class FakeRedis {
  store = new Map<string, string>()
  async set(k: string, v: string, _px: 'PX', _ms: number, _nx: 'NX') {
    if (this.store.has(k)) return null
    this.store.set(k, v)
    return 'OK'
  }
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async eval(script: string, _n: number, k: string, v: string) {
    if (this.store.get(k) !== v) return 0
    if (script.includes('del')) this.store.delete(k)
    return 1
  }
}

const managers: CronManager[] = []
function make(redis: FakeRedis) {
  const m = new CronManager()
  // biome-ignore lint/suspicious/noExplicitAny: test double
  ;(m.leader as any).observer = redis
  managers.push(m)
  return m
}
afterEach(() => {
  for (const m of managers.splice(0)) m.stopAll()
})

describe('unsafe jobs run once across processes (#1085)', () => {
  it('a run-now is refused while another process runs the job', async () => {
    const r = new FakeRedis()
    const a = make(r)
    const b = make(r)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    a.schedule('mailer', '0 0 1 1 *', () => gate, { idempotent: 'unsafe' })
    b.schedule('mailer', '0 0 1 1 *', async () => {}, { idempotent: 'unsafe' })
    const first = a.runNow('mailer', 'u1')
    await new Promise((res) => setTimeout(res, 10))
    await expect(b.runNow('mailer', 'u2')).rejects.toBeInstanceOf(JobBusyError)
    release()
    await first
    expect(r.store.size).toBe(0)
    await expect(b.runNow('mailer', 'u2')).resolves.toBe(true)
  })

  it('a safe job takes no marker', async () => {
    const r = new FakeRedis()
    const a = make(r)
    a.schedule('sweep', '0 0 1 1 *', async () => {}, { idempotent: 'safe' })
    expect(await a.claimUnsafeRun('sweep', 'run now')).toBeNull()
    expect(r.store.size).toBe(0)
  })

  it('refuses when Redis cannot say', async () => {
    const r = new FakeRedis()
    r.set = async () => {
      throw new Error('down')
    }
    const a = make(r)
    a.schedule('mailer', '0 0 1 1 *', async () => {}, { idempotent: 'unsafe' })
    await expect(a.runNow('mailer', 'u1')).rejects.toThrow(/Redis unreachable/)
  })
})

describe('heavy jobs take turns across processes (#1086)', () => {
  it('a second heavy run waits until the first releases the slot', async () => {
    const r = new FakeRedis()
    const a = make(r)
    const b = make(r)
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const first = a.withHeavySlot('nightly', async () => {
      order.push('a-start')
      await gate
      order.push('a-end')
    })
    await new Promise((res) => setTimeout(res, 10))
    expect(await b.heavySlotHolder()).toMatch(/nightly/)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const second = b.withHeavySlot('run-now', async () => {
      order.push('b')
    })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(order).toEqual(['a-start'])
    release()
    await first
    await vi.advanceTimersByTimeAsync(6_000)
    await second
    vi.useRealTimers()
    expect(order).toEqual(['a-start', 'a-end', 'b'])
    expect(r.store.size).toBe(0)
  })

  it('runs at once when Redis fails', async () => {
    const r = new FakeRedis()
    r.set = async () => {
      throw new Error('down')
    }
    const a = make(r)
    let ran = false
    await a.withHeavySlot('nightly', async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })
})

describe('extension build identity (#1089)', () => {
  it('prefers the export, else the .release-sha beside the extension', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { resolveExtensionBuild } = await import('../../../extensions/loader.js')
    const d = mkdtempSync(join(tmpdir(), 'nvr-ext-'))
    expect(resolveExtensionBuild(undefined, d)).toBeNull()
    writeFileSync(join(d, '.release-sha'), 'abc12345\n')
    expect(resolveExtensionBuild(undefined, d)).toBe('abc12345')
    expect(resolveExtensionBuild('  v1.2  ', d)).toBe('v1.2')
  })
})
