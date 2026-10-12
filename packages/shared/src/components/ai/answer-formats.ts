import type { AiMarkdownBlock, ChartSpec } from './AiMarkdown'

/**
 * Switch an answer's format (#1885): a table, chart or bullet list in an Ask
 * AI answer shown as one of the others, from the SAME rows the answer
 * carries — no new question, no model call. Pure conversions, so what can be
 * switched is decided here and the renderer only draws it.
 */

export type AnswerFormat = 'table' | 'chart' | 'list'

export interface AnswerRows {
  header: string[]
  rows: string[][]
}

/** Inline markdown → plain text (labels on a chart axis). */
export function plainCell(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()
}

/**
 * A cell as a number, or null: "$1,234.50", "(1,200)", "12%", "**42**",
 * "1.2k". Anything with words in it is not a number.
 */
export function cellNumber(cell: string): number | null {
  let s = plainCell(cell).replace(/[\s,$€£¥]/g, '')
  if (!s) return null
  let sign = 1
  if (/^\(.*\)$/.test(s)) {
    sign = -1
    s = s.slice(1, -1)
  }
  s = s.replace(/%$/, '')
  const m = /^(-?\d+(?:\.\d+)?)([kKmMbB]?)$/.exec(s)
  if (!m) return null
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] ?? 1
  return sign * Number(m[1]) * mult
}

const LIST_ITEM = /^(.+?)\s*(?::|—|–|\s-\s)\s*(.+)$/

/** The rows a block holds, or null when it holds none to switch. */
export function rowsOfBlock(block: AiMarkdownBlock): AnswerRows | null {
  if (block.kind === 'table') {
    return block.rows.length ? { header: block.header, rows: block.rows } : null
  }
  if (block.kind === 'chart') {
    return {
      header: [block.spec.title ? plainCell(block.spec.title) : 'Label', 'Value'],
      rows: block.spec.data.map((d) => [d.label, String(d.value)])
    }
  }
  if (block.kind === 'ul' || block.kind === 'ol') {
    // Only a list of "label: value" lines is data; prose bullets stay prose.
    if (block.items.length < 2) return null
    const rows: string[][] = []
    for (const it of block.items) {
      const m = LIST_ITEM.exec(it.trim())
      if (!m || cellNumber(m[2]) == null) return null
      rows.push([m[1].trim(), m[2].trim()])
    }
    return { header: ['Item', 'Value'], rows }
  }
  return null
}

/** Which column labels the rows and which holds the numbers to chart. */
export function chartColumns(r: AnswerRows): { label: number; value: number } | null {
  const width = r.header.length
  if (width < 2 || r.rows.length < 2) return null
  const numeric = (c: number) => r.rows.every((row) => cellNumber(row[c] ?? '') != null)
  let value = -1
  for (let c = 1; c < width; c++) {
    if (numeric(c)) {
      value = c
      break
    }
  }
  if (value < 0) return null
  let label = 0
  for (let c = 0; c < width; c++) {
    if (c !== value && !numeric(c)) {
      label = c
      break
    }
  }
  return { label, value }
}

export function chartOf(r: AnswerRows, type: ChartSpec['type'] = 'bar'): ChartSpec | null {
  const cols = chartColumns(r)
  if (!cols) return null
  const data = r.rows
    .map((row) => ({
      label: plainCell(row[cols.label] ?? ''),
      value: cellNumber(row[cols.value] ?? '') as number
    }))
    .filter((d) => d.label)
    .slice(0, 40)
  if (data.length < 2) return null
  return { type, title: plainCell(r.header[cols.value] ?? ''), data }
}

/** One bullet per row: "**first** — col: value; col: value". */
export function listOf(r: AnswerRows): string[] {
  return r.rows.map((row) => {
    const [cell0, ...rest] = row
    // A cell already in bold must not double up the markers.
    const first = (cell0 ?? '').replace(/^\*\*(.*)\*\*$/, '$1')
    if (r.header.length === 2) return `**${first}** — ${rest[0] ?? ''}`
    const parts = rest
      .map((cell, i) => (cell ? `${r.header[i + 1] ?? ''}: ${cell}` : ''))
      .filter(Boolean)
    return `**${first}**${parts.length ? ` — ${parts.join('; ')}` : ''}`
  })
}

/** The formats this block can be shown in (its own first); one = nothing to switch. */
export function formatsFor(block: AiMarkdownBlock): AnswerFormat[] {
  const own: AnswerFormat | null =
    block.kind === 'table'
      ? 'table'
      : block.kind === 'chart'
        ? 'chart'
        : block.kind === 'ul' || block.kind === 'ol'
          ? 'list'
          : null
  if (!own) return []
  const r = rowsOfBlock(block)
  if (!r) return [own]
  const out: AnswerFormat[] = [own]
  if (own !== 'table') out.push('table')
  if (own !== 'chart' && chartOf(r)) out.push('chart')
  if (own !== 'list') out.push('list')
  return out
}
