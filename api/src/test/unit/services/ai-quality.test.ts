import { describe, expect, it } from 'vitest'
import { READ_ONLY_REFUSED } from '../../../services/ai-chat-loop.js'
import { gradeProbe } from '../../../services/ai-health.js'
import {
  type BudgetCap,
  budgetDay,
  canSeeReplay,
  capApplies,
  classifyCause,
  evaluateBudgets,
  isProviderFailure,
  normalizeCap,
  parseQualityConfig,
  type QualityConfig
} from '../../../services/ai-quality.js'
import { watchRoomId } from '../../../services/watch-rooms.js'

const cap = (o: Partial<BudgetCap> = {}): BudgetCap => ({
  id: 'c1',
  who: 'everyone',
  who_id: null,
  feature: null,
  pooled: false,
  daily_usd: 5,
  cheaper_model: null,
  ...o
})
const cfg = (caps: BudgetCap[], enabled = true): QualityConfig => ({
  budgets: { enabled, caps },
  fallback_model: null
})
const subj = { userId: 'U1', roleId: 'R1', feature: 'chat' }

describe('AI quality config', () => {
  it('defaults to no limit on malformed input', () => {
    expect(parseQualityConfig('not json').budgets.enabled).toBe(false)
    expect(parseQualityConfig(null).budgets.caps).toEqual([])
  })
  it('rejects a person cap with no person', () => {
    expect(normalizeCap({ id: 'x', who: 'person', daily_usd: 3 })).toBeNull()
  })
})

describe('budgets (#1817)', () => {
  it('does nothing when disabled', async () => {
    const v = await evaluateBudgets(cfg([cap()], false), subj, async () => 99)
    expect(v.blocked).toBeNull()
    expect(v.remaining_usd).toBeNull()
  })
  it('blocks past a cap with no cheaper model', async () => {
    const v = await evaluateBudgets(cfg([cap()]), subj, async () => 5)
    expect(v.blocked?.cap.id).toBe('c1')
  })
  it('switches to the cheaper model instead of stopping', async () => {
    const v = await evaluateBudgets(cfg([cap({ cheaper_model: 'haiku' })]), subj, async () => 6)
    expect(v.blocked).toBeNull()
    expect(v.cheaper_model).toBe('haiku')
  })
  it('reports the tightest remaining allowance', async () => {
    const v = await evaluateBudgets(
      cfg([cap(), cap({ id: 'c2', daily_usd: 2 })]),
      subj,
      async () => 1
    )
    expect(v.remaining_usd).toBe(1)
  })
  it('scopes caps by person, role and feature', () => {
    expect(capApplies(cap({ who: 'person', who_id: 'u1' }), subj)).toBe(true)
    expect(capApplies(cap({ who: 'person', who_id: 'U2' }), subj)).toBe(false)
    expect(capApplies(cap({ who: 'role', who_id: 'R2' }), subj)).toBe(false)
    expect(capApplies(cap({ feature: 'generate' }), subj)).toBe(false)
  })
  it('resets at UTC midnight', () => {
    const d = budgetDay(new Date('2026-10-12T15:00:00Z'))
    expect(d.resets_at.toISOString()).toBe('2026-10-13T00:00:00.000Z')
  })
})

describe('provider health and failure (#1821)', () => {
  it('grades reachable, slow and failing', () => {
    expect(gradeProbe(true, 400).status).toBe('reachable')
    expect(gradeProbe(true, 9000).status).toBe('slow')
    expect(gradeProbe(false, 100).status).toBe('failing')
  })
  it('falls back only on provider failures', () => {
    expect(isProviderFailure({ status: 503 })).toBe(true)
    expect(isProviderFailure({ status: 429 })).toBe(true)
    expect(isProviderFailure({ status: 400 })).toBe(false)
    expect(isProviderFailure(new Error('fetch failed'))).toBe(true)
  })
})

describe('triage (#1862)', () => {
  const base = {
    question: 'q',
    answer: 'a',
    comment: null,
    tools: ['query_records'],
    toolErrors: []
  }
  it('sorts by the strongest evidence', () => {
    expect(classifyCause({ ...base, toolErrors: ['Not allowed to read x'] })).toBe('permission')
    expect(classifyCause({ ...base, toolErrors: ['unknown field foo'] })).toBe('wrong_filter')
    expect(classifyCause({ ...base, answer: 'There are no records.' })).toBe('missing_data')
    expect(classifyCause({ ...base, tools: [] })).toBe('misunderstood')
    expect(classifyCause(base)).toBe('unclassified')
  })
})

describe('tenant isolation of live calls and replays', () => {
  it('scopes the ai-calls watch room per tenant in cloud mode', () => {
    expect(watchRoomId('ai-calls', 't:a', true)).toBe('watch:ai-calls:t:a')
    expect(watchRoomId('ai-calls', 't:b', true)).not.toBe(watchRoomId('ai-calls', 't:a', true))
    expect(watchRoomId('ai-calls', null, true)).toBeNull()
    expect(watchRoomId('traffic-map', 't:a', true)).toBe('watch:traffic-map:t:a')
  })
  it('keeps the global room self-hosted and for unscoped rooms', () => {
    expect(watchRoomId('ai-calls', null, false)).toBe('watch:ai-calls')
    expect(watchRoomId('jobs', 't:a', true)).toBe('watch:jobs')
  })
  it('shows a replay only to its starter in its tenant', () => {
    const run = { user: 'A', store: 't:1' }
    expect(canSeeReplay(run, 'A', 't:1')).toBe(true)
    expect(canSeeReplay(run, 'B', 't:1')).toBe(false)
    expect(canSeeReplay(run, 'A', 't:2')).toBe(false)
  })
  it('refuses write-capable tools in a read-only run', () => {
    expect(READ_ONLY_REFUSED.has('run_custom_query')).toBe(true)
    expect(READ_ONLY_REFUSED.has('propose_action')).toBe(true)
    expect(READ_ONLY_REFUSED.has('query_items')).toBe(false)
  })
})
