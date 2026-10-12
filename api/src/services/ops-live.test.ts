import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onOpsWrite, opsTopicsOfWrite, raiseOpsWrite } from '../db/ops-signal.js'
import { setIo } from './io-holder.js'
import { emitOps, opsRoom, opsTopicGate, pokeOps, wireOpsLive } from './ops-live.js'

describe('opsTopicsOfWrite', () => {
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

describe('opsTopicGate', () => {
  it('allowlists topics and names who may join', () => {
    expect(opsTopicGate('readiness')).toEqual({ topic: 'readiness', gate: 'admin' })
    expect(opsTopicGate('broadcasts')?.gate).toBe('admin')
    expect(opsTopicGate('support')?.gate).toBe('auth')
    expect(opsTopicGate('my-work')?.gate).toBe('auth')
    // an issue's occurrence stream names a person: admin only
    expect(opsTopicGate('issue:42')).toEqual({ topic: 'issue:42', gate: 'admin' })
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
