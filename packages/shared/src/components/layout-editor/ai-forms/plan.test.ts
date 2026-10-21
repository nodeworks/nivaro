import { describe, expect, it } from 'vitest'
import { applyLayoutOps, type LayoutBundle, newGroup, newPlacement } from '../../../lib/layout-ops'
import {
  type ComposedForm,
  extraChoices,
  meaningChoices,
  meaningGroups,
  planComposed,
  planMeaning,
  planSlimOps,
  planStructure,
  unplacedFields
} from './plan'

const env = {
  fields: [
    { field: 'reason', label: 'Reason' },
    { field: 'amount', label: 'Amount' },
    { field: 'manager', label: 'Manager' },
    { field: 'decision', label: 'Decision' },
    { field: 'notes', label: 'Notes' }
  ]
}

const empty: LayoutBundle = {
  layout: { id: 9, collection: 'returns', name: 'New', layout_type: 'grouped' },
  groups: [],
  placements: [],
  rev: 'r0'
}

const form = (over: Partial<ComposedForm> = {}): ComposedForm => ({
  name: null,
  layout: 'steps',
  groups: [
    { label: 'Request', fields: ['reason', 'amount'], source: null },
    { label: 'Approval', fields: ['manager', 'decision'], source: null }
  ],
  locks: [],
  requirements: [],
  candidates: [],
  dropped: [],
  explanation: null,
  ...over
})

const fieldsIn = (b: LayoutBundle, key: string) =>
  b.placements
    .filter((p) => p.group_key === key)
    .sort((a, c) => a.sort - c.sort)
    .map((p) => p.field)

describe('planStructure', () => {
  it('builds steps on an empty form as one applicable batch', () => {
    const plan = planStructure(empty, form(), env)
    const out = applyLayoutOps(empty, plan.ops)
    expect(out.groups.map((g) => [g.key, g.type])).toEqual([
      ['request', 'tab'],
      ['approval', 'tab']
    ])
    expect(fieldsIn(out, 'request')).toEqual(['reason', 'amount'])
    expect(fieldsIn(out, 'approval')).toEqual(['manager', 'decision'])
    expect(out.layout.tab_mode).toBe('steps')
    expect(plan.steps).toEqual([
      'Add step "Request": add Reason, Amount',
      'Add step "Approval": add Manager, Decision',
      'Show the tabs as steps, filled one after another'
    ])
  })

  it('reuses a same-named section, removes emptied ones, keeps ones still holding fields', () => {
    const bundle: LayoutBundle = {
      ...empty,
      groups: [
        { ...newGroup('main', 'Main', 'section', null), sort: 0 },
        { ...newGroup('approval_old', 'approval', 'section', null), sort: 1 },
        { ...newGroup('misc', 'Misc', 'section', null), sort: 2 }
      ],
      placements: [
        { ...newPlacement('reason', 'main'), sort: 0 },
        { ...newPlacement('amount', 'main'), sort: 1 },
        { ...newPlacement('manager', 'approval_old'), sort: 0 },
        { ...newPlacement('notes', 'misc'), sort: 0 },
        { ...newPlacement('__comments__', null), sort: 3 }
      ]
    }
    const plan = planStructure(bundle, form({ layout: 'sections' }), env)
    const out = applyLayoutOps(bundle, plan.ops)
    const top = out.groups.filter((g) => g.parent_key === null).map((g) => g.key)
    expect(top).toEqual(['request', 'approval_old', 'misc'])
    expect(fieldsIn(out, 'approval_old')).toEqual(['manager', 'decision'])
    expect(out.groups.find((g) => g.key === 'main')).toBeUndefined()
    expect(out.placements.some((p) => p.field === '__comments__')).toBe(true)
    expect(plan.steps).toContain('Use the existing section "approval" as section 2: add Decision')
    expect(plan.steps).toContain('Remove the empty section "Main"')
    expect(plan.notes.join(' ')).toMatch(/"Misc" stays: it still holds 1 field/)
  })

  it('puts new steps into the tab group the form already has', () => {
    const bundle: LayoutBundle = {
      ...empty,
      layout: { ...empty.layout, tab_mode: 'steps' },
      groups: [
        { ...newGroup('tabs', 'Steps', 'container', null), sort: 0 },
        { ...newGroup('one', 'One', 'tab', 'tabs'), sort: 0 }
      ],
      placements: [{ ...newPlacement('reason', 'one'), sort: 0 }]
    }
    const plan = planStructure(bundle, form(), env)
    const out = applyLayoutOps(bundle, plan.ops)
    expect(out.groups.filter((g) => g.parent_key === 'tabs').map((g) => g.key)).toEqual([
      'request',
      'approval'
    ])
    expect(plan.steps).toContain('Remove the empty step "One"')
    expect(plan.steps.some((s) => s.startsWith('Show the tabs'))).toBe(false)
  })

  it('leaves out names that are not fields and says so', () => {
    const plan = planStructure(
      empty,
      form({
        layout: 'sections',
        groups: [{ label: 'A', fields: ['reason', 'ghost'], source: null }],
        dropped: ['Cost centre']
      }),
      env
    )
    expect(plan.notes[0]).toMatch(/no field for: Cost centre/)
    expect(plan.notes[1]).toMatch(/Left out ghost/)
    expect(applyLayoutOps(empty, plan.ops).placements.map((p) => p.field)).toEqual(['reason'])
  })
})

