import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { getLabels, resolvePathValues } from './queues.js'

/**
 * The "record card" every detailed email opens with: the record's title
 * (display template), a link, and the fields the collection's ACTIVE grouped
 * layout pins in its item-header strip — the same strip the form shows, so
 * the card follows the layout instead of a per-collection field list baked
 * into code. Values resolve like the form does: M2O / M2M / dotted paths to
 * display labels, currency-formatted where the layout says so.
 *
 * Best-effort throughout — an email must never fail because a card could not
 * be built; a missing layout yields the title + link alone.
 */

export interface RecordCardField {
  key: string
  label: string
  value: string
}

export interface RecordCard {
  collection: string
  collection_label: string
  item: string
  title: string
  url: string
  fields: RecordCardField[]
}

const titleCase = (s: string) =>
  s
    .replace(/[_.]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()

const SENTINEL = /^__/
const DATE_ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/

function formatValue(raw: string, format?: string | null): string {
  if (raw === '' || raw == null) return '—'
  if (format === 'currency') {
    const n = Number(String(raw).replace(/[^\d.-]/g, ''))
    if (Number.isFinite(n)) return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  }
  if (raw === 'true' || raw === '1') return 'Yes'
  if (raw === 'false' || raw === '0') return format === 'boolean' ? 'No' : raw
  if (DATE_ISO.test(raw)) {
    const d = new Date(raw.length === 10 ? `${raw}T00:00:00` : raw)
    if (!Number.isNaN(d.getTime()))
      return raw.length === 10
        ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : d.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          })
  }
  return raw
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

/** Header-strip assignments of the active grouped layout (sentinels dropped). */
async function headerAssignments(
  collection: string
): Promise<Array<{ field: string; label: string | null; format: string | null }>> {
  const layout = (await db('nivaro_collection_layouts')
    .where({ collection, layout_type: 'grouped', is_active: true })
    .orderBy('sort')
    .first('id')) as { id: number } | undefined
  if (!layout) return []
  const rows = (await db('nivaro_layout_field_assignments')
    .where({ layout_id: layout.id, group_key: '__header__' })
    .orderBy('sort')
    .select('field', 'label_override', 'overrides', 'is_visible')) as Array<{
    field: string
    label_override: string | null
    overrides: string | null
    is_visible: boolean | number | null
  }>
  return rows
    .filter((r) => !SENTINEL.test(r.field) && r.is_visible !== false && r.is_visible !== 0)
    .map((r) => {
      const ov = parseJson<{ label?: string; options?: { format?: string } }>(r.overrides)
      return {
        field: r.field,
        label: r.label_override ?? ov?.label ?? null,
        format: ov?.options?.format ?? null
      }
    })
}

export async function buildRecordCard(
  collection: string,
  item: string | number
): Promise<RecordCard> {
  const itemId = String(item)
  const base = adminBaseUrl() ?? ''
  const url = `${base}/collections/${collection}/${encodeURIComponent(itemId)}`
  const meta = (await db('nivaro_collections')
    .where({ collection })
    .first('singular', 'display_name')
    .catch(() => undefined)) as { singular: string | null; display_name: string | null } | undefined
  const collectionLabel = meta?.singular || meta?.display_name || titleCase(collection)

  let title = itemId
  try {
    const labels = await getLabels(new Map([[collection, new Set([itemId])]]))
    title = labels[`${collection}:${itemId}`] || itemId
  } catch {
    /* title stays the id */
  }

  const fields: RecordCardField[] = []
  try {
    const assignments = await headerAssignments(collection)
    if (assignments.length > 0) {
      const fieldMeta = (await db('nivaro_fields')
        .where({ collection })
        .whereIn(
          'field',
          assignments.map((a) => a.field.split('.')[0])
        )
        .select('field', 'label', 'options', 'type')) as Array<{
        field: string
        label: string | null
        options: string | null
        type: string | null
      }>
      const metaByField = new Map(fieldMeta.map((f) => [f.field, f]))
      const relationsCache = new Map()
      for (const a of assignments) {
        const segments = a.field.split('.')
        let value = ''
        try {
          const resolved = await resolvePathValues(collection, [itemId], segments, relationsCache)
          value = resolved.get(itemId)?.value ?? ''
        } catch {
          value = ''
        }
        const fm = metaByField.get(segments[0])
        const fmOptions = parseJson<{ format?: string }>(fm?.options)
        const format = a.format ?? fmOptions?.format ?? (fm?.type === 'boolean' ? 'boolean' : null)
        fields.push({
          key: a.field,
          label: a.label ?? (segments.length === 1 ? fm?.label : null) ?? titleCase(a.field),
          value: formatValue(value, format)
        })
      }
    }
  } catch {
    /* card renders without fields */
  }

  return { collection, collection_label: collectionLabel, item: itemId, title, url, fields }
}
