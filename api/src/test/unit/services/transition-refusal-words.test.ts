import { beforeEach, describe, expect, it, vi } from 'vitest'

const perm = vi.hoisted(() => ({
  fields: vi.fn(async () => ['id', 'vendor'] as string[] | null),
  can: vi.fn(async (_u: unknown, _a: string, c: string) => c === 'workflow_line_items')
}))
vi.mock('../../../services/permissions.js', () => ({
  getAllowedFields: perm.fields,
  can: perm.can
}))

import {
  automaticMessage,
  completedMessage,
  conditionsMessage,
  conditionsToStepMessage,
  describeConditionRule,
  notFromHereMessage,
  roleMessage,
  visibleUnmetRules
} from '../../../services/transition-refusal-words.js'

// The words a refused pipeline move answers with (GraphQL, REST, bulk): each
// names the move, where the record is, and what would let it run.

const lines = { field: 'workflow_line_items:workflow', op: 'related_some', value: null }

describe('transition refusal words', () => {
  it('conditions name every unmet rule', () => {
    expect(
      conditionsMessage('Submit', [lines, { field: 'vendor', op: 'nnull', value: null }])
    ).toBe(
      '"Submit" can\'t run yet. Needs at least one Workflow Line Items row. Vendor must be set.'
    )
  })

  it('conditions with nothing to name still say what happened', () => {
    expect(conditionsMessage(null, [])).toBe(
      "This move can't run yet: this record doesn't meet its conditions."
    )
  })

  it('one branch left: no numbered list; duplicates fold', () => {
    expect(conditionsToStepMessage('Waiting on Level 1 Approval', [[lines], [lines]])).toBe(
      'Can\'t move to "Waiting on Level 1 Approval" yet. Needs at least one Workflow Line Items row.'
    )
  })

  it('the other refusals name the move and the steps', () => {
    expect(completedMessage('Submit', 'Canceled')).toBe(
      'This record\'s pipeline has ended at "Canceled", so "Submit" can\'t run. It has to be reopened before it can move again.'
    )
    expect(notFromHereMessage('Submit', 'Canceled', 'Started')).toBe(
      '"Submit" can\'t run from "Canceled". It only runs from "Started".'
    )
    expect(automaticMessage('Close out')).toBe(
      '"Close out" runs automatically when its conditions are met; it can\'t be made by hand.'
    )
    expect(roleMessage('Approve', ['Manager', 'Admin'])).toBe(
      'Your role can\'t make "Approve". Roles that can: Manager, Admin.'
    )
  })

  it('virtual condition fields read as sentences', () => {
    expect(describeConditionRule({ field: '$state', op: 'eq', value: 'started' })).toBe(
      'The record must be at step started'
    )
    expect(
      describeConditionRule({ field: 'tasks:workflow', op: 'children_in_state', value: 'done' })
    ).toBe('Every Tasks row must be at done')
  })
})

describe('visibleUnmetRules: a refusal never names a rule on a field the caller cannot read', () => {
  const user = { id: 'U', role: 'R' } as never
  const salary = { field: 'salary', op: 'lt', value: '100000' }
  const vendor = { field: 'vendor', op: 'nnull', value: null }
  const secret = { field: 'secret_notes:workflow', op: 'related_none', value: '{"kind":"x"}' }
  const hop = { field: 'project.budget_owner', op: 'nnull', value: null }

  beforeEach(() => {
    perm.fields.mockReset().mockResolvedValue(['id', 'vendor'])
    perm.can.mockReset().mockImplementation(async (_u, _a, c) => c === 'workflow_line_items')
  })

  it('readable fields and child collections are named; the rest fold into one placeholder', async () => {
    const out = await visibleUnmetRules(user, false, 'workflows', [
      vendor,
      salary,
      lines,
      secret,
      hop
    ])
    expect(out).toEqual([vendor, lines, { field: '$hidden', op: 'hidden', value: null }])
    expect(conditionsMessage('Submit', out)).toBe(
      '"Submit" can\'t run yet. Vendor must be set. Needs at least one Workflow Line Items row. A condition you can\'t see is not met.'
    )
  })

  it('administrators see every rule', async () => {
    const all = [salary, secret, hop]
    expect(await visibleUnmetRules(user, true, 'workflows', all)).toBe(all)
    expect(perm.fields).not.toHaveBeenCalled()
  })

  it('a failed permission read hides the rule (fail closed)', async () => {
    perm.fields.mockRejectedValue(new Error('db down'))
    expect(await visibleUnmetRules(user, false, 'workflows', [vendor])).toEqual([
      { field: '$hidden', op: 'hidden', value: null }
    ])
  })

  it('no signed-in caller sees no rule', async () => {
    expect(await visibleUnmetRules(undefined, false, 'workflows', [vendor])).toEqual([
      { field: '$hidden', op: 'hidden', value: null }
    ])
  })
})
