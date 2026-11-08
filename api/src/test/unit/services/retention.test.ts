import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// Retention policies (2026-11-08): a person is in scope only when EVERY gate
// holds — no activity and no sign-in since the cutoff, not a machine account,
// not excluded, not under a legal hold, not already redacted, and (when the
// policy asks) gone per directory sync. The directory gate refuses to run on
// an off or stale directory instead of falling back to inactivity alone.

const NOW = new Date('2026-11-08T12:00:00Z')
const DAY = 86_400_000

const state = vi.hoisted(() => ({
  ran: [] as FakeQuery[],
  users: [] as Array<Record<string, unknown>>,
  settings: undefined as Record<string, unknown> | undefined,
  hasDirColumn: true,
  activity: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  const fake = makeFakeDb((q) => {
    state.ran.push(q)
    if (q.sql.includes('[nivaro_settings]')) return state.settings
    if (q.sql.includes('from [nivaro_users]') && q.method === 'select') return state.users
    if (q.method === 'update') return 1
    if (q.method === 'insert') return []
    return []
  })
  // The fake has no server to BEGIN on — run a transaction body on the same fake.
  const transaction = async (fn: (trx: unknown) => unknown) => fn(fake)
  const db = new Proxy(
    (...a: unknown[]) => (fake as unknown as (...x: unknown[]) => unknown)(...a),
    {
      get: (_t, p) => (p === 'transaction' ? transaction : Reflect.get(fake, p))
    }
  )
  return { db }
})
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: vi.fn(async () => state.hasDirColumn),
  resetColumnProbes: vi.fn()
}))
// The activity log is no longer read: a retention scan must never touch it.
vi.mock('../../../services/custom-query-exec.js', () => ({
  execCustomQuerySql: vi.fn(async () => {
    throw new Error('retention must not scan nivaro_activity')
  })
}))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (e: Record<string, unknown>) => {
    state.activity.push(e)
    return 1
  })
}))
vi.mock('../../../services/field-defaults.js', () => ({
  deleteDefaultsForUser: vi.fn(async () => undefined)
}))

import {
  directoryGateRefusal,
  executeRetentionPolicy,
  judgeRetentionCandidates,
  type RetentionPolicy,
  retentionCutoff,
  runRetentionPolicy
} from '../../../services/retention.js'

const policy = (over: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  id: 1,
  name: '3-year inactivity redaction',
  inactivity_threshold_months: 36,
  action: 'redact',
  redact_fields: '[]',
  redact_value_template: 'Redacted_{{id}}',
  exclusion_emails: '[]',
  exclusion_roles: '[]',
  is_active: true,
  dry_run_mode: false,
  require_directory_gone: false,
  ...over
})

const old = new Date(NOW.getTime() - 4 * 365 * DAY)
const recent = new Date(NOW.getTime() - 30 * DAY)
const checked = new Date(NOW.getTime() - DAY)

const person = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  email: `${id}@corp.example`,
  first_name: 'Pat',
  last_name: id,
  role: 'role-user',
  status: 'active',
  account_kind: null,
  last_access: old,
  directory_status: 'missing',
  directory_checked_at: checked,
  ...over
})

