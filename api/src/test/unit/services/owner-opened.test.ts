import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwnersBatch: vi.fn(),
  coerceBool: (v: unknown) => v === true || v === 1
}))
vi.mock('../../../services/branch-instances.js', () => ({ findRecordInstance: vi.fn() }))

import {
  type DirectoryPerson,
  decideOwnerOpened,
  delegationActiveAt,
  MOVER_GRACE_MS,
  type OwnerDelegation,
  ownersWhoOpened,
  type ViewMarks,
  viewerOwnsStep
} from '../../../services/owner-opened.js'

const H = 3_600_000
const ENTERED = Date.UTC(2026, 10, 14, 12, 0, 0)
const JANE = 'aaaaaaaa-0000-0000-0000-000000000001'
const MARK = 'aaaaaaaa-0000-0000-0000-000000000002'
const REQUESTER = 'aaaaaaaa-0000-0000-0000-000000000009'
const state = { id: 's-approve', label: 'Finance approval' }

const views = (entries: Array<[string, number]>) =>
  new Map<string, ViewMarks>(entries.map(([u, t]) => [u.toUpperCase(), { last: t, prev: null }]))

const base = {
  viewerId: REQUESTER,
  state,
  enteredAt: ENTERED,
  mover: REQUESTER,
  ownerIds: [JANE, MARK]
}

describe('ownersWhoOpened', () => {
  it('counts an owner whose last open is at or after the step entry', () => {
    const out = ownersWhoOpened({
      ...base,
      views: views([
        [JANE, ENTERED + 2 * H],
        [MARK, ENTERED - 1]
      ])
    })
    expect(out).toEqual([{ id: JANE, at: ENTERED + 2 * H }])
  })

  it('an open before the record entered this step does not count', () => {
    expect(ownersWhoOpened({ ...base, views: views([[JANE, ENTERED - H]]) })).toEqual([])
  })

  it('matches user ids regardless of case and lists newest open first', () => {
    const out = ownersWhoOpened({
      ...base,
      ownerIds: [JANE.toLowerCase(), MARK.toLowerCase()],
      views: views([
        [JANE, ENTERED + H],
        [MARK, ENTERED + 3 * H]
      ])
    })
    expect(out.map((o) => o.id)).toEqual([MARK.toLowerCase(), JANE.toLowerCase()])
  })

  it('the mover who also owns the step counts only on a later visit', () => {
    const stayed = ownersWhoOpened({
      ...base,
      mover: JANE,
      views: views([[JANE, ENTERED + 5 * 60_000]])
    })
    expect(stayed).toEqual([])
    const came = ownersWhoOpened({
      ...base,
      mover: JANE,
      views: views([[JANE, ENTERED + MOVER_GRACE_MS + 1]])
    })
    expect(came).toHaveLength(1)
  })
})

describe('decideOwnerOpened', () => {
  const jane = {
    id: JANE,
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane@example.com',
    department: 'Finance',
    title: 'Analyst'
  }

  it('no owners: nothing to say', () => {
    expect(
      decideOwnerOpened({ ...base, ownerIds: [], views: new Map(), listed: new Map() })
    ).toEqual({ status: 'none' })
  })

  it('a viewer who owns the step gets `owner` (the panel shows nothing)', () => {
    expect(
      decideOwnerOpened({
        ...base,
        viewerId: JANE.toLowerCase(),
        views: new Map(),
        listed: new Map()
      })
    ).toEqual({ status: 'owner' })
  })

  it('not opened yet', () => {
    expect(decideOwnerOpened({ ...base, views: new Map(), listed: new Map() })).toEqual({
      status: 'not_opened',
      state,
      entered_at: new Date(ENTERED).toISOString()
    })
  })

  it('names the opener with their department and counts the others', () => {
    const out = decideOwnerOpened({
      ...base,
      views: views([
        [JANE, ENTERED + 2 * H],
        [MARK, ENTERED + H]
      ]),
      listed: new Map<string, DirectoryPerson>([
        [JANE.toUpperCase(), jane],
        [MARK.toUpperCase(), { id: MARK, first_name: 'Mark', last_name: 'Lee' }]
      ])
    })
    expect(out).toEqual({
      status: 'opened',
      state,
      entered_at: new Date(ENTERED).toISOString(),
      opened_at: new Date(ENTERED + 2 * H).toISOString(),
      by: { id: JANE, name: 'Jane Smith', group: 'Finance', covering_for: null },
      delegate: false,
      others: 1
    })
  })

  it('falls back to the job title, then to no group', () => {
    const titled = decideOwnerOpened({
      ...base,
      views: views([[JANE, ENTERED + H]]),
      listed: new Map([[JANE.toUpperCase(), { ...jane, department: '' }]])
    })
    expect(titled.status === 'opened' && titled.by?.group).toBe('Analyst')
    const bare = decideOwnerOpened({
      ...base,
      views: views([[JANE, ENTERED + H]]),
      listed: new Map([[JANE.toUpperCase(), { id: JANE, first_name: 'Jane', last_name: null }]])
    })
    expect(bare.status === 'opened' && bare.by).toEqual({
      id: JANE,
      name: 'Jane',
      group: null,
      covering_for: null
    })
  })

  it('never names someone the people directory does not list', () => {
    // Mark (newest open) is suspended / redacted: not in `listed`. Jane is named instead.
    const out = decideOwnerOpened({
      ...base,
      views: views([
        [JANE, ENTERED + H],
        [MARK, ENTERED + 3 * H]
      ]),
      listed: new Map([[JANE.toUpperCase(), jane]])
    })
    expect(out.status === 'opened' && out.by?.id).toBe(JANE)
    expect(out.status === 'opened' && out.opened_at).toBe(new Date(ENTERED + H).toISOString())
    // Nobody listed: the newest open stands unnamed.
    const anon = decideOwnerOpened({
      ...base,
      views: views([[MARK, ENTERED + 3 * H]]),
      listed: new Map()
    })
    expect(anon).toMatchObject({
      status: 'opened',
      by: null,
      others: 0,
      opened_at: new Date(ENTERED + 3 * H).toISOString()
    })
  })

  it('admins get the same answer as anyone else (no viewer-role input)', () => {
    const a = decideOwnerOpened({ ...base, views: new Map(), listed: new Map() })
    const b = decideOwnerOpened({
      ...base,
      viewerId: 'bbbbbbbb-0000-0000-0000-000000000001',
      views: new Map(),
      listed: new Map()
    })
    expect(a).toEqual(b)
  })
})

