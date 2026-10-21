import { describe, expect, it } from 'vitest'
import { type BulkFieldsReport, bulkFieldNote, bulkFieldSections } from './bulk-field-options'

const form = (over: Partial<BulkFieldsReport['forms'][number]> = {}) => ({
  layout_id: 1,
  name: 'Main',
  records: 3,
  ungrouped_sort: null,
  groups: [{ id: 1, key: 'money', label: 'Money', type: 'section', sort: 1, container_id: null }],
  placements: [
    { field: 'amount', group_key: 'money', sort: 1, label_override: null, is_visible: true },
    { field: 'code', group_key: 'money', sort: 2, label_override: 'Cost code', is_visible: true },
    { field: 'secret', group_key: 'money', sort: 3, label_override: null, is_visible: true }
  ],
  ...over
})

describe('bulkFieldSections', () => {
  it('lists the form’s fields the person may change, in its sections', () => {
    const report: BulkFieldsReport = {
      readable: 4,
      no_form: 0,
      forms: [
        form(),
        form({
          layout_id: 2,
          name: 'Other',
          records: 1,
          groups: [
            { id: 9, key: 'x', label: 'Extra', type: 'section', sort: 1, container_id: null }
          ],
          placements: [
            { field: 'amount', group_key: 'x', sort: 1, label_override: null, is_visible: true },
            { field: 'site', group_key: 'x', sort: 2, label_override: null, is_visible: true }
          ]
        })
      ],
      fields: {
        amount: { records: 4, locked: 0, reason: null },
        code: { records: 3, locked: 3, reason: 'The “Money” section is locked for your role' },
        site: { records: 1, locked: 0, reason: null }
      }
    }
    const out = bulkFieldSections(report, { amount: 'Amount' })
    expect(out.map((s) => [s.label, s.options.map((o) => o.field)])).toEqual([
      ['Money', ['amount', 'code']],
      ['Extra', ['site']]
    ])
    const [amount, code] = out[0].options
    expect(amount).toMatchObject({ label: 'Amount', writable: 4, offForm: 0 })
    expect(code).toMatchObject({ label: 'Cost code', writable: 0, offForm: 1, locked: 3 })
    expect(bulkFieldNote(amount, 4)).toBeNull()
    expect(bulkFieldNote(code, 4)).toBe('0 of 4 — locked on 3, not on the form of 1')
    expect(bulkFieldNote(out[1].options[0], 4)).toBe('1 of 4 — not on the form of 3')
  })

  it('names the lock when every record locks the field', () => {
    expect(
      bulkFieldNote(
        {
          field: 'c',
          label: 'C',
          writable: 0,
          offForm: 0,
          locked: 2,
          reason: 'Locked for your role on this form'
        },
        2
      )
    ).toBe('Locked for your role on this form')
  })

  it('records without a form offer every field the person may change', () => {
    const out = bulkFieldSections({
      readable: 2,
      no_form: 2,
      forms: [],
      fields: {
        b: { records: 2, locked: 0, reason: null },
        a: { records: 2, locked: 0, reason: null }
      }
    })
    expect(out).toEqual([
      {
        key: '__no_form__',
        label: 'Fields',
        options: [
          { field: 'a', label: 'A', writable: 2, offForm: 0, locked: 0, reason: null },
          { field: 'b', label: 'B', writable: 2, offForm: 0, locked: 0, reason: null }
        ]
      }
    ])
  })
})
