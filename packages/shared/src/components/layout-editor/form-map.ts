import {
  type GroupRow,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import { asObject } from './inspector/model'
import type { ChoiceLabels, DescribeField } from './overview/describe-conditions'
import { describeShowWhen, orList, safeParse } from './show-when'
import { slotName } from './slot-names'

/**
 * #2617 — a printable map of a form: its steps or tabs, their sections and
 * fields in order, with each field's width, required / read-only marks and
 * the rules that hide or lock things, in plain words. Pure: the editor passes
 * the draft layout, the collection's fields and the role names; the result
 * renders as a standalone light page (formMapHtml) for printing or saving as
 * PDF — training material and business sign-off.
 */

export interface MapField {
  field: string
  label: string
  /** "Full", "Half", "Third", "Quarter". */
  width: string
  required: boolean
  readOnly: boolean
  /** Plain-word rules on this field ("Hidden on this form", "Locked for Finance"). */
  rules: string[]
}

export interface MapGroup {
  key: string
  label: string
  /** "Step", "Tab", "Section", "Text block", "Record info", "Steps", "Tabs". */
  kind: string
  rules: string[]
  fields: MapField[]
  children: MapGroup[]
}

export interface FormMap {
  layoutName: string
  collectionLabel: string
  header: MapField[]
  groups: MapGroup[]
  counts: { groups: number; fields: number; required: number }
}

export interface FormMapInput {
  bundle: LayoutBundle
  collectionLabel: string
  fields: Array<DescribeField & { required?: boolean | null; readonly?: boolean | null }>
  roles: Array<{ id: string; name: string }>
  choiceLabels?: ChoiceLabels
}

const WIDTHS: Record<number, string> = { 3: 'Quarter', 4: 'Third', 6: 'Half', 12: 'Full' }

function list(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string' || !raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

const andList = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

function groupKind(g: GroupRow, parent: GroupRow | null): string {
  if (g.type === 'tab') return parent?.tab_mode === 'steps' ? 'Step' : 'Tab'
  if (g.type === 'container') return g.tab_mode === 'steps' ? 'Steps' : 'Tabs'
  if (g.type === 'content') return 'Text block'
  if (g.type === 'metadata') return 'Record info'
  return 'Section'
}

export function buildFormMap(input: FormMapInput): FormMap {
  const { bundle, fields } = input
  const byField = new Map(fields.map((f) => [f.field, f]))
  const roleName = new Map(input.roles.map((r) => [r.id.toUpperCase(), r.name]))
  const names = (ids: string[]) => ids.map((id) => roleName.get(id.toUpperCase()) ?? id)
  const choices = input.choiceLabels ?? {}
  const counts = { groups: 0, fields: 0, required: 0 }

  const mapField = (p: PlacementRow): MapField => {
    const meta = byField.get(p.field)
    const ov = asObject(p.overrides)
    const opts = asObject(ov.options)
    const slot = p.field.startsWith('__')
    const label =
      (typeof ov.label === 'string' && ov.label) ||
      p.label_override ||
      (slot ? slotName(p.field) : meta?.label || titleCase(p.field.split('.').pop() ?? p.field))
    const span = Number(p.col_span ?? opts.col_span ?? asObject(meta?.options).col_span ?? 12)
    const required = !slot && (ov.required !== undefined ? !!ov.required : !!meta?.required)
    const readOnly = !slot && (ov.readonly !== undefined ? !!ov.readonly : !!meta?.readonly)
    const rules: string[] = []
    if (!p.is_visible || ov.hidden === true) rules.push('Hidden on this form')
    for (const c of asArrayOf(p.lock_conditions)) {
      if (c.type === 'role' && c.role_ids?.length)
        rules.push(`Locked for ${orList(names(c.role_ids))}`)
      if (c.type === 'pipeline_state' && c.state_keys?.length)
        rules.push(`Locked in ${orList(c.state_keys.map((k) => titleCase(k)))}`)
    }
    if (p.field.includes('.') && !slot) rules.push('Shows a value from a linked record')
    counts.fields += slot ? 0 : 1
    if (required) counts.required += 1
    return {
      field: p.field,
      label,
      width: WIDTHS[span] ?? 'Full',
      required,
      readOnly,
      rules
    }
  }

  const placementsIn = (key: string | null) =>
    bundle.placements
      .filter((p) => p.group_key === key)
      .slice()
      .sort((a, b) => a.sort - b.sort)
      .map(mapField)

  const groupRules = (g: GroupRow): string[] => {
    const out: string[] = []
    const show = describeShowWhen(g.visible_when, fields, choices)
    if (show) out.push(`Shows only when ${show}`)
    const hidden = names(list(g.hidden_for_roles))
    if (hidden.length) out.push(`Hidden from ${andList(hidden)}`)
    const locked = names(list(g.locked_for_roles))
    if (locked.length) out.push(`Read-only for ${andList(locked)}`)
    if (g.is_collapsed) out.push('Starts folded')
    return out
  }

  const real = bundle.groups.filter((g) => g.key !== UNGROUPED_KEY && g.key !== HEADER_GROUP_KEY)
  const byKey = new Map(real.map((g) => [g.key, g]))
  const mapGroup = (g: GroupRow): MapGroup => {
    counts.groups += 1
    const parent = g.parent_key ? (byKey.get(g.parent_key) ?? null) : null
    return {
      key: g.key,
      label: g.label || titleCase(g.key),
      kind: groupKind(g, parent),
      rules: groupRules(g),
      fields: placementsIn(g.key),
      children: real
        .filter((c) => c.parent_key === g.key)
        .sort((a, b) => a.sort - b.sort)
        .map(mapGroup)
    }
  }

  // Top level in canvas order, the Ungrouped zone at its stored place.
  const ungroupedSort = bundle.groups.find((g) => g.key === UNGROUPED_KEY)?.sort ?? 0
  const top: Array<{ sort: number; build: () => MapGroup | null }> = real
    .filter((g) => !g.parent_key || !byKey.has(g.parent_key))
    .map((g) => ({ sort: g.sort, build: () => mapGroup(g) }))
  top.push({
    sort: ungroupedSort,
    build: () => {
      const fields = placementsIn(null).filter((f) => f.field !== '__subtitle__')
      return fields.length
        ? {
            key: UNGROUPED_KEY,
            label: 'Not in a section',
            kind: 'Fields',
            rules: [],
            fields,
            children: []
          }
        : null
    }
  })
  const groups = top
    .sort((a, b) => a.sort - b.sort)
    .map((t) => t.build())
    .filter((g): g is MapGroup => g !== null)

  return {
    layoutName: String(bundle.layout.name ?? ''),
    collectionLabel: input.collectionLabel,
    header: placementsIn(HEADER_GROUP_KEY),
    groups,
    counts
  }
}

function asArrayOf(
  raw: unknown
): Array<{ type?: string; role_ids?: string[]; state_keys?: string[] }> {
  const v = typeof raw === 'string' ? safeParse(raw) : raw
  return Array.isArray(v) ? v : []
}

// ── Standalone page ──────────────────────────────────────────────────────────

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 40px; background: #fff; color: #0f172a;
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header { border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 20px; }
h1 { font-size: 22px; margin: 0 0 2px; }
.sub { color: #475569; margin: 0; }
.legend { color: #475569; font-size: 11.5px; margin-top: 8px; }
section.g { border: 1px solid #cbd5e1; border-radius: 6px; margin: 0 0 14px; break-inside: avoid; }
section.g section.g { margin: 10px 12px; }
.gh { display: flex; gap: 8px; align-items: baseline; padding: 8px 12px; background: #f1f5f9;
  border-bottom: 1px solid #cbd5e1; border-radius: 6px 6px 0 0; }
.kind { font-size: 11px; color: #475569; }
.gl { font-weight: 600; font-size: 14px; }
.rules { margin: 6px 12px 0; padding: 0; list-style: none; color: #92400e; font-size: 12px; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 8px; }
th, td { text-align: left; padding: 4px 12px; border-top: 1px solid #e2e8f0; vertical-align: top; }
th { font-size: 11px; font-weight: 600; color: #475569; border-top: 0; }
td.w { width: 70px; color: #475569; }
td.m { width: 90px; }
.req { color: #b91c1c; font-weight: 600; }
.ro { color: #475569; }
.rule { color: #92400e; font-size: 12px; }
.key { color: #94a3b8; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
footer { margin-top: 24px; color: #64748b; font-size: 11px; }
@page { margin: 14mm; }
@media print { body { padding: 0; } }
`

function fieldsTable(fields: MapField[]): string {
  if (!fields.length) return ''
  const rows = fields
    .map((f) => {
      const marks = [
        f.required ? '<span class="req">Required</span>' : '',
        f.readOnly ? '<span class="ro">Read-only</span>' : ''
      ]
        .filter(Boolean)
        .join(' · ')
      const rules = f.rules.map((r) => `<div class="rule">${esc(r)}</div>`).join('')
      return `<tr><td>${esc(f.label)}<div class="key">${esc(f.field)}</div>${rules}</td><td class="w">${esc(f.width)}</td><td class="m">${marks}</td></tr>`
    })
    .join('')
  return `<table><thead><tr><th>Field</th><th>Width</th><th>Marks</th></tr></thead><tbody>${rows}</tbody></table>`
}

function groupHtml(g: MapGroup): string {
  const rules = g.rules.length
    ? `<ul class="rules">${g.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
    : ''
  return `<section class="g"><div class="gh"><span class="kind">${esc(g.kind)}</span><span class="gl">${esc(g.label)}</span></div>${rules}${fieldsTable(g.fields)}${g.children.map(groupHtml).join('')}</section>`
}

/** The map as a complete light HTML page (printed through an iframe). */
export function formMapHtml(map: FormMap, generatedAt: Date = new Date()): string {
  const title = `${map.layoutName} — form map`
  const { groups, fields, required } = map.counts
  const header = map.header.length
    ? groupHtml({
        key: HEADER_GROUP_KEY,
        label: 'Header strip',
        kind: 'Top of the record',
        rules: [],
        fields: map.header,
        children: []
      })
    : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body><header><h1>${esc(map.layoutName)}</h1><p class="sub">${esc(map.collectionLabel)} form · ${groups} ${groups === 1 ? 'part' : 'parts'} · ${fields} ${fields === 1 ? 'field' : 'fields'} · ${required} required</p><p class="legend">Widths are the share of a row a field takes on a wide screen. Rules are shown under the field or section they apply to.</p></header>${header}${map.groups.map(groupHtml).join('')}<footer>Generated ${esc(generatedAt.toLocaleString())}</footer></body></html>`
}
