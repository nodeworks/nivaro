import { describe, expect, it } from 'vitest'
import { dedupeChooserKeys } from './column-chooser'

const LABELS: Record<string, string> = {
  state: 'State',
  aging_hours: 'Aging',
  state_entered: 'Last State Change',
  'extra.last_state_change': 'Last State Change',
  'extra.created': 'Created',
  tasks: 'Tasks'
}
const labelOf = (k: string) => LABELS[k] ?? k
const KEYS = [
  'state',
  'aging_hours',
  'state_entered',
  'extra.created',
  'tasks',
  'extra.last_state_change'
]

describe('dedupeChooserKeys (army 4 a06-5)', () => {
  it('lists "Last State Change" once — the visible one', () => {
    const out = dedupeChooserKeys(KEYS, labelOf, new Set(['state', 'state_entered']))
    expect(out).toEqual(['state', 'aging_hours', 'state_entered', 'extra.created', 'tasks'])
  })

  it('keeps the visible legacy column when that is the one on screen', () => {
    const out = dedupeChooserKeys(KEYS, labelOf, new Set(['extra.last_state_change']))
    expect(out).toContain('extra.last_state_change')
    expect(out).not.toContain('state_entered')
  })

  it('prefers the built-in when neither is shown', () => {
    expect(dedupeChooserKeys(KEYS, labelOf, new Set())).not.toContain('extra.last_state_change')
  })

  it('never hides a visible column, even a duplicate', () => {
    const out = dedupeChooserKeys(
      KEYS,
      labelOf,
      new Set(['state_entered', 'extra.last_state_change'])
    )
    expect(out).toContain('state_entered')
    expect(out).toContain('extra.last_state_change')
  })

  it('leaves distinct labels alone', () => {
    expect(dedupeChooserKeys(['a', 'b'], (k) => k, new Set())).toEqual(['a', 'b'])
  })
})
