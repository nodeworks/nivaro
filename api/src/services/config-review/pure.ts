import { createHash } from 'node:crypto'

/**
 * Config review — the pure parts (no database), unit-tested on their own:
 * rule contradictions, duplicate saved views, label concepts, the detail
 * envelope stored on a finding and the validation of anything a model wrote.
 *
 * Model output never decides what happens: it may only re-phrase a reason
 * (plain text, capped) or propose a label the administrator can choose. Every
 * change itself is built here, from configuration rows, and shown before it
 * is applied.
 */

export type ReviewFamily = 'review' | 'cleanup' | 'label'

export interface ReviewImpact {
  count?: number
  bytes?: number
  /** One plain sentence about what tidying it would change. */
  text?: string
}

export interface ReviewFix {
  /** Fix kind understood by fixes.ts — never a free-form instruction. */
  kind: string
  /** Button text, e.g. "Delete the duplicate view". */
  label: string
  undoable: boolean
}

/** What a finding stores in nivaro_config_health.detail for the new families. */
export interface ReviewDetail {
  reason: string
  /** The model's re-phrasing of `reason`, when a run asked for one. */
  ai_reason?: string
  impact?: ReviewImpact
  fix?: ReviewFix | null
  /** Check-specific facts the page needs (label occurrences, candidates…). */
  data?: Record<string, unknown>
  /** Fixes applied to this finding, newest first (at most APPLIED_KEEP). */
  applied?: AppliedFix[]
}

export interface AppliedFix {
  at: string
  by: string | null
  title: string
  total: number
  /** What an undo needs; null when the fix cannot be undone. */
  undo: { kind: string; data: unknown } | null
}

export const APPLIED_KEEP = 5
/** A fixed finding stays listed (with its undo) this long after the fix. */
export const FIXED_KEEP_DAYS = 30

/** The newest applied fix still carrying an undo. */
export function undoableFix(d: ReviewDetail): AppliedFix | null {
  const first = d.applied?.[0]
  return first?.undo ? first : null
}

/** A detail as the page sees it: undo copies stay on the server. */
export function publicDetail(d: ReviewDetail): ReviewDetail & { can_undo: boolean } {
  return {
    ...d,
    applied: d.applied?.map((a) => ({
      ...a,
      undo: a.undo ? { kind: a.undo.kind, data: null } : null
    })),
    can_undo: !!undoableFix(d)
  }
}

export interface ReviewFinding {
  family: ReviewFamily
  code: string
  subject: string
  title: string
  severity: 'info' | 'warning'
  href?: string
  detail: ReviewDetail
}

export function encodeDetail(d: ReviewDetail): string {
  return JSON.stringify(d)
}

/** Parse a stored detail; an older plain-text detail becomes the reason. */
export function decodeDetail(raw: unknown): ReviewDetail {
  if (typeof raw !== 'string' || !raw.trim()) return { reason: '' }
  try {
    const parsed = JSON.parse(raw) as ReviewDetail
    if (parsed && typeof parsed === 'object' && typeof parsed.reason === 'string') return parsed
  } catch {
    /* plain text */
  }
  return { reason: raw }
}

// ─── Field rule contradictions ───────────────────────────────────────────────

export interface FieldRuleRow {
  id: number
  collection: string
  trigger_field: string | null
  trigger_op: string | null
  trigger_value: string | null
  target_field: string | null
  target_type: string | null
  target_value: string | null
  sort: number | null
  is_active: boolean | number | null
  only_when_empty?: boolean | number | null
  dynamic_config?: string | null
}

export interface RuleConflict {
  kind: 'contradiction' | 'duplicate'
  collection: string
  /** The rule that loses: applied first, then overwritten (or an exact twin). */
  shadowed: FieldRuleRow
  /** The rule whose value wins. */
  winner: FieldRuleRow
}

const blank = (v: unknown) => (v == null ? '' : String(v).trim())

/**
 * Field rules run in `sort` order (then id) and the later write wins. Two
 * ACTIVE rules on the same collection with the same trigger (field, operator,
 * value) and the same target field therefore never both take effect:
 *   - different action or value  → contradiction (the earlier one is dead)
 *   - identical action and value → duplicate
 * `only_when_empty` rules are skipped as the winner of a contradiction: the
 * later rule only fills a blank, so the earlier one still takes effect.
 */
