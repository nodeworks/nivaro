import { createHash } from 'node:crypto'
import type { Sheet } from './xlsx-writer.js'

// ─── Owner matrix as a spreadsheet (idea 29) ─────────────────────────────────
//
// Download a pipeline's owner matrix as an .xlsx an admin can edit by hand,
// upload it back, see what would change (grouped by step), then apply. The
// sheet has ONE row per owner group: its step, name, one column per filter
// field (dimension values as their readable labels), default flag, priority,
// the people (names + emails) and teams, and a hidden Group ID column so a
// row round-trips to the group it came from. A row without an id is a new
// group; a group whose id no row names is removed.
//
// Everything in this file is pure (no database): the route loads an
// OwnerSheetContext (owner-matrix-sheet-db.ts), and planOwnerSheet turns the
// uploaded rows into the changes + problems + the write ops. The ops are
// bound to the matrix as it was read (planHash): apply recomputes the plan
// and refuses when the hash moved.

/** Filter ops the engine knows (pipeline-engine SkipOp). */
const OPS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'notin'])

export interface SheetFilter {
  field: string
  op: string
  value: unknown
  id_value?: number | string | null
}

export interface SheetState {
  id: string
  key: string
  label: string
  sort: number
}

/** A filter field with its own column: a matrix dimension, or a field some
 *  group filters on that is not a dimension (kept so nothing is lost). */
export interface SheetField {
  field: string
  header: string
  /** The bound collection the dotted path starts from. */
  collection: string
  required: boolean
  is_dimension: boolean
}

export interface SheetGroup {
  id: string
  state: string
  name: string | null
  filters: SheetFilter[]
  is_default: boolean
  priority: number
  /** Direct member user ids. */
  members: string[]
  teams: number[]
}

export interface SheetPerson {
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  inactive: boolean
}

export interface SheetTeam {
  id: number
  name: string
  slug: string | null
}

/** The known values of one filter field: lower(text) → the stored value + its record ids. */
export interface FieldCatalog {
  /** Values can be checked (the path resolved to a table + column). */
  checkable: boolean
  /** Every value is in `values` (not cut at the cap). */
  complete: boolean
  /** True when the value lives on the bound collection itself (no id_value). */
  self: boolean
  values: Map<string, { value: unknown; ids: unknown[] }>
}

export interface OwnerSheetContext {
  template: { id: string; name: string }
  states: SheetState[]
  fields: SheetField[]
  groups: SheetGroup[]
  people: SheetPerson[]
  teams: SheetTeam[]
  catalogs: Map<string, FieldCatalog>
  /** sha256 of the live owner matrix (owner-matrix-versions snapshot). */
  matrixHash: string
}

export const SHEET_NAME = 'Owners'
export const H = {
  step: 'Step',
  name: 'Group name',
  isDefault: 'Default group',
  priority: 'Priority',
  people: 'People',
  teams: 'Teams',
  other: 'Other filters',
  id: 'Group ID'
} as const
const FIXED_HEADERS = new Set(Object.values(H).map((h) => h.toLowerCase()))

// ─── Small helpers ───────────────────────────────────────────────────────────

const up = (v: unknown) => String(v ?? '').toUpperCase()
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
const lower = (s: string) => collapse(s).toLowerCase()

export function cellText(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return collapse(String(v))
}

export function personName(p: Pick<SheetPerson, 'first_name' | 'last_name'>): string {
  return collapse([p.first_name, p.last_name].filter(Boolean).join(' '))
}

