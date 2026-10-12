import { extname } from 'node:path'
import { type ExtractedDocument, extractDocumentText } from './document-extract.js'

/**
 * The document extractor, bounded for Ask AI (#1842 #1993): anyone can drop a
 * file on the panel, so a zip bomb dressed as .xlsx/.docx is refused from its
 * central directory before anything inflates, spreadsheets are read at most
 * SHEET_ROWS rows per sheet, and the whole extraction runs under a timeout.
 */

export const ZIP_MAX_UNCOMPRESSED = 100 * 1024 * 1024
export const ZIP_MAX_ENTRIES = 5000
export const SHEET_ROWS = 2000
export const EXTRACT_TIMEOUT_MS = 30_000

export class AskExtractError extends Error {
  constructor(
    message: string,
    public statusCode = 422
  ) {
    super(message)
  }
}

const ZIP_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.docx'])

/**
 * The total uncompressed size and entry count a zip declares, read from its
 * central directory (nothing is inflated). Null when the buffer is not a
 * readable zip, or uses ZIP64 — both are refused by the caller.
 */
export function zipDeclaredSize(buf: Buffer): { total: number; entries: number } | null {
  const EOCD = 0x06054b50
  const CEN = 0x02014b50
  const floor = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const entries = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null
  if (cdOffset + cdSize > buf.length) return null
  let total = 0
  let p = cdOffset
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) return null
    const size = buf.readUInt32LE(p + 24)
    if (size === 0xffffffff) return null
    total += size
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return { total, entries }
}

export async function extractForAsk(
  buffer: Buffer,
  filename: string,
  mimeType?: string | null,
  timeoutMs = EXTRACT_TIMEOUT_MS
): Promise<ExtractedDocument> {
  if (ZIP_EXTENSIONS.has(extname(filename || '').toLowerCase())) {
    const declared = zipDeclaredSize(buffer)
    if (!declared) throw new AskExtractError('This file could not be read')
    if (declared.total > ZIP_MAX_UNCOMPRESSED || declared.entries > ZIP_MAX_ENTRIES)
      throw new AskExtractError('This file expands too large to read', 413)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      extractDocumentText(buffer, filename, mimeType, { sheetRows: SHEET_ROWS }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AskExtractError('Reading this file took too long')),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
