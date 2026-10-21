import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type LayoutBundle,
  newGroup,
  type PlacementRow,
  ungroupedGroup
} from '../../lib/layout-ops'
import { refineLockReasons } from '../item-edit/lock-why'
import { noteKey, noteOf, noteOps, notesOf } from './editor-notes'
import { buildFormMap, formMapHtml } from './form-map'
import { describeShowWhen } from './show-when'

const place = (
  field: string,
  group_key: string | null,
  sort: number,
  extra = {}
): PlacementRow => ({
  field,
  group_key,
  sort,
  label_override: null,
  is_visible: true,
  default_expanded: true,
  col_span: null,
  overrides: null,
  show_row_revisions: false,
  allow_revision_restore: true,
  lock_conditions: null,
  input_bindings: null,
  widget_id: null,
  show_approval_chain: false,
  ...extra
})

const bundle = (): LayoutBundle => ({
  layout: { id: 1, collection: 'requests', name: 'Request form', layout_type: 'grouped' },
  groups: [
    { ...newGroup('steps', 'Steps', 'container', null), sort: 0, tab_mode: 'steps' },
    { ...newGroup('ask', 'Ask', 'tab', 'steps'), sort: 0 },
    {
      ...newGroup('approve', 'Approve', 'tab', 'steps'),
      sort: 1,
      visible_when: JSON.stringify([{ field: 'kind', op: 'in', value: 'big,huge' }]),
      locked_for_roles: JSON.stringify(['R1'])
    },
    ungroupedGroup(5)
  ],
  placements: [
    place('title', 'ask', 0, { overrides: { required: true } }),
    place('amount', 'ask', 1, { col_span: 6 }),
    place('approver', 'approve', 0, {
      lock_conditions: JSON.stringify([{ type: 'role', role_ids: ['r1'] }])
    }),
    place('legacy', null, 0, { is_visible: false })
  ],
  rev: 'r0'
})

const note = {
  text: 'Finance asked for this in Q3',
  by: 'u1',
  by_name: 'Ann Lee',
  at: '2026-10-20T10:00:00Z'
}

describe('editor notes (#2608)', () => {
  it('pins a note to a field through its overrides, and removes it again', () => {
    const b = bundle()
    const target = { kind: 'field' as const, field: 'amount', group_key: 'ask' }
    const ops = noteOps(b, target, note)
    expect(ops).toEqual([
      {
        op: 'update_placement',
        at: { field: 'amount', group_key: 'ask' },
        patch: { overrides: { editor_note: note } }
      }
    ])
    const after = applyLayoutOps(b, ops)
    expect(noteOf(after, target)).toEqual(note)
    expect(notesOf(after).get(noteKey(target) as string)).toEqual(note)
    const removed = applyLayoutOps(after, noteOps(after, target, null))
    expect(noteOf(removed, target)).toBeNull()
    expect(removed.placements.find((p) => p.field === 'amount')?.overrides).toBeNull()
  })

  it('keeps other overrides when a note is added', () => {
    const b = bundle()
    const target = { kind: 'field' as const, field: 'title', group_key: 'ask' }
    const after = applyLayoutOps(b, noteOps(b, target, note))
    expect(after.placements.find((p) => p.field === 'title')?.overrides).toEqual({
      required: true,
      editor_note: note
    })
  })

  it('pins a note to a section through group_update', () => {
    const b = bundle()
    const target = { kind: 'group' as const, key: 'approve' }
    const ops = noteOps(b, target, note)
    expect(ops).toEqual([
      { op: 'group_update', key: 'approve', patch: { editor_note: JSON.stringify(note) } }
    ])
    expect(noteOf(applyLayoutOps(b, ops), target)).toEqual(note)
  })

  it('an empty note removes it; a target not on the layout gets no op', () => {
    const b = bundle()
    expect(noteOps(b, { kind: 'group', key: 'approve' }, { ...note, text: '   ' })).toEqual([
      { op: 'group_update', key: 'approve', patch: { editor_note: null } }
    ])
    expect(noteOps(b, { kind: 'group', key: 'nope' }, note)).toEqual([])
    expect(noteOps(b, { kind: 'field', field: 'nope', group_key: null }, note)).toEqual([])
  })

  it('the ops twin refuses an over-long section note', () => {
    expect(() =>
      applyLayoutOps(bundle(), [
        { op: 'group_update', key: 'ask', patch: { editor_note: 'x'.repeat(5000) } }
      ])
    ).toThrow(/at most/)
  })
})

