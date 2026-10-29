import type { User } from '../types.js'
import {
  type ComputeFormStateOptions,
  computeFormState,
  type FormFieldRow,
  type FormFieldState,
  type FormGroupRow,
  type FormGroupState,
  type FormState,
  publicFormState
} from './form-state.js'
import { HEADER_GROUP_KEY, UNGROUPED_KEY } from './layout-ops-apply.js'

/**
 * Form image (#3216): a PNG of how a record's form looks for the caller (or,
 * administrators only, for a role). The picture is drawn from the form state
 * (services/form-state.ts — the resolver, the field rows /field-config
 * answers, the section and field rules), so it shows exactly the fields that
 * form shows, marks required and locked ones, and holds only values the
 * caller read through readOne AND the judged principal may read. Linked
 * records show their label only when the caller may read that record
 * (ai-link-labels, as the asker). The HTML is self-contained: no script, no
 * external request; Chromium runs through htmlToPng (local, else the render
 * peer — slim parity).
 */

type Obj = Record<string, unknown>

/** `viewport: 'phone'` draws at phone width (and resolves the form's phone version). */
export interface FormImageOptions extends ComputeFormStateOptions {
  theme?: 'light' | 'dark'
  /** Also draw what rules hide (dashed, with the reason; never a value). */
  showHidden?: boolean
}

const MAX_FIELDS = 400

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A date-only value without a time zone shift (never new Date('YYYY-MM-DD')). */
function dateOnly(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.slice(0, 10))
  if (!m) return null
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`
}

function choiceText(options: Obj | null | undefined, value: unknown): string | null {
  const choices = (options?.choices ?? null) as Array<{ text?: unknown; value?: unknown }> | null
  if (!Array.isArray(choices)) return null
  const hit = choices.find((c) => String(c?.value) === String(value))
  if (!hit) return null
  const t = String(hit.text ?? hit.value ?? '')
  return t.startsWith('$t:') ? t.slice(3).replace(/_/g, ' ') : t
}

/** A stored value as one short line of text (escaped by the caller). */
export function displayValue(
  row: Pick<FormFieldRow, 'type' | 'interface' | 'options'>,
  value: unknown,
  linkLabel?: string | null
): { text: string; empty: boolean } {
  if (linkLabel) return { text: linkLabel, empty: false }
  if (value === null || value === undefined || value === '') return { text: '—', empty: true }
  const type = String(row.type ?? '').toLowerCase()
  if (typeof value === 'boolean' || type === 'boolean')
    return { text: value === true || value === 1 || value === '1' ? 'Yes' : 'No', empty: false }
  if (Array.isArray(value)) {
    if (!value.length) return { text: '—', empty: true }
    const parts = value.map((v) =>
      v && typeof v === 'object' ? String((v as Obj).id ?? '…') : String(v)
    )
    const head = parts.slice(0, 6).join(', ')
    return { text: parts.length > 6 ? `${head} +${parts.length - 6}` : head, empty: false }
  }
  if (typeof value === 'object') {
    const o = value as Obj
    if (o.id != null) return { text: `#${String(o.id)}`, empty: false }
    return { text: clip(JSON.stringify(value), 160), empty: false }
  }
  const choice = choiceText(row.options, value)
  if (choice) return { text: choice, empty: false }
  const s = String(value)
  if (type === 'date') return { text: dateOnly(s) ?? s, empty: false }
  if (type === 'datetime' || type === 'timestamp' || type === 'datetime2') {
    const d = dateOnly(s)
    const t = /T(\d{2}):(\d{2})/.exec(s)
    return { text: d ? `${d}${t ? ` ${t[1]}:${t[2]}` : ''}` : s, empty: false }
  }
  if (typeof value === 'number' || /^(integer|bigint|float|decimal|double)$/.test(type)) {
    const n = Number(value)
    if (Number.isFinite(n))
      return { text: n.toLocaleString('en-US', { maximumFractionDigits: 6 }), empty: false }
  }
  // Rich text and HTML: tags out (the output is escaped again on the way in).
  const text = /<[a-z][\s\S]*>/i.test(s) ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ') : s
  return { text: clip(text.trim(), 300), empty: !text.trim() }
}

