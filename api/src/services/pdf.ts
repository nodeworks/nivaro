/**
 * PDF document generation.
 *
 * Templates are Liquid (same engine as mail) producing a small HTML-ish
 * markup that is laid out with pdfkit. Supported tags:
 *   <h1> <h2> <h3> <p> <table>/<tr>/<td>(/<th>) <hr> <strong> <br>
 * Unknown tags are stripped and their inner text rendered as plain text.
 * Output gets a title header (first <h1>) and "Page X of Y" footers.
 */
import { Liquid } from 'liquidjs'
import PDFDocument from 'pdfkit'

const engine = new Liquid()

// ─── Markup parsing ──────────────────────────────────────────────────────────

interface Inline {
  text: string
  bold: boolean
}

type Block =
  | { type: 'heading'; level: 1 | 2 | 3; inlines: Inline[] }
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'hr' }
  | { type: 'table'; rows: { header: boolean; cells: Inline[][] }[] }

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const n = Number.parseInt(code.slice(2), 16)
      return Number.isNaN(n) ? full : String.fromCodePoint(n)
    }
    if (code.startsWith('#')) {
      const n = Number.parseInt(code.slice(1), 10)
      return Number.isNaN(n) ? full : String.fromCodePoint(n)
    }
    return ENTITIES[code.toLowerCase()] ?? full
  })
}

/** Strip remaining tags, decode entities, normalize whitespace (keeps \n). */
function cleanText(s: string): string {
  const stripped = decodeEntities(s.replace(/<[^>]*>/g, ''))
  return stripped
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim()
}

function parseInlines(raw: string): Inline[] {
  const withBreaks = raw.replace(/<br\s*\/?>/gi, '\n')
  const inlines: Inline[] = []
  const re = /<strong>([\s\S]*?)<\/strong>/gi
  let last = 0
  let m = re.exec(withBreaks)
  while (m) {
    const before = cleanText(withBreaks.slice(last, m.index))
    if (before) inlines.push({ text: before, bold: false })
    const bold = cleanText(m[1])
    if (bold) inlines.push({ text: bold, bold: true })
    last = m.index + m[0].length
    m = re.exec(withBreaks)
  }
  const tail = cleanText(withBreaks.slice(last))
  if (tail) inlines.push({ text: tail, bold: false })
  return inlines
}

function parseTable(raw: string): Block {
  const rows: { header: boolean; cells: Inline[][] }[] = []
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let tr = trRe.exec(raw)
  while (tr) {
    const cells: Inline[][] = []
    let header = false
    const cellRe = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi
    let cell = cellRe.exec(tr[1])
    while (cell) {
      if (cell[1].toLowerCase() === 'th') header = true
      cells.push(parseInlines(cell[2]))
      cell = cellRe.exec(tr[1])
    }
    if (cells.length > 0) rows.push({ header, cells })
    tr = trRe.exec(raw)
  }
  return { type: 'table', rows }
}

function pushPlainText(blocks: Block[], raw: string): void {
  for (const chunk of raw.split(/\n\s*\n/)) {
    const inlines = parseInlines(chunk)
    if (inlines.length > 0) blocks.push({ type: 'paragraph', inlines })
  }
}

export function parseMarkup(html: string): Block[] {
  const blocks: Block[] = []
  const re = /<(h1|h2|h3|p)[^>]*>([\s\S]*?)<\/\1>|<hr\s*\/?>|<table[^>]*>([\s\S]*?)<\/table>/gi
  let last = 0
  let m = re.exec(html)
  while (m) {
    if (m.index > last) pushPlainText(blocks, html.slice(last, m.index))
    const tag = m[1]?.toLowerCase()
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      blocks.push({
        type: 'heading',
        level: Number(tag[1]) as 1 | 2 | 3,
        inlines: parseInlines(m[2])
      })
    } else if (tag === 'p') {
      const inlines = parseInlines(m[2])
      if (inlines.length > 0) blocks.push({ type: 'paragraph', inlines })
    } else if (m[0].toLowerCase().startsWith('<hr')) {
      blocks.push({ type: 'hr' })
    } else if (m[3] !== undefined) {
      blocks.push(parseTable(m[3]))
    }
    last = m.index + m[0].length
    m = re.exec(html)
  }
  if (last < html.length) pushPlainText(blocks, html.slice(last))
  return blocks
}

// ─── PDF layout ──────────────────────────────────────────────────────────────

