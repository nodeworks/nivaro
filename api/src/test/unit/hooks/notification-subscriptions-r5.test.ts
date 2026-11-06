import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/app-links.js', () => ({
  recordLink: vi.fn(async (c: string, id: string) => `https://admin.test/collections/${c}/${id}`)
}))

import { activeSubscribers, stateMarkerLabel } from '../../../hooks/notification-subscriptions.js'

// Army 5 (2026-11-06): b06-N4 a suspended person still got state-subscription
// mail; b06-N5 / b13-N2 one-word state keys stayed raw in the subject.

describe('stateMarkerLabel — one-word keys', () => {
  it.each([
    ['started', 'Started'],
    ['completed', 'Completed'],
    ['canceled', 'Canceled']
  ])('maps "%s" to its label', (key, label) => {
    expect(stateMarkerLabel(`Workflow state: ${key}`, key, label)).toBe(`Workflow state: ${label}`)
  })
  it('leaves another one-word tail as written', () => {
    expect(stateMarkerLabel('Workflow state: started', 'completed', 'Completed')).toBe(
      'Workflow state: started'
    )
    expect(stateMarkerLabel('Alerts: urgent', 'started', 'Started')).toBe('Alerts: urgent')
  })
  it('multi-word keys keep working', () => {
    expect(stateMarkerLabel('Workflow state: waiting_on_po', 'started', 'Started')).toBe(
      'Workflow state: Waiting on po'
    )
  })
})

describe('activeSubscribers', () => {
  it('drops suspended, archived and redacted people', () => {
    const rows = [
      { id: 1, status: 'active', is_redacted: false, first_name: 'Tim', last_name: 'D' },
      { id: 2, status: 'suspended', is_redacted: false, first_name: 'Joseph', last_name: 'P' },
      { id: 3, status: 'active', is_redacted: 1, first_name: 'A', last_name: 'B' },
      { id: 4, status: 'active', is_redacted: null, first_name: 'Redacted', last_name: 'Redacted' },
      { id: 5, status: 'archived', is_redacted: null, first_name: 'C', last_name: 'D' },
      { id: 6, status: null, is_redacted: null, first_name: 'Andrew', last_name: 'F' }
    ]
    expect(activeSubscribers(rows).map((r) => r.id)).toEqual([1, 6])
  })
})
