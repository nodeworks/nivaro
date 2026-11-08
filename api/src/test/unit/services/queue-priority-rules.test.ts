import { describe, expect, it } from 'vitest'
import {
  filterAndOrderNarrowRows,
  requiresLiveResolveFallback
} from '../../../services/queue-materialization-read.js'
import {
  atRiskWeight,
  choicesFromOptions,
  computeAvailableValues,
  computePriorityScore,
  computeStats,
  labelOwnerOptions,
  normalizeDisplayConfig,
  normalizeRuleWeights,
  type QueueItem,
  roundAgingHours
} from '../../../services/queues.js'

const item = (over: Partial<QueueItem> = {}): QueueItem =>
  ({
    collection: 'workflows',
    item_id: '1',
    label: 'X',
    state: 'l1',
    owners: [],
    claimed_by: null,
    sla_status: null,
    at_risk: false,
    aging_hours: 10,
    ...over
  }) as QueueItem

describe('priority: per at-risk rule weights (army 11 Q1-6)', () => {
  const weights = {
    sla_warning: 1000,
    sla_breached: 2000,
    at_risk: 500,
    age_hour_cap: 499,
    at_risk_rule_weights: { 'on hold': -5000 }
  }
  it('an on-hold record ranks below an unflagged one, even breached', () => {
    const held = item({
      at_risk: true,
      at_risk_rule: { id: 2, name: 'On hold' },
      sla_status: 'breached',
      aging_hours: 900
    })
    const fresh = item({ aging_hours: 1 })
    expect(computePriorityScore(held, weights)).toBeLessThan(computePriorityScore(fresh, weights))
  })
  it('other rules keep the default at-risk weight', () => {
    const sentBack = item({ at_risk: true, at_risk_rule: { id: 1, name: 'Sent back' } })
    expect(atRiskWeight(sentBack, weights)).toBe(500)
    expect(atRiskWeight(item(), weights)).toBe(0)
  })
  it('the normalizer keeps the map and drops junk', () => {
    expect(normalizeRuleWeights({ 'On hold': '-5000', '': 3, x: 'nope' })).toEqual({
      'On hold': -5000
    })
    expect(normalizeRuleWeights(null)).toBeNull()
    const cfg = normalizeDisplayConfig({
      priority_weights: { at_risk_rule_weights: { 'On hold': -999999 } }
    })
    expect(cfg.priority_weights?.at_risk_rule_weights).toEqual({ 'On hold': -100000 })
  })
  it('a materialized queue with rule weights keeps the cached path (rev11-api #1)', () => {
    expect(requiresLiveResolveFallback('-priority', {})).toBe(false)
  })
  it('the cached narrow-scan sort ranks a held row last too', () => {
    const narrow = (id: number, over: Record<string, unknown>) =>
      ({
        id,
        label: String(id),
        state: 'l1',
        collection: 'workflows',
        at_risk: false,
        has_owner: true,
        sla_status: null,
        aging_hours: 10,
        sort_val: null,
        ...over
      }) as never
    const out = filterAndOrderNarrowRows(
      [
        narrow(1, {
          at_risk: true,
          at_risk_rule: 'On hold',
          sla_status: 'breached',
          aging_hours: 900
        }),
        narrow(2, { aging_hours: 1 }),
        narrow(3, { at_risk: true, at_risk_rule: 'Sent back' })
      ],
      {},
      '-priority',
      weights
    )
    expect(out.map((r) => r.id)).toEqual([3, 2, 1])
  })
})

describe('stats: at risk per rule', () => {
  it('splits At Risk by the rule that flagged each row', () => {
    const s = computeStats([
      item({ at_risk: true, at_risk_rule: { id: 2, name: 'On hold' } }),
      item({ at_risk: true, at_risk_rule: { id: 2, name: 'On hold' } }),
      item({ at_risk: true, at_risk_rule: { id: 1, name: 'Sent back' } }),
      item()
    ])
    expect(s.at_risk).toBe(3)
    expect(s.at_risk_by_rule).toEqual({ 'On hold': 2, 'Sent back': 1 })
    expect(computeStats([item()]).at_risk_by_rule).toBeUndefined()
  })
})

describe('aging precision (army 11 N1)', () => {
  it('keeps minutes exact (3.9 minutes is not 6)', () => {
    const h = roundAgingHours(3.9 / 60)
    expect(Math.round(h * 60)).toBe(4)
  })
})

describe('owner filter options (army 11 Q1-3)', () => {
  it('tags people who cannot act and numbers look-alikes', () => {
    const out = labelOwnerOptions([
      { id: 'b', name: 'Nisha Uprety', inactive: 'suspended' },
      { id: 'a', name: 'Nisha Uprety' },
      { id: 'r1', name: 'Redacted Redacted', inactive: 'former' },
      { id: 'r2', name: 'Redacted Redacted', inactive: 'former' }
    ])
    expect(out.map((o) => o.label ?? o.name)).toEqual([
      'Nisha Uprety',
      'Nisha Uprety (suspended)',
      'Redacted Redacted (former user) · 1',
      'Redacted Redacted (former user) · 2'
    ])
  })
  it('narrows the owner list by the other filters', () => {
    const rows = [
      item({ item_id: '1', state: 'l1', owners: [{ id: 'u1', name: 'A' }] }),
      item({ item_id: '2', state: 'l5', owners: [{ id: 'u2', name: 'B' }] })
    ]
    expect(computeAvailableValues(rows, { state: ['l1'] }).owners.map((o) => o.id)).toEqual(['u1'])
    expect(computeAvailableValues(rows).owners).toHaveLength(2)
  })
})

describe('select choices on extra columns (army 11 Q1-2)', () => {
  it('reads options.choices', () => {
    expect(
      choicesFromOptions('{"choices":[{"text":"At Risk","value":"at_risk"},{"value":"good"}]}')
    ).toEqual([
      { value: 'at_risk', text: 'At Risk' },
      { value: 'good', text: 'good' }
    ])
    expect(choicesFromOptions(null)).toBeNull()
    expect(choicesFromOptions('{"choices":"x"}')).toBeNull()
  })
})