describe('form map (#2617)', () => {
  const map = () =>
    buildFormMap({
      bundle: bundle(),
      collectionLabel: 'Requests',
      fields: [
        { field: 'title', label: 'Title' },
        { field: 'amount', label: 'Amount', readonly: true },
        { field: 'approver', label: 'Approver', required: true },
        { field: 'kind', label: 'Kind' }
      ],
      roles: [{ id: 'R1', name: 'Finance' }]
    })

  it('walks steps → sections → fields in canvas order with widths, marks and rules', () => {
    const m = map()
    expect(m.groups.map((g) => [g.kind, g.label])).toEqual([
      ['Steps', 'Steps'],
      ['Fields', 'Not in a section']
    ])
    const [ask, approve] = m.groups[0].children
    expect([ask.kind, ask.label, approve.kind]).toEqual(['Step', 'Ask', 'Step'])
    expect(ask.fields.map((f) => [f.label, f.width, f.required, f.readOnly])).toEqual([
      ['Title', 'Full', true, false],
      ['Amount', 'Half', false, true]
    ])
    expect(approve.rules).toEqual(['Shows only when Kind is big or huge', 'Read-only for Finance'])
    expect(approve.fields[0].rules).toEqual(['Locked for Finance'])
    expect(m.groups[1].fields[0].rules).toEqual(['Hidden on this form'])
    expect(m.counts).toEqual({ groups: 3, fields: 4, required: 2 })
  })

  it('renders an escaped light page', () => {
    const b = bundle()
    b.layout.name = '<b>Form</b>'
    const html = formMapHtml(
      buildFormMap({ bundle: b, collectionLabel: 'Requests', fields: [], roles: [] }),
      new Date('2026-10-20T10:00:00Z')
    )
    expect(html).toContain('color-scheme: light')
    expect(html).toContain('&lt;b&gt;Form&lt;/b&gt;')
    expect(html).not.toContain('<b>Form</b>')
  })
})

describe('describeShowWhen', () => {
  it('words step rules, `in` included', () => {
    const fields = [
      { field: 'kind', label: 'Kind' },
      { field: 'hold', label: 'On hold', type: 'boolean' }
    ]
    expect(describeShowWhen('[{"field":"kind","op":"eq","value":"big"}]', fields)).toBe(
      'Kind is big'
    )
    expect(describeShowWhen([{ field: 'kind', op: 'nnull' }], fields)).toBe('Kind is set')
    expect(describeShowWhen(null, fields)).toBeNull()
  })
})

describe('refineLockReasons (#2596)', () => {
  const why = {
    layout: { id: 1, name: 'Request form', why: null },
    role: 'Field Tech',
    record_lock: 'The Field Tech role can view this record but not change it',
    locks: {
      amount: {
        kind: 'role' as const,
        text: 'Locked for the Field Tech role by a rule on the “Request form” form'
      },
      title: {
        kind: 'permission' as const,
        text: 'The Field Tech role can read this field but not change it (role permissions)'
      }
    }
  }
  it('names the exact rule for general reasons only', () => {
    const out = refineLockReasons(
      {
        amount: 'Locked for your role',
        title: 'Read-only field',
        notes: 'Read-only field',
        total: 'Calculated on save from other fields',
        other: 'Ann is editing this record — read-only until the lock is released'
      },
      why
    )
    expect(out.amount).toBe(why.locks.amount.text)
    expect(out.title).toBe(why.locks.title.text)
    expect(out.notes).toBe(why.record_lock)
    expect(out.total).toBe('Calculated on save from other fields')
    expect(out.other).toContain('is editing')
  })
  it('is a no-op without an answer', () => {
    const r = { a: 'Locked for your role' }
    expect(refineLockReasons(r, null)).toBe(r)
  })
})
