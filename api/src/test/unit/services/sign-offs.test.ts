import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: {} }))

import {
  branchSignOffs,
  chainSignOffs,
  type SignOffPerson,
  signOffName
} from '../../../services/sign-offs.js'

const people = new Map<string, SignOffPerson>([
  ['U-ANA', { id: 'u-ana', first_name: 'Ana', last_name: 'Ruiz', email: 'ana@x.test' }],
  ['U-BEN', { id: 'u-ben', first_name: 'Ben', last_name: 'Ko', email: 'ben@x.test' }],
  ['U-GONE', { id: 'u-gone', first_name: 'Old', last_name: 'Name', is_redacted: 1 }]
])

const step = (by: string | null, byId: string | null, at: string) => ({
  state: { id: 's', label: 's', color: null },
  entered_at: at,
  left_at: null,
  by,
  by_id: byId
})

describe('signOffName', () => {
  it('a redacted account reads "Former user", flagged or renamed', () => {
    expect(signOffName(people.get('U-GONE'), 'Old Name')).toBe('Former user')
    expect(signOffName(undefined, 'Redacted Redacted')).toBe('Former user')
    expect(signOffName(people.get('U-ANA'), null)).toBe('Ana Ruiz')
  })
})

describe('branchSignOffs', () => {
  const lanes = [
    {
      label: 'Legal',
      terminal: true,
      finished_at: '2026-11-12T15:00:00.000Z',
      steps: [step(null, null, 'a'), step('Ben Ko', 'u-ben', '2026-11-12T15:00:00.000Z')]
    },
    {
      label: 'Security',
      terminal: true,
      finished_at: '2026-11-12T16:00:00.000Z',
      steps: [step('Old Name', 'u-gone', '2026-11-12T16:00:00.000Z')]
    },
    {
      label: 'Finance',
      terminal: false,
      finished_at: null,
      steps: [step(null, null, 'a')],
      owners: [{ id: 'u-ana', name: 'Ana Ruiz' }]
    }
  ]

  it('an open split with three branches: 2 of 3 signed, waiting on the open one', () => {
    const s = branchSignOffs({ open: true, lanes }, people)
    expect(s).toMatchObject({ kind: 'branches', required: 3, signed: 2 })
    expect(s?.waiting).toEqual([{ label: 'Finance', names: ['Ana Ruiz'], more: 0 }])
    expect(s?.signers).toEqual([
      { label: 'Legal', name: 'Ben Ko', at: '2026-11-12T15:00:00.000Z' },
      { label: 'Security', name: 'Former user', at: '2026-11-12T16:00:00.000Z' }
    ])
  })

  it('nothing for a joined split or a single branch', () => {
    expect(branchSignOffs({ open: false, lanes }, people)).toBeNull()
    expect(branchSignOffs({ open: true, lanes: [lanes[2]] }, people)).toBeNull()
    expect(branchSignOffs(null, people)).toBeNull()
  })

  it('caps the waiting names and counts the rest', () => {
    const s = branchSignOffs(
      {
        open: true,
        lanes: [
          lanes[0],
          {
            ...lanes[2],
            owners: [
              { id: 'u-ana', name: 'Ana Ruiz' },
              { id: 'u-ben', name: 'Ben Ko' },
              { id: 'u-3', name: 'Cy Doe' },
              { id: 'u-4', name: 'Di Fox' }
            ]
          }
        ]
      },
      people
    )
    expect(s?.waiting[0]).toEqual({ label: 'Finance', names: ['Ana Ruiz', 'Ben Ko'], more: 2 })
  })
})

describe('chainSignOffs', () => {
  const steps = [
    { step_order: 0, label: 'Manager', approver: 'u-ben', approver_role: null },
    { step_order: 1, label: 'Finance', approver: 'u-ana', approver_role: null },
    { step_order: 2, label: null, approver: null, approver_role: 'r-exec' }
  ]

  it('approved steps are signed; the current step names its approver', () => {
    const s = chainSignOffs({
      name: 'Spend approval',
      currentStep: 1,
      steps,
      decisions: [
        { step_order: 0, user: 'u-ben', decision: 'approved', decided_at: '2026-11-12T10:00:00Z' }
      ],
      people,
      roleNames: new Map([['R-EXEC', 'Executives']])
    })
    expect(s).toMatchObject({ kind: 'chain', title: 'Spend approval', required: 3, signed: 1 })
    expect(s?.waiting).toEqual([{ label: 'Finance', names: ['Ana Ruiz'], more: 0 }])
    expect(s?.signers[0]).toEqual({
      label: 'Manager',
      name: 'Ben Ko',
      at: '2026-11-12T10:00:00.000Z'
    })
  })

  it('a role step waits on anyone in that role', () => {
    const s = chainSignOffs({
      name: null,
      currentStep: 2,
      steps,
      decisions: [
        { step_order: 0, user: 'u-ben', decision: 'approved', decided_at: '2026-11-12T10:00:00Z' },
        { step_order: 1, user: 'u-ana', decision: 'approved', decided_at: '2026-11-12T11:00:00Z' }
      ],
      people,
      roleNames: new Map([['R-EXEC', 'Executives']])
    })
    expect(s?.signed).toBe(2)
    expect(s?.waiting).toEqual([{ label: 'Step 3', names: ['anyone in Executives'], more: 0 }])
  })

  it('a single-step chain shows nothing new', () => {
    expect(
      chainSignOffs({
        name: null,
        currentStep: 0,
        steps: [steps[0]],
        decisions: [],
        people,
        roleNames: new Map()
      })
    ).toBeNull()
  })
})
