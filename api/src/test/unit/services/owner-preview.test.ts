import { describe, expect, it, vi } from 'vitest'
import { parseDraft } from '../../../routes/owner-preview.js'
import {
  type DraftOwnerGroupInput,
  type OwnerPreviewDeps,
  previewRecordOwners
} from '../../../services/owner-preview.js'
import type { OwnerGroup, ResolvedOwner } from '../../../services/pipeline-engine.js'

// The owner preview runs the REAL resolver (resolveStateOwnersBatch) against a
// fake database; only the preview's own reads (states, dimensions, instance,
// saved groups, people) are faked through its deps.

type Person = ResolvedOwner & {
  delegate_id?: string | null
  delegate_expires_at?: Date | null
  is_out_of_office?: boolean
  status?: string | null
}

const people: Person[] = [
  { id: 'u-east', email: 'east@x.com', first_name: 'Erin', last_name: 'East' },
  { id: 'u-west', email: 'west@x.com', first_name: 'Wes', last_name: 'West' },
  { id: 'u-wh', email: 'wh@x.com', first_name: 'Wanda', last_name: 'House' },
  {
    id: 'u-ooo',
    email: 'ooo@x.com',
    first_name: 'Olly',
    last_name: 'Out',
    delegate_id: 'u-cover',
    delegate_expires_at: null,
    is_out_of_office: true
  },
  { id: 'u-cover', email: 'cover@x.com', first_name: 'Cora', last_name: 'Cover' },
  { id: 'u-creator', email: 'me@x.com', first_name: 'Cam', last_name: 'Creator' }
]

function group(o: Partial<OwnerGroup> & { id: string; state: string }): OwnerGroup {
  return {
    template: 't1',
    name: null,
    filters: null,
    sort: 0,
    is_default: false,
    priority: 0,
    max_wip: null,
    ...o
  }
}

const zone = (value: string) => JSON.stringify([{ field: 'zone', op: 'eq', value }])

function setup(opts: {
  groups: OwnerGroup[]
  members: Array<{ group: string; user: string }>
  record: Record<string, unknown>
  fallbackField?: string
}) {
  const byId = new Map(people.map((p) => [p.id, p]))
  const owner = (id: string): ResolvedOwner => {
    const p = byId.get(id)!
    return { id: p.id, email: p.email, first_name: p.first_name, last_name: p.last_name }
  }
  const database = vi.fn((table: string) => {
    if (table === 'nivaro_pipeline_owner_groups') {
      return {
        whereIn: (_c: string, states: string[]) => ({
          orderBy: () => ({
            orderBy: async () => opts.groups.filter((g) => states.includes(g.state))
          })
        })
      }
    }
    if (table === 'nivaro_relations') return { where: () => ({ select: async () => [] }) }
    if (table === 'nivaro_pipeline_owner_group_users as ogu') {
      return {
        join: () => ({
          whereIn: (_c: string, ids: string[]) => ({
            select: async () =>
              opts.members
                .filter((m) => ids.includes(m.group))
                .map((m) => ({ group: m.group, ...owner(m.user) }))
          })
        })
      }
    }
    if (table === 'nivaro_pipeline_owner_group_teams as ogt') {
      return { join: () => ({ join: () => ({ whereIn: () => ({ select: async () => [] }) }) }) }
    }
    if (table === 'nivaro_pipeline_instance_owners as io') {
      return { join: () => ({ whereIn: () => ({ select: async () => [] }) }) }
    }
    if (table === 'nivaro_workflow_states') {
      return {
        whereIn: (_c: string, ids: string[]) => ({
          select: async () => ids.map((id) => ({ id, template: 't1' }))
        })
      }
    }
    if (table === 'nivaro_workflow_bindings') {
      return {
        whereIn: () => ({
          select: async () => [
            { collection: 'requests', template: 't1', owner_fallback_field: opts.fallbackField }
          ]
        })
      }
    }
    if (table === 'nivaro_users') {
      return {
        whereIn: (_c: string, ids: string[]) => ({
          select: async (...cols: string[]) =>
            people
              .filter((p) => ids.includes(p.id))
              .map((p) =>
                cols.includes('delegate_id')
                  ? {
                      id: p.id,
                      delegate_id: p.delegate_id ?? null,
                      delegate_expires_at: p.delegate_expires_at ?? null,
                      is_out_of_office: !!p.is_out_of_office
                    }
                  : owner(p.id)
              )
        })
      }
    }
    // The bound collection's own rows.
    return {
      whereIn: (_c: string, ids: string[]) => ({
        select: async () => (ids.includes('42') ? [{ id: '42', ...opts.record }] : []),
        columnInfo: async () => ({})
      }),
      columnInfo: async () => ({})
    }
  }) as unknown as OwnerPreviewDeps['database']

  const deps: OwnerPreviewDeps = {
    database,
    loadStates: async () => [
      { id: 's-sub', key: 'submitted', label: 'Submitted', color: null, is_initial: true },
      { id: 's-wh', key: 'warehouse', label: 'Warehouse Submission', color: '#f59e0b' },
      { id: 's-done', key: 'done', label: 'Done', color: null, is_terminal: true }
    ],
    loadDimensions: async () => [
      { field: 'zone', label: 'Zone', required: false, is_row_axis: true, collection: 'requests' },
      {
        field: 'project_type',
        label: 'Project type',
        required: false,
        is_row_axis: false,
        collection: 'requests'
      }
    ],
    findInstance: async () => ({ id: 'inst-1', template: 't1', current_state: 's-wh' }),
    savedGroups: async (ids) => {
      const m = new Map<string, OwnerGroup[]>()
      for (const id of ids)
        m.set(
          id,
          opts.groups.filter((g) => g.state === id)
        )
      return m
    },
    readPeople: async (ids) => people.filter((p) => ids.includes(p.id)),
    readTeamMembers: async () => []
  }
  return deps
}

