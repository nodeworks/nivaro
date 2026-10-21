import type { OverviewReference } from './layout-overview.js'

/**
 * What relies on a layout (#2613), for the dependency diagram shown before a
 * layout is renamed, retyped or deleted.
 *
 * Stored references come from layout-references.ts (other layouts, queues,
 * grids, share links, submission forms, generated files, drill-downs, pages).
 * Extension CODE cannot be read for layout names at runtime, so extensions
 * declare what they open: `ctx.layouts?.dependsOn({ collection, slug | layout_id,
 * label })` in register(). An extension that declares nothing is reported as
 * "not checked", never as "uses nothing".
 */

export type LayoutChange = 'slug' | 'type' | 'delete'

export interface ExtensionLayoutDependency {
  extension: string
  collection: string
  slug: string | null
  layout_id: number | null
  label: string
}

const declared: ExtensionLayoutDependency[] = []
const declaring = new Set<string>()

/** ctx.layouts.dependsOn — validated; a malformed declaration throws (the loader logs it). */
export function registerLayoutDependency(
  extId: string,
  dep: { collection?: unknown; slug?: unknown; layout_id?: unknown; label?: unknown }
): ExtensionLayoutDependency {
  const collection = typeof dep?.collection === 'string' ? dep.collection.trim() : ''
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection)) throw new Error('collection is required')
  const slug = typeof dep.slug === 'string' && dep.slug.trim() ? dep.slug.trim() : null
  const id = dep.layout_id == null ? null : Number(dep.layout_id)
  const layoutId = id != null && Number.isInteger(id) && id > 0 ? id : null
  if (!slug && layoutId == null) throw new Error('slug or layout_id is required')
  const label =
    typeof dep.label === 'string' && dep.label.trim() ? dep.label.trim().slice(0, 200) : extId
  const row = { extension: extId, collection, slug, layout_id: layoutId, label }
  // A reload registers again: the same declaration is kept once.
  const same = declared.find(
    (d) =>
      d.extension === extId &&
      d.collection === collection &&
      d.slug === slug &&
      d.layout_id === layoutId &&
      d.label === label
  )
  if (same) return same
  declared.push(row)
  declaring.add(extId)
  return row
}

/** Drop an extension's declarations (unload / reload). */
export function forgetLayoutDependencies(extId: string): void {
  for (let i = declared.length - 1; i >= 0; i--)
    if (declared[i].extension === extId) declared.splice(i, 1)
  declaring.delete(extId)
}

/** Declarations naming this layout (by id, or by its link name in its collection). */
export function extensionDependenciesOf(layout: {
  id: number
  collection: string
  slug: string | null
}): ExtensionLayoutDependency[] {
  const slug = layout.slug?.trim().toLowerCase() ?? ''
  return declared.filter(
    (d) =>
      d.collection === layout.collection &&
      (d.layout_id === layout.id || (!!slug && d.slug?.toLowerCase() === slug))
  )
}

/** Extensions that declared anything at all (so "none here" means something for them). */
export function declaringExtensions(): string[] {
  return [...declaring]
}

/** Which changes break a reference of this kind, and how it finds the layout. */
export function referenceImpact(kind: string): {
  by: 'id' | 'slug' | 'id or slug'
  breaks: LayoutChange[]
} {
  switch (kind) {
    case 'queue':
      return { by: 'slug', breaks: ['slug', 'type', 'delete'] }
    case 'grid':
      return { by: 'id or slug', breaks: ['slug', 'type', 'delete'] }
    case 'generated_files':
      return { by: 'id', breaks: ['delete'] }
    case 'extended_by':
      return { by: 'id', breaks: ['type', 'delete'] }
    default:
      // addendum_form_of, addendums, share_links, submission_form, queue_drilldown,
      // drilldown, pdf_button, page: they open the layout by id and expect its kind.
      return { by: 'id', breaks: ['type', 'delete'] }
  }
}

/** Diagram lanes, in reading order. */
export const DEPENDENCY_GROUPS: Array<{ id: string; label: string; kinds: string[] }> = [
  {
    id: 'layouts',
    label: 'Other layouts',
    kinds: ['addendum_form_of', 'extended_by', 'addendums']
  },
  { id: 'queues', label: 'Queues', kinds: ['queue', 'queue_drilldown'] },
  { id: 'grids', label: 'Grids & drill-downs', kinds: ['grid', 'drilldown', 'pdf_button', 'page'] },
  { id: 'public', label: 'Share links & public forms', kinds: ['share_links', 'submission_form'] },
  { id: 'files', label: 'Generated files', kinds: ['generated_files'] },
  { id: 'extensions', label: 'Extension code', kinds: ['extension'] }
]

export interface DependencyNode {
  kind: string
  group: string
  id: string | number
  label: string
  by: 'id' | 'slug' | 'id or slug'
  breaks: LayoutChange[]
}

export function dependencyNodes(
  refs: OverviewReference[],
  extensionDeps: ExtensionLayoutDependency[]
): DependencyNode[] {
  const groupOf = (kind: string) =>
    DEPENDENCY_GROUPS.find((g) => g.kinds.includes(kind))?.id ?? 'grids'
  const nodes: DependencyNode[] = refs.map((r) => ({
    kind: r.kind,
    group: groupOf(r.kind),
    id: r.id,
    label: r.label,
    ...referenceImpact(r.kind)
  }))
  for (const d of extensionDeps)
    nodes.push({
      kind: 'extension',
      group: 'extensions',
      id: `${d.extension}:${d.label}`,
      label: `${d.label} (${d.extension})`,
      by: d.layout_id != null ? 'id' : 'slug',
      breaks: d.layout_id != null ? ['type', 'delete'] : ['slug', 'type', 'delete']
    })
  return nodes
}
