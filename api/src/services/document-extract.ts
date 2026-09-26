import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import * as XLSX from 'xlsx'

/**
 * Turn an uploaded document into plain text the model can read. One entry
 * point, one contract: `{ text, method, pages }`. The text is what a person
 * would see, in reading order, capped so a 200-page contract cannot blow the
 * prompt — the model needs the first pages (parties, term, fee table), never
 * the appendices.
 *
 * PDF: `pdftotext -layout` when the binary exists (dev laptops; keeps table
 * columns aligned, which is what makes a fee table legible), else pdfjs in
 * process (the release image carries no poppler). Scanned PDFs have no text
 * layer — they come back empty and the caller says so instead of inventing
 * a proposal from nothing.
 */

export const MAX_TEXT_CHARS = 60_000

export type ExtractedDocument = {
  text: string
  method: 'pdftotext' | 'pdfjs' | 'docx' | 'sheet' | 'text'
  pages: number | null
  truncated: boolean
}

const PDFTOTEXT_CANDIDATES = [
  '/opt/homebrew/bin/pdftotext',
  '/usr/local/bin/pdftotext',
  '/usr/bin/pdftotext'
]
let pdftotextPath: string | null | undefined

function findPdftotext(): string | null {
  if (pdftotextPath !== undefined) return pdftotextPath
  pdftotextPath = PDFTOTEXT_CANDIDATES.find((p) => existsSync(p)) ?? null
  return pdftotextPath
}

function cap(text: string): { text: string; truncated: boolean } {
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
  if (cleaned.length <= MAX_TEXT_CHARS) return { text: cleaned, truncated: false }
  return {
    text: `${cleaned.slice(0, MAX_TEXT_CHARS)}\n\n[… document truncated …]`,
    truncated: true
  }
}

async function pdfViaPoppler(bin: string, buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      ['-layout', '-enc', 'UTF-8', '-', '-'],
      { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
    )
    child.stdin?.end(buffer)
  })
}

async function pdfViaPdfjs(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true
  }).promise
  const out: string[] = []
  const pageCap = Math.min(doc.numPages, 40)
  for (let i = 1; i <= pageCap; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const lines: string[] = []
    let line: string[] = []
    let lastY: number | null = null
    for (const item of content.items) {
      if (!('str' in item)) continue
      const y = Math.round(item.transform[5])
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line.join(' '))
        line = []
      }
      line.push(item.str)
      lastY = y
    }
    lines.push(line.join(' '))
    out.push(`--- page ${i} ---\n${lines.join('\n')}`)
  }
  return { text: out.join('\n\n'), pages: doc.numPages }
}

function countPages(text: string): number | null {
  const ff = text.split('\f').length
  return ff > 1 ? ff : null
}

export async function extractDocumentText(
  buffer: Buffer,
  filename: string,
  mimeType?: string | null
): Promise<ExtractedDocument> {
  const ext = extname(filename || '').toLowerCase()
  const mime = (mimeType ?? '').toLowerCase()

  if (ext === '.pdf' || mime === 'application/pdf') {
    const bin = findPdftotext()
    if (bin) {
      try {
        const raw = await pdfViaPoppler(bin, buffer)
        const pages = countPages(raw)
        const { text, truncated } = cap(raw.replace(/\f/g, '\n\n'))
        if (text.trim().length > 0) return { text, method: 'pdftotext', pages, truncated }
      } catch {
        // fall through to pdfjs
      }
    }
    const { text: raw, pages } = await pdfViaPdfjs(buffer)
    const { text, truncated } = cap(raw)
    return { text, method: 'pdfjs', pages, truncated }
  }

  if (
    ext === '.docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const mammoth = await import('mammoth')
    const res = await mammoth.extractRawText({ buffer })
    const { text, truncated } = cap(res.value)
    return { text, method: 'docx', pages: null, truncated }
  }

  if (['.xlsx', '.xls', '.xlsm', '.csv'].includes(ext) || /spreadsheet|excel|csv/.test(mime)) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const parts: string[] = []
    for (const name of wb.SheetNames.slice(0, 8)) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false })
      parts.push(`--- sheet ${name} ---\n${csv}`)
    }
    const { text, truncated } = cap(parts.join('\n\n'))
    return { text, method: 'sheet', pages: wb.SheetNames.length, truncated }
  }

  // .txt .md .eml .json .html — anything else is read as UTF-8 text. HTML
  // tags are stripped so a saved email body reads as prose.
  let raw = buffer.toString('utf8')
  if (ext === '.html' || ext === '.htm' || /html/.test(mime)) {
    raw = raw
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
  }
  const { text, truncated } = cap(raw)
  return { text, method: 'text', pages: null, truncated }
}

export const ACCEPTED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.xlsx',
  '.xls',
  '.xlsm',
  '.csv',
  '.txt',
  '.md',
  '.eml',
  '.html',
  '.htm'
]
