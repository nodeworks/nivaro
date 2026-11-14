import { describe, expect, it } from 'vitest'
import type { OwnerGroup, OwnerResolutionTrace } from './pipeline-engine.js'
import { type StandInDeps, type StandInGap, standInReasonFor } from './stand-in-reason.js'

// Rob 2026-11-14 (CR26INV-36126, Engineering Review): the panel said only
// "Shown as a stand-in — no one is assigned" and the header said nothing.
// Both now say WHY nobody is assigned and WHY this person stands in.

const nathan = { id: 'U-NATHAN', email: 'nw@x.test', first_name: 'Nathan', last_name: 'Winger' }
const kim = { id: 'U-KIM', email: 'kim@x.test', first_name: 'Kim', last_name: 'Lee' }

const trace = (over: Partial<OwnerResolutionTrace> = {}): OwnerResolutionTrace => ({
  stateId: 'S-ENG',
  hasGroups: true,
  prepared: null,
  winning: [],
  record: {},
  relations: [],
  resolved: undefined,
  groupOwners: [],
  instanceOwners: [],
  standIn: [nathan],
  substitutions: [],
  ...over
})

const group = (over: Partial<OwnerGroup> = {}): OwnerGroup =>
  ({
    id: 'G1',
    template: 'T1',
    state: 'S-ENG',
    name: 'East CRAN',
    filters: null,
    sort: 0,
    is_default: false,
    priority: 0,
    max_wip: null,
    ...over
  }) as OwnerGroup

const gapOf = (over: Partial<StandInGap> = {}): StandInGap => ({
  dims: [
    { field: 'division.name', label: 'Division', value: 'Zone 3' },
    { field: 'region.name', label: 'Region', value: 'CRAN' },
    { field: 'project_type.name', label: 'Project Type', value: 'PNR' }
  ],
  uncovered: [],
  suggestion: null,
  ...over
})

/** canReadPath that allows exactly these paths. */
const only =
  (...paths: string[]): StandInDeps['canReadPath'] =>
  async (_v, _c, path) =>
    paths.includes(path)

function deps(over: Partial<StandInDeps> & { t?: OwnerResolutionTrace } = {}): StandInDeps {
  return {
    trace: async () => over.t ?? trace(),
    state: async () => ({ id: 'S-ENG', key: 'engineering_review', label: 'Engineering Review' }),
    gap: async () => gapOf(),
    creatorColumn: async () => 'user_created',
    fieldLabel: async (_c, f) => (f === 'requester' ? 'Requester' : null),
    canReadPath: async () => true,
    ...over
  }
}

const input = (over: Record<string, unknown> = {}) => ({
  collection: 'inventory_request',
  item: '36126',
  instance: { id: 'I1', template: 'T1', current_state: 'S-ENG' },
  fallbackField: 'user_created',
  viewer: { user: { id: 'U-VIEW', role: 'R1' } as never, isAdmin: false },
  showAdmin: false,
  ...over
})

