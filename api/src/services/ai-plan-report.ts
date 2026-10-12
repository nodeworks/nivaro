import * as XLSX from 'xlsx'
import type { User } from '../types.js'
import type { PlanStepDef } from './ai-plan-runner.js'
import { labelsFor, stillVisibleIds } from './ai-plan-steps.js'
import { assertCanReadPlan, loadPlan, type StoredPlanDoc } from './ai-plans.js'
import { readItems } from './items.js'
import { can, getAllowedFields } from './permissions.js'

/**
 * A plan's CHANGE REPORT (#2002): every field change it would make — or,
 * for steps that ran, did make — per record, old value → new value.
 *
 * Built for the person LOOKING at it, every time: a record they cannot read
 * shows as `#id` with no values, a field they cannot read shows as hidden.
 * Steps not yet run read the current values through readItems as the viewer
 * (RLS + User Scopes apply); steps that ran use what the step captured
 * (ai-plan-made.ts), filtered the same way.
 */

export const HIDDEN = '(hidden)'
export const NO_ACCESS = '(no access)'
const MAX_ROWS = 5000

export interface PlanChangeRow {
  step: number
  step_title: string
  collection: string
  /** null = a record the step creates. */
  id: string | null
  label: string
  field: string
  from: unknown
  to: unknown
  /** planned = not run yet; made = written; undone = written then reverted. */
  status: 'planned' | 'made' | 'undone'
}

export interface PlanChangeReport {
  plan_id: string
  title: string
  rows: PlanChangeRow[]
  truncated: boolean
}

interface Access {
  fields: (collection: string) => Promise<(f: string) => boolean>
  visible: (collection: string, ids: string[]) => Promise<Set<string>>
}

/** The viewer's field + record access, cached per collection for one report. */
function accessFor(viewer: User): Access {
  const fieldCache = new Map<string, (f: string) => boolean>()
  return {
    async fields(collection) {
      const hit = fieldCache.get(collection)
      if (hit) return hit
      let test: (f: string) => boolean = () => false
      if (await can(viewer, 'read', collection)) {
        const allowed = await getAllowedFields(viewer, 'read', collection)
        test =
          allowed == null || allowed.includes('*') ? () => true : (f: string) => allowed.includes(f)
      }
      fieldCache.set(collection, test)
      return test
    },
    async visible(collection, ids) {
      return new Set(await stillVisibleIds(viewer, collection, ids))
    }
  }
}

async function plannedRows(
  viewer: User,
  step: PlanStepDef,
  access: Access
): Promise<PlanChangeRow[]> {
  const base = { step: step.n, step_title: step.title, status: 'planned' as const }
  const payload = step.payload ?? {}
  const collection = String(payload.collection ?? step.targets?.collection ?? '')
  if (step.kind === 'bulk_update') {
    const ids = ((payload.ids as string[]) ?? []).map(String)
    const changes = (payload.changes as Record<string, unknown>) ?? {}
    const readable = await access.fields(collection)
    const fields = Object.keys(changes)
    let current = new Map<string, Record<string, unknown>>()
    if (ids.length > 0 && (await can(viewer, 'read', collection))) {
      const res = (await readItems(viewer, collection, {
        filter: { id: { _in: ids } },
        fields: ['id', ...fields.filter(readable)],
        limit: ids.length + 1
      })) as { data?: Array<Record<string, unknown>> }
      current = new Map((res.data ?? []).map((r) => [String(r.id), r]))
    }
    const labels = await labelsFor(collection, [...current.keys()])
    const rows: PlanChangeRow[] = []
    for (const id of ids) {
      const row = current.get(id)
      for (const f of fields) {
        rows.push({
          ...base,
          collection,
          id,
          label: row ? (labels[id] ?? `#${id}`) : `#${id}`,
          field: f,
          from: !row ? NO_ACCESS : readable(f) ? (row[f] ?? null) : HIDDEN,
          to: !row ? NO_ACCESS : readable(f) ? changes[f] : HIDDEN
        })
      }
    }
    return rows
  }
  if (step.kind === 'create_record') {
    const readable = await access.fields(collection)
    const data = (payload.data as Record<string, unknown>) ?? {}
    return Object.entries(data).map(([f, v]) => ({
      ...base,
      collection,
      id: null,
      label: 'New record',
      field: f,
      from: null,
      to: readable(f) ? v : HIDDEN
    }))
  }
  if (step.kind === 'integrity_fix') {
    // Record-by-record preview the fix engine built (an administrator's step).
    const previews = (step.preview?.rows as Array<Record<string, unknown>>) ?? []
    const out: PlanChangeRow[] = []
    const byCollection = new Map<string, string[]>()
    for (const r of previews) {
      const c = String(r.collection ?? collection)
      byCollection.set(c, [...(byCollection.get(c) ?? []), String(r.item_id ?? '')])
    }
    const seen = new Map<string, Set<string>>()
    for (const [c, ids] of byCollection) seen.set(c, await access.visible(c, ids))
    for (const r of previews) {
      const c = String(r.collection ?? collection)
      const id = String(r.item_id ?? '')
      const ok = seen.get(c)?.has(id) ?? false
      const readable = await access.fields(c)
      const f = String(r.field ?? '')
      out.push({
        ...base,
        collection: c,
        id,
        label: ok ? String(r.label ?? `#${id}`) : `#${id}`,
        field: f,
        from: !ok ? NO_ACCESS : readable(f) ? (r.from ?? null) : HIDDEN,
        to: !ok ? NO_ACCESS : readable(f) ? (r.to ?? null) : HIDDEN
      })
    }
    return out
  }
  return []
}

