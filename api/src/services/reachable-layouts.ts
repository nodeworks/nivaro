import { db } from '../db/index.js'

/**
 * The grouped layouts a record can actually OPEN as its form: the active one,
 * plus slugged variants (Unit / Non-Unit / Sparing orders, the CAR PUB form).
 * Inactive slugless layouts are unreachable (nothing resolves them) and
 * create_hidden ones are special-purpose sub-forms (the warehouse-submission
 * line-entry layout). A form-entry rule (required / validation) binds a record
 * only when EVERY one of these shows it — with several of them we cannot know
 * which one a host renders for a given record.
 *
 * Config conformance and dashboard readiness share this rule; the bulk sweep's
 * SQL copy in config-conformance must stay in step with it.
 */
export interface GroupedLayoutRow {
  id: number
  name: string
  is_active: unknown
  slug: string | null
  create_hidden: unknown
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

export function isReachableGroupedLayout(l: GroupedLayoutRow): boolean {
  return truthy(l.is_active) || (!!l.slug && !truthy(l.create_hidden))
}

/** The reachable grouped layouts of a collection. A failed read throws. */
export async function reachableGroupedLayouts(collection: string): Promise<GroupedLayoutRow[]> {
  const rows = (await db('nivaro_collection_layouts')
    .where({ collection, layout_type: 'grouped' })
    .select('id', 'name', 'is_active', 'slug', 'create_hidden')) as GroupedLayoutRow[]
  return rows.filter(isReachableGroupedLayout)
}