describe('delegates covering an out-of-office owner', () => {
  const DELEGATE = 'aaaaaaaa-0000-0000-0000-000000000003'
  const NOW = ENTERED + 10 * H
  const jane = { id: JANE, first_name: 'Jane', last_name: 'Smith', department: 'Finance' }
  const mark = { id: DELEGATE, first_name: 'Mark', last_name: 'Lee', department: 'Ops' }
  const listedBoth = new Map<string, DirectoryPerson>([
    [JANE.toUpperCase(), jane],
    [DELEGATE.toUpperCase(), mark]
  ])
  const outAll: OwnerDelegation = {
    ownerId: JANE,
    delegateId: DELEGATE,
    expiresAt: null,
    outFrom: ENTERED - 24 * H,
    outTo: null,
    outNow: true
  }
  const one = { ...base, ownerIds: [JANE], now: NOW }

  it('names the delegate and who they covered for', () => {
    const out = decideOwnerOpened({
      ...one,
      views: views([[DELEGATE, ENTERED + 2 * H]]),
      listed: listedBoth,
      delegations: [outAll]
    })
    expect(out).toMatchObject({
      status: 'opened',
      delegate: true,
      opened_at: new Date(ENTERED + 2 * H).toISOString(),
      by: { id: DELEGATE, name: 'Mark Lee', covering_for: 'Jane Smith' },
      others: 0
    })
  })

  it('only while the delegation was active at the time of the view', () => {
    // Back from the window before the delegate looked.
    const back = { ...outAll, outTo: ENTERED + H, outNow: false }
    expect(
      ownersWhoOpened({ ...one, views: views([[DELEGATE, ENTERED + 2 * H]]), delegations: [back] })
    ).toEqual([])
    // Delegation expired before the view.
    const expired = { ...outAll, expiresAt: ENTERED + H }
    expect(
      ownersWhoOpened({
        ...one,
        views: views([[DELEGATE, ENTERED + 2 * H]]),
        delegations: [expired]
      })
    ).toEqual([])
    // The older open (prev) fell inside the window: that one counts.
    const viewsBoth = new Map<string, ViewMarks>([
      [DELEGATE.toUpperCase(), { last: ENTERED + 3 * H, prev: ENTERED + 0.5 * H }]
    ])
    expect(ownersWhoOpened({ ...one, views: viewsBoth, delegations: [back] })).toEqual([
      { id: DELEGATE, at: ENTERED + 0.5 * H, coveringFor: JANE }
    ])
  })

  it('no recorded window: counts only while the owner is out now', () => {
    const manual = { ...outAll, outFrom: null }
    const v = views([[DELEGATE, ENTERED + 2 * H]])
    expect(ownersWhoOpened({ ...one, views: v, delegations: [manual] })).toHaveLength(1)
    expect(
      ownersWhoOpened({ ...one, views: v, delegations: [{ ...manual, outNow: false }] })
    ).toEqual([])
  })

  it('a delegate who owns the step too counts as an owner, not as covering', () => {
    const out = decideOwnerOpened({
      ...base,
      ownerIds: [JANE, DELEGATE],
      now: NOW,
      views: views([[DELEGATE, ENTERED + 2 * H]]),
      listed: listedBoth,
      delegations: [outAll]
    })
    expect(out).toMatchObject({ delegate: false, by: { id: DELEGATE, covering_for: null } })
  })

  it('an unlisted owner is covered anonymously', () => {
    const out = decideOwnerOpened({
      ...one,
      views: views([[DELEGATE, ENTERED + 2 * H]]),
      listed: new Map([[DELEGATE.toUpperCase(), mark]]),
      delegations: [outAll]
    })
    expect(out.status === 'opened' && out.by?.covering_for).toBe('an owner of this step')
  })

  it('a delegate only counts for the step’s own owners', () => {
    const other = { ...outAll, ownerId: MARK }
    expect(
      ownersWhoOpened({ ...one, views: views([[DELEGATE, ENTERED + H]]), delegations: [other] })
    ).toEqual([])
  })

  it('the working delegate viewing now owns the step (the panel shows nothing)', () => {
    expect(viewerOwnsStep(DELEGATE, [JANE], [outAll], NOW)).toBe(true)
    expect(viewerOwnsStep(DELEGATE, [JANE], [{ ...outAll, outTo: NOW - H }], NOW)).toBe(false)
    expect(
      decideOwnerOpened({
        ...one,
        viewerId: DELEGATE,
        views: new Map(),
        listed: new Map(),
        delegations: [outAll]
      })
    ).toEqual({ status: 'owner' })
  })

  it('delegationActiveAt never looks into the future', () => {
    expect(delegationActiveAt(outAll, NOW + 1, NOW)).toBe(false)
  })
})
