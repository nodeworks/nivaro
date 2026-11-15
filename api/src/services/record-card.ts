import type { User } from '../types.js'

/**
 * Hover cards on record links (rt3 #16): the linked record's CURRENT state in one small read —
 * its name, pipeline step, current owners, SLA and a few key amounts — read AS THE VIEWER.
 * `readOne` judges the record (role policy, row filters, User Scopes); a record they cannot
 * read answers null and the route says 404, so a card never confirms a hidden record exists.
 * Amounts come only from fields the record read returned (the viewer's field list).
 */

export interface RecordCardAmount {
  field: string
  label: string
  value: number
  /** Money-named field: the client shows it as currency. */
  money: boolean
}

export interface RecordCard {
  collection: string
  collection_label: string
  id: string
  title: string
  state: { key: string; label: string; color: string | null } | null
  sla: 'ok' | 'warning' | 'breached' | null
  owners: Array<{ id: string; name: string; inactive?: 'suspended' | 'former' }>
  amounts: RecordCardAmount[]
  /** ISO time the record last changed, when the row carries one. */
  updated_at: string | null
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const NUMERIC = new Set(['integer', 'biginteger', 'bigInteger', 'float', 'decimal', 'double'])
const MONEY = /(^|_)(total|amount|price|cost|subtotal|spend|budget|value)s?($|_)/i
const SKIP = /^(id|sort|sequence|order|year|.*_id|.*_count|lat|lng|lon|latitude|longitude)$/i
export const CARD_AMOUNTS_MAX = 3

/** Top-level field names a display template reads (`{{amount}}`, `{{project.name}}` → project). */
export function templateFieldNames(template: string | null | undefined): string[] {
  if (!template) return []
  const out: string[] = []
  for (const m of template.matchAll(/\{\{\s*([A-Za-z_][\w]*)/g))
    if (!out.includes(m[1])) out.push(m[1])
  return out
}

/**
 * Which numeric fields a card shows: the ones the display template names first, then
 * money-named ones; only fields present in the (viewer-projected) row with a number in them.
 */
export function pickCardAmounts(
  row: Record<string, unknown>,
  fields: Array<{
    field: string
    type?: string | null
    hidden?: boolean | null
    label?: string | null
  }>,
  template: string | null | undefined
): RecordCardAmount[] {
  const inTemplate = new Set(templateFieldNames(template))
  const candidates = fields.filter(
    (f) =>
      NUMERIC.has(String(f.type ?? '')) &&
      !f.hidden &&
      !SKIP.test(f.field) &&
      f.field in row &&
      row[f.field] != null &&
      row[f.field] !== '' &&
      Number.isFinite(Number(row[f.field])) &&
      (inTemplate.has(f.field) || MONEY.test(f.field))
  )
  candidates.sort(
    (a, z) =>
      Number(inTemplate.has(z.field)) - Number(inTemplate.has(a.field)) ||
      Number(MONEY.test(z.field)) - Number(MONEY.test(a.field))
  )
  return candidates.slice(0, CARD_AMOUNTS_MAX).map((f) => ({
    field: f.field,
    label:
      f.label?.trim() ||
      f.field
        .replace(/_/g, ' ')
        .trim()
        .replace(/^\w/, (c) => c.toUpperCase()),
    value: Number(row[f.field]),
    money: MONEY.test(f.field)
  }))
}

export interface CardDecorations {
  state: RecordCard['state']
  sla: RecordCard['sla']
  owners: RecordCard['owners']
}

/**
 * Step, SLA and owners exactly as the record page shows them to anyone who may open the
 * record (security review 2026-11-14). None of the three is a field read: the record page
 * gates the pipeline read (`GET /pipelines/instance/:c/:id`, recordReadGate), the SLA read
 * (`GET /sla/status/:c/:id`, canSeeRecord) and the header Owners tile
 * (`POST /pipelines/instance/:c/owners/batch`, readable ids) on record visibility alone, and
 * the caller of this has already judged the record with readOne. So the card takes the SAME
 * sources — never a looser or a different one:
 * - state: the instance the pipeline panel shows (findRecordInstance: open first, never a
 *   parallel branch child) and its current step;
 * - owners: `resolvedOwnerNames`, the function behind the header Owners tile (addendum in
 *   flight → its owners, redacted people "Former user", inactive people marked);
 * - SLA: the same status computation the SLA chip reads.
 * A failed decoration is left out (null / empty), never guessed.
 */
export async function cardDecorations(collection: string, id: string): Promise<CardDecorations> {
  const out: CardDecorations = { state: null, sla: null, owners: [] }
  try {
    const { findRecordInstance } = await import('./branch-instances.js')
    const inst = (await findRecordInstance(collection, id)) as
      | { current_state?: string | null }
      | undefined
    if (inst?.current_state) {
      const { db } = await import('../db/index.js')
      const st = (await db('nivaro_workflow_states')
        .where({ id: inst.current_state })
        .first('key', 'label', 'color')) as
        | { key: string; label: string; color: string | null }
        | undefined
      if (st) out.state = { key: st.key, label: st.label, color: st.color ?? null }
    }
  } catch {
    /* no step shown */
  }
  try {
    const { resolvedOwnerNames } = await import('../routes/pipelines.js')
    out.owners = ((await resolvedOwnerNames(collection, [id]))[id] ?? []).slice(0, 5).map((o) => ({
      id: String(o.id),
      name: String(o.name ?? '') || 'Someone',
      ...(o.inactive ? { inactive: o.inactive } : {})
    }))
  } catch {
    /* no owners shown */
  }
  try {
    const { computeStatusBatch } = await import('../routes/sla.js')
    const s = (await computeStatusBatch(collection, [id]))[id]?.status
    out.sla = s === 'breached' ? 'breached' : s === 'warning' ? 'warning' : s ? 'ok' : null
  } catch {
    /* no SLA shown */
  }
  return out
}

export async function recordCard(
  user: User,
  collection: string,
  id: string,
  workspaceId?: string
): Promise<RecordCard | null> {
  if (!NAME.test(collection) || /^(nivaro_|directus_)/i.test(collection)) return null
  const { readOne } = await import('./items.js')
  let row: Record<string, unknown> | null = null
  try {
    row = (await readOne(user, collection, id, workspaceId)) as Record<string, unknown> | null
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
    if (status === 400 || status === 403 || status === 404) return null
    throw err
  }
  if (!row) return null
  const rid = String(row.id ?? id)
  const { getCollection, getFields } = await import('./collections.js')
  const [meta, fields] = await Promise.all([
    getCollection(collection).catch(() => undefined),
    getFields(collection).catch(() => [])
  ])
  const { readableName } = await import('./command-center/regions.js')
  const collectionLabel = readableName(collection, meta?.singular ?? meta?.display_name)
  // The name as the viewer reads it (links in the template named through their own access).
  let title = ''
  try {
    const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
    const labels = await recordLabelsAsViewer(user, [{ collection, id: rid }])
    title = labels[`${collection}:${rid}`] ?? ''
  } catch {
    /* fall back below */
  }
  if (!title) {
    const { resolveDisplayValue } = await import('./display-value.js')
    title = resolveDisplayValue(row, meta?.display_template ?? null) || `${collectionLabel} ${rid}`
  }
  const deco = await cardDecorations(collection, rid)
  const updated = row.date_updated ?? row.updated_at ?? row.date_created ?? row.created_at ?? null
  const updatedIso =
    updated && Number.isFinite(new Date(String(updated)).getTime())
      ? new Date(String(updated)).toISOString()
      : null
  return {
    collection,
    collection_label: collectionLabel,
    id: rid,
    title,
    state: deco.state,
    sla: deco.sla,
    owners: deco.owners,
    amounts: pickCardAmounts(
      row,
      fields as Array<{
        field: string
        type?: string | null
        hidden?: boolean | null
        label?: string | null
      }>,
      meta?.display_template ?? null
    ),
    updated_at: updatedIso
  }
}