/** col_span (1–12) from the placement's options; a full row by default. */
function spanOf(row: FormFieldRow | undefined): number {
  const n = Number((row?.options as Obj | null | undefined)?.col_span)
  return Number.isFinite(n) && n >= 1 && n <= 12 ? Math.round(n) : 12
}

const PALETTE = {
  light: {
    bg: '#f8fafc',
    card: '#ffffff',
    border: '#e2e8f0',
    text: '#0f172a',
    muted: '#64748b',
    input: '#ffffff',
    inputBorder: '#cbd5e1',
    locked: '#f1f5f9',
    required: '#e11d48',
    accent: '#0284c7',
    chip: '#e0f2fe',
    chipText: '#075985',
    hidden: '#fef3c7',
    hiddenText: '#92400e'
  },
  dark: {
    bg: '#0b1220',
    card: '#111827',
    border: '#1f2937',
    text: '#e5e7eb',
    muted: '#94a3b8',
    input: '#0f172a',
    inputBorder: '#334155',
    locked: '#1e293b',
    required: '#fb7185',
    accent: '#38bdf8',
    chip: '#0c4a6e',
    chipText: '#bae6fd',
    hidden: '#422006',
    hiddenText: '#fcd34d'
  }
} as const

const LOCK_SVG =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'

export interface FormHtmlInput {
  title: string
  subtitle: string
  state: Pick<FormState, 'layout' | 'as' | 'record' | 'collection' | 'can_update'>
  groups: FormGroupState[]
  groupRows: FormGroupRow[]
  fields: FormFieldState[]
  rows: Map<string, FormFieldRow>
  values: Obj
  /** field → the linked record's label (only for what the caller may read). */
  linkLabels: Map<string, string>
  theme: 'light' | 'dark'
  phone: boolean
  showHidden: boolean
  generatedAt: string
}