async function madeRows(
  step: PlanStepDef,
  doc: StoredPlanDoc,
  access: Access
): Promise<PlanChangeRow[]> {
  const made = doc.made?.[step.id]
  if (!made) return []
  const byCollection = new Map<string, string[]>()
  for (const r of made.records) {
    const c = r.collection ?? made.collection
    byCollection.set(c, [...(byCollection.get(c) ?? []), r.id])
  }
  const seen = new Map<string, Set<string>>()
  const labels = new Map<string, Record<string, string>>()
  for (const [c, ids] of byCollection) {
    const visible = await access.visible(c, ids)
    seen.set(c, visible)
    labels.set(c, await labelsFor(c, [...visible]))
  }
  const rows: PlanChangeRow[] = []
  for (const r of made.records) {
    const c = r.collection ?? made.collection
    const ok = seen.get(c)?.has(r.id) ?? false
    const readable = await access.fields(c)
    const fields = [...new Set([...Object.keys(r.before), ...Object.keys(r.after)])]
    for (const f of fields) {
      rows.push({
        step: step.n,
        step_title: step.title,
        status: r.undone ? 'undone' : 'made',
        collection: c,
        id: r.id,
        label: ok ? (labels.get(c)?.[r.id] ?? `#${r.id}`) : `#${r.id}`,
        field: f,
        from: !ok ? NO_ACCESS : readable(f) ? (r.created ? null : (r.before[f] ?? null)) : HIDDEN,
        to: !ok ? NO_ACCESS : readable(f) ? (r.after[f] ?? null) : HIDDEN
      })
    }
  }
  return rows
}

export async function planChangeReport(viewer: User, id: string): Promise<PlanChangeReport> {
  const { row, doc } = await loadPlan(id)
  await assertCanReadPlan(viewer, row)
  const access = accessFor(viewer)
  const rows: PlanChangeRow[] = []
  for (const step of [...doc.steps].sort((a, b) => a.n - b.n)) {
    const state = doc.state.find((x) => x.id === step.id)?.status
    if (doc.made?.[step.id]) rows.push(...(await madeRows(step, doc, access)))
    else if (state === 'pending' || state === 'running' || state === 'failed')
      rows.push(...(await plannedRows(viewer, step, access)))
    if (rows.length > MAX_ROWS) break
  }
  return {
    plan_id: String(row.id),
    title: doc.title,
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS
  }
}

function cell(v: unknown): string | number | boolean {
  if (v == null) return ''
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return v.toISOString()
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** The report as an .xlsx workbook — the same rows, one sheet. */
export function changeReportXlsx(report: PlanChangeReport): Buffer {
  const header = [
    'Step',
    'Step title',
    'Collection',
    'Record',
    'Record id',
    'Field',
    'Old value',
    'New value',
    'Status'
  ]
  const body = report.rows.map((r) => [
    r.step,
    r.step_title,
    r.collection,
    r.label,
    r.id ?? '(new)',
    r.field,
    cell(r.from),
    cell(r.to),
    r.status
  ])
  const ws = XLSX.utils.aoa_to_sheet([header, ...body])
  ws['!cols'] = header.map((h, ci) => ({
    wch: Math.min(
      60,
      Math.max(h.length, ...body.slice(0, 200).map((r) => String(r[ci] ?? '').length)) + 2
    )
  }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Changes')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
