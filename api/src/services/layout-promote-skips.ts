import { db } from '../db/index.js'
import type { LayoutBundle } from './layout-ops.js'
import { LAYOUT_PATCH_KEYS } from './layout-ops-apply.js'
import { type LayoutPatchBody, normalizeLayoutPatch } from './layout-patch.js'
import { PROMOTE_KEPT_KEYS, PROMOTE_REFERENCE_KEYS, sameValue } from './layout-promote.js'

/**
 * #2593 — which of the other copy's layout settings cannot be carried here:
 * references to rows this environment does not have, a name or link name
 * another layout here already uses, and values this instance's settings
 * rules refuse. Each comes back with the sentence the comparison shows.
 */
export async function promotionSkips(mine: LayoutBundle, theirs: LayoutBundle) {
  const skip: Record<string, string> = {}
  const collection = String(mine.layout.collection)
  const tables: Record<string, [string, string]> = {
    parent_layout_id: ['nivaro_collection_layouts', 'layout'],
    addendum_layout_id: ['nivaro_collection_layouts', 'layout'],
    pdf_template_id: ['nivaro_pdf_templates', 'PDF template'],
    workflow_template_id: ['nivaro_workflow_templates', 'workflow']
  }
  for (const key of PROMOTE_REFERENCE_KEYS) {
    const to = theirs.layout[key]
    if (to == null || to === '' || sameValue(to, mine.layout[key])) continue
    const [table, noun] = tables[key]
    const row = await db(table)
      .where({ id: to as string | number })
      .first('id')
      .catch(() => undefined)
    if (!row) skip[key] = `Not carried: it names ${noun} #${String(to)}, which is not here`
  }
  const others = (await db('nivaro_collection_layouts')
    .where({ collection })
    .whereNot({ id: Number(mine.layout.id) })
    .select('name', 'slug')) as Array<{ name: string | null; slug: string | null }>
  const lc = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
  for (const col of ['name', 'slug'] as const) {
    const to = theirs.layout[col]
    if (!lc(to) || lc(to) === lc(mine.layout[col])) continue
    if (others.some((o) => lc(o[col]) === lc(to)))
      skip[col] = `Not carried: another layout here already uses “${String(to)}”`
  }
  // Values this instance's settings rules refuse (a legacy page size, a
  // malformed rule list) are listed instead of failing the whole apply.
  for (const key of LAYOUT_PATCH_KEYS) {
    if (skip[key] || (PROMOTE_KEPT_KEYS as readonly string[]).includes(key)) continue
    if (!(key in theirs.layout) || sameValue(theirs.layout[key], mine.layout[key])) continue
    if (key === 'name' || key === 'slug') continue
    const res = await normalizeLayoutPatch(
      db,
      Number(mine.layout.id),
      { slug: (mine.layout.slug as string | null) ?? null, collection },
      { [key]: theirs.layout[key] } as LayoutPatchBody
    ).catch((err: unknown) => ({ error: err instanceof Error ? err.message : 'refused' }))
    if (res.error !== undefined) skip[key] = `Not carried: ${res.error}`
  }
  return skip
}
