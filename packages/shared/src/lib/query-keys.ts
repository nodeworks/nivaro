/**
 * Shared query keys: one key = one shape.
 *
 * Every screen in an app shares ONE TanStack QueryClient, and the shared components here run
 * inside admin and every portal. Two readers that put different shapes under the same key
 * crash whichever reads second — prod 2026-11-13 "nn.find is not a function": the lines grid
 * cached the relations ARRAY under ['collection-meta', c] while the list view cached the whole
 * meta OBJECT there; whichever filled the cache first decided what the other got.
 *
 * Rules:
 *  - A key listed in QUERY_KEY_SPECS stores exactly the shape it declares, for every reader in
 *    every app. Need a narrower view? Keep the key and the fetch, and narrow with `select`
 *    (it runs per observer and never touches the cache). Need different data? Use another key.
 *  - Prefer the builders (`queryKeys.collectionMeta(c)`) and, in shared code, the fetchers
 *    (`fetchCollectionMeta(client, c)`): the builder's key is typed with its shape, so
 *    getQueryData / setQueryData on it are checked by TypeScript.
 *  - `query-keys.guard.test.ts` scans packages/shared, packages/react and admin and fails when
 *    any literal key is read with two shapes, or a key below is read with a shape it does not
 *    declare. `pnpm query-keys [--all] [dir…]` prints the readable report (pass another app's
 *    src, e.g. ../efp-new/src, to check it against the shared library too).
 *
 * Keys built in a variable, spread keys and queryFns the scanner cannot read are not checked —
 * see the limits in query-key-scan.ts.
 */

import type { NivaroClient } from '@nivaro/sdk'
import type { DataTag } from '@tanstack/react-query'
import type { CMSField, CMSRelation } from '../components/item-edit/types'
import { get } from './commands'

/** What GET /collections/:c answers under `data`: the whole collection meta. */
export interface CollectionMetaShape {
  collection: string
  fields?: CMSField[]
  relations?: CMSRelation[]
  display_template?: string | null
  [key: string]: unknown
}

export interface QueryKeySpec {
  /** The literal first key element. */
  root: string
  /**
   * Shape signatures every reader must produce (see query-key-scan.ts): `<METHOD> <path>
   * <body path>`. Path parameters are `:p`; `.` is the whole response body.
   */
  shapes: string[]
  /** Key length this spec covers; omitted = every length. */
  length?: number
  /** What the entry holds, in words. */
  what: string
}

const META = 'GET /collections/:p .data'

/** The shared keys and the one shape each stores. */
export const QUERY_KEY_SPECS: QueryKeySpec[] = [
  { root: 'collection-meta', shapes: [META], what: "A collection's whole meta object" },
  { root: 'cbv-collection-meta', shapes: [META], what: "A collection's whole meta object" },
  { root: 'col-meta', shapes: [META], what: "A collection's whole meta object" },
  { root: 'collection-meta-alias', shapes: [META], what: "A collection's whole meta object" },
  { root: 'collection-meta-cr', shapes: [META], what: "A collection's whole meta object" },
  {
    root: 'collection-display-meta',
    shapes: [META],
    what: "A collection's whole meta object (readers select display_template)"
  },
  {
    root: 'collection-relations',
    shapes: ['GET /collections/:p .data.relations'],
    what: "A collection's relations ARRAY (never the meta object)"
  },
  {
    root: 'collection-fields',
    length: 2,
    shapes: ['GET /collections/:p .data.fields →filter'],
    what: "A collection's visible (non-hidden) fields ARRAY"
  },
  {
    root: 'collection-fields',
    length: 3,
    shapes: ['GET /field-config/:p .data'],
    what: "A collection's field-config rows for one layout"
  },
  {
    root: 'field-config',
    shapes: ['GET /field-config/:p .data'],
    what: "A collection's field-config rows ARRAY (unfiltered)"
  },
  {
    root: 'field-config-all',
    shapes: ['GET /field-config/:p .data'],
    what: "A collection's field-config rows ARRAY (unfiltered)"
  },
  {
    root: 'collections',
    length: 1,
    shapes: ['GET /collections .data'],
    what: 'The collection list ARRAY (rows as the API sends them)'
  },
  {
    root: 'collections-list',
    shapes: ['GET /collections .data'],
    what: 'The collection list ARRAY (rows as the API sends them)'
  },
  {
    root: 'collection-layouts',
    length: 2,
    shapes: ['GET /collection-layouts .data'],
    what: "A collection's layouts ARRAY (unfiltered)"
  },
  {
    root: 'active-layout',
    shapes: ['GET /collection-layouts/active .data'],
    what: 'The layout a record resolves to'
  },
  {
    root: 'relations',
    shapes: ['GET /data-model/relations/for/:p .data'],
    what: 'Relations touching a collection'
  },
  {
    root: 'relations-for',
    shapes: ['GET /data-model/relations/for/:p .data'],
    what: 'Relations touching a collection'
  },
  { root: 'field-rules', shapes: ['GET /field-rules .data'], what: "A collection's field rules" },
  { root: 'workspaces', shapes: ['GET /workspaces .data'], what: 'The workspace list ARRAY' },
  {
    root: 'settings',
    length: 1,
    shapes: ['GET /settings .data'],
    what: 'The settings singleton'
  }
]

