/**
 * A small .xlsx writer for workbooks that need what SheetJS Community cannot
 * write: dropdown (data validation) cells, a frozen header row, coloured
 * header cells and hidden sheets. Strings are inline, the zip is stored
 * (uncompressed) — a sheet of a few thousand rows is small either way, and
 * Excel, Numbers and Google Sheets all open it.
 */

import { buildZip } from './zip-writer.js'

export type Cell = string | number | boolean | null | undefined

/** A header or body cell look. */
export type CellStyle = 'plain' | 'header' | 'required' | 'note' | 'wrap'

export interface Validation {
  /** 0-based column. */
  col: number
  /** 1-based first and last row the rule covers. */
  fromRow: number
  toRow: number
  kind: 'list' | 'decimal' | 'whole' | 'date'
  /** For `list`: a range in another sheet, e.g. `Lists!$A$1:$A$12`. */
  listRange?: string
  /** For `list`: the options inline (short lists only; 255 characters in all). */
  list?: string[]
  prompt?: string
}

export interface Sheet {
  name: string
  hidden?: boolean
  rows: Array<Array<Cell | { v: Cell; s: CellStyle }>>
  widths?: number[]
  /** Freeze this many rows at the top. */
  freezeRows?: number
  validations?: Validation[]
}

const STYLE_ID: Record<CellStyle, number> = { plain: 0, header: 1, required: 2, note: 3, wrap: 4 }

const esc = (s: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 forbids these characters
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, (c) => {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  })

/** Column letters for a 0-based index: 0 → A, 26 → AA. */
export function colName(i: number): string {
  let n = i
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/** Excel limits a sheet name to 31 characters and forbids : \ / ? * [ ]. */
export function sheetName(raw: string, taken: Set<string>): string {
  const base =
    raw
      .replace(/[:\\/?*[\]']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 31) || 'Sheet'
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++)
    name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`
  taken.add(name.toLowerCase())
  return name
}

function cellXml(ref: string, raw: Cell | { v: Cell; s: CellStyle }): string {
  const styled = raw !== null && typeof raw === 'object'
  const v = styled ? (raw as { v: Cell }).v : (raw as Cell)
  const s = styled ? STYLE_ID[(raw as { s: CellStyle }).s] : 0
  const attr = s ? ` s="${s}"` : ''
  if (v === null || v === undefined || v === '') return s ? `<c r="${ref}"${attr}/>` : ''
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${attr}><v>${v}</v></c>`
  if (typeof v === 'boolean') return `<c r="${ref}"${attr} t="b"><v>${v ? 1 : 0}</v></c>`
  return `<c r="${ref}"${attr} t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`
}

function validationXml(v: Validation): string {
  const ref = `${colName(v.col)}${v.fromRow}:${colName(v.col)}${v.toRow}`
  const prompt = v.prompt
    ? ` showInputMessage="1" promptTitle="${esc(v.prompt.slice(0, 32))}" prompt="${esc(v.prompt.slice(0, 255))}"`
    : ''
  // A dropdown refuses other text; a number or date only warns (a pasted ISO date is text).
  const style = v.kind === 'list' ? '' : ' errorStyle="warning"'
  const head = `<dataValidation allowBlank="1" showErrorMessage="1"${style}${prompt} sqref="${ref}"`
  if (v.kind === 'list') {
    const formula = v.listRange
      ? v.listRange
      : `"${(v.list ?? []).map((x) => x.replace(/"/g, '""').replace(/,/g, ';')).join(',')}"`
    return `${head} type="list"><formula1>${esc(formula)}</formula1></dataValidation>`
  }
  if (v.kind === 'date')
    return `${head} type="date" operator="greaterThan"><formula1>1</formula1></dataValidation>`
  if (v.kind === 'whole')
    return `${head} type="whole" operator="between"><formula1>-2147483648</formula1><formula2>2147483647</formula2></dataValidation>`
  return `${head} type="decimal" operator="between"><formula1>-1E+15</formula1><formula2>1E+15</formula2></dataValidation>`
}

function sheetXml(sheet: Sheet, selected: boolean): string {
  const freeze = sheet.freezeRows ?? 0
  const view = freeze
    ? `<sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}><pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
    : `<sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}/>`
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''
  const rows = sheet.rows
    .map((cells, r) => {
      const xml = cells.map((c, i) => cellXml(`${colName(i)}${r + 1}`, c)).join('')
      return xml ? `<row r="${r + 1}">${xml}</row>` : ''
    })
    .join('')
  const vals = sheet.validations?.length
    ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map(validationXml).join('')}</dataValidations>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${vals}</worksheet>`
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF1E293B"/><name val="Calibri"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF334155"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCD34D"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>`

/** The workbook as .xlsx bytes. The first visible sheet opens selected. */
export function buildXlsx(sheets: Sheet[]): Buffer {
  const firstVisible = sheets.findIndex((s) => !s.hidden)
  const files: Array<{ name: string; data: Buffer }> = []
  const add = (name: string, xml: string) => files.push({ name, data: Buffer.from(xml, 'utf8') })
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  add(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join('')}</Types>`
  )
  add(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  )
  add(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView activeTab="${Math.max(0, firstVisible)}"/></bookViews><sheets>${sheets
      .map(
        (s, i) =>
          `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`
      )
      .join('')}</sheets></workbook>`
  )
  add(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      )
      .join(
        ''
      )}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`
  )
  add('xl/styles.xml', STYLES_XML)
  for (const [i, s] of sheets.entries())
    add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, i === firstVisible))
  return buildZip(files)
}
