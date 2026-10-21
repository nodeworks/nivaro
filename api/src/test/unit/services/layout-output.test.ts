import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  blankFormHtml,
  buildHelpSheet,
  buildSpreadsheet,
  cellValue,
  fieldKind,
  type HelpRow,
  type OutputField,
  parseHelpSheet
} from '../../../services/layout-output.js'
import { buildXlsx, colName, sheetName } from '../../../services/xlsx-writer.js'

const field = (over: Partial<OutputField> & { path: string }): OutputField => ({
  label: over.path,
  db_type: 'string',
  required: false,
  placeholder: null,
  choices: null,
  visibility: null,
  section: null,
  ...over
})

const FIELDS: OutputField[] = [
  field({ path: 'title', label: 'Title', required: true, section: 'Basics', help: 'What it is' }),
  field({
    path: 'status',
    label: 'Status',
    section: 'Basics',
    choices: [
      { value: 'open', text: 'Open' },
      { value: 'done', text: 'Done, closed' }
    ]
  }),
  field({ path: 'urgent', label: 'Urgent', db_type: 'boolean', section: 'Details' }),
  field({ path: 'qty', label: 'Quantity', db_type: 'integer', section: 'Details' }),
  field({ path: 'notes', label: 'Notes', db_type: 'text', section: 'Details' })
]

/** The text of one part of the workbook zip (stored, so a plain scan finds it). */
const zipText = (buf: Buffer) => buf.toString('latin1')

describe('xlsx writer', () => {
  it('names columns and sheets the way Excel does', () => {
    expect(colName(0)).toBe('A')
    expect(colName(25)).toBe('Z')
    expect(colName(26)).toBe('AA')
    const taken = new Set<string>()
    expect(sheetName('Records: a/b?', taken)).toBe('Records a b')
    expect(sheetName('records a b', taken)).toBe('records a b 2')
    expect(sheetName('x'.repeat(40), new Set()).length).toBe(31)
  })

  it('writes a workbook SheetJS reads back, with strings, numbers and booleans', () => {
    const buf = buildXlsx([
      { name: 'One', rows: [['a', 1, true], [], [{ v: 'x & <y>', s: 'header' }]] }
    ])
    const wb = XLSX.read(buf, { type: 'buffer' })
    expect(wb.SheetNames).toEqual(['One'])
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.One, { header: 1 })
    expect(rows[0]).toEqual(['a', 1, true])
    expect(rows[2]).toEqual(['x & <y>'])
  })
})

describe('spreadsheet in the form shape (#2721)', () => {
  it('kinds map from the stored type', () => {
    expect(fieldKind({ db_type: 'boolean' })).toBe('boolean')
    expect(fieldKind({ db_type: 'integer' })).toBe('whole')
    expect(fieldKind({ db_type: 'decimal' })).toBe('decimal')
    expect(fieldKind({ db_type: 'dateTime' })).toBe('date')
    expect(fieldKind({ db_type: 'text' })).toBe('long')
    expect(fieldKind({ db_type: 'string' })).toBe('text')
  })

  it('shows choice text, Yes / No and plain values', () => {
    expect(cellValue(FIELDS[1], 'done')).toBe('Done, closed')
    expect(cellValue(FIELDS[1], 'gone')).toBe('gone')
    expect(cellValue(FIELDS[2], 1)).toBe('Yes')
    expect(cellValue(FIELDS[2], false)).toBe('No')
    expect(cellValue(FIELDS[3], 4)).toBe(4)
    expect(cellValue(FIELDS[0], null)).toBe('')
  })

  it('a template has the form’s columns in order, a dropdown per choice, required marked', () => {
    const buf = buildSpreadsheet({ fields: FIELDS, formName: 'Intake', collectionLabel: 'Ticket' })
    const wb = XLSX.read(buf, { type: 'buffer' })
    expect(wb.SheetNames).toEqual(['Import', 'Fields', 'Lists'])
    const grid = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Import, { header: 1 })
    expect(grid[0]).toEqual(['Title', 'Status', 'Urgent', 'Quantity', 'Notes'])
    const text = zipText(buf)
    // Status is a list over the hidden Lists sheet; Urgent is Yes / No; Quantity a whole number.
    expect(text).toContain('sqref="B2:B1001" type="list"')
    expect(text).toContain("<formula1>'Lists'!$B$1:$B$2</formula1>")
    expect(text).toContain('sqref="C2:C1001" type="list"')
    expect(text).toContain('sqref="D2:D1001" type="whole"')
    expect(text).toContain('state="hidden"')
    // Required header uses the amber style (s="2"), the others the dark one (s="1").
    expect(text).toContain('<c r="A1" s="2" t="inlineStr">')
    expect(text).toContain('<c r="B1" s="1" t="inlineStr">')
    // The frozen header row.
    expect(text).toContain('state="frozen"')
    const lists = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Lists, { header: 1 })
    expect(lists.flat()).toEqual(expect.arrayContaining(['Yes', 'No', 'Open', 'Done, closed']))
    const guide = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Fields, { header: 1 })
    expect(guide[1].slice(0, 5)).toEqual(['Title', 'title', 'Basics', 'Text', 'Yes'])
    expect(guide[2][5]).toBe('Open, Done, closed')
  })

  it('an export puts the id first and the rows under the same columns', () => {
    const buf = buildSpreadsheet({
      fields: FIELDS,
      withId: true,
      formName: 'Intake',
      collectionLabel: 'Ticket',
      records: [
        { id: 7, title: 'Leak', status: 'open', urgent: 1, qty: 3, notes: 'wet' },
        { id: 8, title: 'Door', status: 'done', urgent: 0, qty: null, notes: null }
      ]
    })
    const wb = XLSX.read(buf, { type: 'buffer' })
    expect(wb.SheetNames[0]).toBe('Records')
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Records, { header: 1 })
    expect(grid[0]).toEqual(['ID', 'Title', 'Status', 'Urgent', 'Quantity', 'Notes'])
    expect(grid[1]).toEqual([7, 'Leak', 'Open', 'Yes', 3, 'wet'])
    expect(grid[2].slice(0, 4)).toEqual([8, 'Door', 'Done, closed', 'No'])
    // Validations start one column to the right of the id.
    expect(zipText(buf)).toContain('sqref="C2:C1001" type="list"')
  })
})

