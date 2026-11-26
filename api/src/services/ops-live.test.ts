import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onOpsWrite, opsTopicsOfWrite, raiseOpsWrite } from '../db/ops-signal.js'
import { setIo } from './io-holder.js'
import { emitOps, opsRoom, opsTopicGate, pokeOps, wireOpsLive } from './ops-live.js'

describe('opsTopicsOfWrite', () => {
  it('rt-fix C: tracker link writes poke trackers; outbox ticks do not', () => {
    expect(
      opsTopicsOfWrite('update [nivaro_tracker_links] set [state] = @p0 where [id] = @p1')
    ).toEqual(['trackers'])
    expect(
      opsTopicsOfWrite('insert into [nivaro_tracker_link_members] ([link]) values (@p0)')
    ).toEqual(['trackers'])
    expect(opsTopicsOfWrite('update [nivaro_tracker_outbox] set [attempts] = @p0')).toEqual([])
  })
  it('Hub tables poke hub; the per-minute sample tables do not', () => {
    for (const sql of [
      'update [nivaro_hub_deploys] set [heartbeat_at] = @p0 where [id] = @p1',
      'insert into "nivaro_hub_creations" ("environment_id") values ($1)',
      'update nivaro_hub_fleet_status set state = ? where environment_id = ?',
      'delete from `nivaro_hub_apps` where `id` = ?'
    ])
      expect(opsTopicsOfWrite(sql)).toEqual(['hub'])
    for (const sql of [
      'insert into [nivaro_hub_uptime_samples] ([up]) values (@p0)',
      'insert into nivaro_hub_uptime_hours (hour) values (?)',
      'insert into [nivaro_hub_capacity_samples] ([cpu]) values (@p0)',
      'insert into [nivaro_hub_usage_days] ([day]) values (@p0)',
      'select * from [nivaro_hub_apps]'
    ])
      expect(opsTopicsOfWrite(sql)).toEqual([])
    expect(opsTopicGate('hub')).toEqual({ topic: 'hub', gate: 'auth' })
  })
  it('maps writes to the topics whose pages show that table', () => {
    expect(opsTopicsOfWrite('insert into [nivaro_issues] ([title]) values (@p0)')).toEqual([
      'issues'
    ])
    expect(opsTopicsOfWrite('update nivaro_tasks set status = ? where id = ?').sort()).toEqual([
      'my-work',
      'support',
      'team'
    ])
    expect(opsTopicsOfWrite('delete from nivaro_announcement_acks where id = 1')).toEqual([
      'broadcasts'
    ])
  })

  it('counts a notification only when it is UPDATED (read), not when one is created', () => {
    expect(opsTopicsOfWrite('update nivaro_notifications set status = ?')).toEqual(['broadcasts'])
    expect(opsTopicsOfWrite('insert into nivaro_notifications (recipient) values (?)')).toEqual([])
  })

  it('ignores reads and unrelated tables', () => {
    expect(opsTopicsOfWrite('select * from nivaro_issues')).toEqual([])
    expect(opsTopicsOfWrite('update articles set title = ?')).toEqual([])
    expect(opsTopicsOfWrite('')).toEqual([])
  })
})

describe('S15 — comments poke support only for ticket comments', () => {
  const ins =
    'insert into [nivaro_comments] ([id], [collection], [item], [text]) values (@p0, @p1, @p2, @p3)'
  it('a record comment pokes nothing', () => {
    expect(opsTopicsOfWrite(ins, ['a', 'workflows', '5', 'hi'])).toEqual([])
  })
  it('a ticket comment pokes support', () => {
    expect(opsTopicsOfWrite(ins, ['a', 'nivaro_tasks', '5', 'hi'])).toEqual(['support'])
  })
  it('an unreadable insert fails open; edits/deletes are poked by their route', () => {
    expect(opsTopicsOfWrite(ins)).toEqual(['support'])
    expect(
      opsTopicsOfWrite('update nivaro_comments set text = ? where id = ?', ['x', 'a'])
    ).toEqual([])
  })
})

