import { describe, expect, it, vi } from 'vitest'
import {
  currentLinks,
  m2mFieldInfo,
  m2mFields,
  m2mIntent,
  m2mPayload,
  planM2M,
  planM2MRow
} from '../../../services/bulk-m2m.js'
import { bulkUpdatePlan } from '../../../services/bulk-update-plan.js'
import type { User } from '../../../types.js'

// Bulk "Update field" on a to-many field (2026-11-13): which fields qualify,
// the three intents, the per-record plan and the ONE batched read of links.

const user = { id: 'U1', role: 'R1' } as User

// locations.additional_expenditure_orgs → junction locations_org_codes_1 → org_codes
const rels = [
  {
    many_collection: 'locations_org_codes_1',
    many_field: 'locations_id',
    one_collection: 'locations',
    one_field: 'additional_expenditure_orgs',
    junction_field: 'org_codes_id'
  },
  {
    many_collection: 'locations_org_codes_1',
    many_field: 'org_codes_id',
    one_collection: 'org_codes',
    one_field: 'locations_additional',
    junction_field: 'locations_id'
  },
  // an M2O on the same collection — never a to-many field
  {
    many_collection: 'locations',
    many_field: 'default_expenditure_org',
    one_collection: 'org_codes',
    one_field: null,
    junction_field: null
  },
  // a polymorphic (M2A) alias — left out
  {
    many_collection: 'locations_contacts',
    many_field: 'locations_id',
    one_collection: 'locations',
    one_field: 'contacts',
    junction_field: 'item'
  },
  {
    many_collection: 'locations_contacts',
    many_field: 'item',
    one_collection: null,
    one_field: null,
    junction_field: 'locations_id',
    one_allowed_collections: 'nivaro_users,additional_emails'
  }
]

describe('which fields are to-many', () => {
  it('reads the junction legs by their junction_field pairing', () => {
    expect(m2mFieldInfo('locations', 'additional_expenditure_orgs', rels)).toEqual({
      field: 'additional_expenditure_orgs',
      junction: 'locations_org_codes_1',
      parentFk: 'locations_id',
      relatedFk: 'org_codes_id',
      related: 'org_codes'
    })
  })

  it('never takes an M2O column or a polymorphic alias', () => {
    expect(m2mFieldInfo('locations', 'default_expenditure_org', rels)).toBeNull()
    expect(m2mFieldInfo('locations', 'contacts', rels)).toBeNull()
    expect(m2mFields('locations', rels).map((f) => f.field)).toEqual([
      'additional_expenditure_orgs'
    ])
  })
})

describe('the three intents', () => {
  it('reads the alias shapes the bar sends (and a bare array as an append)', () => {
    expect(m2mIntent({ create: [1, 2, 2] })).toEqual({ mode: 'append', ids: [1, 2] })
    expect(m2mIntent({ set: [] })).toEqual({ mode: 'replace', ids: [] })
    expect(m2mIntent({ delete: [{ id: 'A' }, 'a'] })).toEqual({ mode: 'remove', ids: ['A'] })
    expect(m2mIntent([3])).toEqual({ mode: 'append', ids: [3] })
    expect(m2mIntent('x')).toBeNull()
    expect(m2mIntent({ create: [1], delete: [2] })).toBeNull()
    expect(m2mPayload('replace', [1, 1, 2])).toEqual({ set: [1, 2] })
  })

  it('append adds only what a record lacks (no duplicates, case-blind ids)', () => {
    expect(planM2MRow('append', ['a', 'B'], ['b'])).toEqual({ adds: ['a'], removes: [] })
    expect(planM2MRow('append', ['a'], ['A'])).toEqual({ adds: [], removes: [] })
  })

  it('replace makes the links exactly the picked set; empty takes all off', () => {
    expect(planM2MRow('replace', [1, 2], [2, 3])).toEqual({ adds: [1], removes: [3] })
    expect(planM2MRow('replace', [], [2, 3])).toEqual({ adds: [], removes: [2, 3] })
    expect(planM2MRow('replace', [2], [2])).toEqual({ adds: [], removes: [] })
  })

  it('remove takes off only the picked links a record has', () => {
    expect(planM2MRow('remove', [1, 9], [1, 2])).toEqual({ adds: [], removes: [1] })
    expect(planM2MRow('remove', [9], [1])).toEqual({ adds: [], removes: [] })
  })

  it('sums the plan across records', () => {
    const current = new Map([
      ['10', [1]],
      ['11', [1, 2]],
      ['12', []]
    ])
    const { summary } = planM2M('append', [1, 2], [10, 11, 12], current)
    expect(summary).toEqual({ changing: 2, unchanged: 1, links_added: 3, links_removed: 0 })
  })
})

