import { parseRecordConditions } from './layout-patch.js'

// Test records per layout (#2646, #2647) and the new-record walkthrough
// (#2648): the pure half of what the layout editor's checks ask the server.
// Pinned test records live in the layout's `conditions` JSON under `testing`
// (beside the form cost limit, #2649), so they version with the layout and
// need no table — only `conditions.role_ids` there decides who gets the form.

/** Records one check may ask about (the editor pins at most 5). */
export const MAX_CHECK_RECORDS = 10
/** Fields whose values one check may read back (the draft's visibility conditions). */
export const MAX_CHECK_FIELDS = 200

/** The layout settings that change which form a record resolves to. */
export const DRAFT_RESOLUTION_KEYS = [
  'record_conditions',
  'conditions',
  'is_active',
  'sort',
  'layout_type'
] as const

export type DraftResolution = Partial<Record<(typeof DRAFT_RESOLUTION_KEYS)[number], unknown>>

export interface CheckRecord {
  item: string
  role_id: string | null
}

export interface CheckBody {
  records: CheckRecord[]
  draft: DraftResolution | null
  fields: string[]
}

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** Only the settings that change resolution; anything else in `draft` is ignored. */
export function parseDraftResolution(raw: unknown): DraftResolution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: DraftResolution = {}
  for (const k of DRAFT_RESOLUTION_KEYS)
    if (k in (raw as object)) out[k] = (raw as Record<string, unknown>)[k]
  return out
}

/** POST /collection-layouts/:id/test-records body, validated. */
export function parseCheckBody(body: unknown): CheckBody | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const list = b.records
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CHECK_RECORDS)
    return { error: `records must be an array of 1 to ${MAX_CHECK_RECORDS}` }
  const records: CheckRecord[] = []
  for (const r of list) {
    const item = (r as { item?: unknown } | null)?.item
    const role = (r as { role_id?: unknown } | null)?.role_id
    if ((typeof item !== 'string' && typeof item !== 'number') || String(item).length === 0)
      return { error: 'every record needs an item id' }
    if (String(item).length > 64) return { error: 'item ids are at most 64 characters' }
    if (role != null && (typeof role !== 'string' || role.length > 64))
      return { error: 'role_id must be a role id' }
    records.push({ item: String(item), role_id: role ? String(role) : null })
  }
  const rawFields = b.fields == null ? [] : b.fields
  if (!Array.isArray(rawFields) || rawFields.length > MAX_CHECK_FIELDS)
    return { error: `fields must be an array of at most ${MAX_CHECK_FIELDS}` }
  const fields = [...new Set(rawFields.filter((f): f is string => typeof f === 'string'))]
  if (fields.some((f) => !FIELD_RE.test(f))) return { error: 'fields must be field names' }
  return { records, draft: parseDraftResolution(b.draft), fields }
}

const isRecordForm = (row: Record<string, unknown>) =>
  row.layout_type == null || row.layout_type === 'grouped'

const truthy = (v: unknown) => v === true || v === 1 || v === '1'

/**
 * The resolver's candidates as if `self` carried the draft's settings: the
 * stored candidates with this layout replaced (added when the draft makes it a
 * record form, dropped when it no longer is one), in /active's order
 * (is_active desc, sort asc, id asc). A draft that makes this layout the
 * default steps the previous default down, as activation does.
 */
export function draftCandidates(
  candidates: Record<string, unknown>[],
  self: Record<string, unknown>,
  draft: DraftResolution | null
): Record<string, unknown>[] {
  const id = Number(self.id)
  const others = candidates.filter((r) => Number(r.id) !== id)
  const mine: Record<string, unknown> = { ...self, ...(draft ?? {}) }
  const becomesDefault = truthy(mine.is_active) && !truthy(self.is_active)
  const rows: Record<string, unknown>[] = [
    ...others.map((r) => (becomesDefault && isRecordForm(mine) ? { ...r, is_active: false } : r)),
    ...(isRecordForm(mine) ? [mine] : [])
  ]
  return rows.sort(
    (a, b) =>
      Number(truthy(b.is_active)) - Number(truthy(a.is_active)) ||
      Number(a.sort ?? 0) - Number(b.sort ?? 0) ||
      Number(a.id) - Number(b.id)
  )
}

/** Every field a candidate's record rules read. */
export function ruleFields(rows: Record<string, unknown>[]): string[] {
  const out = new Set<string>()
  for (const row of rows)
    for (const rule of parseRecordConditions(row.record_conditions) ?? [])
      if (typeof rule.field === 'string' && FIELD_RE.test(rule.field)) out.add(rule.field)
  return [...out]
}

/** The columns one check reads: id, the rule fields and the asked fields that are real columns. */
export function checkColumns(wanted: string[], physical: string[]): string[] {
  const have = new Map(physical.map((c) => [c.toLowerCase(), c]))
  const out = new Set<string>()
  for (const w of ['id', ...wanted]) {
    const col = have.get(w.toLowerCase())
    if (col) out.add(col)
  }
  return [...out]
}

/**
 * Layout conditions as a non-admin is sent them: `testing` (pinned test
 * records, cost limit) and `ab` (an A/B test, #2614) are the editor's and
 * never leave for anyone else.
 */
export function shownConditions<T>(conditions: T, isAdmin: boolean): T {
  if (
    isAdmin ||
    !conditions ||
    typeof conditions !== 'object' ||
    !('testing' in conditions || 'ab' in conditions)
  )
    return conditions
  const { testing: _testing, ab: _ab, ...rest } = conditions as Record<string, unknown>
  return (Object.keys(rest).length > 0 ? rest : null) as T
}
