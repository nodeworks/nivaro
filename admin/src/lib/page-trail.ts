import { navCategories } from '@/layouts/nav-config'
import { hubForPath } from '@/lib/hubs'
import { titleCase } from '@/lib/utils'

/**
 * #3225 — what a path IS, for the breadcrumb trail. Pure: the trail component
 * turns a 'record' / 'collection' / 'queue' answer into a label read as the
 * viewer (labels endpoint, collection metadata, the queue itself); a 'static'
 * answer is already a label (nav map, hub tabs).
 */
export type PathKind =
  | { kind: 'record'; collection: string; id: string }
  | { kind: 'new-record'; collection: string }
  | { kind: 'collection'; collection: string }
  | { kind: 'queue'; id: string }
  | { kind: 'static'; label: string }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

const clean = (pathname: string) =>
  pathname.length > 1 ? pathname.split(/[?#]/)[0].replace(/\/+$/, '') : pathname.split(/[?#]/)[0]

const navItems = () => navCategories.flatMap((c) => c.items)

/** The nav entry whose path IS this pathname. */
function exactNavItem(pathname: string) {
  return navItems().find((i) => i.to === pathname) ?? null
}

/** The most specific nav entry this pathname sits UNDER (not equal to). */
function parentNavItem(pathname: string) {
  let best: { to: string; label: string } | null = null
  for (const i of navItems()) {
    if (i.to === '/' || pathname === i.to || !pathname.startsWith(`${i.to}/`)) continue
    if (!best || i.to.length > best.to.length) best = i
  }
  return best
}

export function describePath(path: string): PathKind {
  const p = clean(path) || '/'
  const rec = p.match(/^\/collections\/([^/]+)\/([^/]+)$/)
  if (rec && IDENT.test(decodeURIComponent(rec[1]))) {
    const collection = decodeURIComponent(rec[1])
    const id = decodeURIComponent(rec[2])
    if (id === 'new') return { kind: 'new-record', collection }
    if (id !== 'classic') return { kind: 'record', collection, id }
  }
  const col = p.match(/^\/collections\/([^/]+)(?:\/classic)?$/)
  if (col && IDENT.test(decodeURIComponent(col[1]))) {
    return { kind: 'collection', collection: decodeURIComponent(col[1]) }
  }
  const queue = p.match(/^\/queues\/([^/]+)$/)
  if (queue) return { kind: 'queue', id: decodeURIComponent(queue[1]) }
  const hub = hubForPath(p)
  if (hub) {
    const first = hub.hub.tabs[0] === hub.tab
    return { kind: 'static', label: first ? hub.hub.title : `${hub.hub.title} · ${hub.tab.label}` }
  }
  const exact = exactNavItem(p)
  if (exact) return { kind: 'static', label: exact.label }
  const parent = parentNavItem(p)
  const last = decodeURIComponent(p.split('/').filter(Boolean).pop() ?? '')
  if (parent) {
    if (last === 'new') return { kind: 'static', label: `New · ${parent.label}` }
    return {
      kind: 'static',
      label: /^\d+$/.test(last)
        ? `${parent.label} #${last}`
        : `${parent.label} · ${titleCase(last)}`
    }
  }
  if (p === '/profile') return { kind: 'static', label: 'My Profile' }
  return { kind: 'static', label: last ? titleCase(last) : 'Overview' }
}

/**
 * A page a trail starts from: a nav entry, a hub tab, a collection's list, a
 * queue's worklist, search. The trail stops after the first one walking back,
 * so it reads "Pending approvals › PO 4471 › Line 3", not the whole session.
 */
export function isTrailRoot(path: string): boolean {
  const p = clean(path) || '/'
  if (exactNavItem(p) || hubForPath(p)) return true
  if (/^\/collections\/[^/]+(?:\/classic)?$/.test(p)) return true
  if (/^\/queues\/[^/]+$/.test(p)) return true
  return p === '/search'
}

export interface StructuralCrumb {
  to: string
  kind: PathKind
}

/**
 * The fixed hierarchy above a page, for a cold load (no trail in this tab):
 * Collections › <collection> for a record, Queues for a worklist, the hub for
 * a non-first hub tab, the nav entry a detail page sits under.
 */
export function structuralCrumbs(path: string): StructuralCrumb[] {
  const p = clean(path) || '/'
  const kind = describePath(p)
  const collections: StructuralCrumb = {
    to: '/collections',
    kind: { kind: 'static', label: 'Collections' }
  }
  if (kind.kind === 'record' || kind.kind === 'new-record') {
    return [
      collections,
      {
        to: `/collections/${encodeURIComponent(kind.collection)}`,
        kind: { kind: 'collection', collection: kind.collection }
      }
    ]
  }
  if (kind.kind === 'collection') return [collections]
  if (kind.kind === 'queue') return [{ to: '/queues', kind: { kind: 'static', label: 'Queues' } }]
  const hub = hubForPath(p)
  if (hub) {
    return hub.hub.tabs[0] === hub.tab
      ? []
      : [{ to: hub.hub.base, kind: { kind: 'static', label: hub.hub.title } }]
  }
  if (exactNavItem(p)) return []
  const parent = parentNavItem(p)
  return parent ? [{ to: parent.to, kind: { kind: 'static', label: parent.label } }] : []
}