describe('previewRecordOwners', () => {
  const record = { zone: 'East', project_type: 'Materials', created_by: 'u-creator' }

  it('names the matching group, its values and the inherited optional dimension', async () => {
    const deps = setup({
      groups: [group({ id: 'g-east', state: 's-sub', name: 'East', filters: zone('East') })],
      members: [{ group: 'g-east', user: 'u-east' }],
      record
    })
    const p = await previewRecordOwners(
      { templateId: 't1', collection: 'requests', item: '42' },
      deps
    )
    const sub = p.steps.find((s) => s.state.id === 's-sub')!
    expect(sub.saved.owners.map((o) => o.name)).toEqual(['Erin East'])
    expect(sub.saved.match.kind).toBe('match')
    expect(sub.saved.match.facts).toEqual([
      { field: 'zone', label: 'Zone', wants: 'East', record_value: 'East' }
    ])
    expect(sub.saved.match.inherited).toEqual([{ label: 'Project type', value: 'Materials' }])
    expect(sub.draft).toBeNull()
    expect(p.steps.find((s) => s.state.id === 's-wh')!.state.is_current).toBe(true)
  })

  it('flags a step no group matches as having no assigned owner (stand-in only)', async () => {
    const deps = setup({
      groups: [group({ id: 'g-west', state: 's-wh', name: 'West WH', filters: zone('West') })],
      members: [{ group: 'g-west', user: 'u-west' }],
      record,
      fallbackField: 'created_by'
    })
    const p = await previewRecordOwners(
      { templateId: 't1', collection: 'requests', item: '42' },
      deps
    )
    const wh = p.steps.find((s) => s.state.id === 's-wh')!
    expect(wh.saved.match.kind).toBe('no_match')
    expect(wh.saved.no_assigned_owner).toBe(true)
    expect(wh.saved.owners).toEqual([
      expect.objectContaining({ name: 'Cam Creator', via: 'stand_in' })
    ])
    expect(wh.saved.why.join(' ')).toMatch(/No owner group matches/)
    expect(wh.saved.why.join(' ')).toMatch(/only an assigned owner can approve/)
    // Submitted has no groups at all; the terminal step is not counted.
    expect(p.unowned).toBe(2)
  })

  it('a draft group changes who owns the step, and the saved answer stays as it is', async () => {
    const deps = setup({
      groups: [group({ id: 'g-west', state: 's-wh', name: 'West WH', filters: zone('West') })],
      members: [{ group: 'g-west', user: 'u-west' }],
      record
    })
    const draft: DraftOwnerGroupInput[] = [
      {
        id: 'draft:1',
        state: 's-wh',
        name: null,
        filters: [{ field: 'zone', op: 'eq', value: 'East' }],
        users: ['u-wh'],
        teams: []
      }
    ]
    const p = await previewRecordOwners(
      { templateId: 't1', collection: 'requests', item: '42', draft },
      deps
    )
    const wh = p.steps.find((s) => s.state.id === 's-wh')!
    expect(wh.saved.no_assigned_owner).toBe(true)
    expect(wh.draft?.owners.map((o) => o.name)).toEqual(['Wanda House'])
    expect(wh.draft?.match.group).toEqual(
      expect.objectContaining({ id: 'draft:1', is_draft: true })
    )
    expect(wh.draft?.no_assigned_owner).toBe(false)
    expect(wh.changed).toBe(true)
    expect(p.steps.find((s) => s.state.id === 's-sub')!.changed).toBe(false)
  })

  it('a draft that removes the matching group leaves the step with no owner', async () => {
    const deps = setup({
      groups: [group({ id: 'g-east', state: 's-wh', filters: zone('East') })],
      members: [{ group: 'g-east', user: 'u-east' }],
      record
    })
    const p = await previewRecordOwners(
      {
        templateId: 't1',
        collection: 'requests',
        item: '42',
        draft: [
          {
            id: 'g-east',
            state: 's-wh',
            filters: [{ field: 'zone', op: 'eq', value: 'East' }],
            users: ['u-east'],
            teams: [],
            removed: true
          }
        ]
      },
      deps
    )
    const wh = p.steps.find((s) => s.state.id === 's-wh')!
    expect(wh.saved.owners.map((o) => o.id)).toEqual(['u-east'])
    expect(wh.draft?.owners).toEqual([])
    expect(wh.draft?.no_assigned_owner).toBe(true)
    expect(wh.changed).toBe(true)
  })

  it('shows an out-of-office owner swapped for their delegate, with why', async () => {
    const deps = setup({
      groups: [group({ id: 'g-east', state: 's-wh', name: 'East WH', filters: zone('East') })],
      members: [{ group: 'g-east', user: 'u-ooo' }],
      record
    })
    const p = await previewRecordOwners(
      { templateId: 't1', collection: 'requests', item: '42' },
      deps
    )
    const wh = p.steps.find((s) => s.state.id === 's-wh')!
    expect(wh.saved.owners).toEqual([
      expect.objectContaining({ id: 'u-cover', name: 'Cora Cover', delegate_for: 'Olly Out' })
    ])
    expect(wh.saved.delegations).toEqual([
      { from_id: 'u-ooo', from_name: 'Olly Out', to_id: 'u-cover', to_name: 'Cora Cover' }
    ])
    expect(wh.saved.why).toContain('Olly Out is out of office — Cora Cover stands in.')
  })

  it('counts broader groups the record also matched', async () => {
    const deps = setup({
      groups: [
        group({ id: 'g-east', state: 's-wh', filters: zone('East') }),
        group({
          id: 'g-east-mat',
          state: 's-wh',
          name: 'East materials',
          filters: JSON.stringify([
            { field: 'zone', op: 'eq', value: 'East' },
            { field: 'project_type', op: 'eq', value: 'Materials' }
          ])
        })
      ],
      members: [
        { group: 'g-east', user: 'u-east' },
        { group: 'g-east-mat', user: 'u-wh' }
      ],
      record
    })
    const p = await previewRecordOwners(
      { templateId: 't1', collection: 'requests', item: '42' },
      deps
    )
    const wh = p.steps.find((s) => s.state.id === 's-wh')!
    expect(wh.saved.owners.map((o) => o.id)).toEqual(['u-wh'])
    expect(wh.saved.match.outranked).toBe(1)
    expect(wh.saved.match.override).toEqual(['Project type'])
    expect(wh.saved.match.inherited).toEqual([])
  })
})

describe('parseDraft', () => {
  it('accepts the editor shape and refuses an unknown filter op', () => {
    const ok = parseDraft([
      {
        id: 'draft:1',
        state: 's-wh',
        filters: [{ field: 'zone', op: 'eq', value: 'East', id_value: 3 }],
        users: ['u1'],
        teams: [4]
      }
    ])
    expect(Array.isArray(ok) && ok[0].filters?.[0]).toEqual({
      field: 'zone',
      op: 'eq',
      value: 'East',
      id_value: 3
    })
    expect(
      parseDraft([{ id: 'x', state: 's', filters: [{ field: 'z', op: 'drop', value: 1 }] }])
    ).toBe('draft group filters are invalid')
    expect(parseDraft('nope')).toBe('draft must be a list of owner groups')
  })
})