describe('SOP extras', () => {
  const states = [
    { pipeline_id: 'p1', pipeline: 'Flow', key: 'approved', label: 'Approved' },
    { pipeline_id: 'p1', pipeline: 'Flow', key: 'closed', label: 'Closed' }
  ]
  const sop = form({
    locks: [
      { field: 'amount', pipeline_id: 'p1', state_keys: ['approved', 'closed'], source: 'q' }
    ],
    requirements: [{ field: 'manager', pipeline_id: 'p1', state_key: 'approved', source: null }]
  })

  it('lists locks checked and requirements unchecked with the reason', () => {
    const rows = extraChoices(sop, states, env)
    expect(rows.map((r) => [r.text, r.checked])).toEqual([
      ['Make Amount read-only in Approved, Closed', true],
      ['Make Manager required', false]
    ])
    expect(rows[1].note).toMatch(/by Approved/)
  })

  it('writes the inspector settings for the chosen ones', () => {
    const chosen = new Set(extraChoices(sop, states, env).map((r) => r.id))
    const plan = planComposed(empty, sop, env, { chosen, states })
    const out = applyLayoutOps(empty, plan.ops)
    const amount = out.placements.find((p) => p.field === 'amount')
    expect(JSON.parse(String(amount?.lock_conditions))).toEqual([
      { type: 'pipeline_state', pipeline_id: 'p1', state_keys: ['approved', 'closed'] }
    ])
    const manager = out.placements.find((p) => p.field === 'manager')
    expect(manager?.overrides).toEqual({ required: true })
    expect(plan.steps.slice(-2)).toEqual([
      'Make Amount read-only in Approved, Closed',
      'Make Manager required'
    ])
  })
})

describe('planSlimOps', () => {
  it('inherits, shows to the role, hides dropped fields and all-dropped sections', () => {
    const parentGroups = [
      { ...newGroup('request', 'Request', 'section', null), sort: 0 },
      { ...newGroup('internal', 'Internal', 'section', null), sort: 1, icon: 'lock' }
    ]
    const plan = planSlimOps(
      empty,
      { id: 3, groups: parentGroups },
      {
        keep: [{ field: 'reason', label: 'Reason', changes: 9, why: 'changed' }],
        drop: [
          { field: 'notes', label: 'Notes', group_key: 'request', group_label: 'Request' },
          { field: 'decision', label: 'Decision', group_key: 'internal', group_label: 'Internal' }
        ],
        hide_groups: [{ key: 'internal', label: 'Internal' }],
        min_changes: 1
      },
      { id: 'r-1', name: 'Requester' }
    )
    const out = applyLayoutOps(empty, plan.ops)
    expect(out.layout.parent_layout_id).toBe(3)
    expect(out.layout.conditions).toEqual({ role_ids: ['r-1'] })
    expect(out.placements.map((p) => [p.field, p.group_key, p.is_visible])).toEqual([
      ['notes', null, false],
      ['decision', null, false]
    ])
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0]).toMatchObject({
      key: 'internal',
      icon: 'lock',
      hidden_for_roles: '["r-1"]'
    })
    expect(plan.steps).toEqual([
      'Inherit everything from the parent form and show this one to Requester',
      'Hide 2 fields: Notes, Decision',
      'Hide the section "Internal" for Requester'
    ])
  })
})

describe('sections by meaning', () => {
  const bundle: LayoutBundle = {
    ...empty,
    groups: [
      { ...newGroup('request', 'Request', 'section', null), sort: 0 },
      { ...newGroup('approval', 'Approval', 'section', null), sort: 1 }
    ],
    placements: [{ ...newPlacement('reason', 'request'), sort: 0 }]
  }

  it('lists unplaced fields without system columns or hidden fields', () => {
    expect(
      unplacedFields(bundle, [
        ...env.fields,
        { field: 'id' },
        { field: 'date_created' },
        { field: 'secret', hidden: true }
      ])
    ).toEqual(['amount', 'manager', 'decision', 'notes'])
    expect(meaningGroups(bundle)).toEqual([
      { key: 'request', label: 'Request', fields: ['reason'] },
      { key: 'approval', label: 'Approval', fields: [] }
    ])
  })

  it('offers only suggestions that apply now, and applies several as one batch', () => {
    const choices = meaningChoices(
      bundle,
      [
        { field: 'manager', group_key: 'approval', reason: 'Approver' },
        { field: 'decision', group_key: 'approval', reason: null },
        { field: 'reason', group_key: 'approval', reason: 'already placed' },
        { field: 'amount', group_key: 'gone', reason: null }
      ],
      env
    )
    expect(choices.map((c) => c.field)).toEqual(['manager', 'decision'])
    const plan = planMeaning(bundle, choices)
    const out = applyLayoutOps(bundle, plan.ops)
    expect(fieldsIn(out, 'approval')).toEqual(['manager', 'decision'])
    expect(plan.steps).toEqual(['Add Manager to "Approval"', 'Add Decision to "Approval"'])
  })
})