const MARGIN = 50
const HEADING_SIZES: Record<1 | 2 | 3, number> = { 1: 20, 2: 15, 3: 12.5 }
const BODY_SIZE = 10
const FONT = 'Helvetica'
const FONT_BOLD = 'Helvetica-Bold'

function inlineText(inlines: Inline[]): string {
  return inlines.map((i) => i.text).join('')
}

function renderInlines(doc: PDFKit.PDFDocument, inlines: Inline[], size: number, allBold = false) {
  doc.fontSize(size)
  inlines.forEach((seg, idx) => {
    doc.font(seg.bold || allBold ? FONT_BOLD : FONT)
    doc.text(seg.text, { continued: idx < inlines.length - 1 })
  })
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  const bottom = doc.page.height - doc.page.margins.bottom
  if (doc.y + needed > bottom) doc.addPage()
}

function renderTable(doc: PDFKit.PDFDocument, rows: { header: boolean; cells: Inline[][] }[]) {
  if (rows.length === 0) return
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const cols = Math.max(...rows.map((r) => r.cells.length))
  const colWidth = contentWidth / cols
  const padding = 5

  for (const row of rows) {
    doc.font(row.header ? FONT_BOLD : FONT).fontSize(BODY_SIZE - 0.5)
    const texts = Array.from({ length: cols }, (_, i) =>
      row.cells[i] ? inlineText(row.cells[i]) : ''
    )
    const rowHeight =
      Math.max(
        BODY_SIZE,
        ...texts.map((t) => doc.heightOfString(t, { width: colWidth - padding * 2 }))
      ) +
      padding * 2

    ensureSpace(doc, rowHeight + 2)
    const y = doc.y
    const xStart = doc.page.margins.left

    texts.forEach((text, i) => {
      const x = xStart + i * colWidth
      doc.rect(x, y, colWidth, rowHeight).strokeColor('#cbd5e1').lineWidth(0.5).stroke()
      doc
        .fillColor('#0f172a')
        .text(text, x + padding, y + padding, { width: colWidth - padding * 2 })
    })

    doc.x = xStart
    doc.y = y + rowHeight
  }
  doc.moveDown(0.75)
}

/** Render a Liquid template with the given data and lay it out as a PDF. */
export async function generatePdf(
  template: string,
  data: Record<string, unknown>
): Promise<Buffer> {
  const html = await engine.parseAndRender(template, data)
  const blocks = parseMarkup(html)

  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true })
  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  doc.fillColor('#0f172a')

  // Title header — first h1 becomes the document title with a rule under it.
  let startIndex = 0
  const first = blocks[0]
  if (first && first.type === 'heading' && first.level === 1) {
    doc.font(FONT_BOLD).fontSize(HEADING_SIZES[1]).text(inlineText(first.inlines))
    const y = doc.y + 4
    doc
      .moveTo(doc.page.margins.left, y)
      .lineTo(doc.page.width - doc.page.margins.right, y)
      .strokeColor('#0f172a')
      .lineWidth(1)
      .stroke()
    doc.y = y + 14
    startIndex = 1
  }

  for (const block of blocks.slice(startIndex)) {
    switch (block.type) {
      case 'heading': {
        const size = HEADING_SIZES[block.level]
        ensureSpace(doc, size * 2)
        doc.moveDown(0.4)
        renderInlines(doc, block.inlines, size, true)
        doc.moveDown(0.35)
        break
      }
      case 'paragraph':
        ensureSpace(doc, BODY_SIZE * 2)
        renderInlines(doc, block.inlines, BODY_SIZE)
        doc.moveDown(0.6)
        break
      case 'hr': {
        ensureSpace(doc, 12)
        const y = doc.y + 2
        doc
          .moveTo(doc.page.margins.left, y)
          .lineTo(doc.page.width - doc.page.margins.right, y)
          .strokeColor('#cbd5e1')
          .lineWidth(0.5)
          .stroke()
        doc.y = y + 10
        break
      }
      case 'table':
        renderTable(doc, block.rows)
        break
    }
  }

  // Page number footers
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const savedBottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0 // allow writing in the footer area without auto-paging
    doc
      .font(FONT)
      .fontSize(8)
      .fillColor('#64748b')
      .text(
        `Page ${i + 1} of ${range.count}`,
        doc.page.margins.left,
        doc.page.height - savedBottom + 14,
        {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          align: 'center',
          lineBreak: false
        }
      )
    doc.page.margins.bottom = savedBottom
  }

  doc.end()
  return done
}
