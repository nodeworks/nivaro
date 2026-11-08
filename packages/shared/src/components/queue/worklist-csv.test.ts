import { describe, expect, it } from 'vitest'
import { type CsvRow, worklistCsv, worklistCsvName } from './worklist-csv'

const ctx = {
  stateLabel: (k: string) =>
    k === 'waiting_on_manager_approval' ? 'Waiting on Level 1 Approval' : k,
  collectionLabel: (c: string) => (c === 'workflows' ? 'Workflows' : c),
  extraText: (_p: string, v: string) => (v === 'at_risk' ? 'At Risk' : v),
  extraIsNumber: (p: string) => p === 'req_amount'
}
const row: CsvRow = {
  collection: 'workflows',
  item_id: '372994',
  label: 'MM26-81441 Project',
  state: 'waiting_on_manager_approval',
  owners: [
    { id: 'u1', name: 'Lee Herzog' },
    { id: 'u2', name: 'Redacted Redacted', inactive: 'former' }
  ],
  sla_status: 'breached',
  aging_hours: 36,
  extra: { req_amount: '$3,703.68', forecast_status: 'at_risk', note: '=HYPERLINK("x")' }
}

describe('worklistCsv (army 11 N9)', () => {
  it('writes the on-screen columns in on-screen words, numbers as numbers', () => {
    const text = worklistCsv(
      [row],
      [
        { key: 'label', header: 'Item' },
        { key: 'state', header: 'State' },
        { key: 'owners', header: 'Owners' },
        { key: 'aging_hours', header: 'Aging' },
        { key: 'sla_status', header: 'SLA' },
        { key: 'extra.req_amount', header: 'REQ $' },
        { key: 'extra.forecast_status', header: 'Forecast Status' },
        { key: 'extra.note', header: 'Note' },
        { key: 'actions', header: 'Actions' }
      ],
      ctx
    )
    const [head, line] = text.replace(/^﻿/, '').trim().split('\r\n')
    expect(head).toBe('Item,State,Owners,Aging (days),SLA,REQ $,Forecast Status,Note')
    expect(line).toBe(
      'MM26-81441 Project,Waiting on Level 1 Approval,Lee Herzog; Redacted Redacted (former user),1.5,Breached,3703.68,At Risk,"\'=HYPERLINK(""x"")"'
    )
    // No internal row id anywhere.
    expect(text).not.toContain('372994')
  })
  it('names the file after the worklist and the day', () => {
    expect(worklistCsvName('Inventory Requests', new Date(2026, 10, 8))).toBe(
      'Inventory-Requests-2026-11-08.csv'
    )
  })
})
