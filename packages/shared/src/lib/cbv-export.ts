/**
 * The collection list's "CSV — visible columns" (army 11 N8): the file holds
 * what the person sees — the State, Last State Change, Aging, Owners,
 * Addendums, Shipped, Integrations and Tasks columns too — with no internal
 * row id, numbers as numbers and dates a spreadsheet can sort.
 *
 * Pure helpers plus one chunked reader of the per-record extras (the same
 * endpoints the table reads per page).
 */
import { dotsForRecord } from './integration-dots'

export type CbvVirtualKind =
  | 'state'
  | 'entered'
  | 'aging'
  | 'owners'
  | 'addendums'
  | 'fulfilment'
  | 'integrations'
  | 'tasks'

export interface ExportInstance {
  state_key?: string
  state_label?: string
  entered_at?: string | null
  completed_at?: string | null
}

export interface ExportExtras {
  instances: Record<string, ExportInstance>
  owners: Record<string, Array<{ name: string }>>
  addendums: Record<
    string,
    {
      active: number
      total: number
      latest: { title: string | null; status: string; cost_impact: number | null } | null
    }
  >
  integrations: Record<string, Array<{ api: string; outcome: string }>>
  tasks: Record<string, { open: number; overdue: number }>
}

export const VIRTUAL_HEADERS: Record<CbvVirtualKind, string> = {
  state: 'State',
  entered: 'Last State Change',
  aging: 'Aging (days)',
  owners: 'Owners',
  addendums: 'Addendums',
  fulfilment: 'Shipped',
  integrations: 'Integrations',
  tasks: 'Open tasks'
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A date a spreadsheet sorts: "2026-11-08 15:13" (local time) for a moment,
 * the stored "2026-11-08" for a date-only value (never shifted a day).
 */
export function csvDateTime(raw: unknown): string {
  if (raw == null || raw === '') return ''
  const s = String(raw).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A number as a number ("3703.68"), never "$3,703.68"; '' when not a number. */
export function csvNumber(raw: unknown): number | string {
  if (raw == null || raw === '') return ''
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : ''
  const s = String(raw).replace(/[$,\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(s)) return String(raw)
  return Number(s)
}

const TONE_WORD = {
  danger: 'behind',
  warning: 'in progress',
  positive: 'sent',
  neutral: 'unknown'
} as const

const ADDENDUM_STATUS: Record<string, string> = {
  draft: 'draft',
  submitted: 'submitted',
  review: 'in review',
  approved: 'approved',
  rejected: 'rejected'
}

/** One extra column's cell, as the table shows it (in words a file can hold). */
export function virtualExportCell(
  kind: CbvVirtualKind,
  id: string,
  extras: ExportExtras,
  row: Record<string, unknown>,
  opts: {
    now?: number
    fulfilment?: { shipped_field: string; requested_field: string } | null
  } = {}
): string | number {
  const inst = extras.instances[id]
  switch (kind) {
    case 'state':
      return inst?.state_label ?? inst?.state_key ?? ''
    case 'entered':
      return csvDateTime(inst?.entered_at ?? '')
    case 'aging': {
      const at = inst?.entered_at ? new Date(inst.entered_at).getTime() : Number.NaN
      if (inst?.completed_at || !Number.isFinite(at)) return ''
      const days = ((opts.now ?? Date.now()) - at) / 86_400_000
      return Math.max(0, Math.round(days * 10) / 10)
    }
    case 'owners':
      return (extras.owners[id] ?? []).map((o) => o.name).join('; ')
    case 'addendums': {
      const a = extras.addendums[id]
      if (!a || a.total === 0) return ''
      const status = a.latest ? (ADDENDUM_STATUS[a.latest.status] ?? a.latest.status) : ''
      return a.active > 0
        ? `${a.active} ${a.active === 1 ? 'addendum' : 'addendums'} ${status || 'active'}`
        : `${a.total} ${status}`.trim()
    }
    case 'fulfilment': {
      const f = opts.fulfilment
      if (!f) return ''
      const s = Number(row[f.shipped_field] ?? 0) || 0
      const r = Number(row[f.requested_field] ?? 0) || 0
      return r > 0 || s > 0 ? `${s} of ${r}` : ''
    }
    case 'integrations':
      return dotsForRecord(extras.integrations[id] ?? [])
        .map((d) => `${d.api}: ${TONE_WORD[d.tone]}`)
        .join('; ')
    case 'tasks':
      return extras.tasks[id]?.open ?? 0
  }
}

const CHUNK = 200

/**
 * The extras the visible virtual columns need, for every exported id, in
 * chunks (the batch routes cap at 500 ids). A part that fails leaves its
 * column blank rather than failing the file.
 */
export async function readExportExtras(
  ids: string[],
  kinds: Set<CbvVirtualKind>,
  call: {
    instances: (ids: string[]) => Promise<Record<string, ExportInstance>>
    owners: (ids: string[]) => Promise<Record<string, Array<{ name: string }>>>
    addendums: (ids: string[]) => Promise<ExportExtras['addendums']>
    integrations: (ids: string[]) => Promise<ExportExtras['integrations']>
    tasks: (ids: string[]) => Promise<ExportExtras['tasks']>
  }
): Promise<ExportExtras> {
  const out: ExportExtras = {
    instances: {},
    owners: {},
    addendums: {},
    integrations: {},
    tasks: {}
  }
  const needInstances = kinds.has('state') || kinds.has('entered') || kinds.has('aging')
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const parts: Array<Promise<void>> = []
    if (needInstances)
      parts.push(
        call.instances(chunk).then(
          (m) => void Object.assign(out.instances, m),
          () => undefined
        )
      )
    if (kinds.has('owners'))
      parts.push(
        call.owners(chunk).then(
          (m) => void Object.assign(out.owners, m),
          () => undefined
        )
      )
    if (kinds.has('addendums'))
      parts.push(
        call.addendums(chunk).then(
          (m) => void Object.assign(out.addendums, m),
          () => undefined
        )
      )
    if (kinds.has('integrations'))
      parts.push(
        call.integrations(chunk).then(
          (m) => void Object.assign(out.integrations, m),
          () => undefined
        )
      )
    if (kinds.has('tasks'))
      parts.push(
        call.tasks(chunk).then(
          (m) => void Object.assign(out.tasks, m),
          () => undefined
        )
      )
    await Promise.all(parts)
  }
  return out
}
