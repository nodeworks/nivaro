import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  buildExportTable,
  cellText,
  columnWidths,
  displayCell,
  headerFor,
  tableToAoa,
  tableToCsv
} from '../../../services/ai-export-table.js'

const NY = 'America/New_York'

// The rows behind the answer exported on production: a record query that asked
// for columns of linked records, so each link came back as a nested object.
const fields = [
  'inventory_request_id',
  'date_created',
  'user_created.first_name',
  'user_created.last_name',
  'division.name',
  'region.short_name',
  'project_type.name',
  'is_on_hold',
  'requested_delivery_date',
  'supporting_warehouse.name'
]
const row = {
  inventory_request_id: 'GE22INV-37440',
  date_created: new Date('2026-11-09T05:56:12.000Z'),
  user_created: { id: 'u-1', first_name: 'Steven', last_name: 'Moye' },
  division: { id: 1, name: 'Zone 1' },
  region: { id: 3, short_name: 'NER' },
  project_type: { id: 28, name: 'Genesis' },
  is_on_hold: false,
  requested_delivery_date: new Date('2026-11-16T00:00:00.000Z'),
  supporting_warehouse: { id: 4, name: 'PAE77' }
}
const labels: Record<string, string> = {
  inventory_request_id: 'IR ID',
  date_created: 'Created',
  user_created: 'Created By',
  division: 'Zone',
  is_on_hold: 'On Hold'
}
const kinds: Record<string, 'instant' | 'naive' | 'date'> = {
  date_created: 'instant',
  requested_delivery_date: 'date'
}
const meta = {
  fields,
  label: (p: string) => labels[p],
  kind: (p: string) => kinds[p],
  timeZone: NY
}

describe('displayCell — what one value shows', () => {
  it('shows a linked record by its name, never as JSON or a bare id', () => {
    expect(displayCell({ id: 28, name: 'Genesis' })).toBe('Genesis')
    expect(displayCell({ id: 7, label: 'Acme' })).toBe('Acme')
    expect(displayCell({ id: 'u-1', first_name: 'Steven', last_name: 'Moye' })).toBe('Steven Moye')
    // Two hops: the linked record's own link reads through.
    expect(displayCell({ id: 9, name: 'FDX', region: { id: 3, short_name: 'NER' } })).toBe(
      'FDX NER'
    )
  })

  it('keeps the id when that is all the reader may see of the linked record', () => {
    expect(displayCell({ id: 28 })).toBe(28)
    expect(displayCell(1201)).toBe(1201)
  })

  it('lists several linked records, comma-separated', () => {
    expect(
      displayCell([
        { id: 1, name: 'Zone 1' },
        { id: 2, label: 'Zone 2' }
      ])
    ).toBe('Zone 1, Zone 2')
    expect(displayCell(['a', 'b'])).toBe('a, b')
    expect(displayCell([])).toBeNull()
  })

  it('writes yes/no, keeps numbers as numbers and blanks as blanks', () => {
    expect(displayCell(true)).toBe('Yes')
    expect(displayCell(false)).toBe('No')
    expect(displayCell(-5)).toBe(-5)
    expect(displayCell(null)).toBeNull()
    expect(displayCell('')).toBeNull()
  })

  it('writes plain settings data as readable pairs, not braces', () => {
    expect(displayCell({ width: 2, colour: 'red' })).toBe('Width: 2; Colour: red')
  })

  it('shows a timestamp in the reader’s time zone and a calendar date as written', () => {
    const stamp = displayCell(new Date('2026-11-09T22:08:53Z'), { kind: 'instant', timeZone: NY })
    expect(cellText(stamp)).toBe('2026-11-09 5:08 PM')
    // A date column arrives as UTC midnight: shifting it would show the day before.
    const due = displayCell(new Date('2026-11-16T00:00:00Z'), { kind: 'date', timeZone: NY })
    expect(cellText(due)).toBe('2026-11-16')
    // A clock time stored without a zone stays the clock time it is.
    const naive = displayCell(new Date('2026-11-16T14:30:00Z'), { kind: 'naive', timeZone: NY })
    expect(cellText(naive)).toBe('2026-11-16 2:30 PM')
    // The same values as text (a tool result that was serialized).
    expect(
      cellText(displayCell('2026-11-09T22:08:53.686Z', { kind: 'instant', timeZone: NY }))
    ).toBe('2026-11-09 5:08 PM')
    // Text in a column nobody said holds dates is left alone.
    expect(displayCell('2026-11-09T22:08:53.686Z')).toBe('2026-11-09T22:08:53.686Z')
  })
})

describe('headerFor', () => {
  it('uses the configured label, else the field name in plain words', () => {
    expect(headerFor('is_on_hold', (p) => labels[p])).toBe('On Hold')
    expect(headerFor('requested_delivery_date')).toBe('Requested Delivery Date')
    expect(headerFor('inventory_request_id')).toBe('Inventory Request ID')
    expect(headerFor('file_url')).toBe('File URL')
  })
})

