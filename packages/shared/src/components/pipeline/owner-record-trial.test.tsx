// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type OwnerPreviewStep, OwnerTrialStrip, type PreviewStepOwners } from './OwnerRecordTrial'
import {
  cloneGroupsMap,
  draftAddUser,
  draftDelta,
  draftRemoveUser,
  draftSaveOps,
  isDraftGroupId
} from './owner-matrix-draft'
import type { PipelineOwnerGroupsMap } from './types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const owners = (o: Partial<PreviewStepOwners> = {}): PreviewStepOwners => ({
  owners: [],
  no_assigned_owner: false,
  match: { kind: 'match', group: null, facts: [], inherited: [], override: [], outranked: 0 },
  delegations: [],
  why: [],
  ...o
})

const person = (id: string, name: string, via: 'group' | 'stand_in' = 'group') => ({
  id,
  name,
  email: null,
  via,
  delegate_for: null,
  inactive: false
})

const step = (
  key: string,
  saved: PreviewStepOwners,
  draft: PreviewStepOwners | null = null,
  extra: Partial<OwnerPreviewStep['state']> = {}
): OwnerPreviewStep => ({
  state: {
    id: `s-${key}`,
    key,
    label: key,
    color: null,
    is_current: false,
    is_terminal: false,
    owners_not_required: false,
    ...extra
  },
  saved,
  draft,
  changed: !!draft
})

describe('OwnerTrialStrip', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('renders owner chips per step and warns on a step with no assigned owner', () => {
    const steps = [
      step('submitted', owners({ owners: [person('u1', 'Erin East')] })),
      step(
        'warehouse',
        owners({
          no_assigned_owner: true,
          match: {
            kind: 'no_match',
            group: null,
            facts: [],
            inherited: [],
            override: [],
            outranked: 0
          },
          owners: [person('u9', 'Cam Creator', 'stand_in')]
        }),
        null,
        { is_current: true }
      ),
      step('done', owners({ no_assigned_owner: true }), null, { is_terminal: true })
    ]
    act(() => root.render(<OwnerTrialStrip steps={steps} />))
    const cards = [...host.querySelectorAll('[data-step]')]
    expect(cards.map((c) => c.getAttribute('data-step'))).toEqual([
      'submitted',
      'warehouse',
      'done'
    ])
    expect(cards[0].textContent).toContain('Erin East')
    expect(cards[0].getAttribute('data-no-owner')).toBeNull()
    expect(cards[1].getAttribute('data-no-owner')).toBe('true')
    expect(cards[1].textContent).toContain('No assigned owner — only a stand-in')
    expect(cards[1].textContent).toContain('stand-in')
    expect(cards[1].textContent).toContain('Now')
    // A final step never warns.
    expect(cards[2].getAttribute('data-no-owner')).toBeNull()
    expect(cards[2].textContent).toContain('Final step')
  })

  it('shows the draft answer with what the saved matrix said', () => {
    const steps = [
      step(
        'warehouse',
        owners({ no_assigned_owner: true }),
        owners({ owners: [person('u3', 'Wanda House')] })
      )
    ]
    act(() => root.render(<OwnerTrialStrip steps={steps} />))
    const card = host.querySelector('[data-step="warehouse"]')
    expect(card?.textContent).toContain('Draft')
    expect(card?.textContent).toContain('Wanda House')
    expect(card?.textContent).toContain('Saved:')
    expect(card?.textContent).toContain('nobody')
    expect(card?.getAttribute('data-no-owner')).toBeNull()
  })
})

describe('owner matrix draft', () => {
  const saved: PipelineOwnerGroupsMap = {
    s1: [
      {
        id: 'g1',
        template: 't',
        state: 's1',
        name: null,
        filters: [{ field: 'zone', op: 'eq', value: 'East' }],
        sort: 0,
        is_default: false,
        priority: 0,
        max_wip: null,
        users: [
          {
            id: 1,
            link_id: 11,
            group: 'g1',
            user: 'u1',
            first_name: 'Erin',
            last_name: null,
            email: 'e@x'
          }
        ],
        teams: []
      }
    ]
  }

  it('adds a person to a new cell as a draft group, and Save creates it then adds them', () => {
    const draft = draftAddUser(cloneGroupsMap(saved), {
      stateId: 's2',
      groupId: null,
      filters: [{ field: 'zone', op: 'eq', value: 'West' }],
      user: { id: 'u2', first_name: 'Wes', last_name: null, email: 'w@x' }
    })
    expect(saved.s2).toBeUndefined()
    const delta = draftDelta(saved, draft)
    expect(delta).toHaveLength(1)
    expect(isDraftGroupId(delta[0].id)).toBe(true)
    expect(delta[0]).toMatchObject({ state: 's2', users: ['u2'] })
    expect(draftSaveOps(saved, draft).map((o) => o.kind)).toEqual(['create', 'add-user'])
  })

  it('removing a saved member is a change, and Save removes that link', () => {
    const draft = draftRemoveUser(cloneGroupsMap(saved), 11)
    expect(draftDelta(saved, draft)).toEqual([expect.objectContaining({ id: 'g1', users: [] })])
    expect(draftSaveOps(saved, draft)).toEqual([{ kind: 'remove-user', linkId: 11 }])
    // An untouched copy is no change at all.
    expect(draftDelta(saved, cloneGroupsMap(saved))).toEqual([])
  })
})