export function findRuleConflicts(rules: FieldRuleRow[]): RuleConflict[] {
  const active = rules.filter((r) => r.is_active === true || r.is_active === 1)
  const ordered = [...active].sort(
    (a, b) => (Number(a.sort ?? 0) || 0) - (Number(b.sort ?? 0) || 0) || a.id - b.id
  )
  const groups = new Map<string, FieldRuleRow[]>()
  for (const r of ordered) {
    if (!r.target_field || !r.trigger_field) continue
    const key = [
      r.collection.toLowerCase(),
      blank(r.trigger_field).toLowerCase(),
      blank(r.trigger_op).toLowerCase() || 'eq',
      blank(r.trigger_value),
      blank(r.target_field).toLowerCase()
    ].join('|')
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }
  const out: RuleConflict[] = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const last = list[list.length - 1]
    for (let i = 0; i < list.length - 1; i++) {
      const earlier = list[i]
      const sameAction =
        blank(earlier.target_type) === blank(last.target_type) &&
        blank(earlier.target_value) === blank(last.target_value) &&
        blank(earlier.dynamic_config) === blank(last.dynamic_config)
      if (sameAction) {
        out.push({
          kind: 'duplicate',
          collection: last.collection,
          shadowed: earlier,
          winner: last
        })
        continue
      }
      if (last.only_when_empty === true || last.only_when_empty === 1) continue
      out.push({
        kind: 'contradiction',
        collection: last.collection,
        shadowed: earlier,
        winner: last
      })
    }
  }
  return out
}

export function describeRule(r: FieldRuleRow): string {
  const op = blank(r.trigger_op) || 'eq'
  const when =
    op === 'nnull'
      ? `${r.trigger_field} is set`
      : op === 'null'
        ? `${r.trigger_field} is empty`
        : `${r.trigger_field} ${op} "${blank(r.trigger_value)}"`
  const action = blank(r.target_type) || 'set'
  const value = blank(r.target_value)
  return `#${r.id} (when ${when}, ${action} ${r.target_field}${value ? ` = "${value}"` : ''})`
}

// ─── Duplicate saved views ───────────────────────────────────────────────────

export interface SavedViewRow {
  id: number
  collection: string
  name: string
  filters: string | null
  sort: string | null
  columns: string | null
  user: string | null
  is_shared: boolean | number | null
  role: string | null
  is_default: boolean | number | null
  default_for_role: string | null
  created_at?: Date | string | null
}

/** Canonical JSON: object keys sorted so `{a,b}` and `{b,a}` compare equal. */
export function canonicalJson(raw: unknown): string {
  let v: unknown = raw
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t) return ''
    try {
      v = JSON.parse(t)
    } catch {
      return t
    }
  }
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, walk(o[k])])
      )
    }
    return x
  }
  return JSON.stringify(walk(v ?? null))
}

export interface ViewDuplicate {
  keep: SavedViewRow
  duplicates: SavedViewRow[]
}

const truthy = (v: unknown) => v === true || v === 1

/**
 * Views that show exactly the same thing (filters, sort and columns) to the
 * same audience (same owner, or both shared to the same role). The kept view
 * is the collection default if one is in the group, else the oldest.
 */
export function findDuplicateViews(views: SavedViewRow[]): ViewDuplicate[] {
  const groups = new Map<string, SavedViewRow[]>()
  for (const v of views) {
    const audience = truthy(v.is_shared)
      ? `shared:${String(v.role ?? '').toUpperCase()}`
      : `own:${String(v.user ?? '').toUpperCase()}`
    const key = [
      v.collection.toLowerCase(),
      audience,
      canonicalJson(v.filters),
      canonicalJson(v.sort),
      canonicalJson(v.columns)
    ].join('§')
    const list = groups.get(key) ?? []
    list.push(v)
    groups.set(key, list)
  }
  const out: ViewDuplicate[] = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => {
      const pin = (x: SavedViewRow) => (truthy(x.is_default) || x.default_for_role ? 0 : 1)
      return pin(a) - pin(b) || a.id - b.id
    })
    out.push({ keep: sorted[0], duplicates: sorted.slice(1) })
  }
  return out
}

// ─── Label concepts ──────────────────────────────────────────────────────────

export type LabelSource = 'field' | 'layout' | 'queue' | 'view' | 'report'

export interface LabelOccurrence {
  source: LabelSource
  /** Row the label lives on (nivaro_fields.id, assignment id, queue id…). */
  ref: string | number
  /** Where inside that row: 'label', 'label_override', 'overrides.label',
   *  an alias key, a JSON pointer into a config. */
  path: string
  /** The field the label names (leaf of a dotted path). */
  field: string
  label: string
  /** Human context: "Workflows queue", "Layout 2 · Workflows". */
  where: string
  href?: string
}

