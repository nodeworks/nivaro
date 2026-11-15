import { describe, expect, it } from 'vitest'
import {
  badgeNeeds,
  badgeWatch,
  defaultBadgeRules,
  effectiveBadgeRules,
  evaluateBadges,
  MAX_BADGES,
  normalizeBadgeRule,
  parsePickerBadges,
  pickerBadgesForStorage,
  rulesForViewer
} from '../../../services/picker-badges.js'

const facts = {
  pipeline: true,
  fields: [
    { field: 'id', type: 'integer' },
    { field: 'name', type: 'string' },
    { field: 'is_active', type: 'boolean' },
    { field: 'over_budget', type: 'boolean' },
    { field: 'spent', type: 'decimal' },
    { field: 'budget', type: 'decimal' }
  ]
}

describe('picker badges — setting', () => {
  it('missing or malformed config reads as automatic', () => {
    expect(parsePickerBadges(null)).toEqual({ mode: 'auto', rules: [] })
    expect(parsePickerBadges('{not json')).toEqual({ mode: 'auto', rules: [] })
    expect(parsePickerBadges({ picker_badges: 'x' })).toEqual({ mode: 'auto', rules: [] })
    expect(parsePickerBadges(JSON.stringify({ picker_badges: { mode: 'off' } })).mode).toBe('off')
  })

  it('custom rules are normalized; garbage is dropped', () => {
    const s = parsePickerBadges({
      picker_badges: {
        mode: 'custom',
        rules: [
          {
            label: 'Over budget',
            tone: 'red',
            when: { field: 'spent', op: 'gt_field', other: 'budget' }
          },
          { label: 'Bad', when: { field: 'x; drop', op: 'is_true' } },
          { label: '', when: { terminal: true } },
          { label: 'Paused', tone: 'weird', when: { states: ['paused', 3] } }
        ]
      }
    })
    expect(s.mode).toBe('custom')
    expect(s.rules).toHaveLength(2)
    expect(s.rules[0].key).toBe('over_budget')
    expect(s.rules[1]).toEqual({
      key: 'paused',
      label: 'Paused',
      tone: 'neutral',
      when: { states: ['paused'] }
    })
  })

  it('stores automatic as null and keeps custom rules', () => {
    expect(pickerBadgesForStorage({ mode: 'auto', rules: [] })).toBeNull()
    expect(pickerBadgesForStorage({ mode: 'off', rules: [] })).toEqual({ mode: 'off' })
    const rule = normalizeBadgeRule({ label: 'Closed', when: { terminal: true } })
    expect(pickerBadgesForStorage({ mode: 'custom', rules: rule ? [rule] : [] })).toEqual({
      mode: 'custom',
      rules: [{ key: 'closed', label: 'Closed', tone: 'neutral', when: { terminal: true } }]
    })
  })
})

describe('picker badges — automatic rules', () => {
  it('derive from the pipeline binding and yes/no flags', () => {
    const keys = defaultBadgeRules(facts).map((r) => r.key)
    expect(keys).toEqual(['hidden', 'closed', 'on_hold', 'over_budget', 'inactive'])
  })

  it('a table without a pipeline or flags only says hidden', () => {
    expect(
      defaultBadgeRules({ pipeline: false, fields: [{ field: 'name', type: 'string' }] }).map(
        (r) => r.key
      )
    ).toEqual(['hidden'])
  })

  it('an archived flag reads Archived', () => {
    const r = defaultBadgeRules({
      pipeline: false,
      fields: [{ field: 'archived', type: 'boolean' }]
    })
    expect(r[1]).toMatchObject({
      key: 'inactive',
      label: 'Archived',
      when: { field: 'archived', op: 'is_true' }
    })
  })

  it('off means none, custom means only the admin rules', () => {
    expect(effectiveBadgeRules({ mode: 'off', rules: [] }, facts)).toEqual([])
    const custom = [{ key: 'x', label: 'X', tone: 'red' as const, when: { hidden: true } }]
    expect(effectiveBadgeRules({ mode: 'custom', rules: custom }, facts)).toBe(custom)
  })
})

describe('picker badges — as the viewer', () => {
  const rules = defaultBadgeRules(facts)
  const columns = new Set(facts.fields.map((f) => f.field))

  it('drops rules on columns the viewer cannot read', () => {
    const viewer = rulesForViewer(rules, ['id', 'name', 'over_budget'], columns)
    expect(viewer.map((r) => r.key)).toEqual(['hidden', 'closed', 'on_hold', 'over_budget'])
    expect(rulesForViewer(rules, null, columns)).toHaveLength(rules.length)
  })

  it('drops rules on columns the table does not have', () => {
    const r = normalizeBadgeRule({ label: 'Gone', when: { field: 'nope', op: 'is_true' } })
    expect(r && rulesForViewer([r], null, columns)).toEqual([])
  })

  it('needs + watch name only what the rules read', () => {
    const needs = badgeNeeds(rules)
    expect(needs).toEqual({ fields: ['over_budget', 'is_active'], state: true, hidden: true })
    expect(badgeWatch(needs)).toEqual(['over_budget', 'is_active', '$state', '$picker'])
  })
})

describe('picker badges — evaluation', () => {
  const rules = defaultBadgeRules(facts)

  it('final step says Closed, never also On hold', () => {
    const row = {
      id: 1,
      $state: { key: 'closed_hold', label: 'Closed - on hold', is_terminal: true }
    }
    expect(evaluateBadges(rules, row, false).map((b) => b.key)).toEqual(['closed'])
  })

  it('a hold step says On hold', () => {
    const row = { id: 1, $state: { key: 'on_hold', label: 'On Hold', is_terminal: false } }
    expect(evaluateBadges(rules, row, false)).toEqual([
      { key: 'on_hold', label: 'On hold', tone: 'amber' }
    ])
    expect(
      evaluateBadges(rules, { id: 1, $state: { key: 'household', label: 'Household' } }, false)
    ).toEqual([])
  })

  it('an unset yes/no never says Inactive', () => {
    expect(evaluateBadges(rules, { id: 1, is_active: null }, false)).toEqual([])
    expect(evaluateBadges(rules, { id: 1, is_active: 0 }, false).map((b) => b.key)).toEqual([
      'inactive'
    ])
  })

  it('caps at MAX_BADGES, first rules first', () => {
    const row = {
      id: 1,
      is_active: false,
      over_budget: true,
      $state: { key: 'done', is_terminal: true }
    }
    const out = evaluateBadges(rules, row, true)
    expect(out).toHaveLength(MAX_BADGES)
    expect(out.map((b) => b.key)).toEqual(['hidden', 'closed'])
  })

  it('compares two columns and fixed values', () => {
    const gt = normalizeBadgeRule({
      label: 'Over budget',
      when: { field: 'spent', op: 'gt_field', other: 'budget' }
    })
    const inn = normalizeBadgeRule({
      label: 'Retired',
      when: { field: 'status', op: 'in', value: ['retired', 'sold'] }
    })
    if (!gt || !inn) throw new Error('rules')
    expect(evaluateBadges([gt], { spent: '1200.50', budget: 1000 }, false)).toHaveLength(1)
    expect(evaluateBadges([gt], { spent: 900, budget: 1000 }, false)).toHaveLength(0)
    expect(evaluateBadges([gt], { spent: 900, budget: null }, false)).toHaveLength(0)
    expect(evaluateBadges([inn], { status: 'Retired' }, false)).toHaveLength(1)
  })
})
