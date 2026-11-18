import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SyncOptions } from './api'
import { PriorityLanesCard, SimilarCard, SyncOptionsCard } from './SyncCards'

const SYNC: SyncOptions = {
  status_map: { closed: 'resolved' },
  close_on_resolve: true,
  reopen_on_recur: true,
  recur_when_closed: 'reopen',
  comments: true,
  seen_note: true,
  seen_note_min_minutes: 60,
  labels: { always: [], by_severity: {}, by_source: {}, on_example: [] },
  similar: { enabled: true, join_at: 0.88, suggest_at: 0.78 },
  priority_map: {},
  lane_map: {},
  priority_two_way: true,
  lanes_two_way: true,
  push_to_linked: false,
  ticket_priority_map: {},
  ticket_lane_map: {},
  create_roles: [],
  sources: { issue: true, ticket: true, record: true }
}

const ROLES = [
  { id: 'R-ADMIN', name: 'Administrator' },
  { id: 'R-SUP', name: 'Support desk' }
]

describe('PriorityLanesCard', () => {
  it('warns when one label is used twice', () => {
    render(
      <PriorityLanesCard
        sync={{ ...SYNC, priority_map: { high: 'P1', low: 'P4' }, lane_map: { open: 'p1' } }}
        labels={[]}
        onChange={() => {}}
      />
    )
    expect(screen.getByRole('alert').textContent).toMatch(/“P1” is used twice/)
  })

  it('says nothing when every label is distinct', () => {
    render(
      <PriorityLanesCard
        sync={{ ...SYNC, priority_map: { high: 'P1' }, lane_map: { open: 'Doing' } }}
        labels={[]}
        onChange={() => {}}
      />
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the support-ticket maps only while tickets sync', () => {
    const { rerender } = render(<PriorityLanesCard sync={SYNC} labels={[]} onChange={() => {}} />)
    expect(screen.getByText('Support tickets')).toBeTruthy()
    rerender(
      <PriorityLanesCard
        sync={{ ...SYNC, sources: { ...SYNC.sources, ticket: false } }}
        labels={[]}
        onChange={() => {}}
      />
    )
    expect(screen.queryByText('Support tickets')).toBeNull()
  })
})

describe('SyncOptionsCard', () => {
  it('switches each source on its own', () => {
    const onChange = vi.fn()
    render(<SyncOptionsCard sync={SYNC} roles={ROLES} onChange={onChange} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Support tickets' }))
    expect(onChange).toHaveBeenCalledWith({ sources: { issue: true, ticket: false, record: true } })
  })

  it('offers pushing to issues people wrote, off by default', () => {
    const onChange = vi.fn()
    render(<SyncOptionsCard sync={SYNC} roles={ROLES} onChange={onChange} />)
    const sw = screen.getByRole('switch', { name: 'Also change GitLab issues people wrote' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith({ push_to_linked: true })
  })

  it('names the chosen create roles', () => {
    render(
      <SyncOptionsCard
        sync={{ ...SYNC, create_roles: ['R-SUP'] }}
        roles={ROLES}
        onChange={() => {}}
      />
    )
    expect(screen.getByText('Support desk')).toBeTruthy()
  })
})

describe('SimilarCard', () => {
  it('keeps "suggest at" at or below "join at"', () => {
    const onChange = vi.fn()
    render(<SimilarCard sync={SYNC} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/Join at/), { target: { value: '0.7' } })
    expect(onChange).toHaveBeenCalledWith({
      similar: { enabled: true, join_at: 0.7, suggest_at: 0.7 }
    })
  })
})
