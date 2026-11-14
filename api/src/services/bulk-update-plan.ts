/**
 * What a bulk "Update field" would do, record by record, read AS the person
 * (2026-11-13): the preview the bar shows before Apply ("Changes 12 records ·
 * 3 already have it") and, for to-many fields, which records the write can
 * skip. Two batched reads at most per field kind — the records' own values
 * (one list read, chunked) and each to-many field's current links (one
 * junction read, chunked; services/bulk-m2m.ts) — never one read per record.
 *
 * Edit locks are not judged here (a lock is held for seconds and is checked
 * again on every record as it is written).
 */
import type { User } from '../types.js'
import { aliasLinkIdKey } from './alias-links.js'
import { currentLinks, type ListReader, type M2MFieldInfo, m2mIntent, planM2M } from './bulk-m2m.js'
import { selectInChunks } from './db-batch.js'
import { valueUnchanged } from './value-unchanged.js'

export interface BulkUpdatePreview {
  /** Records the write would change. */
  would_update: number
  /** Readable records that already hold the value (left as they are). */
  skipped: number
  /** Records a form lock or field rule refuses. */
  refused: number
  refused_reason: string | null
  /** Selected records the person cannot read (they fail the write the usual way). */
  unreadable: number
  /** To-many fields: links the write would add and remove across the changing records. */
  links_added?: number
  links_removed?: number
  /** The person cannot read a junction, so link counts and skips are unknown. */
  links_unknown?: boolean
}

export interface BulkUpdatePlan {
  preview: BulkUpdatePreview
  /** Lower-cased ids of readable records with nothing to change (known only). */
  unchanged: Set<string>
  /** Per to-many field: lower-cased record id → its planned adds/removes. */
  links: Map<string, Map<string, { adds: unknown[]; removes: unknown[] }>>
}

export async function bulkUpdatePlan(opts: {
  user: User
  collection: string
  ids: Array<string | number>
  data: Record<string, unknown>
  m2m: Map<string, M2MFieldInfo>
  refusals: Map<string, string>
  read: ListReader
  workspaceId?: string
}): Promise<BulkUpdatePlan> {
  const { user, collection, ids, data, m2m, refusals, read, workspaceId } = opts
  const fields = Object.keys(data).filter((k) => !k.startsWith('_'))
  const scalars = fields.filter((f) => !m2m.has(f))

  const rows = await selectInChunks(ids, 1000, async (chunk) => {
    const res = (await read(
      user,
      collection,
      {
        fields: ['id', ...scalars],
        filter: { id: { _in: chunk } },
        limit: chunk.length,
        count: false
      },
      undefined,
      workspaceId
    )) as { data?: Array<Record<string, unknown>> }
    return res.data ?? []
  })
  const byId = new Map(rows.map((r) => [aliasLinkIdKey(r.id), r]))
  const readableIds = ids.filter((id) => byId.has(aliasLinkIdKey(id)))

  let linksUnknown = false
  const links = new Map<string, Map<string, { adds: unknown[]; removes: unknown[] }>>()
  for (const [field, info] of m2m) {
    const intent = m2mIntent(data[field])
    if (!intent) continue
    try {
      const current = await currentLinks(user, info, readableIds, read, workspaceId)
      links.set(field, planM2M(intent.mode, intent.ids, readableIds, current).rows)
    } catch {
      linksUnknown = true
    }
  }

  const unchanged = new Set<string>()
  const preview: BulkUpdatePreview = {
    would_update: 0,
    skipped: 0,
    refused: 0,
    refused_reason: null,
    unreadable: 0
  }
  let added = 0
  let removed = 0
  for (const id of ids) {
    const k = aliasLinkIdKey(id)
    const refusal = refusals.get(k) ?? refusals.get(String(id).toLowerCase())
    if (refusal) {
      preview.refused++
      preview.refused_reason = preview.refused_reason ?? refusal
      continue
    }
    const row = byId.get(k)
    if (!row) {
      preview.unreadable++
      continue
    }
    const scalarSame = scalars.every((f) => valueUnchanged(row[f], data[f]))
    const linkPlans = [...links.values()].map((m) => m.get(k))
    const linksSame =
      !linksUnknown && linkPlans.every((p) => !p || (p.adds.length === 0 && p.removes.length === 0))
    if (scalarSame && linksSame && fields.length > 0) {
      unchanged.add(k)
      preview.skipped++
      continue
    }
    preview.would_update++
    for (const p of linkPlans) {
      added += p?.adds.length ?? 0
      removed += p?.removes.length ?? 0
    }
  }
  if (m2m.size > 0) {
    preview.links_added = added
    preview.links_removed = removed
    if (linksUnknown) preview.links_unknown = true
  }
  return { preview, unchanged, links }
}