describe('buildExportTable — the file behind an answer', () => {
  it('gives one readable column per thing asked for (the production export)', () => {
    const table = buildExportTable([row], meta)
    expect(table.headers).toEqual([
      'IR ID',
      'Created',
      'Created By',
      'Zone',
      'Region',
      'Project Type',
      'On Hold',
      'Requested Delivery Date',
      'Supporting Warehouse'
    ])
    expect(table.rows[0].map(cellText)).toEqual([
      'GE22INV-37440',
      '2026-11-09 12:56 AM',
      'Steven Moye',
      'Zone 1',
      'NER',
      'Genesis',
      'No',
      '2026-11-16',
      'PAE77'
    ])
    // The complaint, as an assertion: no cell is a JSON blob.
    for (const cell of table.rows[0]) expect(cellText(cell)).not.toMatch(/[{}"]/)
  })

  it('splits several columns of one linked record, keeping a person’s name together', () => {
    const table = buildExportTable(
      [
        {
          creator: { id: 'u', first_name: 'Richard', last_name: 'Peart', email: 'r@example.com' },
          project: { id: 5, project_id: 'NAT TPX', name: 'NAT TPX EXPENSE 2026' }
        }
      ],
      {
        fields: [
          'creator.first_name',
          'creator.last_name',
          'creator.email',
          'project.project_id',
          'project.name'
        ],
        label: (p) => ({ creator: 'Created By', 'project.project_id': 'Project ID' })[p]
      }
    )
    expect(table.headers).toEqual(['Created By', 'Created By Email', 'Project ID', 'Project Name'])
    expect(table.rows[0]).toEqual([
      'Richard Peart',
      'r@example.com',
      'NAT TPX',
      'NAT TPX EXPENSE 2026'
    ])
  })

  it('shows what the reader has of a link that was not opened for them', () => {
    const table = buildExportTable(
      [
        { name: 'A', vendor: { id: 7, label: 'Acme' } },
        { name: 'B', vendor: 1201 },
        { name: 'C', vendor: null }
      ],
      { fields: ['name', 'vendor.name'] }
    )
    expect(table.headers).toEqual(['Name', 'Vendor'])
    expect(table.rows.map((r) => r[1])).toEqual(['Acme', 1201, null])
  })

  it('exports every column, labelled, when the query named none', () => {
    const table = buildExportTable(
      [
        { id: 1, vendor: { id: 7, label: 'Acme' }, tags: ['a', 'b'] },
        { id: 2, vendor: 1201, note: 'x' }
      ],
      { label: (p) => (p === 'vendor' ? 'Supplier' : undefined) }
    )
    expect(table.headers).toEqual(['ID', 'Supplier', 'Tags', 'Note'])
    expect(table.rows).toEqual([
      [1, 'Acme', 'a, b', null],
      [2, 1201, null, 'x']
    ])
  })

  it('leaves out a column the query asked for but the read did not return', () => {
    const table = buildExportTable([{ name: 'A' }], { fields: ['name', 'secret', 'vendor.name'] })
    expect(table.headers).toEqual(['Name'])
    // With no rows at all the file still carries the headers that were asked for.
    expect(buildExportTable([], { fields: ['name', 'vendor.name'] }).headers).toEqual([
      'Name',
      'Vendor'
    ])
  })

  it('keeps two columns apart when their labels are the same', () => {
    const table = buildExportTable([{ a: 1, b: 2 }], { label: () => 'Amount' })
    expect(table.headers).toEqual(['Amount', 'Amount (2)'])
  })
})

describe('writing the file', () => {
  const table = buildExportTable(
    [
      { ...row, note: '=SUM(A1)', amount: -5 },
      { inventory_request_id: 'x,y', date_created: null }
    ],
    { ...meta, fields: [...fields, 'note', 'amount'] }
  )

  it('writes CSV with labels, numbers as numbers and formula-safe text', () => {
    const [head, r1, r2] = tableToCsv(table).split('\r\n')
    expect(head.startsWith('"IR ID","Created","Created By"')).toBe(true)
    expect(r1).toContain('"2026-11-09 12:56 AM","Steven Moye","Zone 1","NER","Genesis","No"')
    expect(r1.endsWith('"\'=SUM(A1)",-5')).toBe(true)
    expect(r2.startsWith('"x,y","",')).toBe(true)
    expect(tableToCsv(table)).not.toContain('{')
  })

  it('writes a workbook whose dates are real dates and whose links are names', () => {
    const ws = XLSX.utils.aoa_to_sheet(tableToAoa(table))
    ws['!cols'] = columnWidths(table)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Answer')
    const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), {
      type: 'buffer'
    }).Sheets.Answer
    expect(back.A1.v).toBe('IR ID')
    expect(back.F2.v).toBe('Genesis')
    expect(back.C2.v).toBe('Steven Moye')
    // A date cell: a number Excel sorts and filters, shown the way the text reads.
    expect(back.B2.t).toBe('n')
    expect(back.B2.w).toBe('2026-11-09 12:56 AM')
    expect(back.H2.w).toBe('2026-11-16')
    expect(columnWidths(table)).toHaveLength(table.headers.length)
  })
})