/** How a person is written in the People column: "First Last <email>". */
export function personCell(p: SheetPerson): string {
  const name = personName(p)
  if (!p.email) return name || p.id
  return name ? `${name} <${p.email}>` : p.email
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

/** Split a filter set into its column values (one plain "equals" per field
 *  column) and the rest, which ride in Other filters as JSON. */
export function splitFilters(
  filters: SheetFilter[],
  fieldSet: Set<string>
): { byField: Map<string, SheetFilter>; other: SheetFilter[] } {
  const counts = new Map<string, number>()
  for (const f of filters) counts.set(f.field, (counts.get(f.field) ?? 0) + 1)
  const byField = new Map<string, SheetFilter>()
  const other: SheetFilter[] = []
  for (const f of filters) {
    const plain =
      fieldSet.has(f.field) &&
      f.op === 'eq' &&
      isScalar(f.value) &&
      f.value !== null &&
      cellText(f.value) !== '' &&
      counts.get(f.field) === 1
    if (plain) byField.set(f.field, f)
    else other.push(f)
  }
  return { byField, other }
}

const otherText = (other: SheetFilter[]) => (other.length ? JSON.stringify(other) : '')

/** Order-free identity of a filter set (what makes two groups the same cell). */
export function filterSetKey(filters: SheetFilter[]): string {
  return filters
    .map((f) =>
      [
        f.field.toLowerCase(),
        f.op,
        Array.isArray(f.value)
          ? f.value.map((x) => lower(String(x))).join(',')
          : lower(String(f.value ?? '')),
        f.id_value == null ? '' : String(f.id_value)
      ].join('|')
    )
    .sort()
    .join('&')
}

/** The sheet's column headers, in order. */
export function sheetHeaders(ctx: Pick<OwnerSheetContext, 'fields'>): string[] {
  return [
    H.step,
    H.name,
    ...ctx.fields.map((f) => f.header),
    H.isDefault,
    H.priority,
    H.people,
    H.teams,
    H.other,
    H.id
  ]
}

/** A field column's header: the dimension's label, made unique. */
export function fieldHeaders(
  fields: Array<{ field: string; label: string | null }>
): Map<string, string> {
  const taken = new Set(FIXED_HEADERS)
  const out = new Map<string, string>()
  for (const f of fields) {
    let h = collapse(f.label || f.field)
    if (taken.has(h.toLowerCase())) h = `${h} (${f.field})`
    for (let n = 2; taken.has(h.toLowerCase()); n++) h = `${collapse(f.label || f.field)} ${n}`
    taken.add(h.toLowerCase())
    out.set(f.field, h)
  }
  return out
}

/** Step cell text per state: its label, or "label (key)" when labels repeat. */
export function stepCells(states: SheetState[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const s of states) counts.set(lower(s.label), (counts.get(lower(s.label)) ?? 0) + 1)
  return new Map(
    states.map((s) => [
      up(s.id),
      (counts.get(lower(s.label)) ?? 0) > 1 || !s.label ? `${s.label || s.key} (${s.key})` : s.label
    ])
  )
}

// ─── Download ────────────────────────────────────────────────────────────────

/** The groups as sheet rows, in step order. */
export function sheetRows(ctx: OwnerSheetContext): Array<Record<string, string | number>> {
  const steps = stepCells(ctx.states)
  const order = new Map(ctx.states.map((s, i) => [up(s.id), i]))
  const people = new Map(ctx.people.map((p) => [up(p.id), p]))
  const teams = new Map(ctx.teams.map((t) => [t.id, t]))
  const fieldSet = new Set(ctx.fields.map((f) => f.field))
  const groups = [...ctx.groups].sort(
    (a, b) =>
      (order.get(up(a.state)) ?? 999) - (order.get(up(b.state)) ?? 999) ||
      Number(b.is_default) - Number(a.is_default)
  )
  return groups.map((g) => {
    const { byField, other } = splitFilters(g.filters, fieldSet)
    const row: Record<string, string | number> = {
      [H.step]: steps.get(up(g.state)) ?? g.state,
      [H.name]: g.name ?? ''
    }
    for (const f of ctx.fields) row[f.header] = cellText(byField.get(f.field)?.value)
    row[H.isDefault] = g.is_default ? 'Yes' : ''
    row[H.priority] = g.priority
    row[H.people] = g.members
      .map((id) => people.get(up(id)))
      .filter((p): p is SheetPerson => !!p)
      .map(personCell)
      .sort((a, b) => a.localeCompare(b))
      .join('; ')
    row[H.teams] = g.teams
      .map((id) => teams.get(id)?.name)
      .filter(Boolean)
      .join('; ')
    row[H.other] = otherText(other)
    row[H.id] = g.id
    return row
  })
}

const LIST_CAP = 2000

/** The workbook: Owners (the groups), README, and a hidden Lists sheet the
 *  Step / dimension / Default dropdowns read from. */
export function buildOwnerSheetWorkbook(ctx: OwnerSheetContext, now = new Date()): Sheet[] {
  const headers = sheetHeaders(ctx)
  const rows = sheetRows(ctx)
  const steps = stepCells(ctx.states)
  const lastRow = Math.max(rows.length + 1, 2) + 500
  const col = (h: string) => headers.indexOf(h)

  // Lists: column A = steps, B = Yes, then one column per checkable field.
  const listCols: Array<{ title: string; values: string[] }> = [
    { title: 'Steps', values: ctx.states.map((s) => steps.get(up(s.id)) ?? s.label) },
    { title: 'Default', values: ['Yes'] }
  ]
  const validations: Sheet['validations'] = []
  const listRef = (i: number, n: number) =>
    `Lists!$${String.fromCharCode(65 + i)}$2:$${String.fromCharCode(65 + i)}$${n + 1}`
  validations.push({
    col: col(H.step),
    fromRow: 2,
    toRow: lastRow,
    kind: 'list',
    listRange: listRef(0, listCols[0].values.length),
    prompt: 'Pick the step this group owns'
  })
  validations.push({
    col: col(H.isDefault),
    fromRow: 2,
    toRow: lastRow,
    kind: 'list',
    listRange: listRef(1, 1),
    prompt: 'Yes = this group owns every record no other group in the step matches'
  })
  validations.push({ col: col(H.priority), fromRow: 2, toRow: lastRow, kind: 'whole' })
  for (const f of ctx.fields) {
    const cat = ctx.catalogs.get(f.field)
    if (!cat?.checkable || !cat.complete || cat.values.size === 0) continue
    if (cat.values.size > LIST_CAP || listCols.length >= 26) continue
    const values = [...new Set([...cat.values.values()].map((v) => cellText(v.value)))]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    listCols.push({ title: f.header, values })
    validations.push({
      col: col(f.header),
      fromRow: 2,
      toRow: lastRow,
      kind: 'list',
      listRange: listRef(listCols.length - 1, values.length),
      prompt: `Pick a ${f.header} — blank = any`
    })
  }
  const listDepth = Math.max(...listCols.map((c) => c.values.length))
  const listRows: Sheet['rows'] = [listCols.map((c) => c.title)]
  for (let r = 0; r < listDepth; r++) listRows.push(listCols.map((c) => c.values[r] ?? null))

  const widths = headers.map((h) => {
    if (h === H.people) return 60
    if (h === H.id) return 38
    if (h === H.step) return 24
    if (h === H.name || h === H.other || h === H.teams) return 24
    if (h === H.isDefault || h === H.priority) return 12
    return 18
  })

  const owners: Sheet = {
    name: SHEET_NAME,
    rows: [
      headers.map((h) => ({ v: h, s: 'header' as const })),
      ...rows.map((r) =>
        headers.map((h) => (h === H.people ? { v: r[h] ?? '', s: 'wrap' as const } : r[h]))
      )
    ],
    widths,
    hiddenCols: [col(H.id)],
    freezeRows: 1,
    validations
  }

  const dimList = ctx.fields
    .map((f) => `${f.header}${f.is_dimension ? '' : ' (a field some groups filter on)'}`)
    .join(', ')
  const readme: Sheet = {
    name: 'README',
    widths: [110],
    rows: [
      [{ v: `Owner matrix — ${ctx.template.name}`, s: 'header' }],
      [
        `Downloaded ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC. Upload it back on the pipeline's Owner Matrix (Upload).`
      ],
      [''],
      [{ v: 'How it works', s: 'note' }],
      [
        'Each row of the Owners sheet is one owner group: the people who own one step for the records that match its values.'
      ],
      [
        'Uploading never changes anything by itself: you see every change (people added or removed, groups added, removed or changed) and press Apply.'
      ],
      [
        'If someone changes the owner matrix after you upload, Apply refuses and asks you to check again.'
      ],
      [''],
      [{ v: 'Columns', s: 'note' }],
      [`Step — the step the group owns. Pick from the list.`],
      ['Group name — optional, for your own reference.'],
      [
        `${dimList || 'Value columns'} — the values a record must have for this group to own it. Blank = any value. Pick from the list.`
      ],
      ['Default group — Yes = owns every record in the step that no other group matches.'],
      ['Priority — a tie-breaker when two groups match the same record equally well; lower wins.'],
      [
        'People — one or more people, separated by ; (semicolon). Write "Name <email>" or just the email. A name alone works only when exactly one person has it; when two people share a name, the email is required.'
      ],
      ["Teams — team names separated by ; (semicolon). A team's members own the step too."],
      [
        'Other filters — conditions the columns cannot show (not equal, lists, …), as written by the app. Leave it as it is unless you know the format.'
      ],
      [
        'Group ID — hidden. It ties a row to the group it came from: keep it as it is. Leave it empty on a new row. Copying a row copies its ID — clear the ID on the copy.'
      ],
      [''],
      [{ v: 'Adding and removing', s: 'note' }],
      ['Add a group: add a row and leave Group ID empty.'],
      ['Remove a group: delete its row.'],
      ['Move a group to another step: change its Step.'],
      [''],
      [{ v: 'Steps', s: 'note' }],
      ...ctx.states.map((s) => [`${steps.get(up(s.id))}  —  key ${s.key}`])
    ]
  }

  const lists: Sheet = { name: 'Lists', hidden: true, rows: listRows }
  return [owners, readme, lists]
}

// ─── Upload: plan ────────────────────────────────────────────────────────────

export type Severity = 'error' | 'warning'

export interface SheetProblem {
  /** Sheet row number (header = 1); null = the file as a whole. */
  row: number | null
  column: string | null
  severity: Severity
  message: string
}

export interface PersonRef {
  id: string
  name: string
  email: string | null
}

export interface TeamRef {
  id: number
  name: string
}

export interface GroupChange {
  kind: 'added' | 'removed' | 'changed'
  group_id: string | null
  row: number | null
  state_id: string
  /** The group in words: its column values, else its name, else Default / Any record. */
  label: string
  /** "Region: East" per value; before = as saved, after = as uploaded. */
  filters_before: string[]
  filters_after: string[]
  fields: Array<{ field: 'step' | 'name' | 'default' | 'priority'; before: string; after: string }>
  people_added: PersonRef[]
  people_removed: PersonRef[]
  teams_added: TeamRef[]
  teams_removed: TeamRef[]
}

export interface StepChanges {
  state_id: string
  state_label: string
  changes: GroupChange[]
  people_added: number
  people_removed: number
}

export interface InsertOp {
  row: number
  state: string
  name: string | null
  filters: SheetFilter[]
  is_default: boolean
  priority: number
  users: string[]
  teams: number[]
}

export interface UpdateOp {
  id: string
  set: Partial<{
    state: string
    name: string | null
    filters: SheetFilter[]
    is_default: boolean
    priority: number
  }>
  add_users: string[]
  remove_users: string[]
  add_teams: number[]
  remove_teams: number[]
}

export interface SheetOps {
  deletes: string[]
  inserts: InsertOp[]
  updates: UpdateOp[]
}

/** One group of the upload as owner-preview's draft takes it ("Try a record"). */
export interface SheetDraftGroup {
  id: string
  state: string
  name: string | null
  filters: SheetFilter[] | null
  is_default: boolean
  priority: number
  users: string[]
  teams: number[]
  removed?: boolean
}

export interface SheetPlan {
  rows: number
  steps: StepChanges[]
  problems: SheetProblem[]
  /** Problems found but not listed (the list is capped). */
  problems_hidden: number
  errors: number
  warnings: number
  counts: {
    groups_added: number
    groups_removed: number
    groups_changed: number
    groups_unchanged: number
    people_added: number
    people_removed: number
  }
  draft_groups: SheetDraftGroup[]
  ops: SheetOps
}

const MAX_PROBLEMS = 400

export function planHash(matrixHash: string, ops: SheetOps): string {
  return createHash('sha256')
    .update(`${matrixHash}|${JSON.stringify(ops)}`)
    .digest('hex')
}

export function opsEmpty(ops: SheetOps): boolean {
  return ops.deletes.length === 0 && ops.inserts.length === 0 && ops.updates.length === 0
}

type PeopleIndex = {
  byId: Map<string, SheetPerson>
  byEmail: Map<string, SheetPerson[]>
  byName: Map<string, SheetPerson[]>
}

function indexPeople(people: SheetPerson[]): PeopleIndex {
  const byId = new Map<string, SheetPerson>()
  const byEmail = new Map<string, SheetPerson[]>()
  const byName = new Map<string, SheetPerson[]>()
  const push = (m: Map<string, SheetPerson[]>, k: string, p: SheetPerson) => {
    if (!k) return
    const arr = m.get(k) ?? []
    arr.push(p)
    m.set(k, arr)
  }
  for (const p of people) {
    byId.set(up(p.id), p)
    if (p.email) push(byEmail, p.email.trim().toLowerCase(), p)
    push(byName, lower(personName(p)), p)
  }
  return { byId, byEmail, byName }
}

const EMAIL_IN_ANGLES = /^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/

export type PersonParse = { ok: true; person: SheetPerson } | { ok: false; message: string }

/** One entry of the People column → a person, never by display name alone
 *  when two people share it. `current` = the group's members today, so an
 *  unchanged entry for someone without an email still resolves. */
export function resolvePerson(
  raw: string,
  idx: PeopleIndex,
  current: SheetPerson[] = []
): PersonParse {
  const text = collapse(raw)
  const same = current.find((p) => lower(personCell(p)) === lower(text))
  if (same) return { ok: true, person: same }
  const angled = EMAIL_IN_ANGLES.exec(text)
  const email = angled ? angled[2] : text.includes('@') ? text : null
  if (email) {
    const hits = idx.byEmail.get(email.toLowerCase()) ?? []
    if (hits.length === 1) return { ok: true, person: hits[0] }
    if (hits.length > 1)
      return { ok: false, message: `${hits.length} accounts share the email "${email}"` }
    return { ok: false, message: `No one has the email "${email}" — check the spelling` }
  }
  const hits = idx.byName.get(lower(text)) ?? []
  if (hits.length === 1) return { ok: true, person: hits[0] }
  if (hits.length > 1) {
    const sample = hits
      .slice(0, 3)
      .map((p) => personCell(p))
      .join(', ')
    return {
      ok: false,
      message: `${hits.length} people are named "${text}" — write the email of the one you mean (${sample})`
    }
  }
  return { ok: false, message: `No one is named "${text}" — write their email instead` }
}

export function splitPeople(text: string): string[] {
  return text
    .split(/[;,\n]+/)
    .map((s) => collapse(s))
    .filter(Boolean)
}

export function splitTeams(text: string): string[] {
  return text
    .split(/[;\n]+/)
    .map((s) => collapse(s))
    .filter(Boolean)
}

const YES = new Set(['yes', 'y', 'true', '1', 'x'])
const NO = new Set(['', 'no', 'n', 'false', '0'])

function parseOther(text: string): SheetFilter[] | string {
  if (!text) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return 'Other filters is not in the format the app writes — put back the text it had, or clear it'
  }
  if (!Array.isArray(raw)) return 'Other filters must be a list'
  const out: SheetFilter[] = []
  for (const f of raw as Array<Record<string, unknown>>) {
    const field = typeof f?.field === 'string' ? f.field : ''
    const op = typeof f?.op === 'string' ? f.op : ''
    if (!field || !OPS.has(op) || (!isScalar(f.value ?? null) && !Array.isArray(f.value)))
      return 'Other filters has a condition the app cannot read'
    out.push({
      field,
      op,
      value: f.value ?? null,
      ...(f.id_value !== undefined ? { id_value: f.id_value as number | string | null } : {})
    })
  }
  return out
}