/** Leaves too generic to mean one concept across collections. */
const GENERIC_LEAVES = new Set([
  'id',
  'name',
  'title',
  'label',
  'status',
  'type',
  'number',
  'email',
  'description',
  'notes',
  'note',
  'amount',
  'total',
  'date',
  'created',
  'changed',
  'updated',
  'created_at',
  'updated_at',
  'date_created',
  'date_updated',
  'short_name',
  'key',
  'value',
  'code',
  'sort',
  'year',
  'user',
  'count',
  'quantity',
  'price',
  'comment',
  'reason'
])

export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .replace(/[.:]+$/, '')
    .trim()
}

export function leafOf(path: string): string {
  const parts = path.split('.')
  return (parts[parts.length - 1] ?? path).toLowerCase()
}

export interface LabelConcept {
  field: string
  /** Distinct labels in first-seen order, with how often each is used. */
  labels: Array<{ label: string; count: number }>
  suggested: string
  occurrences: LabelOccurrence[]
}

/**
 * Group label occurrences by the field they name; a concept with two or more
 * different labels (after case / spacing / trailing punctuation are ignored)
 * is inconsistent. The suggestion is the most used label that reads as a
 * label (SUGGEST_MAX_CHARS or shorter — on dev a layout's help-text-like
 * "Enter amount to increase / decrease by" outvoted "REQ Amount"); ties go to
 * the field's own label, then the shorter one.
 */
/** Longer labels read as instructions, not names — never suggested over a short one. */
export const SUGGEST_MAX_CHARS = 30

export function groupLabelConcepts(occ: LabelOccurrence[], limit = 60): LabelConcept[] {
  const byField = new Map<string, LabelOccurrence[]>()
  for (const o of occ) {
    const field = o.field.toLowerCase()
    const label = o.label?.trim()
    if (!label || GENERIC_LEAVES.has(field) || field.startsWith('__')) continue
    const list = byField.get(field) ?? []
    list.push({ ...o, label })
    byField.set(field, list)
  }
  const out: LabelConcept[] = []
  for (const [field, list] of byField) {
    const counts = new Map<string, { label: string; count: number; own: boolean }>()
    for (const o of list) {
      const key = normalizeLabel(o.label)
      const cur = counts.get(key) ?? { label: o.label, count: 0, own: false }
      cur.count++
      if (o.source === 'field') cur.own = true
      counts.set(key, cur)
    }
    if (counts.size < 2) continue
    const long = (x: { label: string }) => Number(x.label.length > SUGGEST_MAX_CHARS)
    const ranked = [...counts.values()].sort(
      (a, b) =>
        long(a) - long(b) ||
        b.count - a.count ||
        Number(b.own) - Number(a.own) ||
        a.label.length - b.label.length
    )
    out.push({
      field,
      labels: [...counts.values()].map(({ label, count }) => ({ label, count })),
      suggested: ranked[0].label,
      occurrences: list
    })
  }
  return out
    .sort(
      (a, b) => b.labels.length - a.labels.length || b.occurrences.length - a.occurrences.length
    )
    .slice(0, limit)
}

