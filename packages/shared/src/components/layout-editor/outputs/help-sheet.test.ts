import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../../lib/layout-ops'
import { inverseOps } from '../useLayoutDraft'
import { diffHelpSheet, type HelpGlobals, helpSheetPlan, helpSheetRows } from './help-sheet'

// #2729: rows out of the draft, a diff against an uploaded sheet, one ops batch back.

const place = (
  field: string,
  group: string | null,
  sort: number,
  over: Partial<PlacementRow> = {}
) => ({ ...newPlacement(field, group), sort, ...over })
const grp = (key: string, label: string, sort: number): GroupRow => ({
  ...newGroup(key, label, 'section', null),
  sort
})

function bundle(): LayoutBundle {
  return {
    layout: { id: 1, collection: 'orders', name: 'Form', layout_type: 'grouped' },
    groups: [grp('main', 'Basics', 0), grp('more', 'More', 1), ungroupedGroup(2)],
    rev: 'r',
    placements: [
      place('title', 'main', 0, { overrides: { label: 'Subject', note: 'Short summary' } }),
      place('status', 'main', 1, { label_override: 'State' }),
      place('qty', 'more', 0),
      place('loose', null, 0),
      place('__comments__', null, 1)
    ]
  }
}

const globals: HelpGlobals[] = [
  { field: 'title', label: 'Title' },
  { field: 'status', label: 'Status', note: 'Where it stands', placeholder: 'Pick one' },
  { field: 'qty', label: 'Quantity' }
]

describe('help text sheet', () => {
  it('lists each section then its fields, with what the form shows today', () => {
    const rows = helpSheetRows(bundle(), globals)
    expect(rows.map((r) => r.key)).toEqual([
      's:main',
      'f:title:main',
      'f:status:main',
      's:more',
      'f:qty:more',
      'f:loose:'
    ])
    const title = rows[1]
    expect([title.label, title.help]).toEqual(['Subject', 'Short summary'])
    const status = rows[2]
    expect([status.label, status.help, status.placeholder]).toEqual([
      'State',
      'Where it stands',
      'Pick one'
    ])
    expect(rows.find((r) => r.field === 'loose')?.label).toBe('Loose')
  })

  it('an unedited sheet changes nothing', () => {
    const b = bundle()
    const diff = diffHelpSheet(b, globals, helpSheetRows(b, globals))
    expect(diff.changes).toEqual([])
    expect(diff.same).toBe(6)
    expect(diff.unknown).toBe(0)
  })

  it('finds edited cells, ignores clearing text the field supplies, flags unknown rows', () => {
    const b = bundle()
    const rows = helpSheetRows(b, globals).map((r) => ({
      key: r.key,
      label: r.label,
      help: r.help,
      placeholder: r.placeholder
    }))
    const edit = (key: string, over: Record<string, string>) =>
      Object.assign(rows.find((r) => r.key === key) ?? {}, over)
    edit('s:main', { label: 'Essentials' })
    edit('f:title:main', { label: 'Heading', help: '' })
    edit('f:status:main', { help: '', label: 'Stage', placeholder: 'Choose' })
    edit('s:more', { label: '' })
    rows.push({ key: 'f:gone:main', label: 'x', help: '', placeholder: '' })
    const diff = diffHelpSheet(b, globals, rows)
    expect(diff.changes.map((c) => c.id).sort()).toEqual(
      [
        's:main|label',
        'f:title:main|label',
        'f:title:main|help',
        'f:status:main|label',
        'f:status:main|placeholder'
      ].sort()
    )
    // status help comes from the field and the form sets none: clearing it is not a change.
    expect(diff.changes.some((c) => c.key === 'f:status:main' && c.prop === 'help')).toBe(false)
    expect(diff.unknown).toBe(1)
    expect(diff.skipped).toEqual(['More: a section needs a name'])
  })

  it('applies the ticked changes as one batch that undoes whole', () => {
    const b = bundle()
    const diff = diffHelpSheet(b, globals, [
      { key: 's:main', label: 'Essentials', help: '', placeholder: '' },
      { key: 'f:title:main', label: 'Heading', help: '', placeholder: 'e.g. Leak' },
      { key: 'f:status:main', label: 'Stage', help: 'Now', placeholder: 'Pick one' }
    ])
    const plan = helpSheetPlan(b, diff.changes)
    if (!plan.ok) throw new Error(plan.reason)
    const next = applyLayoutOps(b, plan.ops)
    const g = next.groups.find((x) => x.key === 'main')
    expect(g?.label).toBe('Essentials')
    const pl = (f: string) => next.placements.find((p) => p.field === f)
    // title: its own override label changes, the cleared help text drops the override.
    expect(pl('title')?.overrides).toEqual({ label: 'Heading', placeholder: 'e.g. Leak' })
    // status used the older label_override, which stays the label's home.
    expect(pl('status')?.label_override).toBe('Stage')
    expect(pl('status')?.overrides).toEqual({ note: 'Now' })
    const back = applyLayoutOps(next, inverseOps(b, plan.ops))
    const pb = (f: string) => back.placements.find((p) => p.field === f)
    expect(pb('title')?.overrides).toEqual({ label: 'Subject', note: 'Short summary' })
    expect(pb('status')?.label_override).toBe('State')
    expect(pb('status')?.overrides).toBeNull()
    expect(back.groups.find((x) => x.key === 'main')?.label).toBe('Basics')
    expect(plan.ops.filter((o) => o.op === 'update_placement')).toHaveLength(2)
  })

  it('refuses an empty pick', () => {
    expect(helpSheetPlan(bundle(), []).ok).toBe(false)
  })
})