/** The form as self-contained HTML (pure; no script, no external resource). */
export function buildFormHtml(input: FormHtmlInput): string {
  const c = PALETTE[input.theme]
  const shown = (f: FormFieldState) => f.visible || input.showHidden
  const fieldHtml = (f: FormFieldState) => {
    const row = input.rows.get(`${f.field}\u0000${f.group_key ?? ''}`) ?? input.rows.get(f.field)
    const span = input.phone ? 12 : spanOf(row)
    const v = f.visible
      ? displayValue(row ?? {}, input.values[f.field], input.linkLabels.get(f.field))
      : { text: '', empty: true }
    const cls = [
      'f',
      f.locked ? 'locked' : '',
      f.visible ? '' : 'hidden',
      f.missing ? 'missing' : ''
    ]
      .filter(Boolean)
      .join(' ')
    const marks = `${f.required ? '<span class="req" title="Required">*</span>' : ''}${
      f.locked ? `<span class="lock" title="${esc(f.why ?? 'Locked')}">${LOCK_SVG}</span>` : ''
    }`
    const body = f.visible
      ? `<div class="v${v.empty ? ' empty' : ''}">${esc(v.text)}</div>`
      : `<div class="v why">${
          f.hidden_by === 'section_role' || f.hidden_by === 'section_rule'
            ? 'Hidden with its section'
            : `Hidden — ${esc(f.why ?? 'by a rule')}`
        }</div>`
    const note =
      f.visible && f.missing
        ? '<div class="note">Required — still empty</div>'
        : f.visible && f.locked && f.why
          ? `<div class="note">${esc(f.why)}</div>`
          : ''
    return `<div class="${cls}" style="grid-column: span ${span}"><div class="l">${esc(
      f.label
    )}${marks}</div>${body}${note}</div>`
  }

  const byGroup = new Map<string, FormFieldState[]>()
  const header: FormFieldState[] = []
  const loose: FormFieldState[] = []
  for (const f of input.fields.slice(0, MAX_FIELDS)) {
    if (!shown(f)) continue
    if (f.group_key === HEADER_GROUP_KEY) header.push(f)
    else if (
      !f.group_key ||
      f.group_key === UNGROUPED_KEY ||
      !input.groups.some((g) => g.key === f.group_key)
    )
      loose.push(f)
    else {
      const list = byGroup.get(f.group_key) ?? []
      list.push(f)
      byGroup.set(f.group_key, list)
    }
  }
  const sortOf = new Map(input.groupRows.map((g) => [g.key, Number(g.sort ?? 0)]))
  const children = (parent: string | null) =>
    input.groups
      .filter((g) => (g.parent_key ?? null) === parent)
      .sort((a, b) => (sortOf.get(a.key) ?? 0) - (sortOf.get(b.key) ?? 0))

  const groupHtml = (g: FormGroupState, depth: number): string => {
    if (!g.visible && !input.showHidden) return ''
    const own = byGroup.get(g.key) ?? []
    const kids = children(g.key)
      .map((k) => groupHtml(k, depth + 1))
      .join('')
    if (!own.length && !kids) return ''
    const tag = g.type === 'tab' ? 'Tab' : g.type === 'step' ? 'Step' : ''
    const flags = [
      tag ? `<span class="kind">${tag}</span>` : '',
      g.locked ? `<span class="kind">${LOCK_SVG} Read-only</span>` : '',
      !g.visible ? `<span class="kind warn">Hidden — ${esc(g.why ?? 'by a rule')}</span>` : ''
    ].join('')
    const grid = own.length ? `<div class="grid">${own.map(fieldHtml).join('')}</div>` : ''
    return `<section class="card d${Math.min(depth, 2)}${g.visible ? '' : ' hidden'}"><h2>${esc(
      g.label
    )}${flags}</h2>${grid}${kids}</section>`
  }

  const headerHtml = header.length
    ? `<div class="strip">${header
        .map((f) => {
          const row = input.rows.get(f.field)
          const v = displayValue(row ?? {}, input.values[f.field], input.linkLabels.get(f.field))
          return `<div class="chipv"><span>${esc(f.label)}</span><b>${esc(v.text)}</b></div>`
        })
        .join('')}</div>`
    : ''
  const looseHtml = loose.length
    ? `<section class="card d0"><div class="grid">${loose.map(fieldHtml).join('')}</div></section>`
    : ''
  const sections = children(null)
    .map((g) => groupHtml(g, 0))
    .join('')
  const empty =
    !headerHtml && !looseHtml && !sections
      ? '<section class="card d0"><p class="muted">This form shows no fields to this person.</p></section>'
      : ''
  const as = input.state.as.role
    ? `As ${input.state.as.role}${input.state.as.preview ? ' (preview)' : ''}`
    : input.state.as.admin
      ? 'As an administrator'
      : 'As you'
  const chips = [
    input.state.layout ? `Form: ${input.state.layout.name}` : 'No form — plain field list',
    as,
    input.state.can_update ? '' : 'Read-only record'
  ]
    .filter(Boolean)
    .map((t) => `<span class="chip">${esc(t)}</span>`)
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}html,body{margin:0;background:${c.bg};color:${c.text}}
body{font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;padding:${input.phone ? 12 : 20}px}
.top{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px;margin:0 0 12px}
.top h1{font-size:${input.phone ? 16 : 18}px;font-weight:600;margin:0;letter-spacing:-.01em}
.sub{color:${c.muted};font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.chip{background:${c.chip};color:${c.chipText};border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:500}
.strip{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
.chipv{background:${c.card};border:1px solid ${c.border};border-radius:8px;padding:6px 10px;display:flex;flex-direction:column;min-width:120px}
.chipv span{font-size:11px;color:${c.muted}}.chipv b{font-weight:600}
.card{background:${c.card};border:1px solid ${c.border};border-radius:10px;padding:14px 16px;margin:0 0 12px}
.card .card{margin:12px 0 0;padding:12px 14px}
.card.d1{background:transparent}.card.hidden{border-style:dashed;opacity:.75}
h2{font-size:13px;font-weight:600;margin:0 0 10px;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.kind{font-size:10.5px;font-weight:500;color:${c.muted};border:1px solid ${c.border};border-radius:999px;padding:1px 7px;display:inline-flex;align-items:center;gap:4px}
.kind.warn{background:${c.hidden};color:${c.hiddenText};border-color:transparent}
.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:10px 12px}
.f{min-width:0}.l{font-size:11.5px;font-weight:500;color:${c.muted};margin:0 0 4px;display:flex;align-items:center;gap:4px}
.req{color:${c.required};font-weight:700}.lock{color:${c.muted};display:inline-flex}
.v{background:${c.input};border:1px solid ${c.inputBorder};border-radius:6px;padding:6px 9px;min-height:31px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v.empty{color:${c.muted}}
.locked .v{background:${c.locked};border-color:${c.border}}
.missing .v{border-color:${c.required}}
.hidden .v{border-style:dashed;background:transparent}
.v.why{white-space:normal;color:${c.hiddenText};background:${c.hidden};border-color:transparent;font-size:12px}
.note{font-size:11px;color:${c.muted};margin-top:3px}.missing .note{color:${c.required}}
.muted{color:${c.muted};margin:0}
.foot{color:${c.muted};font-size:11px;margin-top:6px}
</style></head><body>
<div class="top"><h1>${esc(input.title)}</h1><span class="sub">${esc(input.subtitle)}</span></div>
<div class="chips">${chips}</div>
${headerHtml}${looseHtml}${sections}${empty}
<div class="foot">Drawn by Nivaro ${esc(input.generatedAt)} · values shown only where this person may read them</div>
</body></html>`
}

export interface FormImage {
  png: Buffer
  width: number
  state: FormState
}

/** Load the form state, the readable values and labels, draw and render. */
export async function renderFormImage(
  caller: User,
  callerIsAdmin: boolean,
  opts: FormImageOptions
): Promise<FormImage> {
  const state = await computeFormState(caller, callerIsAdmin, opts)
  const theme = opts.theme === 'dark' ? 'dark' : 'light'
  const phone = opts.viewport === 'phone'

  // Rows by (field, section) and by field, for widths and types.
  const rows = new Map<string, FormFieldRow>()
  for (const r of state._rows) {
    rows.set(`${r.field}\u0000${r.group_key ?? ''}`, r)
    if (!rows.has(r.field)) rows.set(r.field, r)
  }

  // Only values of fields the form SHOWS (judged for the principal) leave here.
  const visible = new Set(state.fields.filter((f) => f.visible).map((f) => f.field))
  const values: Obj = {}
  for (const f of visible) if (f in state._values) values[f] = state._values[f]

  // Linked-record labels, read as the caller (a target they cannot read keeps its id).
  const linkLabels = new Map<string, string>()
  try {
    const { getRelations } = await import('./collections.js')
    const { linkLabelKey, linkLabelsAsUser } = await import('./ai-link-labels.js')
    const rels = (await getRelations(state.collection)) as unknown as Array<Obj>
    const m2o = new Map<string, string>()
    for (const r of rels) {
      if (
        r.many_collection === state.collection &&
        typeof r.many_field === 'string' &&
        r.one_collection
      )
        m2o.set(String(r.many_field), String(r.one_collection))
    }
    const byTarget = new Map<string, Set<string>>()
    for (const [field, target] of m2o) {
      const v = values[field]
      if (v == null || v === '' || typeof v === 'object') continue
      const set = byTarget.get(target) ?? new Set<string>()
      set.add(String(v))
      byTarget.set(target, set)
    }
    if (byTarget.size) {
      const labels = await linkLabelsAsUser(caller, byTarget)
      for (const [field, target] of m2o) {
        const v = values[field]
        if (v == null || typeof v === 'object') continue
        const label = labels[linkLabelKey(target, v)]
        if (label) linkLabels.set(field, label)
      }
    }
  } catch {
    /* no labels: ids show */
  }

  let collectionLabel = state.collection.replace(/_/g, ' ')
  try {
    const { getCollection } = await import('./collections.js')
    const col = (await getCollection(state.collection).catch(() => null)) as Obj | null
    const t = (col?.label ?? col?.name ?? col?.singular) as string | undefined
    if (t && typeof t === 'string') collectionLabel = t
  } catch {
    /* plain name */
  }
  collectionLabel = collectionLabel.replace(/\b\w/g, (ch) => ch.toUpperCase())

  const html = buildFormHtml({
    title: state.record ? `${collectionLabel} #${state.record}` : `New ${collectionLabel}`,
    subtitle: state.layout?.why ? `Why this form: ${state.layout.why}` : '',
    state,
    groups: state.groups,
    groupRows: state._groups,
    fields: state.fields,
    rows,
    values,
    linkLabels,
    theme,
    phone,
    showHidden: !!opts.showHidden,
    generatedAt: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`
  })
  const { htmlToPng } = await import('./pdf-layout.js')
  const width = phone ? 390 : 1100
  const png = await htmlToPng(html, { width, maxHeight: 6000 })
  return { png, width, state: publicFormState(state) }
}
