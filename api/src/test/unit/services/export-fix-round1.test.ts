import { afterEach, describe, expect, it, vi } from 'vitest'

// Fix round 1 of streaming exports — the pieces below the export routes:
//  - a guarded run (an export another process may end) never overwrites that outcome;
//  - a per-person slot is renewed only by its owner;
//  - a handed-off job's person is re-read WITHOUT credential columns.

const rows = vi.hoisted(() => ({
  status: 'running' as string,
  updates: [] as Array<{ where: Record<string, unknown>; patch: Record<string, unknown> }>,
  user: null as Record<string, unknown> | null
}))
const emitted = vi.hoisted(() => ({ calls: [] as Array<{ event: string; payload: any }> }))

vi.mock('../../../db/index.js', () => {
  const make = (table: string) => {
    const where: Record<string, unknown> = {}
    const chain: Record<string, any> = {
      insert: vi.fn(() => chain),
      returning: vi.fn(async () => [{ id: 41 }]),
      where: vi.fn((k: unknown, v?: unknown) => {
        Object.assign(where, typeof k === 'object' ? k : { [String(k)]: v })
        return chain
      }),
      update: vi.fn(async (patch: Record<string, unknown>) => {
        rows.updates.push({ where: { ...where }, patch })
        if (where.status && where.status !== rows.status) return 0
        rows.status = String(patch.status ?? rows.status)
        return 1
      }),
      first: vi.fn(async () =>
        table === 'nivaro_users'
          ? rows.user
          : table === 'nivaro_roles'
            ? { id: 'r1', admin_access: false, app_access: true }
            : undefined
      )
    }
    return chain
  }
  return { db: vi.fn((t: string) => make(t)) }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))
vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({
    to: () => ({
      emit: (event: string, payload: any) => emitted.calls.push({ event, payload })
    })
  }),
  getApp: () => null
}))

import { renewRunSlot } from '../../../services/background-runs.js'
import { principalFor } from '../../../services/export-kinds.js'
import { resumeJobRun, startJobRun } from '../../../services/job-runs.js'

afterEach(() => {
  rows.status = 'running'
  rows.updates.length = 0
  emitted.calls.length = 0
})

describe('guardRunning job runs', () => {
  it('complete after another process failed the run writes nothing and tells no one', async () => {
    const run = await startJobRun('export', 'bg-export:items:a', {
      triggeredBy: 'u1',
      guardRunning: true
    })
    rows.status = 'error' // a drainer judged its lease lost
    emitted.calls.length = 0
    await run.complete('1 row · a.csv → file x')
    expect(rows.updates.at(-1)!.where).toMatchObject({ id: 41, status: 'running' })
    expect(rows.status).toBe('error')
    expect(run.stillOurs?.()).toBe(false)
    expect(emitted.calls.filter((c) => c.payload?.status === 'completed')).toHaveLength(0)
  })

  it('a resumed handle is guarded the same way; an unguarded run still writes as before', async () => {
    const resumed = resumeJobRun(41, 'export', 'bg-export:items:a', {
      triggeredBy: 'u1',
      guardRunning: true
    })
    await resumed.fail(new Error('boom'))
    expect(rows.status).toBe('error')
    expect(resumed.stillOurs?.()).toBe(true)
    await resumed.complete('late')
    expect(rows.status).toBe('error')
    const plain = await startJobRun('cron', 'tick')
    await plain.complete('done')
    expect(rows.updates.at(-1)!.where).not.toHaveProperty('status')
  })
})

describe('per-person slot renewal', () => {
  it('extends the slot only while the run still owns it', async () => {
    const evals: unknown[][] = []
    const redis = { eval: vi.fn(async (...a: unknown[]) => evals.push(a)) }
    await renewRunSlot(redis as never, 'u1', 2, 'export:abc', 1800)
    expect(evals).toHaveLength(1)
    const [script, keys, key, owner, ttl] = evals[0]
    expect(String(script)).toContain("redis.call('get', KEYS[1]) == ARGV[1]")
    expect(String(script)).toContain("'expire'")
    expect(keys).toBe(1)
    expect(String(key)).toMatch(/^nvr:bgrun:slot:.*:u1:2$/)
    expect([owner, ttl]).toEqual(['export:abc', '1800'])
  })
})

describe('principalFor', () => {
  it('re-reads the person without credential columns', async () => {
    rows.user = {
      id: 'u1',
      status: 'active',
      role: 'r1',
      static_token: 'nvt_SECRET',
      password_hash: 'hash',
      totp_secret: 'totp',
      external_id: 'sub'
    }
    const who = await principalFor('u1')
    expect(who).not.toBeNull()
    const user = who!.user as unknown as Record<string, unknown>
    for (const k of ['static_token', 'password_hash', 'totp_secret', 'external_id'])
      expect(user).not.toHaveProperty(k)
    expect(user.id).toBe('u1')
    expect(who!.isAdmin).toBe(false)
  })
})
