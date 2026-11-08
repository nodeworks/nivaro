import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/app-links.js', () => ({
  recordLink: vi.fn(
    async (c: string, id: string, o: { recipientUserId?: string; query?: string }) =>
      o.recipientUserId === 'portal-user'
        ? `https://portal.test/records/${c}/${id}${o.query ? `?${o.query}` : ''}`
        : `https://admin.test/collections/${c}/${id}`
  )
}))

import { recordUrlFor, stateMarkerLabel } from '../../../hooks/notification-subscriptions.js'

// Army 4 (2026-11-05): subjects read "Workflow state: waiting_on_manager_approval";
// "View item" sent portal users to the admin host.

describe('stateMarkerLabel', () => {
  it('maps the entered state key to its label', () => {
    expect(
      stateMarkerLabel(
        'Workflow state: waiting_on_manager_approval',
        'waiting_on_manager_approval',
        'Waiting on Level 1 Approval'
      )
    ).toBe('Workflow state: Waiting on Level 1 Approval')
  })
  it('reads any other key as words', () => {
    expect(stateMarkerLabel('Workflow state: waiting_on_po', 'started', 'Started')).toBe(
      'Workflow state: Waiting on po'
    )
  })
  it('leaves a person-written label alone', () => {
    expect(stateMarkerLabel('My zone approvals', 'x_y', 'X')).toBe('My zone approvals')
    expect(stateMarkerLabel(null, 'x_y', 'X')).toBeNull()
  })
})

describe('recordUrlFor', () => {
  it('resolves the link for the recipient', async () => {
    expect(await recordUrlFor('workflows', '372934', 'portal-user')).toBe(
      'https://portal.test/records/workflows/372934'
    )
    expect(await recordUrlFor('workflows', '372934', 'admin-user')).toBe(
      'https://admin.test/collections/workflows/372934'
    )
  })
})

describe('state subscription mail subject (army 11)', () => {
  it('names the record first and the state once', async () => {
    const { subscriptionTransitionSubject } = await import(
      '../../../hooks/notification-subscriptions.js'
    )
    expect(
      subscriptionTransitionSubject('CR26-81439', 'Waiting on Level 1 Approval', 'Kristina Davison')
    ).toBe('CR26-81439 moved to Waiting on Level 1 Approval — by Kristina Davison')
    expect(subscriptionTransitionSubject('CR26-81439', 'Completed', null)).toBe(
      'CR26-81439 moved to Completed'
    )
  })
})
