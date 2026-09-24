import { describe, expect, it } from 'vitest'
import { describeCallTrigger } from './trigger'

const USER = { id: 'U1', name: 'Dana Reyes', email: 'dana@example.com' }

describe('describeCallTrigger — Task 15e (Recent calls Triggered-by)', () => {
  it('a resolved user always wins over the raw triggered_by string', () => {
    expect(describeCallTrigger('cron:nami-sync', USER)).toEqual({
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
    expect(describeCallTrigger('cron:nami-sync', null)).toEqual({
      kind: 'scheduled',
      label: 'Scheduled — Nami sync'
    })
    expect(describeCallTrigger('extension:efp-ops', null)).toEqual({
      kind: 'machine',
      label: 'Extension — efp-ops'
    })
    expect(describeCallTrigger('custom-action:7', null)).toEqual({
      kind: 'machine',
      label: 'Custom action #7'
    })
    expect(describeCallTrigger('item-action:push-to-fusion', null)).toEqual({
      kind: 'machine',
      label: 'Item action — Push to fusion'
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
