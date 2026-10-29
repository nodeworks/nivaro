import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/permissions.js', () => ({
  can: async () => true,
  getAllowedFields: async () => null
}))

import {
  matchesRecordConditions,
  pickBestLayoutTraced
} from '../../../routes/collection-layouts.js'
import {
  type CoverageDeps,
  fieldMetaFromRows,
  requirementsFromTransitions,
  tallyCoverage
} from '../../../services/layout-analysis.js'
import { lintLayout } from '../../../services/layout-lint.js'
import { parseRecordConditions, type RecordConditionRule } from '../../../services/layout-patch.js'

const SHARED_TWIN = new URL(
  '../../../../../packages/shared/src/lib/layout-lint.ts',
  import.meta.url
)
const API_TWIN = new URL('../../../services/layout-lint.ts', import.meta.url)

describe('layout lint twin', () => {
  it('is byte-identical to the packages/shared twin', () => {
    expect(readFileSync(API_TWIN, 'utf8')).toBe(readFileSync(SHARED_TWIN, 'utf8'))
  })

  it('runs on the server side', () => {
    const findings = lintLayout(
      {
        layout: { id: 1, layout_type: 'grouped' },
        groups: [{ key: 'main', parent_key: null, sort: 0, label: 'Main', type: 'section' }],
        placements: [{ field: 'title', group_key: 'main', sort: 0, is_visible: false }]
      },
      { fields: [{ field: 'title', required: true }], roles: [], requirements: [] }
    )
    expect(findings.map((f) => f.rule)).toEqual(['required-hidden'])
  })
})

describe('lint context readers', () => {
  it('reads field flags, cascade parents and widths', () => {
    expect(
      fieldMetaFromRows([
        {
          field: 'contact',
          label: 'Contact',
          required: 1,
          hidden: 0,
          readonly: false,
          options: JSON.stringify({ col_span: 6 }),
          dependency_config: JSON.stringify({
            cascade_filters: [{ parent_field: 'vendor', filter_column: 'vendor_id' }]
          })
        }
      ])
    ).toEqual([
      {
        field: 'contact',
        label: 'Contact',
        required: true,
        hidden: false,
        readonly: false,
        cascade_parents: ['vendor'],
        col_span: 6,
        type: null,
        note: null
      }
    ])
  })

  it('keeps only non-optional record_fields requirements', () => {
    expect(
      requirementsFromTransitions([
        {
          label: 'Approve',
          required_roles: '["r1"]',
          requirements: JSON.stringify([
            { type: 'record_fields', fields: ['po', 'site'] },
            { type: 'record_fields', optional: true, fields: ['skip'] },
            { type: 'child_fields', collection: 'lines', fk_field: 'x', fields: ['qty'] }
          ])
        },
        { label: 'Close', required_roles: null, requirements: null }
      ])
    ).toEqual([
      { field: 'po', transition: 'Approve', role_ids: ['r1'] },
      { field: 'site', transition: 'Approve', role_ids: ['r1'] }
    ])
  })
})

describe('tallyCoverage', () => {
  const deps: CoverageDeps = {
    pick: (layouts, record) => pickBestLayoutTraced(layouts, null, record, true).row,
    rulesOf: (l) => parseRecordConditions(l.record_conditions),
    matches: (rules, record) => matchesRecordConditions(rules as RecordConditionRule[], record)
  }
  const layouts = [
    { id: 1, name: 'Default', is_active: 1, record_conditions: null },
    {
      id: 2,
      name: 'Open',
      is_active: 0,
      record_conditions: JSON.stringify([{ field: 'status', op: 'eq', value: 'open' }])
    },
    {
      id: 3,
      name: 'Open urgent',
      is_active: 0,
      record_conditions: JSON.stringify([
        { field: 'status', op: 'eq', value: 'open' },
        { field: 'urgent', op: 'eq', value: '1' }
      ])
    },
    {
      id: 4,
      name: 'Archived',
      is_active: 0,
      record_conditions: JSON.stringify([{ field: 'status', op: 'eq', value: 'archived' }])
    }
  ]

  it('counts the form each record resolves to and what each rule matches', () => {
    const out = tallyCoverage(
      layouts,
      [
        { id: 1, status: 'open', urgent: 1 },
        { id: 2, status: 'open', urgent: 0 },
        { id: 3, status: 'closed', urgent: 0 },
        null
      ],
      deps
    )
    expect(out.sampled).toBe(4)
    expect(out.no_form).toBe(0)
    expect(out.rows).toEqual([
      { layout_id: 1, records: 2, rule_matches: null },
      { layout_id: 2, records: 1, rule_matches: 2 },
      { layout_id: 3, records: 1, rule_matches: 1 },
      { layout_id: 4, records: 0, rule_matches: 0 }
    ])
  })
})