describe('standInReasonFor', () => {
  it('answers nothing without a fallback field, and nothing when an owner is assigned', async () => {
    let asked = 0
    const d = deps({
      trace: async () => {
        asked++
        return trace()
      }
    })
    expect(await standInReasonFor(input({ fallbackField: null }), d)).toBeNull()
    expect(asked).toBe(0)
    expect(
      await standInReasonFor(input(), deps({ t: trace({ standIn: [], groupOwners: [kim] }) }))
    ).toBeNull()
  })

  it('names the values no owner group covers, and that the creator stands in', async () => {
    const r = await standInReasonFor(
      input(),
      deps({
        gap: async () =>
          gapOf({
            uncovered: [
              { field: 'division.name', label: 'Division', value: 'Zone 3' },
              { field: 'region.name', label: 'Region', value: 'CRAN' },
              { field: 'project_type.name', label: 'Project Type', value: 'PNR' }
            ],
            suggestion: { group_label: 'East CRAN', missing_labels: ['Division Zone 1'] }
          })
      })
    )
    expect(r?.why_unassigned).toEqual({
      kind: 'uncovered',
      sentence:
        'No owner group covers Division Zone 3, Region CRAN or Project Type PNR for Engineering Review.',
      values: [
        { label: 'Division', value: 'Zone 3' },
        { label: 'Region', value: 'CRAN' },
        { label: 'Project Type', value: 'PNR' }
      ]
    })
    expect(r?.why_this_person).toEqual({
      kind: 'creator',
      sentence: 'Nathan Winger stands in as the person who created this record.'
    })
    expect(r?.people).toEqual([{ id: 'U-NATHAN', name: 'Nathan Winger' }])
    // Not an administrator: no group names, no matrix link.
    expect(r?.detail).toBeUndefined()
    expect(r?.matrix_href).toBeUndefined()
  })

  it('gives administrators the closest group and the owner matrix link', async () => {
    const r = await standInReasonFor(
      input({ showAdmin: true, viewer: { user: undefined, isAdmin: true } }),
      deps({
        gap: async () =>
          gapOf({
            uncovered: [{ field: 'division.name', label: 'Division', value: 'Zone 3' }],
            suggestion: { group_label: 'East CRAN', missing_labels: ['Region BLT', 'Zone EAST'] }
          })
      })
    )
    expect(r?.why_unassigned.sentence).toBe(
      'No owner group covers Division Zone 3 for Engineering Review.'
    )
    expect(r?.detail).toBe('Closest group: “East CRAN”, which wants Region BLT and Zone EAST.')
    expect(r?.matrix_href).toBe('/pipelines/T1#owner-matrix')
  })

  it('says the values are covered only apart when every one is named by some group', async () => {
    const r = await standInReasonFor(input(), deps())
    expect(r?.why_unassigned).toMatchObject({
      kind: 'no_match',
      sentence:
        'No owner group covers Division Zone 3, Region CRAN and Project Type PNR together for Engineering Review.'
    })
  })

  it('never names a value from a field the viewer cannot read', async () => {
    const r = await standInReasonFor(
      input(),
      deps({
        canReadPath: only('division.name', 'user_created'),
        gap: async () =>
          gapOf({
            uncovered: [
              { field: 'division.name', label: 'Division', value: 'Zone 3' },
              { field: 'region.name', label: 'Region', value: 'CRAN' }
            ]
          })
      })
    )
    expect(r?.why_unassigned.sentence).toBe(
      'No owner group covers Division Zone 3 for Engineering Review.'
    )
    expect(JSON.stringify(r)).not.toContain('CRAN')

    const none = await standInReasonFor(input(), deps({ canReadPath: only('user_created') }))
    expect(none?.why_unassigned.sentence).toBe(
      'No owner group matches this record for Engineering Review.'
    )
  })

  it('a readable root with an unreadable hop leaves that value out', async () => {
    // division (the link) is readable, division.name on the related table is not.
    const r = await standInReasonFor(
      input(),
      deps({
        canReadPath: only('region.name', 'project_type.name', 'user_created'),
        gap: async () =>
          gapOf({
            uncovered: [
              { field: 'division.name', label: 'Division', value: 'Zone 3' },
              { field: 'region.name', label: 'Region', value: 'CRAN' }
            ]
          })
      })
    )
    expect(r?.why_unassigned.sentence).toBe(
      'No owner group covers Region CRAN for Engineering Review.'
    )
    expect(JSON.stringify(r)).not.toContain('Zone 3')
  })

  it('says only the generic sentence when every uncovered value is unreadable', async () => {
    const r = await standInReasonFor(
      input(),
      deps({
        canReadPath: only('region.name', 'project_type.name', 'user_created'),
        gap: async () =>
          gapOf({ uncovered: [{ field: 'division.name', label: 'Division', value: 'Zone 3' }] })
      })
    )
    expect(r?.why_unassigned).toEqual({
      kind: 'no_match',
      sentence: 'No owner group matches this record for Engineering Review.'
    })
    // A combination is never said over part of its values.
    const partial = await standInReasonFor(
      input(),
      deps({ canReadPath: only('region.name', 'user_created') })
    )
    expect(partial?.why_unassigned.sentence).toBe(
      'No owner group matches this record for Engineering Review.'
    )
    expect(JSON.stringify(partial)).not.toContain('CRAN')
  })

  it('says the winning group is empty (its name for administrators only)', async () => {
    const t = trace({ winning: [group()] })
    const r = await standInReasonFor(input(), deps({ t }))
    expect(r?.why_unassigned).toEqual({
      kind: 'empty_group',
      sentence: 'The owner group for Engineering Review has no members.'
    })
    expect(r?.detail).toBeUndefined()
    const admin = await standInReasonFor(
      input({ showAdmin: true, viewer: { user: undefined, isAdmin: true } }),
      deps({ t: trace({ winning: [group({ is_default: true, name: 'Everyone else' })] }) })
    )
    expect(admin?.detail).toBe('Default group “Everyone else” has nobody in it.')
  })

  it('says the step has no owner groups at all', async () => {
    const r = await standInReasonFor(input(), deps({ t: trace({ hasGroups: false }) }))
    expect(r?.why_unassigned).toEqual({
      kind: 'no_groups',
      sentence: 'Engineering Review has no owner groups at all.'
    })
  })

  it('a step whose owners are all inactive still has owners — no stand-in to explain', async () => {
    // Suspended / out-of-office owners are still the ASSIGNED owners (the
    // panel marks them unavailable); the fallback never fires for them.
    const r = await standInReasonFor(
      input(),
      deps({ t: trace({ winning: [group()], groupOwners: [kim], standIn: [] }) })
    )
    expect(r).toBeNull()
  })

  it('names the fallback field when it is not the creator', async () => {
    const r = await standInReasonFor(input({ fallbackField: 'requester' }), deps())
    expect(r?.why_this_person).toEqual({
      kind: 'field',
      sentence: 'Nathan Winger stands in as this record’s Requester.'
    })
    const hidden = await standInReasonFor(
      input({ fallbackField: 'requester' }),
      deps({ canReadPath: only('division.name') })
    )
    expect(hidden?.why_this_person.sentence).toBe(
      'Nathan Winger stands in because this record names them.'
    )
  })

  it('a step that needs no owner says so', async () => {
    const r = await standInReasonFor(
      input(),
      deps({
        state: async () => ({
          id: 'S-ENG',
          key: 'engineering_review',
          label: 'Engineering Review',
          owners_not_required: 1
        })
      })
    )
    expect(r?.why_unassigned.kind).toBe('not_required')
    expect(r?.why_unassigned.sentence).toBe('Engineering Review does not need an owner.')
  })
})
