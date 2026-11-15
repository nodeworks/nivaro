import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/pipeline-engine.js', () => ({ resolveStateOwnersBatch: vi.fn() }))
vi.mock('../../../services/branch-instances.js', () => ({ findRecordInstance: vi.fn() }))

import {
  type DirectoryPerson,
  decideOwnerOpened,
  MOVER_GRACE_MS,
  ownersWhoOpened
} from '../../../services/owner-opened.js'

const H = 3_600_000
const ENTERED = Date.UTC(2026, 10, 14, 12, 0, 0)
const JANE = 'aaaaaaaa-0000-0000-0000-000000000001'
const MARK = 'aaaaaaaa-0000-0000-0000-000000000002'
const REQUESTER = 'aaaaaaaa-0000-0000-0000-000000000009'
const state = { id: 's-approve', label: 'Finance approval' }

const views = (entries: Array<[string, number]>) =>
  new Map(entries.map(([u, t]) => [u.toUpperCase(), t]))

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
      lastViews: views([
        [JANE, ENTERED + 2 * H],
        [MARK, ENTERED - 1]
      ])
    })
    expect(out).toEqual([{ id: JANE, at: ENTERED + 2 * H }])
  })

  it('an open before the record entered this step does not count', () => {
    expect(ownersWhoOpened({ ...base, lastViews: views([[JANE, ENTERED - H]]) })).toEqual([])
  })

  it('matches user ids regardless of case and lists newest open first', () => {
    const out = ownersWhoOpened({
      ...base,
      ownerIds: [JANE.toLowerCase(), MARK.toLowerCase()],
      lastViews: views([
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
      lastViews: views([[JANE, ENTERED + 5 * 60_000]])
    })
    expect(stayed).toEqual([])
    const came = ownersWhoOpened({
      ...base,
      mover: JANE,
      lastViews: views([[JANE, ENTERED + MOVER_GRACE_MS + 1]])
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
      decideOwnerOpened({ ...base, ownerIds: [], lastViews: new Map(), listed: new Map() })
    ).toEqual({ status: 'none' })
  })

  it('a viewer who owns the step gets `owner` (the panel shows nothing)', () => {
    expect(
      decideOwnerOpened({
        ...base,
        viewerId: JANE.toLowerCase(),
        lastViews: new Map(),
        listed: new Map()
      })
    ).toEqual({ status: 'owner' })
  })

  it('not opened yet', () => {
    expect(decideOwnerOpened({ ...base, lastViews: new Map(), listed: new Map() })).toEqual({
      status: 'not_opened',
      state,
      entered_at: new Date(ENTERED).toISOString()
    })
  })

  it('names the opener with their department and counts the others', () => {
    const out = decideOwnerOpened({
      ...base,
      lastViews: views([
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
      by: { id: JANE, name: 'Jane Smith', group: 'Finance' },
      others: 1
    })
  })

  it('falls back to the job title, then to no group', () => {
    const titled = decideOwnerOpened({
      ...base,
      lastViews: views([[JANE, ENTERED + H]]),
      listed: new Map([[JANE.toUpperCase(), { ...jane, department: '' }]])
    })
    expect(titled.status === 'opened' && titled.by?.group).toBe('Analyst')
    const bare = decideOwnerOpened({
      ...base,
      lastViews: views([[JANE, ENTERED + H]]),
      listed: new Map([[JANE.toUpperCase(), { id: JANE, first_name: 'Jane', last_name: null }]])
    })
    expect(bare.status === 'opened' && bare.by).toEqual({ id: JANE, name: 'Jane', group: null })
  })

  it('never names someone the people directory does not list', () => {
    // Mark (newest open) is suspended / redacted: not in `listed`. Jane is named instead.
    const out = decideOwnerOpened({
      ...base,
      lastViews: views([
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
      lastViews: views([[MARK, ENTERED + 3 * H]]),
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
    const a = decideOwnerOpened({ ...base, lastViews: new Map(), listed: new Map() })
    const b = decideOwnerOpened({
      ...base,
      viewerId: 'bbbbbbbb-0000-0000-0000-000000000001',
      lastViews: new Map(),
      listed: new Map()
    })
    expect(a).toEqual(b)
  })
})