describe('admin screen topics (2026-11-14)', () => {
  it('integration tables and access requests poke their own topics', () => {
    expect(opsTopicsOfWrite('update nivaro_integration_signal_rows set x = 1')).toEqual([
      'integrations'
    ])
    expect(opsTopicsOfWrite('insert into nivaro_external_api_logs (api) values (?)')).toEqual([
      'integrations'
    ])
    expect(opsTopicsOfWrite('merge nivaro_erp_submissions as t using x')).toEqual(['integrations'])
    expect(opsTopicsOfWrite('insert into nivaro_access_requests (user) values (?)')).toEqual([
      'access-requests'
    ])
  })

  it('webhook deliveries and failed flow runs poke their own topics (2026-11-14)', () => {
    expect(opsTopicsOfWrite('insert into nivaro_webhook_deliveries (webhook) values (?)')).toEqual([
      'webhooks'
    ])
    expect(opsTopicsOfWrite("update nivaro_flow_runs set status = 'error' where id = ?")).toEqual([
      'dead-letters'
    ])
    // A run STARTING is not a dead letter: only an update (the run ending) pokes.
    expect(opsTopicsOfWrite('insert into nivaro_flow_runs (flow) values (?)')).toEqual([])
  })

  it('mail log writes poke the admin-only mail-log topic (realtime safety 2026-11-18)', () => {
    expect(
      opsTopicsOfWrite('insert into [nivaro_mail_log] ([to], [status]) values (?, ?)')
    ).toEqual(['mail-log'])
    expect(opsTopicsOfWrite('update nivaro_mail_log set retry_at = null where id = ?')).toEqual([
      'mail-log'
    ])
    expect(opsTopicsOfWrite('insert into nivaro_mail_suppressions (address) values (?)')).toEqual(
      []
    )
    expect(opsTopicGate('mail-log')).toEqual({ topic: 'mail-log', gate: 'admin' })
  })

  it('the five topics are admin-only rooms', () => {
    for (const t of ['collections', 'integrations', 'access-requests', 'webhooks', 'dead-letters'])
      expect(opsTopicGate(t)).toEqual({ topic: t, gate: 'admin' })
  })
})

describe('opsTopicGate', () => {
  it('allowlists topics and names who may join', () => {
    expect(opsTopicGate('readiness')).toEqual({ topic: 'readiness', gate: 'admin' })
    expect(opsTopicGate('broadcasts')?.gate).toBe('admin')
    expect(opsTopicGate('support')?.gate).toBe('auth')
    expect(opsTopicGate('my-work')?.gate).toBe('auth')
    // an issue's occurrence stream names a person: admin only
    expect(opsTopicGate('issue:42')).toEqual({ topic: 'issue:42', gate: 'admin' })
    // rt-fix C: GitLab chips — a poke naming nothing, any signed-in person
    expect(opsTopicGate('trackers')).toEqual({ topic: 'trackers', gate: 'auth' })
  })

  it('refuses invented or malformed topics (no privileged room by name)', () => {
    for (const t of ['watch:traffic', 'pulse', 'issue:', 'issue:abc', 'user:1', '', 'x'.repeat(60)])
      expect(opsTopicGate(t)).toBeNull()
    expect(opsTopicGate(42)).toBeNull()
    expect(opsTopicGate(undefined)).toBeNull()
  })

  it('rooms are plain ops:<topic> self-hosted', () => {
    expect(opsRoom('issues', '')).toBe('ops:issues')
    expect(opsRoom('issues', 'acme')).toBe('t:acme:ops:issues')
  })
})

describe('pokes', () => {
  const emitted: Array<{ room: string; event: string; payload: Record<string, unknown> }> = []
  beforeEach(() => {
    vi.useFakeTimers()
    emitted.length = 0
    setIo({
      to: (room: string) => ({
        emit: (event: string, payload: Record<string, unknown>) =>
          emitted.push({ room, event, payload })
      })
    } as never)
  })
  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('a burst is one poke after the settle window, with no row, user or value in it', () => {
    for (let i = 0; i < 20; i++) pokeOps('issues')
    expect(emitted).toHaveLength(0)
    vi.advanceTimersByTime(500)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].room).toBe('ops:issues')
    expect(emitted[0].event).toBe('ops:changed')
    expect(Object.keys(emitted[0].payload).sort()).toEqual(['at', 'topic'])
  })

  it('writes during the cooldown schedule exactly one more poke', () => {
    pokeOps('support')
    vi.advanceTimersByTime(500)
    expect(emitted).toHaveLength(1)
    pokeOps('support')
    pokeOps('support')
    expect(emitted).toHaveLength(1)
    vi.advanceTimersByTime(2000)
    expect(emitted).toHaveLength(2)
    vi.advanceTimersByTime(5000)
    expect(emitted).toHaveLength(2)
  })

  it('topics are independent', () => {
    pokeOps('team')
    pokeOps('delegation')
    vi.advanceTimersByTime(500)
    expect(emitted.map((e) => e.room).sort()).toEqual(['ops:delegation', 'ops:team'])
  })

  it('emitOps sends detail right now to its own room', () => {
    emitOps('issue:7', { occurrence: { route: '/x' } })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].room).toBe('ops:issue:7')
    expect(emitted[0].payload.occurrence).toEqual({ route: '/x' })
  })

  it('driver-seam writes become pokes once wired', () => {
    wireOpsLive()
    raiseOpsWrite(['broadcasts'])
    vi.advanceTimersByTime(500)
    expect(emitted.map((e) => e.room)).toContain('ops:broadcasts')
  })

  it('onOpsWrite listeners that throw never break the write', () => {
    const off = onOpsWrite(() => {
      throw new Error('boom')
    })
    expect(() => raiseOpsWrite(['issues'])).not.toThrow()
    off()
  })
})
