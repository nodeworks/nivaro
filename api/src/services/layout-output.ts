import * as XLSX from 'xlsx'
import type { FormLayoutField, FormLayoutStructure } from './form-layout.js'
import {
  buildXlsx,
  type Cell,
  colName,
  type Sheet,
  sheetName,
  type Validation
} from './xlsx-writer.js'

/**
 * Form-shaped outputs (#2721 #2724 #2729): the same form the people fill in,
 * as a spreadsheet (a template or an export of records, columns in the form's
 * order), as a blank page for pen and paper, and as a sheet of its labels and
 * help text to edit in Excel. Everything here is pure; the routes load the
 * form (loadFormLayout) and the records.
 */

// ── Field kinds ─────────────────────────────────────────────────────────────

export type FieldKind = 'boolean' | 'whole' | 'decimal' | 'date' | 'long' | 'text'

export function fieldKind(f: Pick<FormLayoutField, 'db_type'>): FieldKind {
  const t = f.db_type.toLowerCase()
  if (t === 'boolean' || t === 'bool') return 'boolean'
  if (/^(integer|int|bigint|biginteger|smallint)$/.test(t)) return 'whole'
  if (/^(decimal|float|double|number|numeric|money|currency)$/.test(t)) return 'decimal'
  if (/^(date|datetime|timestamp)$/.test(t)) return 'date'
  if (/^(text|longtext|rich_text|richtext|wysiwyg|json|markdown)$/.test(t)) return 'long'
  return 'text'
}

const KIND_WORDS: Record<FieldKind, string> = {
  boolean: 'Yes or No',
  whole: 'Whole number',
  decimal: 'Number',
  date: 'Date',
  long: 'Long text',
  text: 'Text'
}

export interface OutputField extends FormLayoutField {
  section: string | null
}

/** The form's fields in page order, each with the section it sits in. */
export function flattenForm(structure: FormLayoutStructure): OutputField[] {
  return structure.sections.flatMap((s) => s.fields.map((f) => ({ ...f, section: s.label })))
}

// ── Spreadsheet: template or records ────────────────────────────────────────

export type RecordRow = Record<string, unknown>

/** One stored value as the cell a person reads: choice text, Yes / No, plain text. */
export function cellValue(f: OutputField, raw: unknown): Cell {
  if (raw === null || raw === undefined) return ''
  const kind = fieldKind(f)
  if (kind === 'boolean') {
    if (raw === true || raw === 1 || raw === '1' || raw === 'true') return 'Yes'
    if (raw === false || raw === 0 || raw === '0' || raw === 'false') return 'No'
    return String(raw)
  }
  if (f.choices) {
    const hit = f.choices.find((c) => c.value === String(raw))
    return hit ? hit.text : String(raw)
  }
  if (raw instanceof Date) return raw.toISOString()
  if (typeof raw === 'number' || typeof raw === 'string') return raw
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No'
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

export interface SpreadsheetInput {
  fields: OutputField[]
  /** A records export; omitted = an empty template. */
  records?: RecordRow[]
  /** Put the record id first (an export). */
  withId?: boolean
  formName: string
  collectionLabel: string
}

const TEMPLATE_ROWS = 1000

/**
 * The workbook: sheet 1 is the data (one column per field, in the form's
 * order, required columns amber, choice columns dropdowns), "Fields" explains
 * every column, and a hidden "Lists" sheet holds the dropdown choices.
 */
export function buildSpreadsheet(input: SpreadsheetInput): Buffer {
  const { fields, records, withId } = input
  const taken = new Set<string>()
  const dataName = sheetName(records ? 'Records' : 'Import', taken)
  const fieldsName = sheetName('Fields', taken)
  const listsName = sheetName('Lists', taken)

  const offset = withId ? 1 : 0
  const header: Sheet['rows'][number] = []
  if (withId) header.push({ v: 'ID', s: 'header' })
  for (const f of fields) header.push({ v: f.label, s: f.required ? 'required' : 'header' })

  const body: Sheet['rows'] = (records ?? []).map((rec) => {
    const row: Cell[] = []
    if (withId) row.push(rec.id as Cell)
    for (const f of fields) row.push(cellValue(f, rec[f.path]))
    return row
  })

  // Dropdown choices, one column of the hidden sheet per field.
  const lists: string[][] = []
  const listRange = new Map<string, string>()
  const addList = (key: string, values: string[]) => {
    if (listRange.has(key)) return
    const col = lists.length
    lists.push(values)
    listRange.set(key, `'${listsName}'!$${colName(col)}$1:$${colName(col)}$${values.length}`)
  }
  addList('__yesno', ['Yes', 'No'])
  for (const f of fields)
    if (f.choices)
      addList(
        f.path,
        f.choices.map((c) => c.text)
      )

  const lastRow = Math.max(TEMPLATE_ROWS, body.length + 200) + 1
  const validations: Validation[] = []
  fields.forEach((f, i) => {
    const col = i + offset
    const kind = fieldKind(f)
    const base = { col, fromRow: 2, toRow: lastRow, prompt: f.help ?? f.placeholder ?? undefined }
    if (f.choices) validations.push({ ...base, kind: 'list', listRange: listRange.get(f.path) })
    else if (kind === 'boolean')
      validations.push({ ...base, kind: 'list', listRange: listRange.get('__yesno') })
    else if (kind === 'whole') validations.push({ ...base, kind: 'whole' })
    else if (kind === 'decimal') validations.push({ ...base, kind: 'decimal' })
    else if (kind === 'date') validations.push({ ...base, kind: 'date' })
  })

  const data: Sheet = {
    name: dataName,
    rows: [header, ...body],
    widths: [
      ...(withId ? [10] : []),
      ...fields.map((f) => Math.min(40, Math.max(14, f.label.length + 4)))
    ],
    freezeRows: 1,
    validations
  }

  const guide: Sheet = {
    name: fieldsName,
    freezeRows: 1,
    widths: [26, 24, 24, 16, 10, 60, 40],
    rows: [
      [
        { v: 'Column', s: 'header' },
        { v: 'Field name', s: 'header' },
        { v: 'Section', s: 'header' },
        { v: 'Kind', s: 'header' },
        { v: 'Required', s: 'header' },
        { v: 'Choices', s: 'header' },
        { v: 'Help', s: 'header' }
      ],
      ...(withId
        ? [['ID', 'id', '', 'Record id', '', 'Leave as it is when you send the file back.', '']]
        : []),
      ...fields.map((f): Cell[] => [
        f.label,
        f.path,
        f.section ?? '',
        f.choices ? 'Pick one' : KIND_WORDS[fieldKind(f)],
        f.required ? 'Yes' : '',
        f.choices ? f.choices.map((c) => c.text).join(', ') : '',
        f.help ?? f.placeholder ?? ''
      ]),
      [],
      [`${input.collectionLabel} · ${input.formName}. Amber columns are required.`]
    ]
  }

  const length = Math.max(1, ...lists.map((l) => l.length))
  const hidden: Sheet = {
    name: listsName,
    hidden: true,
    rows: Array.from({ length }, (_, r) => lists.map((l) => l[r] ?? ''))
  }
  return buildXlsx([data, guide, hidden])
}

// ── Blank printable form ────────────────────────────────────────────────────

const h = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )

