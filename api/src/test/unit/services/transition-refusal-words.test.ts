import { describe, expect, it } from 'vitest'
import {
  automaticMessage,
  completedMessage,
  conditionsMessage,
  conditionsToStepMessage,
  describeConditionRule,
  notFromHereMessage,
  roleMessage
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