/** A label an administrator (or a model) proposes: plain text, short, no markup. */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.replace(/\s+/g, ' ').trim()
  if (!t || t.length > 80) return null
  if (/[<>{}`\\]/.test(t)) return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(t)) return null
  return t
}

// ─── Model output ────────────────────────────────────────────────────────────

export interface AiPhrasing {
  reason?: string
  label?: string
}

/**
 * Read the model's reply. Only ids we sent are accepted, only two keys per id,
 * reasons are stripped of markup and capped, labels go through cleanLabel.
 * Anything else in the reply is ignored — it is never executed or stored.
 */
export function parseAiPhrasing(text: string, ids: Set<string>): Record<string, AiPhrasing> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, AiPhrasing> = {}
  for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ids.has(id) || !raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const item: AiPhrasing = {}
    if (typeof r.reason === 'string') {
      const reason = r.reason
        .replace(/<[^>]*>/g, '')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400)
      if (reason) item.reason = reason
    }
    const label = cleanLabel(r.label)
    if (label) item.label = label
    if (item.reason || item.label) out[id] = item
  }
  return out
}

// ─── Label rewrites (#1999 apply + undo) ─────────────────────────────────────

/** Walk an RFC 6901-style pointer ('/a/0/b') to the object it names. */
export function atPointer(root: unknown, pointer: string): Record<string, unknown> | null {
  let cur: unknown = root
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(cur)) cur = cur[Number(key)]
    else if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[key]
    else return null
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : null
}

const sameLabel = (a: unknown, b: string) => typeof a === 'string' && a.trim() === b.trim()

/**
 * Rewrite one label occurrence inside the raw column value it lives in.
 * `expected` is the label the change was previewed against: when the stored
 * value no longer carries it (someone edited it since), null is returned and
 * the occurrence is skipped — an apply or an undo never stomps a later edit.
 * The same call undoes a rename with `expected` and `next` swapped.
 */
export function rewriteLabel(
  occ: Pick<LabelOccurrence, 'source' | 'path'>,
  raw: string | null,
  expected: string,
  next: string
): string | null {
  if (occ.source === 'field' || (occ.source === 'layout' && occ.path === 'label_override')) {
    return sameLabel(raw, expected) ? next : null
  }
  if (raw == null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (occ.source === 'layout') {
    if (occ.path !== 'overrides.label' || !parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (!sameLabel(o.label, expected)) return null
    return JSON.stringify({ ...o, label: next })
  }
  if (occ.source === 'queue') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const o = parsed as Record<string, unknown>
    if (!sameLabel(o[occ.path], expected)) return null
    return JSON.stringify({ ...o, [occ.path]: next })
  }
  if (occ.source === 'view') {
    if (!Array.isArray(parsed)) return null
    let hit = false
    const cols = parsed.map((c) => {
      if (!c || typeof c !== 'object') return c
      const col = c as Record<string, unknown>
      if (col.key !== occ.path || !sameLabel(col.label, expected)) return c
      hit = true
      return { ...col, label: next }
    })
    return hit ? JSON.stringify(cols) : null
  }
  if (occ.source === 'report') {
    const target = atPointer(parsed, occ.path)
    if (!target || !sameLabel(target.label, expected)) return null
    target.label = next
    return JSON.stringify(parsed)
  }
  return null
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/**
 * A row snapshot read back from JSON (an undo copy): ISO timestamps become
 * Dates again so the re-insert binds them as dates, and the identity column
 * is dropped — never supply ids for IDENTITY columns.
 */
export function reviveRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id') continue
    out[k] = typeof v === 'string' && ISO_UTC.test(v) ? new Date(v) : v
  }
  return out
}

// ─── Change-set binding (#1961) ──────────────────────────────────────────────

/**
 * The fingerprint of a planned change set: its kind plus every target key
 * (sorted, so plan order never matters). The preview hands it out with the
 * ids; an apply re-plans from the rows as they are now and proceeds only
 * when the fingerprint is unchanged.
 */
export function changeSetHash(kind: string, targets: string[]): string {
  const text = `${kind}\n${[...targets].sort().join('\n')}`
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

export type ApplyGuard =
  | { ok: true; allowed: Set<string> }
  | { ok: false; status: number; error: string }

/**
 * What an apply may touch: the targets the fresh re-plan produced AND the
 * preview listed — never a row the person did not see. A different
 * fingerprint (rows came, went or changed since the preview) is a 409.
 */
export function guardApply(
  kind: string,
  fresh: string[],
  sent: { ids?: unknown; hash?: unknown }
): ApplyGuard {
  if (!Array.isArray(sent.ids) || typeof sent.hash !== 'string') {
    return { ok: false, status: 400, error: 'Apply needs the ids and hash from the preview' }
  }
  if (changeSetHash(kind, fresh) !== sent.hash) {
    return {
      ok: false,
      status: 409,
      error: 'What this fix would change is different now — preview it again'
    }
  }
  const asked = new Set(sent.ids.map(String))
  const allowed = new Set(fresh.filter((t) => asked.has(t)))
  if (allowed.size === 0) return { ok: false, status: 409, error: 'Nothing left to apply' }
  return { ok: true, allowed }
}

// ─── File references (#2020 unreferenced files) ──────────────────────────────

export interface FileRefMeta {
  /** Columns with a foreign key to nivaro_files — the SQL anti-join covers them. */
  fkRefs: Array<{ table: string; column: string }>
  relations: Array<{
    many_collection: string | null
    many_field: string | null
    one_collection: string | null
    one_field: string | null
    junction_field: string | null
  }>
  fields: Array<{
    collection: string
    field: string
    interface: string | null
    special: string | null
  }>
  /** information_schema rows for every table named below (plus *file* uuid columns). */
  columns: Array<{ table: string; column: string; data_type: string }>
}

/** Where a file id may be written without a foreign key. */
export interface FileRefSource {
  table: string
  column: string
  /** id = the column holds one id; scan = ids anywhere in its text. */
  mode: 'id' | 'scan'
  /** Only rows that look like they carry a file URL (rich text on business tables). */
  urlOnly?: boolean
}

export const FILE_COLLECTIONS = new Set(['nivaro_files', 'directus_files'])
const FILE_INTERFACES = new Set(['file', 'image', 'files', 'file-image', 'file-interface'])
const RICH_INTERFACE = /rich|wysiwyg|markdown|html/i

/** System columns that name files with no foreign key. */
export const TEXT_FILE_REFS: Array<{ table: string; column: string; mode: 'id' | 'scan' }> = [
  { table: 'nivaro_users', column: 'avatar', mode: 'id' },
  { table: 'nivaro_workspaces', column: 'mail_logo', mode: 'id' },
  { table: 'nivaro_import_queue', column: 'file', mode: 'id' },
  { table: 'nivaro_ai_autofill_events', column: 'file_id', mode: 'id' },
  { table: 'nivaro_tasks', column: 'attachments', mode: 'scan' },
  { table: 'nivaro_addendums', column: 'attachments', mode: 'scan' },
  { table: 'nivaro_chat_scheduled', column: 'attachments', mode: 'scan' },
  { table: 'chat_messages', column: 'attachments', mode: 'scan' }
]

/**
 * Configuration tables whose every text column is scanned for file ids:
 * page builder layouts, dashboard / report / page widgets, PDF and mail
 * templates, forms, settings, layouts, record templates, comments.
 */
export const CONFIG_FILE_TABLES = [
  'nivaro_settings',
  'nivaro_settings_overrides',
  'nivaro_extension_settings',
  'nivaro_pages',
  'nivaro_widgets',
  'nivaro_dashboards',
  'nivaro_dashboard_widgets',
  'nivaro_report_widgets',
  'nivaro_report_widget_presets',
  'nivaro_report_templates',
  'nivaro_pdf_templates',
  'nivaro_mail_templates',
  'nivaro_notification_templates',
  'nivaro_broadcast_templates',
  'nivaro_submission_forms',
  'nivaro_collection_layouts',
  'nivaro_layout_field_assignments',
  'nivaro_field_groups',
  'nivaro_record_templates',
  'nivaro_sub_row_templates',
  'nivaro_workspace_templates',
  'nivaro_workspaces',
  'nivaro_collections',
  'nivaro_fields',
  'nivaro_comments',
  'nivaro_chat_channels'
]

const TEXTISH = new Set([
  'nvarchar',
  'varchar',
  'nchar',
  'char',
  'text',
  'ntext',
  'uniqueidentifier'
])

/** The tables fileRefSources may name — read their columns before calling it. */
export function fileRefTables(meta: Pick<FileRefMeta, 'relations' | 'fields'>): string[] {
  const out = new Set<string>([...CONFIG_FILE_TABLES, ...TEXT_FILE_REFS.map((r) => r.table)])
  for (const r of meta.relations) if (r.many_collection) out.add(r.many_collection)
  for (const f of meta.fields) out.add(f.collection)
  return [...out]
}

/**
 * Every place a file id can live without a foreign key, from metadata:
 * relation legs to the files collection (M2O and M2M junction legs), the
 * junction legs behind alias `files` fields, file-type fields with no
 * relation row, uuid columns named *file* on any table (extension tables),
 * the fixed system list, every text column of the config tables, and
 * rich-text fields. Only columns that exist are returned, never one a
 * foreign key already covers.
 */
export function fileRefSources(meta: FileRefMeta): FileRefSource[] {
  const key = (t: string, c: string) => `${t}.${c}`.toLowerCase()
  const cols = new Map(meta.columns.map((c) => [key(c.table, c.column), c.data_type.toLowerCase()]))
  const fk = new Set(meta.fkRefs.map((r) => key(r.table, r.column)))
  const out = new Map<string, FileRefSource>()
  const add = (s: FileRefSource) => {
    const k = key(s.table, s.column)
    const type = cols.get(k)
    if (!type || !TEXTISH.has(type) || fk.has(k)) return
    // A scan finds everything an id read does; an unfiltered scan beats a URL-only one.
    const rank = (x: FileRefSource) => (x.mode === 'id' ? 0 : x.urlOnly ? 1 : 2)
    const prev = out.get(k)
    if (!prev || rank(s) > rank(prev)) out.set(k, s)
  }
  const isFiles = (c: string | null) => !!c && FILE_COLLECTIONS.has(c.toLowerCase())

  for (const r of meta.relations) {
    if (isFiles(r.one_collection) && r.many_collection && r.many_field) {
      add({ table: r.many_collection, column: r.many_field, mode: 'id' })
    }
  }
  for (const f of meta.fields) {
    const iface = String(f.interface ?? '').toLowerCase()
    const special = String(f.special ?? '').toLowerCase()
    if (FILE_INTERFACES.has(iface) || special.includes('file')) {
      // A real column holding an id (a legacy file field with no relation row)…
      add({ table: f.collection, column: f.field, mode: 'id' })
      // …or an alias whose junction carries the file leg.
      for (const r of meta.relations) {
        if (
          r.one_collection === f.collection &&
          r.one_field === f.field &&
          r.many_collection &&
          r.junction_field
        ) {
          add({ table: r.many_collection, column: r.junction_field, mode: 'id' })
        }
      }
    } else if (RICH_INTERFACE.test(iface) && !/^nivaro_/i.test(f.collection)) {
      add({ table: f.collection, column: f.field, mode: 'scan', urlOnly: true })
    }
  }
  for (const c of meta.columns) {
    if (c.data_type.toLowerCase() === 'uniqueidentifier' && /file/i.test(c.column)) {
      add({ table: c.table, column: c.column, mode: 'id' })
    }
  }
  for (const r of TEXT_FILE_REFS) add(r)
  const config = new Set(CONFIG_FILE_TABLES.map((t) => t.toLowerCase()))
  for (const c of meta.columns) {
    if (config.has(c.table.toLowerCase())) add({ table: c.table, column: c.column, mode: 'scan' })
  }
  return [...out.values()]
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Every id-shaped string in a value, upper-cased. */
export function extractFileIds(value: unknown, into = new Set<string>()): Set<string> {
  for (const m of String(value ?? '').match(GUID) ?? []) into.add(m.toUpperCase())
  return into
}

/** Candidates no source names. */
export function dropReferenced<T extends { id: string }>(candidates: T[], named: Set<string>): T[] {
  return candidates.filter((c) => !named.has(String(c.id).toUpperCase()))
}

// ─── Cleanup thresholds (#2020) ──────────────────────────────────────────────

export interface CleanupThresholds {
  /** Drafts not saved for this many months. */
  draftMonths: number
  /** Open tasks untouched for this many months. */
  taskMonths: number
  /** Saved views not opened in this many days. */
  viewDays: number
}

export const CLEANUP_DEFAULTS: CleanupThresholds = { draftMonths: 3, taskMonths: 3, viewDays: 90 }

/** Inclusive [min, max] per threshold. */
export const CLEANUP_BOUNDS: Record<keyof CleanupThresholds, [number, number]> = {
  draftMonths: [1, 24],
  taskMonths: [1, 24],
  viewDays: [30, 365]
}

const CLEANUP_KEYS = Object.keys(CLEANUP_BOUNDS) as Array<keyof CleanupThresholds>

const inBounds = (key: keyof CleanupThresholds, v: unknown): v is number => {
  const [min, max] = CLEANUP_BOUNDS[key]
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

/**
 * Thresholds from anything (stored JSON, a run-now body): each value that is
 * a whole number inside its bounds is kept, every other one falls back —
 * to CLEANUP_DEFAULTS for stored settings, to the saved values for a run.
 */
export function normalizeCleanup(
  raw: unknown,
  fallback: CleanupThresholds = CLEANUP_DEFAULTS
): CleanupThresholds {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = { ...fallback }
  for (const k of CLEANUP_KEYS) {
    const v = typeof o[k] === 'string' && o[k] !== '' ? Number(o[k]) : o[k]
    if (inBounds(k, v)) out[k] = v
  }
  return out
}

/** Strict check for a save: every value present, whole and in bounds. */
export function validateCleanup(
  raw: unknown
): { ok: true; value: CleanupThresholds } | { ok: false; error: string } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  for (const k of CLEANUP_KEYS) {
    if (!inBounds(k, o[k])) {
      const [min, max] = CLEANUP_BOUNDS[k]
      return { ok: false, error: `${k} must be a whole number from ${min} to ${max}` }
    }
  }
  return {
    ok: true,
    value: {
      draftMonths: o.draftMonths as number,
      taskMonths: o.taskMonths as number,
      viewDays: o.viewDays as number
    }
  }
}
