import { describe, expect, it } from 'vitest'

// The parity checklist for the layout-editor rebuild: one row per setting today's
// Layouts tab offers (or the spec adds), with the home it gets in the new editor.
// Later tests assert a control `data-setting="<key>"` exists for every non-retired row.

const HOMES = ['overview', 'form_settings', 'inspector', 'add_panel', 'canvas']
const STATUSES = ['keep', 'fix', 'add', 'retired']
const SCOPES = ['form', 'field']
const LAYOUT_TYPES = ['grouped', 'table', 'file', 'addendum', 'detail', 'summary']

const SECTIONS: Record<string, string[]> = {
  overview: [
    'Rule table',
    'Opened by a link or button only',
    'Other views',
    'Unused',
    'Actions',
    'Row menu'
  ],
  form_settings: [
    'Who gets this form',
    "How it's laid out",
    'Buttons & panels',
    'Read view & summary',
    'PDF',
    'Addendum',
    'Defaults for new records',
    'Inheritance',
    'AI review, previews, version history'
  ],
  inspector: [
    'Look',
    'Rules',
    'Picker',
    'Grid',
    'Advanced',
    'Group',
    'Slot',
    'Widget',
    'Header item',
    'Subtitle',
    'All tabs'
  ],
  add_panel: ['Fields', 'Related fields', 'Sections', 'Widgets', 'Slots'],
  canvas: [
    'Drag and drop',
    'Ungrouped zone',
    'Header strip',
    'Table zones',
    'Selection',
    'Inherited placements',
    'Top bar'
  ]
}

const RETIRED = [
  'layout.summary_show_all',
  'layout.allow_clone',
  'layout.addendum_lock_fields',
  'slot.pipeline.hide_actions_when_collapsed',
  'widget.is_visible'
]

// Every key nivaro_fields stores that the layout editor can reach (part-field-settings
// global allowlist + spec 9.11): these must be marked as applying to every form.
const GLOBAL_FIELD_KEYS = [
  'field.format',
  'field.currency',
  'field.aggregate',
  'field.unit',
  'field.input_mask',
  'field.allow_upload',
  'field.allow_pick',
  'field.pending_save',
  'field.grid_show_totals',
  'field.group_field',
  'field.option_field',
  'field.column_presets',
  'field.default_preset',
  'field.cascade_filters',
  'field.deprecated',
  'field.deprecation_note'
]

interface ParityRow {
  key: string
  label: string
  home: string | null
  tab_or_section: string | null
  scope: string
  status: string
  layout_types: string[]
}

// Loaded by a non-literal specifier: a static JSON import would have to be listed in the
// composite tsconfig (TS6307), and this package ships no node typings for fs.
const PARITY_JSON = './parity-keys.json'
const rows = (await import(/* @vite-ignore */ PARITY_JSON)).default as ParityRow[]
const byKey = new Map(rows.map((r) => [r.key, r]))

describe('layout editor parity keys', () => {
  it('has unique, non-empty keys and labels', () => {
    expect(rows.length).toBeGreaterThan(0)
    expect(byKey.size).toBe(rows.length)
    for (const r of rows) {
      expect(r.key, JSON.stringify(r)).toMatch(/^[a-z_]+(\.[a-z_]+)+$/)
      expect(r.label.trim(), r.key).not.toBe('')
    }
  })

  it('uses only allowed status, scope and layout types', () => {
    for (const r of rows) {
      expect(STATUSES, r.key).toContain(r.status)
      expect(SCOPES, r.key).toContain(r.scope)
      expect(r.layout_types.length, r.key).toBeGreaterThan(0)
      expect(new Set(r.layout_types).size, r.key).toBe(r.layout_types.length)
      for (const t of r.layout_types) expect(LAYOUT_TYPES, r.key).toContain(t)
    }
  })

  it('gives every non-retired row a home and a section from that home', () => {
    for (const r of rows.filter((x) => x.status !== 'retired')) {
      expect(HOMES, r.key).toContain(r.home)
      expect(SECTIONS[r.home as string], r.key).toContain(r.tab_or_section)
    }
  })

  it('gives retired rows no home', () => {
    for (const r of rows.filter((x) => x.status === 'retired')) {
      expect(r.home, r.key).toBeNull()
      expect(r.tab_or_section, r.key).toBeNull()
    }
  })

  it('retires exactly the settings Rob decided to retire', () => {
    const retired = rows.filter((r) => r.status === 'retired').map((r) => r.key)
    expect(retired.sort()).toEqual([...RETIRED].sort())
  })

  it('marks every global nivaro_fields key as every-form', () => {
    for (const key of GLOBAL_FIELD_KEYS) {
      expect(byKey.get(key)?.scope, key).toBe('field')
    }
  })

  it('covers every form settings section', () => {
    const used = new Set(
      rows.filter((r) => r.home === 'form_settings').map((r) => r.tab_or_section)
    )
    for (const s of SECTIONS.form_settings) expect(used, s).toContain(s)
  })
})