const MAX_BOXES = 24

function fieldBlock(f: OutputField): { html: string; wide: boolean } {
  const kind = fieldKind(f)
  const star = f.required ? '<span class="req"> *</span>' : ''
  const help = f.help ? `<div class="help">${h(f.help)}</div>` : ''
  const label = `<div class="label">${h(f.label)}${star}</div>${help}`
  let input: string
  let wide = false
  if (kind === 'boolean') {
    input =
      '<div class="boxes"><span><i class="box"></i>Yes</span><span><i class="box"></i>No</span></div>'
  } else if (f.choices && f.choices.length <= MAX_BOXES) {
    wide = f.choices.length > 6
    input = `<div class="boxes">${f.choices.map((c) => `<span><i class="box"></i>${h(c.text)}</span>`).join('')}</div>`
  } else if (kind === 'long') {
    wide = true
    input = '<div class="lines"><i></i><i></i><i></i><i></i></div>'
  } else {
    const hint =
      kind === 'date'
        ? '<span class="hint">date</span>'
        : f.choices
          ? '<span class="hint">choose one</span>'
          : ''
    input = `<div class="line">${hint}</div>`
  }
  return { html: `<div class="field${wide ? ' wide' : ''}">${label}${input}</div>`, wide }
}

/** The form as a blank page: a ruled line, a set of checkboxes or ruled lines for every field. */
export function blankFormHtml(args: {
  structure: FormLayoutStructure
  title: string
  subtitle?: string | null
  logoUrl?: string | null
  fields: OutputField[]
}): string {
  const bySection = new Map<string | null, OutputField[]>()
  for (const f of args.fields) bySection.set(f.section, [...(bySection.get(f.section) ?? []), f])
  const sections = [...bySection.entries()]
    .map(([label, list]) => {
      const blocks = list.map(fieldBlock)
      return `<section>${label ? `<h2>${h(label)}</h2>` : ''}<div class="grid">${blocks.map((b) => b.html).join('')}</div></section>`
    })
    .join('')
  const logo =
    args.logoUrl && /^https?:\/\//i.test(args.logoUrl)
      ? `<img class="logo" src="${h(args.logoUrl)}" alt="">`
      : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font:10.5pt/1.35 Helvetica,Arial,sans-serif;color:#0f172a}
header{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;border-bottom:1.5pt solid #0f172a;padding-bottom:6pt;margin-bottom:10pt}
h1{font-size:17pt;margin:0}.sub{color:#475569;font-size:9.5pt;margin-top:2pt}.logo{max-height:34pt;max-width:120pt}
h2{font-size:11.5pt;margin:14pt 0 6pt;padding-bottom:2pt;border-bottom:.75pt solid #94a3b8;break-after:avoid}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:9pt 18pt}.field{break-inside:avoid}.wide{grid-column:1 / -1}
.label{font-weight:700;font-size:9.5pt}.req{color:#b91c1c}.help{color:#64748b;font-size:8.5pt;margin-top:1pt}
.line{border-bottom:.75pt solid #0f172a;height:19pt;position:relative}.hint{position:absolute;right:0;bottom:2pt;font-size:7.5pt;color:#94a3b8}
.lines i{display:block;border-bottom:.75pt solid #0f172a;height:19pt}
.boxes{display:flex;flex-wrap:wrap;gap:4pt 14pt;padding-top:5pt}.boxes span{display:inline-flex;align-items:center;gap:4pt;font-size:9.5pt}
.box{display:inline-block;width:9pt;height:9pt;border:1pt solid #0f172a;border-radius:1.5pt}
footer{margin-top:14pt;font-size:8pt;color:#64748b}
</style></head><body><header><div><h1>${h(args.title)}</h1>${args.subtitle ? `<div class="sub">${h(args.subtitle)}</div>` : ''}</div>${logo}</header>${sections}<footer><span class="req">*</span> required</footer></body></html>`
}

// ── Help text sheet (#2729) ─────────────────────────────────────────────────

export interface HelpRow {
  /** `s:<group key>` for a section, `f:<field>:<group key>` for a placement. */
  key: string
  kind: 'section' | 'field'
  section: string
  field: string
  label: string
  help: string
  placeholder: string
}

const HELP_SHEET = 'Help text'

export function buildHelpSheet(rows: HelpRow[]): Buffer {
  const head = ['Key', 'Kind', 'Section', 'Field', 'Label', 'Help text', 'Placeholder']
  const sheet: Sheet = {
    name: HELP_SHEET,
    freezeRows: 1,
    widths: [26, 10, 24, 22, 36, 56, 32],
    rows: [
      head.map((v, i) => ({ v, s: i >= 4 ? ('required' as const) : ('header' as const) })),
      ...rows.map(
        (r): Array<Cell | { v: Cell; s: 'note' | 'wrap' | 'plain' }> => [
          { v: r.key, s: 'note' },
          { v: r.kind === 'section' ? 'Section' : 'Field', s: 'note' },
          { v: r.section, s: 'note' },
          { v: r.field, s: 'note' },
          { v: r.label, s: 'wrap' },
          r.kind === 'section' ? { v: '', s: 'note' } : { v: r.help, s: 'wrap' },
          r.kind === 'section' ? { v: '', s: 'note' } : { v: r.placeholder, s: 'wrap' }
        ]
      )
    ]
  }
  const guide: Sheet = {
    name: 'Read me',
    widths: [90],
    rows: [
      [
        'Edit the amber columns (Label, Help text, Placeholder) and leave the grey ones as they are.'
      ],
      [
        'Upload the file back in the layout editor: you see every change before it is applied, and one Undo puts them all back.'
      ],
      ['Clear a cell to remove the text the form set; the field then shows its own.']
    ]
  }
  return buildXlsx([sheet, guide])
}

export interface ParsedHelpRow {
  key: string
  label: string
  help: string
  placeholder: string
}

const cellText = (v: unknown) =>
  v === null || v === undefined ? '' : String(v).replace(/\r\n?/g, '\n').trim()

/** The edited rows of an uploaded help sheet; null when it is not one of ours. */
export function parseHelpSheet(file: Buffer): ParsedHelpRow[] | null {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(file, { type: 'buffer', cellFormula: false })
  } catch {
    return null
  }
  const ws = wb.Sheets[HELP_SHEET] ?? wb.Sheets[wb.SheetNames[0]]
  if (!ws) return null
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false })
  const head = (grid[0] ?? []).map((c) => cellText(c).toLowerCase())
  const at = (name: string) => head.indexOf(name)
  const iKey = at('key')
  const iLabel = at('label')
  const iHelp = at('help text')
  const iPlace = at('placeholder')
  if (iKey < 0 || iLabel < 0) return null
  const out: ParsedHelpRow[] = []
  for (const row of grid.slice(1)) {
    const key = cellText(row[iKey])
    if (!/^(s:|f:)/.test(key)) continue
    out.push({
      key,
      label: cellText(row[iLabel]),
      help: iHelp >= 0 ? cellText(row[iHelp]) : '',
      placeholder: iPlace >= 0 ? cellText(row[iPlace]) : ''
    })
  }
  return out
}