function describeFilter(f: SheetFilter, headerOf: Map<string, string>): string {
  const name = headerOf.get(f.field) ?? f.field
  const value = Array.isArray(f.value) ? f.value.join(', ') : cellText(f.value)
  const word: Record<string, string> = {
    eq: ':',
    neq: ' is not',
    lt: ' <',
    lte: ' ≤',
    gt: ' >',
    gte: ' ≥',
    in: ' is one of',
    notin: ' is none of'
  }
  return `${name}${word[f.op] ?? ` ${f.op}`} ${value}`
}

function groupLabel(
  g: { name: string | null; filters: SheetFilter[]; is_default: boolean },
  fields: SheetField[]
): string {
  const fieldSet = new Set(fields.map((f) => f.field))
  const { byField } = splitFilters(g.filters, fieldSet)
  const values = fields.map((f) => cellText(byField.get(f.field)?.value)).filter(Boolean)
  if (values.length) return values.join(' · ')
  const name = (g.name ?? '').trim()
  if (name && !/^legacy:/i.test(name)) return name
  if (g.is_default) return 'Default group'
  return g.filters.length ? 'Other conditions' : 'Any record'
}

/**
 * The upload against the live matrix: what changes, per step, and what is
 * wrong per row. Pure — every lookup it needs is in ctx (the route fills the
 * field catalogs for the values the sheet names first).
 */
