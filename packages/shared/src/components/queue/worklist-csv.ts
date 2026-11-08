// Worklist CSV (army 11 N9): the rows of the current tab + filters + sort, with the
// columns on screen, in the words on screen — state labels, owner names, choice
// labels — never internal ids, and numbers as numbers so a spreadsheet can add them.
// Pure: QueueWorklist fetches the rows and downloads the text.

export interface CsvRow {
  collection: string
  item_id: string
  label: string
  state: string | null
  owners: Array<{ id: string; name: string; inactive?: string }>
  claimed_by?: { id: string; name: string } | null
  sla_status?: 'ok' | 'warning' | 'breached' | null
  at_risk?: boolean
  at_risk_rule?: { name: string } | null
  aging_hours: number | null
  state_entered_at?: string | null
  extra?: Record<string, unknown>
}

export interface CsvColumn {
  key: string
  header: string
}

export interface CsvContext {
  stateLabel: (key: string) => string
  collectionLabel: (name: string) => string
  /** Display text of an extra value (choice labels, date formats). */
  extraText: (path: string, value: string) => string
  /** True when the extra column holds numbers (its display format is a number). */
  extraIsNumber: (path: string) => boolean
}

/** Columns a CSV can carry: the on-screen ones minus pure controls (claim, actions). */
const SKIP = new Set(['claim', 'actions', '__actions', 'select'])

export function csvColumns(columns: CsvColumn[]): CsvColumn[] {
  return columns.filter((c) => !SKIP.has(c.key) && c.header.trim() !== '')
}

const SLA_WORDS: Record<string, string> = {
  ok: 'On time',
  warning: 'Warning',
  breached: 'Breached'
}

function ownerText(o: { name: string; inactive?: string }): string {
  if (o.inactive === 'former') return `${o.name} (former user)`
  if (o.inactive) return `${o.name} (${o.inactive})`
  return o.name
}

/** Local "YYYY-MM-DD HH:mm" — a spreadsheet reads it as a date-time. */
function localStamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function csvValue(row: CsvRow, key: string, ctx: CsvContext): string | number {
  switch (key) {
    case 'label':
      return row.label ?? ''
    case 'collection':
      return ctx.collectionLabel(row.collection)
    case 'state':
      return row.state ? ctx.stateLabel(row.state) : ''
    case 'owners':
      return row.owners.map(ownerText).join('; ')
    case 'claimed_by':
      return row.claimed_by?.name ?? ''
    case 'aging_hours':
      // Days in the current step, one decimal — the same clock as the Aging column.
      return row.aging_hours == null ? '' : Math.round((row.aging_hours / 24) * 10) / 10
    case 'state_entered':
      return localStamp(row.state_entered_at)
    case 'sla_status':
      return row.sla_status ? (SLA_WORDS[row.sla_status] ?? row.sla_status) : ''
    case 'at_risk':
      return row.at_risk ? row.at_risk_rule?.name || 'Yes' : ''
  }
  if (key.startsWith('extra.')) {
    const path = key.slice('extra.'.length)
    const raw = row.extra?.[path]
    if (raw == null || raw === '') return ''
    if (ctx.extraIsNumber(path)) {
      const n = Number(String(raw).replace(/[$,\s]/g, ''))
      if (Number.isFinite(n)) return n
    }
    return ctx.extraText(path, String(raw))
  }
  const v = (row as unknown as Record<string, unknown>)[key]
  if (v == null) return ''
  return typeof v === 'number' ? v : typeof v === 'object' ? '' : String(v)
}

function cell(v: string | number): string {
  if (typeof v === 'number') return String(v)
  // Formula injection: a leading = + - @ would run in a spreadsheet.
  const safe = /^[=+\-@]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function worklistCsv(rows: CsvRow[], columns: CsvColumn[], ctx: CsvContext): string {
  const cols = csvColumns(columns)
  const head = cols.map((c) => cell(c.key === 'aging_hours' ? `${c.header} (days)` : c.header))
  const lines = [head.join(',')]
  for (const r of rows) lines.push(cols.map((c) => cell(csvValue(r, c.key, ctx))).join(','))
  // BOM so Excel opens UTF-8 names correctly.
  return `﻿${lines.join('\r\n')}\r\n`
}

/** A file name from the worklist's name and today's date: "Workflows-2026-11-08.csv". */
export function worklistCsvName(name: string, now: Date = new Date()): string {
  const base =
    name
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'worklist'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${base}-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.csv`
}
