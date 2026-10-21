import { onConfigStamp } from '../db/config-epoch.js'
import { emitToTenant, keyedThrottle } from './record-events.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Config changes reach open forms (#1740).
 *
 * A layout, field, field rule or pipeline edit tells every open page of the tenant that its
 * form definition moved: `config:update { surface, collection?, at }` — names only. An open
 * record form on that collection (or on any, when the edit names none) says "This form was
 * changed, reload to see the new version"; what the person typed is kept by the draft store.
 *
 * Two senders, one notice: the write route (names the collection when the request does) and the
 * config epoch's stamp (a raw write or a script — it knows only the tables). The stamp stays
 * quiet when a route already spoke in the last few seconds.
 */

const THROTTLE_MS = 800
const MIN_GAP_MS = 2_000
const STAMP_QUIET_MS = 6_000

/** Configuration tables whose edit can change an open form, with the surface they belong to. */
const SURFACE_OF_TABLE: Record<string, string> = {
  nivaro_fields: 'schema',
  nivaro_collections: 'schema',
  nivaro_relations: 'schema',
  nivaro_field_groups: 'layout',
  nivaro_collection_layouts: 'layout',
  nivaro_layout_field_assignments: 'layout',
  nivaro_field_rules: 'field-rules',
  nivaro_rules: 'field-rules',
  nivaro_workflow_bindings: 'pipeline',
  nivaro_workflow_states: 'pipeline',
  nivaro_workflow_transitions: 'pipeline',
  nivaro_workflow_templates: 'pipeline'
}

const send = keyedThrottle(THROTTLE_MS, MIN_GAP_MS, (key) => {
  const [tenant, surface, collection] = key.split('|')
  emitToTenant(tenant, 'config:update', {
    surface,
    ...(collection ? { collection } : {}),
    at: Date.now()
  })
})

let lastRouteAt = 0

/** A write route changed configuration. `collection` narrows who has to react. */
export function announceConfigChanged(
  surface: string,
  collection?: string | null,
  /** The request's tenant (`req.nvrTenantId`): an onResponse hook may run outside the tenant's
   *  async context, where currentTenantKey() is empty and a cloud notice would be dropped. */
  tenant?: string | null
): void {
  lastRouteAt = Date.now()
  const c = collection && /^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(collection) ? collection : ''
  send(`${tenant ?? currentTenantKey()}|${surface}|${c}`)
}

/**
 * Config-route POSTs that only read — the layout editor's draft projection and the form-rule
 * evaluators — mark themselves (markConfigRead) so the config-write hook flushes no cache and
 * pushes nothing for them (any signed-in caller reaches the evaluators; a push per call would
 * re-fetch every open form). Opt-in per handler, never by URL: a PATCH on a field that happens
 * to be named `project` is still a write.
 */
export function markConfigRead(req: object): void {
  ;(req as { nvrConfigRead?: boolean }).nvrConfigRead = true
}

/** Whether a successful request was a read-only POST that marked itself (see markConfigRead). */
export function isConfigRead(req: { method: string; nvrConfigRead?: unknown }): boolean {
  return req.method === 'POST' && req.nvrConfigRead === true
}

/** Routes whose writes can change collection/field/layout metadata. */
const META_ROUTES =
  /^\/api\/(data-model|collections|field-config|collection-layouts|field-groups)\b/

/**
 * Whether a request (that succeeded) may have changed form configuration: any non-GET under a
 * metadata route, except a read-only POST that marked itself. The config-write hook
 * (routes/index.ts) flushes the metadata caches and sends config:update for these.
 */
export function isConfigWrite(req: {
  method: string
  url: string
  nvrConfigRead?: unknown
}): boolean {
  // Reads, and CORS preflights, change nothing.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false
  return META_ROUTES.test(req.url) && !isConfigRead(req)
}

/** Lets a write keyed by id (a layout, a group) name the collection it changed. */
export function nameConfigCollection(req: object, collection: unknown): void {
  if (typeof collection === 'string' && collection)
    (req as { nvrConfigCollection?: string }).nvrConfigCollection = collection
}

/**
 * The collection a config write names: the one the route set with nameConfigCollection, the
 * body or query's `collection`, or the path segment after `/fields/` or `/collections/` (never
 * a numeric id). null = "any form may be affected".
 */
export function collectionHint(req: {
  url: string
  body?: unknown
  query?: unknown
  nvrConfigCollection?: unknown
}): string | null {
  const pick = (v: unknown) =>
    typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && !/^\d+$/.test(v) ? v : null
  const body = req.body as { collection?: unknown } | null | undefined
  const query = req.query as { collection?: unknown } | null | undefined
  const direct = pick(req.nvrConfigCollection) ?? pick(body?.collection) ?? pick(query?.collection)
  if (direct) return direct
  const m = req.url.split('?')[0].match(/^\/api\/(?:data-model\/)?(?:fields|collections)\/([^/]+)/)
  return m ? pick(m[1]) : null
}

onConfigStamp((stamp) => {
  if (Date.now() - lastRouteAt < STAMP_QUIET_MS) return
  const surfaces = new Set<string>()
  for (const t of stamp.tables) {
    const s = SURFACE_OF_TABLE[t.table]
    if (s) surfaces.add(s)
  }
  for (const surface of surfaces) send(`${currentTenantKey()}|${surface}|`)
})