export function planOwnerSheet(
  ctx: OwnerSheetContext,
  rows: Record<string, unknown>[],
  columns: string[],
  readIssues: Array<{ severity: 'warn' | 'error'; message: string }> = []
): SheetPlan {
  const problems: SheetProblem[] = []
  const problem = (
    row: number | null,
    column: string | null,
    severity: Severity,
    message: string
  ) => problems.push({ row, column, severity, message })
  for (const i of readIssues)
    problem(
      null,
      null,
      'error',
      i.severity === 'warn' ? `${i.message} — the rest would be removed` : i.message
    )

  // Header lookup is case-free; the row objects are keyed by the header text as written.
  const keyOf = new Map<string, string>()
  for (const c of columns) keyOf.set(lower(c), c)
  const get = (r: Record<string, unknown>, header: string) => {
    const k = keyOf.get(lower(header))
    return k === undefined ? '' : cellText(r[k])
  }
  const missing = [H.step, H.people, H.id, ...ctx.fields.map((f) => f.header)].filter(
    (h) => !keyOf.has(lower(h))
  )
  for (const h of missing)
    problem(
      null,
      h,
      'error',
      h === H.step || h === H.id
        ? `This is not an owner matrix sheet from this app (no "${h}" column). Download the matrix and edit that file.`
        : `The "${h}" column is missing — put it back (leave cells blank for "any value").`
    )
  const known = new Set([...sheetHeaders(ctx)].map((h) => h.toLowerCase()))
  for (const c of columns)
    if (!known.has(lower(c)))
      problem(null, c, 'warning', `Column "${c}" is not part of the owner matrix — it is ignored.`)

  const stateBy = new Map<string, SheetState>()
  const cells = stepCells(ctx.states)
  const labelCount = new Map<string, number>()
  for (const s of ctx.states)
    labelCount.set(lower(s.label), (labelCount.get(lower(s.label)) ?? 0) + 1)
  for (const s of ctx.states) {
    stateBy.set(lower(cells.get(up(s.id)) ?? ''), s)
    stateBy.set(lower(s.key), s)
    if (labelCount.get(lower(s.label)) === 1) stateBy.set(lower(s.label), s)
  }
  const stateById = new Map(ctx.states.map((s) => [up(s.id), s]))
  const stateLabel = (id: string) => {
    const s = stateById.get(up(id))
    return s ? (cells.get(up(s.id)) ?? s.label) : id
  }

  const idx = indexPeople(ctx.people)
  const teamsByName = new Map<string, SheetTeam[]>()
  for (const t of ctx.teams) {
    for (const k of new Set([lower(t.name), t.slug ? lower(t.slug) : ''])) {
      if (!k) continue
      const arr = teamsByName.get(k) ?? []
      arr.push(t)
      teamsByName.set(k, arr)
    }
  }
  const teamById = new Map(ctx.teams.map((t) => [t.id, t]))
  const groupsById = new Map(ctx.groups.map((g) => [up(g.id), g]))
  const fieldSet = new Set(ctx.fields.map((f) => f.field))
  const headerOf = new Map(ctx.fields.map((f) => [f.field, f.header]))
  const ref = (p: SheetPerson): PersonRef => ({
    id: p.id,
    name: personName(p) || p.email || p.id,
    email: p.email
  })
  const tref = (id: number): TeamRef => ({ id, name: teamById.get(id)?.name ?? `Team ${id}` })

  const ops: SheetOps = { deletes: [], inserts: [], updates: [] }
  const changes: GroupChange[] = []
  const draft: SheetDraftGroup[] = []
  const seenIds = new Map<string, number>()
  const cellKeys = new Map<string, Array<{ row: number; touched: boolean }>>()
  let unchanged = 0
  let dataRows = 0
  const headerFailed = missing.length > 0

  rows.forEach((r, i) => {
    if (headerFailed) return
    const rowNo = i + 2
    const relevant = [...sheetHeaders(ctx)].some((h) => get(r, h) !== '')
    if (!relevant) return
    dataRows++
    let rowOk = true
    const err = (column: string | null, message: string) => {
      rowOk = false
      problem(rowNo, column, 'error', message)
    }
    const warn = (column: string | null, message: string) =>
      problem(rowNo, column, 'warning', message)

    // Identity.
    const idText = get(r, H.id)
    let existing: SheetGroup | undefined
    if (idText) {
      existing = groupsById.get(up(idText))
      if (!existing) {
        err(
          H.id,
          'This Group ID belongs to no owner group of this pipeline — clear the Group ID cell to add the row as a new group.'
        )
      } else if (seenIds.has(up(idText))) {
        err(
          H.id,
          `Same Group ID as row ${seenIds.get(up(idText))} — a copied row keeps the hidden ID. Clear the Group ID on the copy to add it as a new group.`
        )
        existing = undefined
      } else seenIds.set(up(idText), rowNo)
    }

    // Step.
    const stepText = get(r, H.step)
    const state = stepText ? stateBy.get(lower(stepText)) : undefined
    if (!stepText) err(H.step, 'Step is empty — pick the step this group owns.')
    else if (!state) err(H.step, `"${stepText}" is not a step of this pipeline.`)

    // Filters: one column per field, then Other filters.
    const saved = existing ? splitFilters(existing.filters, fieldSet) : null
    const filters: SheetFilter[] = []
    for (const f of ctx.fields) {
      const text = get(r, f.header)
      if (!text) continue
      const before = saved?.byField.get(f.field)
      if (before && lower(cellText(before.value)) === lower(text)) {
        filters.push(before)
        continue
      }
      const cat = ctx.catalogs.get(f.field)
      if (!cat?.checkable) {
        filters.push({ field: f.field, op: 'eq', value: text, id_value: null })
        warn(
          f.header,
          `"${text}" could not be checked against the ${f.header} values — make sure it is spelled exactly as in the app.`
        )
        continue
      }
      const hit = cat.values.get(lower(text))
      if (!hit) {
        err(f.header, `"${text}" is not a ${f.header} value — pick one from the list.`)
        continue
      }
      if (cat.self) filters.push({ field: f.field, op: 'eq', value: hit.value })
      else {
        filters.push({
          field: f.field,
          op: 'eq',
          value: hit.value,
          id_value: (hit.ids[0] ?? null) as number | null
        })
        if (hit.ids.length > 1)
          warn(
            f.header,
            `${hit.ids.length} ${f.header} records are called "${text}" — the first one is used.`
          )
      }
    }
    const otherRaw = get(r, H.other)
    const savedOther = saved ? otherText(saved.other) : ''
    if (saved && otherRaw === collapse(savedOther)) filters.push(...saved.other)
    else {
      const other = parseOther(otherRaw)
      if (typeof other === 'string') err(H.other, other)
      else filters.push(...other)
    }

    // Default, priority, name.
    const defText = lower(get(r, H.isDefault))
    let isDefault = false
    if (YES.has(defText)) isDefault = true
    else if (!NO.has(defText))
      err(H.isDefault, `Default group must be Yes or blank, not "${get(r, H.isDefault)}".`)
    const prioText = get(r, H.priority)
    let priority = 0
    if (prioText) {
      const n = Number(prioText)
      if (!Number.isInteger(n))
        err(H.priority, `Priority must be a whole number, not "${prioText}".`)
      else priority = n
    }
    const nameText = get(r, H.name)
    const name = nameText ? nameText.slice(0, 255) : null

    // People.
    const current = (existing?.members ?? [])
      .map((id) => idx.byId.get(up(id)))
      .filter((p): p is SheetPerson => !!p)
    const users: string[] = []
    const userSet = new Set<string>()
    for (const entry of splitPeople(get(r, H.people))) {
      const res = resolvePerson(entry, idx, current)
      if (!res.ok) {
        err(H.people, res.message)
        continue
      }
      if (userSet.has(up(res.person.id))) continue
      userSet.add(up(res.person.id))
      users.push(res.person.id)
    }
    // Members whose account is gone from the directory cannot be written in
    // the sheet; they stay unless the row is removed.
    for (const id of existing?.members ?? [])
      if (!idx.byId.has(up(id)) && !userSet.has(up(id))) {
        userSet.add(up(id))
        users.push(id)
      }

    // Teams.
    const teamIds: number[] = []
    for (const entry of splitTeams(get(r, H.teams))) {
      const hits = teamsByName.get(lower(entry)) ?? []
      if (hits.length === 0) err(H.teams, `No team is called "${entry}".`)
      else if (hits.length > 1)
        err(H.teams, `${hits.length} teams are called "${entry}" — use the team's slug.`)
      else if (!teamIds.includes(hits[0].id)) teamIds.push(hits[0].id)
    }

    if (!rowOk || !state) {
      // Keep a broken row's group from being read as removed.
      return
    }

    const after = { name, filters, is_default: isDefault, priority }
    const userAdds = users.filter((u) => !(existing?.members ?? []).some((m) => up(m) === up(u)))
    const userRemoves = (existing?.members ?? []).filter((m) => !userSet.has(up(m)))
    for (const u of userAdds) {
      const p = idx.byId.get(up(u))
      if (p?.inactive)
        warn(
          H.people,
          `${personName(p) || p.email} is suspended or has left — they cannot act on records.`
        )
    }

    let touched = true
    if (!existing) {
      ops.inserts.push({ row: rowNo, state: state.id, ...after, users, teams: teamIds })
      draft.push({
        id: `sheet-row-${rowNo}`,
        state: state.id,
        ...after,
        filters,
        users,
        teams: teamIds
      })
      changes.push({
        kind: 'added',
        group_id: null,
        row: rowNo,
        state_id: state.id,
        label: groupLabel(after, ctx.fields),
        filters_before: [],
        filters_after: filters.map((f) => describeFilter(f, headerOf)),
        fields: [],
        people_added: users
          .map((u) => idx.byId.get(up(u)))
          .filter((p): p is SheetPerson => !!p)
          .map(ref),
        people_removed: [],
        teams_added: teamIds.map(tref),
        teams_removed: []
      })
    } else {
      const set: UpdateOp['set'] = {}
      const fieldChanges: GroupChange['fields'] = []
      if (up(existing.state) !== up(state.id)) {
        set.state = state.id
        fieldChanges.push({
          field: 'step',
          before: stateLabel(existing.state),
          after: stateLabel(state.id)
        })
      }
      if ((existing.name ?? '') !== (name ?? '')) {
        set.name = name
        fieldChanges.push({ field: 'name', before: existing.name ?? '', after: name ?? '' })
      }
      if (existing.is_default !== isDefault) {
        set.is_default = isDefault
        fieldChanges.push({
          field: 'default',
          before: existing.is_default ? 'Yes' : 'No',
          after: isDefault ? 'Yes' : 'No'
        })
      }
      if (Number(existing.priority) !== priority) {
        set.priority = priority
        fieldChanges.push({
          field: 'priority',
          before: String(existing.priority),
          after: String(priority)
        })
      }
      const filtersChanged = filterSetKey(existing.filters) !== filterSetKey(filters)
      if (filtersChanged) set.filters = filters
      const teamAdds = teamIds.filter((t) => !existing!.teams.includes(t))
      const teamRemoves = existing.teams.filter((t) => !teamIds.includes(t))
      const any =
        Object.keys(set).length > 0 ||
        userAdds.length > 0 ||
        userRemoves.length > 0 ||
        teamAdds.length > 0 ||
        teamRemoves.length > 0
      if (!any) {
        unchanged++
        touched = false
      } else {
        ops.updates.push({
          id: existing.id,
          set,
          add_users: userAdds,
          remove_users: userRemoves,
          add_teams: teamAdds,
          remove_teams: teamRemoves
        })
        draft.push({ id: existing.id, state: state.id, ...after, filters, users, teams: teamIds })
        changes.push({
          kind: 'changed',
          group_id: existing.id,
          row: rowNo,
          state_id: state.id,
          label: groupLabel(after, ctx.fields),
          filters_before: filtersChanged
            ? existing.filters.map((f) => describeFilter(f, headerOf))
            : [],
          filters_after: filtersChanged ? filters.map((f) => describeFilter(f, headerOf)) : [],
          fields: fieldChanges,
          people_added: userAdds
            .map((u) => idx.byId.get(up(u)))
            .filter((p): p is SheetPerson => !!p)
            .map(ref),
          people_removed: userRemoves
            .map(
              (u) =>
                idx.byId.get(up(u)) ?? {
                  id: u,
                  email: null,
                  first_name: null,
                  last_name: u,
                  inactive: true
                }
            )
            .map(ref),
          teams_added: teamAdds.map(tref),
          teams_removed: teamRemoves.map(tref)
        })
      }
    }

    if (touched)
      for (const f of ctx.fields)
        if (f.required && !isDefault && !get(r, f.header))
          warn(
            f.header,
            `${f.header} is empty — records with any ${f.header} will match this group.`
          )

    const key = `${up(state.id)}#${isDefault ? 'D' : ''}#${filterSetKey(filters)}`
    const arr = cellKeys.get(key) ?? []
    arr.push({ row: rowNo, touched })
    cellKeys.set(key, arr)
  })

  // Duplicate cells: two rows that own the same step for the same values.
  for (const rowsOfKey of cellKeys.values()) {
    if (rowsOfKey.length < 2) continue
    const first = rowsOfKey[0].row
    const anyTouched = rowsOfKey.some((x) => x.touched)
    for (const x of rowsOfKey.slice(1))
      problem(
        x.row,
        null,
        anyTouched ? 'error' : 'warning',
        `Duplicate group: row ${first} already owns this step for the same values. Put the people on one row.`
      )
  }

  // Removed: saved groups no (valid or broken) row names.
  const named = new Set<string>()
  if (!headerFailed)
    rows.forEach((r) => {
      const idText = get(r, H.id)
      if (idText) named.add(up(idText))
    })
  if (!headerFailed && problems.every((p) => p.row !== null || p.severity !== 'error')) {
    for (const g of ctx.groups) {
      if (named.has(up(g.id))) continue
      ops.deletes.push(g.id)
      draft.push({
        id: g.id,
        state: g.state,
        name: g.name,
        filters: g.filters,
        is_default: g.is_default,
        priority: g.priority,
        users: [],
        teams: [],
        removed: true
      })
      changes.push({
        kind: 'removed',
        group_id: g.id,
        row: null,
        state_id: g.state,
        label: groupLabel(g, ctx.fields),
        filters_before: g.filters.map((f) => describeFilter(f, headerOf)),
        filters_after: [],
        fields: [],
        people_added: [],
        people_removed: g.members
          .map((u) => idx.byId.get(up(u)))
          .filter((p): p is SheetPerson => !!p)
          .map(ref),
        teams_added: [],
        teams_removed: g.teams.map(tref)
      })
    }
  }
  if (!headerFailed && dataRows === 0)
    problem(
      null,
      null,
      'error',
      'The Owners sheet has no rows. Uploading it would remove every owner group.'
    )

  // Group by step, in the pipeline's step order.
  const steps: StepChanges[] = []
  for (const s of ctx.states) {
    const list = changes.filter((c) => up(c.state_id) === up(s.id))
    if (list.length === 0) continue
    steps.push({
      state_id: s.id,
      state_label: stateLabel(s.id),
      changes: list,
      people_added: list.reduce((n, c) => n + c.people_added.length, 0),
      people_removed: list.reduce((n, c) => n + c.people_removed.length, 0)
    })
  }

  problems.sort(
    (a, b) =>
      (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) ||
      (a.row ?? 0) - (b.row ?? 0)
  )
  const errors = problems.filter((p) => p.severity === 'error').length
  return {
    rows: dataRows,
    steps,
    problems: problems.slice(0, MAX_PROBLEMS),
    problems_hidden: Math.max(0, problems.length - MAX_PROBLEMS),
    errors,
    warnings: problems.length - errors,
    counts: {
      groups_added: ops.inserts.length,
      groups_removed: ops.deletes.length,
      groups_changed: ops.updates.length,
      groups_unchanged: unchanged,
      people_added: changes.reduce((n, c) => n + c.people_added.length, 0),
      people_removed: changes.reduce((n, c) => n + c.people_removed.length, 0)
    },
    draft_groups: draft,
    ops
  }
}

/** Field values the sheet names that a cut-off catalog may not hold yet. */
export function valuesToLookUp(
  ctx: OwnerSheetContext,
  rows: Record<string, unknown>[],
  columns: string[]
): Map<string, string[]> {
  const keyOf = new Map<string, string>()
  for (const c of columns) keyOf.set(lower(c), c)
  const out = new Map<string, string[]>()
  for (const f of ctx.fields) {
    const cat = ctx.catalogs.get(f.field)
    if (!cat?.checkable || cat.complete) continue
    const k = keyOf.get(lower(f.header))
    if (k === undefined) continue
    const want = new Set<string>()
    for (const r of rows) {
      const t = cellText(r[k])
      if (t && !cat.values.has(lower(t))) want.add(t)
    }
    if (want.size) out.set(f.field, [...want])
  }
  return out
}
