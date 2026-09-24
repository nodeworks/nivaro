import { describe, expect, it } from 'vitest'
import { callTriggerRequester, describeCallTrigger } from './trigger'

const USER = {
  id: 'U1',
  name: 'Dana Reyes',
  email: 'dana@example.com',
  inactive: null,
  account_kind: null
}
const SUSPENDED_USER = {
  id: 'U2',
  name: 'Old Integration',
  email: 'old@example.com',
  inactive: 'suspended',
  account_kind: null
}
const MACHINE_USER = {
  id: 'U3',
  name: 'Sync Bot',
  email: null,
  inactive: null,
  account_kind: 'integration'
}

describe('describeCallTrigger — Task 15e (Recent calls Triggered-by)', () => {
  it('a resolved user always wins over the raw triggered_by string', () => {
    expect(describeCallTrigger('cron:inventory-sync', USER)).toEqual({
      kind: 'person',
      label: 'Dana Reyes'
    })
  })

  it('reads the recorded named triggers as plain words, not raw machine strings', () => {
    expect(describeCallTrigger('test', null)).toEqual({ kind: 'machine', label: 'The Test button' })
    expect(describeCallTrigger('transition-action', null)).toEqual({
      kind: 'machine',
      label: 'A transition action'
    })
    expect(describeCallTrigger('contract', null)).toEqual({
      kind: 'scheduled',
      label: 'A contract check'
    })
  })

  it('a prefixed trigger names its id — flow, cron, extension, custom action, item action', () => {
    expect(describeCallTrigger('flow:42', null)).toEqual({ kind: 'flow', label: 'Flow #42' })
    expect(describeCallTrigger('cron:inventory-sync', null)).toEqual({
      kind: 'scheduled',
      label: 'Scheduled — Inventory sync'
    })
    expect(describeCallTrigger('extension:ops-toolkit', null)).toEqual({
      kind: 'machine',
      label: 'Extension — ops-toolkit'
    })
    expect(describeCallTrigger('custom-action:7', null)).toEqual({
      kind: 'machine',
      label: 'Custom action #7'
    })
    expect(describeCallTrigger('item-action:push-to-warehouse', null)).toEqual({
      kind: 'machine',
      label: 'Item action — Push to warehouse'
    })
  })

  it('an unknown string is shown verbatim rather than swallowed', () => {
    expect(describeCallTrigger('something-new', null)).toEqual({
      kind: 'unknown',
      label: 'something-new'
    })
  })

  it('nothing recorded at all reads as "Not recorded"', () => {
    expect(describeCallTrigger(null, null)).toEqual({ kind: 'unknown', label: 'Not recorded' })
    expect(describeCallTrigger('', null)).toEqual({ kind: 'unknown', label: 'Not recorded' })
  })
})

describe('callTriggerRequester — adapts a call trigger into the push drill-down Requester shape', () => {
  it('a resolved user is basis "recorded", never "inferred" — a call trigger is never an inference', () => {
    expect(callTriggerRequester('cron:inventory-sync', USER)).toEqual({
      kind: 'person',
      basis: 'recorded',
      label: 'Dana Reyes',
      user: USER,
      via: null,
      how: null
    })
  })

  it('a suspended/machine user carries their inactive/account_kind facts through, unchanged', () => {
    expect(callTriggerRequester('erp-submission', SUSPENDED_USER).user).toEqual(SUSPENDED_USER)
    expect(callTriggerRequester('erp-submission', MACHINE_USER).user).toEqual(MACHINE_USER)
  })

  it('a machine/scheduled/flow trigger carries no user, even if one happened to be passed for an unrelated row', () => {
    const r = callTriggerRequester('flow:42', null)
    expect(r).toEqual({
      kind: 'flow',
      basis: 'recorded',
      label: 'Flow #42',
      user: null,
      via: null,
      how: null
    })
  })

  it('a recognized-but-unmapped string is still basis "recorded" — it IS what was stored', () => {
    expect(callTriggerRequester('something-new', null)).toEqual({
      kind: 'unknown',
      basis: 'recorded',
      label: 'something-new',
      user: null,
      via: null,
      how: null
    })
  })

  it('nothing stored at all is basis "none"', () => {
    expect(callTriggerRequester(null, null)).toEqual({
      kind: 'unknown',
      basis: 'none',
      label: 'Not recorded',
      user: null,
      via: null,
      how: null
    })
  })
})
