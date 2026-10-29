import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: vi.fn() }))

import {
  evaluatePatternEvent,
  type HeldMatch,
  hourStart,
  matchesPattern,
  type PatternDeps
} from './activity-pattern-alerts.js'
import {
  buildRuleIndex,
  candidateRules,
  normalizePatternConfig,
  type PatternEvent,
  type PatternRule
} from './activity-pattern-gate.js'

const ALICE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const BOB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const ROLE_FIN = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
const OWNER = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function rule(id: number, collection: string, config: unknown): PatternRule {
  return {
    id,
    name: `Rule ${id}`,
    collection,
    owner: OWNER,
    config: normalizePatternConfig(config)
  }
}

function ev(over: Partial<PatternEvent> = {}): PatternEvent {
  return {
    activity_id: 1,
    action: 'update',
    user: ALICE,
    collection: 'invoices',
    item: '7',
    changed_fields: ['amount'],
    at: new Date('2026-10-29T14:10:00Z'),
    ...over
  }
}

interface Log {
  rule: number
  state: string
  at: Date
}

function fakeDeps(opts: {
  now?: Date
  roles?: Record<string, string>
  /** What the rule OWNER sees: item → record (filter judged on it). */
  ownerView?: Record<string, Record<string, unknown>>
  log?: Log[]
}) {
  const log = opts.log ?? []
  const notified: Array<{ rule: number; what: unknown }> = []
  let now = opts.now ?? new Date('2026-10-29T14:10:00Z')
  const deps: PatternDeps = {
    now: () => now,
    actorRole: async (u) => opts.roles?.[u] ?? null,
    ownerSees: async (_r, _c, item, filter) => {
      const rec = opts.ownerView?.[item]
      if (!rec) return false
      // tiny _gt/_eq judge for the test
      return Object.entries(filter).every(([f, cond]) => {
        const c = cond as Record<string, unknown>
        if ('_gt' in c) return Number(rec[f]) > Number(c._gt)
        if ('_eq' in c) return rec[f] === c._eq
        return false
      })
    },
    sentSince: async (r, since) =>
      log.filter((l) => l.rule === r && l.state === 'sent' && l.at >= since).length,
    record: async (r, _e, state) => {
      log.push({ rule: r.id, state, at: now })
    },
    claimHeld: async (r, before) => {
      const out: HeldMatch[] = []
      for (const l of log) {
        if (l.rule === r && l.state === 'held' && l.at < before) {
          l.state = 'digested'
          out.push({
            action: 'update',
            user: ALICE,
            collection: 'invoices',
            item: '7',
            at: l.at.toISOString()
          })
        }
      }
      return out
    },
    notify: async (r, what) => {
      notified.push({ rule: r.id, what })
      return 1
    }
  }
  return {
    deps,
    notified,
    log,
    setNow: (d: Date) => {
      now = d
    }
  }
}

describe('normalizePatternConfig', () => {
  it('cleans the config and defaults the hourly limit', () => {
    const c = normalizePatternConfig({
      who: { kind: 'roles', roles: [ROLE_FIN, 'not an id'] },
      actions: ['update', 'bad action!'],
      changed_fields: ['zone', 'x y'],
      record_filter: { amount: { _gt: 50000 } }
    })
    expect(c).toEqual({
      who: { kind: 'roles', users: [], roles: [ROLE_FIN] },
      actions: ['update'],
      changed_fields: ['zone'],
      record_filter: { amount: { _gt: 50000 } },
      max_per_hour: 10
    })
  })

  it('refuses a who list with nobody in it', () => {
    expect(() => normalizePatternConfig({ who: { kind: 'users', users: [] } })).toThrow()
  })
})

describe('rule index (hot path)', () => {
  it('finds candidates by collection + action only, and never matches system tables with *', () => {
    const idx = buildRuleIndex([
      rule(1, 'invoices', { actions: ['delete'] }),
      rule(2, '*', { actions: ['update'] }),
      rule(3, 'nivaro_roles', {})
    ])
    expect(candidateRules(idx, ev()).map((r) => r.id)).toEqual([2])
    expect(candidateRules(idx, ev({ action: 'delete' })).map((r) => r.id)).toEqual([1])
    expect(candidateRules(idx, ev({ collection: 'nivaro_users' }))).toEqual([])
    expect(candidateRules(idx, ev({ collection: 'nivaro_roles' })).map((r) => r.id)).toEqual([3])
    expect(candidateRules(idx, ev({ collection: 'nivaro_notifications' }))).toEqual([])
  })
})