beforeEach(() => {
  state.ran = []
  state.users = []
  state.settings = { directory_sync_enabled: true, directory_sync_last_run: checked }
  state.hasDirColumn = true
  state.activity = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

describe('judgeRetentionCandidates', () => {
  const cutoff = retentionCutoff(36, NOW)

  it('a recent sign-in protects someone with no activity rows', () => {
    const r = judgeRetentionCandidates(
      [person('a', { last_access: recent }), person('b')],
      policy(),
      cutoff,
      NOW
    )
    expect(r.candidates.map((c) => c.id)).toEqual(['b'])
    expect(r.skipped.signed_in).toBe(1)
  })

  it('activity in the log does not protect — sign-in is the only liveness signal', () => {
    const r = judgeRetentionCandidates([person('aa')], policy(), cutoff, NOW)
    expect(r.candidates.map((c) => c.id)).toEqual(['aa'])
  })

  it('never touches machine accounts — the column or the address convention', () => {
    const r = judgeRetentionCandidates(
      [
        person('svc', { account_kind: 'integration' }),
        person('bot', { email: 'chat-bot@nivaro.local' }),
        person('human')
      ],
      policy(),
      cutoff,
      NOW
    )
    expect(r.candidates.map((c) => c.id)).toEqual(['human'])
    expect(r.skipped.machine).toBe(2)
  })

  it('honours excluded emails (any case) and roles', () => {
    const r = judgeRetentionCandidates(
      [
        person('a', { email: 'Keep@Corp.example' }),
        person('b', { role: 'role-admin' }),
        person('c')
      ],
      policy({ exclusion_emails: '["keep@corp.example"]', exclusion_roles: '["role-admin"]' }),
      cutoff,
      NOW
    )
    expect(r.candidates.map((c) => c.id)).toEqual(['c'])
    expect(r.skipped.excluded).toBe(2)
  })

  it('directory gate off: inactivity alone decides', () => {
    const r = judgeRetentionCandidates(
      [person('a', { directory_status: 'active' }), person('b', { directory_status: null })],
      policy({ require_directory_gone: false }),
      cutoff,
      NOW
    )
    expect(r.candidates.map((c) => c.id)).toEqual(['a', 'b'])
    expect(r.candidates[0].reasons).toHaveLength(1)
  })

  it('directory gate on: only missing / disabled with a fresh verdict, and says so', () => {
    const r = judgeRetentionCandidates(
      [
        person('here', { directory_status: 'active' }),
        person('unchecked', { directory_status: null, directory_checked_at: null }),
        person('stale', { directory_checked_at: new Date(NOW.getTime() - 30 * DAY) }),
        person('gone'),
        person('off', { directory_status: 'disabled' })
      ],
      policy({ require_directory_gone: 1 }),
      cutoff,
      NOW
    )
    expect(r.candidates.map((c) => c.id)).toEqual(['gone', 'off'])
    expect(r.skipped.directory_present).toBe(3)
    expect(r.candidates[0].reasons.join(' | ')).toMatch(
      /^No sign-in since .*36 months; last sign-in .* \| Not in the Microsoft directory/
    )
    expect(r.candidates[1].reasons[1]).toMatch(/disabled/)
  })

  it('a person who never signed in says so', () => {
    const r = judgeRetentionCandidates([person('n', { last_access: null })], policy(), cutoff, NOW)
    expect(r.candidates[0].reasons).toContain('Never signed in')
  })
})

describe('directoryGateRefusal', () => {
  it('refuses when directory sync is off', async () => {
    state.settings = { directory_sync_enabled: false, directory_sync_last_run: checked }
    expect(await directoryGateRefusal(NOW)).toMatch(/Directory sync is off/)
  })
  it('refuses when it never completed or is stale', async () => {
    state.settings = { directory_sync_enabled: 1, directory_sync_last_run: null }
    expect(await directoryGateRefusal(NOW)).toMatch(/never completed/)
    state.settings = {
      directory_sync_enabled: 1,
      directory_sync_last_run: new Date(NOW.getTime() - 9 * DAY)
    }
    expect(await directoryGateRefusal(NOW)).toMatch(/more than 7 days ago/)
  })
  it('refuses without the directory column', async () => {
    state.hasDirColumn = false
    expect(await directoryGateRefusal(NOW)).toMatch(/no directory status/)
  })
  it('allows a recent run', async () => {
    expect(await directoryGateRefusal(NOW)).toBeNull()
  })
})

const writes = () =>
  state.ran.filter((q) => q.method === 'update' || q.method === 'insert' || q.method === 'del')

describe('executeRetentionPolicy', () => {
  it('refuses with the directory gate on and sync off — reads no people, writes nothing', async () => {
    state.settings = { directory_sync_enabled: false }
    state.users = [person('gone')]
    const r = await executeRetentionPolicy(policy({ require_directory_gone: true }), 'admin', false)
    expect(r.refused).toMatch(/Directory sync is off/)
    expect(r.affectedCount).toBe(0)
    expect(r.errors).toEqual([r.refused])
    expect(state.ran.some((q) => q.sql.includes('from [nivaro_users]'))).toBe(false)
    expect(r.redactedIds).toEqual([])
    expect(writes()).toHaveLength(0)
  })

  it('dry run lists candidates with reasons and writes nothing', async () => {
    state.users = [person('a'), person('b', { last_access: recent })]
    const r = await executeRetentionPolicy(policy({ require_directory_gone: true }), 'admin', true)
    expect(r.dryRun).toBe(true)
    expect(r.affectedCount).toBe(1)
    expect(r.candidates[0]).toMatchObject({ id: 'a', directory_status: 'missing' })
    expect(r.candidates[0].reasons).toHaveLength(2)
    expect(r.redactedIds).toEqual([])
    expect(writes()).toHaveLength(0)
  })

  it('a policy in dry-run mode never writes, even on a live run', async () => {
    state.users = [person('a')]
    const r = await executeRetentionPolicy(policy({ dry_run_mode: 1 }), 'admin', false)
    expect(r.dryRun).toBe(true)
    expect(r.affectedCount).toBe(1)
    expect(writes()).toHaveLength(0)
  })

  it('reads not-redacted people with no legal hold, in one statement', async () => {
    state.users = [person('a')]
    await executeRetentionPolicy(policy(), 'admin', true)
    const reads = state.ran.filter((q) => q.sql.includes('from [nivaro_users]'))
    expect(reads).toHaveLength(1)
    expect(reads[0].sql).toMatch(/\[is_redacted\] = @p0 or \[is_redacted\] is null/i)
    expect(reads[0].sql).toMatch(/not exists \(select \* from \[nivaro_legal_holds\]/i)
  })

  it('a live run redacts, suspends and writes one audit row per person', async () => {
    state.users = [person('a'), person('svc', { account_kind: 'service' })]
    const r = await executeRetentionPolicy(policy({ require_directory_gone: true }), 'admin', false)
    expect(r.dryRun).toBe(false)
    expect(r.affectedIds).toEqual(['a'])
    // The batch's full list, for a deactivated-accounts notifier.
    expect(r.redactedIds).toEqual(['a'])
    const upd = state.ran.filter((q) => q.method === 'update' && q.sql.includes('[nivaro_users]'))
    expect(upd).toHaveLength(1)
    expect(upd[0].bindings).toEqual(expect.arrayContaining(['suspended', 'Redacted_a', 'a']))
    const audit = state.ran.filter(
      (q) => q.method === 'insert' && q.sql.includes('[nivaro_activity]')
    )
    expect(audit).toHaveLength(1)
    expect(audit[0].bindings.join(' ')).toMatch(
      /left the company per directory sync, no sign-in for 36 months/
    )
  })
})

describe('runRetentionPolicy', () => {
  it('records the run, dry or refused', async () => {
    state.users = [person('a')]
    await runRetentionPolicy(policy(), { dryRun: true, source: 'schedule' })
    state.settings = { directory_sync_enabled: false }
    await runRetentionPolicy(policy({ require_directory_gone: true }), {
      dryRun: false,
      source: 'schedule'
    })
    const runs = state.ran.filter(
      (q) => q.method === 'insert' && q.sql.includes('[nivaro_retention_runs]')
    )
    expect(runs).toHaveLength(2)
    expect(runs[1].bindings.join(' ')).toMatch(/Directory sync is off/)
    expect(state.activity.map((a) => a.comment).join(' | ')).toMatch(
      /dry run \(schedule\): 1 affected .*refused/
    )
  })
})