describe('blank printable form (#2724)', () => {
  const html = blankFormHtml({
    structure: { tab_mode: 'tabs', sections: [], field_paths: [] },
    title: 'Site <visit>',
    subtitle: 'Ticket',
    logoUrl: 'javascript:alert(1)',
    fields: FIELDS
  })

  it('has a line, checkboxes or ruled lines per field, and escapes text', () => {
    expect(html).toContain('Site &lt;visit&gt;')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('<h2>Basics</h2>')
    expect(html).toContain('<h2>Details</h2>')
    expect(html).toContain('Title<span class="req"> *</span>')
    expect(html).toContain('What it is')
    // Status: a checkbox per choice. Urgent: Yes / No. Notes: ruled lines.
    expect(html).toContain('<i class="box"></i>Open')
    expect(html).toContain('<i class="box"></i>Done, closed')
    expect(html).toContain('<i class="box"></i>Yes')
    expect(html).toContain('<div class="lines">')
  })

  it('a long choice list falls back to one line', () => {
    const many = field({
      path: 'site',
      choices: Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, text: `Site ${i}` }))
    })
    const out = blankFormHtml({
      structure: { tab_mode: 'tabs', sections: [], field_paths: [] },
      title: 'T',
      fields: [many]
    })
    expect(out).not.toContain('class="box"')
    expect(out).toContain('choose one')
  })
})

describe('help text sheet (#2729)', () => {
  const ROWS: HelpRow[] = [
    {
      key: 's:basics',
      kind: 'section',
      section: 'Basics',
      field: '',
      label: 'Basics',
      help: '',
      placeholder: ''
    },
    {
      key: 'f:title:basics',
      kind: 'field',
      section: 'Basics',
      field: 'title',
      label: 'Title',
      help: 'What it is',
      placeholder: 'e.g. Leak'
    },
    {
      key: 'f:notes:',
      kind: 'field',
      section: 'Ungrouped',
      field: 'notes',
      label: 'Notes',
      help: 'Line one\nLine two',
      placeholder: ''
    }
  ]

  it('round-trips the keys and the three editable columns', () => {
    const parsed = parseHelpSheet(buildHelpSheet(ROWS))
    expect(parsed).toEqual([
      { key: 's:basics', label: 'Basics', help: '', placeholder: '' },
      { key: 'f:title:basics', label: 'Title', help: 'What it is', placeholder: 'e.g. Leak' },
      { key: 'f:notes:', label: 'Notes', help: 'Line one\nLine two', placeholder: '' }
    ])
  })

  it('reads edits made in a spreadsheet program', () => {
    const wb = XLSX.read(buildHelpSheet(ROWS), { type: 'buffer' })
    const ws = wb.Sheets['Help text']
    ws.E3 = { t: 's', v: 'Heading' }
    ws.F3 = { t: 's', v: '' }
    const edited = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const parsed = parseHelpSheet(edited)
    expect(parsed?.[1]).toEqual({
      key: 'f:title:basics',
      label: 'Heading',
      help: '',
      placeholder: 'e.g. Leak'
    })
  })

  it('refuses a file that is not a help sheet', () => {
    const other = buildXlsx([
      {
        name: 'Sheet1',
        rows: [
          ['a', 'b'],
          [1, 2]
        ]
      }
    ])
    expect(parseHelpSheet(other)).toBeNull()
    expect(parseHelpSheet(Buffer.from('not a workbook'))).toBeNull()
  })
})