/** A shared key, tagged with the shape it stores (typed getQueryData / setQueryData). */
export type SharedQueryKey<R extends string, T> = DataTag<readonly [R, ...unknown[]], T>

type Collection = string | null | undefined

function tagged<R extends string, T>(root: R, ...rest: unknown[]): SharedQueryKey<R, T> {
  return [root, ...rest] as unknown as SharedQueryKey<R, T>
}

export interface QueryKeyBuilders {
  collectionMeta(collection: Collection): SharedQueryKey<'collection-meta', CollectionMetaShape>
  collectionRelations(collection: Collection): SharedQueryKey<'collection-relations', CMSRelation[]>
  collectionDisplayMeta(
    collection: Collection
  ): SharedQueryKey<'collection-display-meta', CollectionMetaShape>
  /** ['field-config', c] — or ['field-config', c, layoutId] when a layout is passed (null too). */
  fieldConfig(
    collection: Collection,
    ...layout: [layoutId?: string | number | null]
  ): SharedQueryKey<'field-config', CMSField[]>
  collections(): SharedQueryKey<'collections', Array<Record<string, unknown>>>
}

/**
 * Key builders for the shared keys. Prefix invalidation still works with the plain root:
 * `invalidateQueries({ queryKey: ['collection-meta'] })`.
 */
export const queryKeys: QueryKeyBuilders = {
  collectionMeta: (collection) => tagged('collection-meta', collection),
  collectionRelations: (collection) => tagged('collection-relations', collection),
  collectionDisplayMeta: (collection) => tagged('collection-display-meta', collection),
  fieldConfig: (collection, ...layout) => tagged('field-config', collection, ...layout),
  collections: () => tagged('collections')
}

/** Builder name → root, for the scanner (keep in step with `queryKeys`). */
export const QUERY_KEY_BUILDERS: Record<string, string> = {
  collectionMeta: 'collection-meta',
  collectionRelations: 'collection-relations',
  collectionDisplayMeta: 'collection-display-meta',
  fieldConfig: 'field-config',
  collections: 'collections'
}

/**
 * Literal key elements a wildcard beside them can never equal, so the guard does not compare
 * them (a reason is required for each).
 */
export const QUERY_KEY_DISJOINT: Array<{ root: string; literal: string; why: string }> = [
  {
    root: 'erp-submissions',
    literal: 'detail',
    why: "['erp-submissions', 'detail', id] sits beside ['erp-submissions', collection, item] so retry invalidations reach it; no collection is called 'detail'"
  },
  {
    root: 'flows',
    literal: 'post-run-picker',
    why: "['flows', 'post-run-picker'] (the flow list) beside ['flows', id]: a flow id is never 'post-run-picker'"
  }
]

/** Identifiers whose `.get(…)` returns an axios RESPONSE (admin's `api`, the editor api). */
export const QUERY_RESPONSE_CLIENTS = ['api', 'axios']

/** GET /collections/:c → the whole meta object. The one fetch for every meta key above. */
export function fetchCollectionMeta(
  client: Pick<NivaroClient, 'request'>,
  collection: string
): Promise<CollectionMetaShape> {
  return client
    .request<{ data: CollectionMetaShape }>(get(`/collections/${collection}`))
    .then((r) => r.data)
}

/** GET /collections/:c → its relations ARRAY (anything else, or no collection, reads as none). */
export function fetchCollectionRelations(
  client: Pick<NivaroClient, 'request'>,
  collection: string | null | undefined
): Promise<CMSRelation[]> {
  if (!collection) return Promise.resolve([])
  return client
    .request<{ data: { relations?: unknown } | null }>(get(`/collections/${collection}`))
    .then((r) => {
      const rel = r.data?.relations
      return Array.isArray(rel) ? (rel as CMSRelation[]) : []
    })
}
