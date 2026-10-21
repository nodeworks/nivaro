import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { pickBestLayout } from '../../../routes/collection-layouts.js'
import { changeLogCsv, parsePeriod, summarizeChange } from '../../../services/layout-change-log.js'
import { candidatesAfter, tallyRecordMoves } from '../../../services/layout-merge.js'

const rows = () => [
  { id: 1, name: 'Goods', is_active: 1, sort: 0, record_conditions: null, conditions: null },
  {
    id: 2,
    name: 'Services',
    is_active: 0,
    sort: 1,
    slug: 'svc',
    record_conditions: JSON.stringify([{ field: 'type', op: 'eq', value: 'Services' }]),
    conditions: null
  },
  {
    id: 3,
    name: 'Rush',
    is_active: 0,
    sort: 2,
    record_conditions: JSON.stringify([
      { field: 'type', op: 'eq', value: 'Services' },
      { field: 'rush', op: 'eq', value: '1' }
    ]),
    conditions: null
  }
]

describe('record check', () => {
  it('counts records carried to the merged form, kept and gone elsewhere', () => {
    const before = rows()
    const after = candidatesAfter(
      before,
      1,
      2,
      { record_conditions: null, role_ids: [], is_active: true, slug: 'svc' },
      'Services (merged into Goods)',
      2
    )
    const folded = after.find((r) => r.id === 2)
    expect(folded).toMatchObject({ record_conditions: null, is_active: false, slug: null, sort: 3 })
    const records = [
      { id: 'a', type: 'Goods', rush: '0' },
      { id: 'b', type: 'Services', rush: '0' },
      { id: 'c', type: 'Services', rush: '1' }
    ]
    const [t] = tallyRecordMoves(
      before,
      after,
      records,
      [{ label: 'Everyone', role: null }],
      1,
      2,
      (r, role, rec) => pickBestLayout(r, role, rec, false)
    )
    expect(t).toMatchObject({ kept: 1, carried: 1, sampled: 3, lost: [], gained: [] })
    expect(t.plain).toEqual({ before: 1, after: 1 })
  })
})

describe('change log', () => {
  const snap = (over: Record<string, unknown> = {}) => ({
    layout: { id: 1, name: 'Form', collection: 'po', tab_mode: 'tabs' },
    groups: [{ id: 10, key: 'details', label: 'Details', sort: 0 }],
    assignments: [
      { id: 1, field: 'title', group_key: 'details', sort: 0, col_span: null },
      { id: 2, field: 'amount', group_key: 'details', sort: 1, col_span: null }
    ],
    ...over
  })

  it('names what a change did', () => {
    const from = snap()
    const to = snap({
      layout: { id: 1, name: 'Form', collection: 'po', tab_mode: 'steps' },
      groups: [
        { id: 10, key: 'details', label: 'Details', sort: 0 },
        { id: 11, key: 'extra', label: 'Extra', sort: 1 }
      ],
      assignments: [
        { id: 1, field: 'title', group_key: 'details', sort: 0, col_span: 6 },
        { id: 3, field: 'hours', group_key: 'extra', sort: 0, col_span: null }
      ]
    })
    const s = summarizeChange(from, to, (f) => (f === 'hours' ? 'Hours' : f))
    expect(s).toMatchObject({
      fields_added: 1,
      fields_removed: 1,
      sections_added: 1,
      settings_changed: ['tab_mode']
    })
    expect(s.summary).toMatch(/New: Hours/)
    expect(s.summary).toMatch(/Form settings: tab_mode/)
    expect(s.summary).toMatch(/1 field's settings changed/)
    expect(summarizeChange(snap(), snap(), (f) => f).summary).toBe('No visible change')
  })

  it('reads a period of whole days, at most a year', () => {
    const p = parsePeriod({ from: '2026-10-01', to: '2026-10-21', collection: 'po' })
    expect('error' in p).toBe(false)
    if ('error' in p) return
    expect(p.from.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(p.to.toISOString()).toBe('2026-10-22T00:00:00.000Z')
    expect(parsePeriod({ from: '2026-10-21', to: '2026-10-01' })).toHaveProperty('error')
    expect(parsePeriod({ from: '2024-01-01', to: '2026-01-01' })).toHaveProperty('error')
    expect(parsePeriod({ collection: 'po; drop' })).toHaveProperty('error')
  })

  it('writes a CSV a spreadsheet cannot run', () => {
    const csv = changeLogCsv({
      truncated: false,
      rows: [
        {
          at: '2026-10-20T10:00:00.000Z',
          collection: 'po',
          layout_id: 1,
          layout: 'Form',
          version: 3,
          version_name: null,
          who: 'Ana Admin',
          who_email: 'ana@example.com',
          note: '=HYPERLINK("x")',
          summary: 'New: Hours',
          sections_added: 0,
          sections_removed: 0,
          fields_added: 1,
          fields_removed: 0,
          fields_moved: 0,
          settings_changed: []
        }
      ]
    })
    const lines = csv.split('\r\n')
    expect(lines[0]).toMatch(/^﻿"When \(UTC\)","Collection","Form"/)
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`)
  })
})