describe('current links: one batched read as the person', () => {
  it('reads the junction in chunks of records, never one read per record', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => i + 1)
    const read = vi.fn(async (_u: User, collection: string, q: Record<string, unknown>) => {
      const chunk = ((q.filter as Record<string, { _in: number[] }>).locations_id._in ??
        []) as number[]
      expect(collection).toBe('locations_org_codes_1')
      expect(q.fields).toEqual(['locations_id', 'org_codes_id'])
      return { data: chunk.map((id) => ({ locations_id: id, org_codes_id: id % 3 })) }
    })
    const info = m2mFieldInfo('locations', 'additional_expenditure_orgs', rels)!
    const out = await currentLinks(user, info, ids, read as never)
    expect(read).toHaveBeenCalledTimes(3) // 200 + 200 + 50
    expect(read.mock.calls.every((c) => c[0] === user)).toBe(true)
    expect(out.get('4')).toEqual([1])
  })
})

describe('bulkUpdatePlan (the preview)', () => {
  const info = m2mFieldInfo('locations', 'additional_expenditure_orgs', rels)!
  const reader = (rows: Array<Record<string, unknown>>, links: Array<Record<string, unknown>>) =>
    vi.fn(async (_u: User, collection: string) =>
      collection === 'locations' ? { data: rows } : { data: links }
    )

  it('counts adds and the records that already have them', async () => {
    const read = reader(
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      [
        { locations_id: 1, org_codes_id: 7 },
        { locations_id: 1, org_codes_id: 8 },
        { locations_id: 2, org_codes_id: 7 }
      ]
    )
    const plan = await bulkUpdatePlan({
      user,
      collection: 'locations',
      ids: [1, 2, 3, 4],
      data: { additional_expenditure_orgs: { create: [7, 8] } },
      m2m: new Map([['additional_expenditure_orgs', info]]),
      refusals: new Map([['3', 'Locked on its form']]),
      read: read as never
    })
    expect(plan.preview).toEqual({
      would_update: 1,
      skipped: 1,
      refused: 1,
      refused_reason: 'Locked on its form',
      unreadable: 1,
      links_added: 1,
      links_removed: 0
    })
    expect([...plan.unchanged]).toEqual(['1'])
  })

  it('replace with nothing picked removes every link', async () => {
    const read = reader(
      [{ id: 1 }, { id: 2 }],
      [
        { locations_id: 1, org_codes_id: 7 },
        { locations_id: 1, org_codes_id: 8 }
      ]
    )
    const plan = await bulkUpdatePlan({
      user,
      collection: 'locations',
      ids: [1, 2],
      data: { additional_expenditure_orgs: { set: [] } },
      m2m: new Map([['additional_expenditure_orgs', info]]),
      refusals: new Map(),
      read: read as never
    })
    expect(plan.preview).toMatchObject({ would_update: 1, skipped: 1, links_removed: 2 })
  })

  it('says the links are unknown when the person cannot read the junction', async () => {
    const read = vi.fn(async (_u: User, collection: string) => {
      if (collection !== 'locations')
        throw Object.assign(new Error('Forbidden'), { name: 'ForbiddenError' })
      return { data: [{ id: 1 }] }
    })
    const plan = await bulkUpdatePlan({
      user,
      collection: 'locations',
      ids: [1],
      data: { additional_expenditure_orgs: { create: [7] } },
      m2m: new Map([['additional_expenditure_orgs', info]]),
      refusals: new Map(),
      read: read as never
    })
    expect(plan.preview).toMatchObject({ would_update: 1, skipped: 0, links_unknown: true })
    expect(plan.unchanged.size).toBe(0)
  })

  it('compares plain fields too (an M2O set or clear)', async () => {
    const read = reader(
      [
        { id: 1, default_expenditure_org: 5 },
        { id: 2, default_expenditure_org: null }
      ],
      []
    )
    const set = await bulkUpdatePlan({
      user,
      collection: 'locations',
      ids: [1, 2],
      data: { default_expenditure_org: 5 },
      m2m: new Map(),
      refusals: new Map(),
      read: read as never
    })
    expect(set.preview).toMatchObject({ would_update: 1, skipped: 1 })
    const clear = await bulkUpdatePlan({
      user,
      collection: 'locations',
      ids: [1, 2],
      data: { default_expenditure_org: null },
      m2m: new Map(),
      refusals: new Map(),
      read: read as never
    })
    expect(clear.preview).toMatchObject({ would_update: 1, skipped: 1 })
    expect(clear.preview).not.toHaveProperty('links_added')
  })
})