describe('matchesPattern', () => {
  it('judges who (people and roles), action and changed fields', async () => {
    const { deps } = fakeDeps({ roles: { [ALICE]: ROLE_FIN } })
    const byPerson = rule(1, 'invoices', { who: { kind: 'users', users: [BOB] } })
    const byRole = rule(2, 'invoices', { who: { kind: 'roles', roles: [ROLE_FIN] } })
    const zone = rule(3, 'invoices', { actions: ['update'], changed_fields: ['zone'] })
    expect(await matchesPattern(byPerson, ev(), deps)).toBe(false)
    expect(await matchesPattern(byPerson, ev({ user: BOB }), deps)).toBe(true)
    expect(await matchesPattern(byRole, ev(), deps)).toBe(true)
    expect(await matchesPattern(byRole, ev({ user: BOB }), deps)).toBe(false)
    expect(await matchesPattern(zone, ev(), deps)).toBe(false)
    expect(await matchesPattern(zone, ev({ changed_fields: ['zone', 'amount'] }), deps)).toBe(true)
  })

  it('evaluates the record filter as the rule owner sees the record', async () => {
    const big = rule(1, 'invoices', { record_filter: { amount: { _gt: 50000 } } })
    // the owner sees record 7 (amount 60000), not record 8 (hidden by their scope)
    const { deps } = fakeDeps({ ownerView: { '7': { amount: 60000 }, '9': { amount: 10 } } })
    expect(await matchesPattern(big, ev(), deps)).toBe(true)
    expect(await matchesPattern(big, ev({ item: '8' }), deps)).toBe(false)
    expect(await matchesPattern(big, ev({ item: '9' }), deps)).toBe(false)
    // a delete with a record filter never matches (the record is gone)
    expect(await matchesPattern(big, ev({ action: 'delete' }), deps)).toBe(false)
  })
})

describe('rate limit + digest', () => {
  it('sends up to max_per_hour, holds the rest, and digests them after the hour', async () => {
    const r = rule(1, 'invoices', { max_per_hour: 2 })
    const f = fakeDeps({ now: new Date('2026-10-29T14:10:00Z') })
    const outcomes: string[] = []
    for (let i = 0; i < 4; i++) {
      const out = await evaluatePatternEvent(ev({ activity_id: i }), [r], f.deps)
      outcomes.push(String(out.get(1)))
    }
    expect(outcomes).toEqual(['sent', 'sent', 'held', 'held'])
    expect(f.notified).toHaveLength(2)

    // next hour: the first match flushes a digest of the two held, then sends
    f.setNow(new Date('2026-10-29T15:05:00Z'))
    const out = await evaluatePatternEvent(ev(), [r], f.deps)
    expect(out.get(1)).toBe('sent')
    expect(f.notified).toHaveLength(4)
    expect(f.notified[2].what).toMatchObject({ digest: { count: 2 } })
    expect(f.notified[3].what).toHaveProperty('event')
    // digested once only
    await evaluatePatternEvent(ev(), [r], f.deps)
    expect(f.notified.filter((n) => 'digest' in (n.what as object))).toHaveLength(1)
  })

  it('hourStart is the clock hour', () => {
    expect(hourStart(new Date('2026-10-29T14:59:59Z')).toISOString()).toBe(
      '2026-10-29T14:00:00.000Z'
    )
  })

  it('no match never records or notifies', async () => {
    const r = rule(1, 'invoices', { actions: ['delete'] })
    const f = fakeDeps({})
    const out = await evaluatePatternEvent(ev(), [r], f.deps)
    expect(out.get(1)).toBe('no_match')
    expect(f.log).toHaveLength(0)
    expect(f.notified).toHaveLength(0)
  })
})
