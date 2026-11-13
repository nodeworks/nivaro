import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { collectionNouns, readableTitle } from './activity-sentence.js'
import { isIdLikeSegment } from './presence-stuck.js'
import { canUserReadQueue } from './queue-access.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Pages visited (the People page's journey card and Day view): a stored route
 * → the place a person would recognise. "Workflow CM26-365984 · Roof
 * replacement", not "Records › Workflows › 365984?Addendum=867F…".
 *
 *   - record pages name the record AS THE VIEWER reads it (ai-link-labels:
 *     their role, row filters, User Scopes, field access). A record they cannot
 *     read is "A workflow record" — no id, no link;
 *   - queues by name, only when the viewer may open the queue;
 *   - query parameters read as meaning ("Addendum open", "People tab") or are
 *     dropped; ids (numbers, GUIDs, friendly ids) never become words.
 *
 * Lookups are batched (one per collection, one for queues), capped, and kept
 * 30 s per tenant + viewer so paging days back and forth stays cheap.
 */

export type JourneyLabelKind = 'record' | 'new-record' | 'list' | 'queue' | 'person' | 'page'

export interface JourneyLabel {
  title: string
  /** The area the place sits in ("Workflows", "Admin", "Queue"); null = none worth saying. */
  section: string | null
  /** What the query string meant ("Addendum open"); null = nothing. */
  detail: string | null
  kind: JourneyLabelKind
  /** One place = one key: consecutive visits with the same key fold into one row. */
  key: string
  /** Present only for a record the viewer can read — the client links it. */
  record?: { collection: string; id: string }
  /** Present only for a queue the viewer may open. */
  queue_id?: string
  /** Present only for a person whose name resolved. */
  person_id?: string
}

type Details = { details: string[] }
export type JourneyPlace =
  | ({ kind: 'record'; collection: string; id: string } & Details)
  | ({ kind: 'new-record'; collection: string } & Details)
  | ({ kind: 'list'; collection: string } & Details)
  | ({ kind: 'queue'; id: string } & Details)
  | ({ kind: 'person'; id: string } & Details)
  | ({ kind: 'page'; title: string; section: string | null; key: string } & Details)

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const SAFE_VALUE = /^[A-Za-z0-9 _-]{1,40}$/
const SYSTEM_TABLE = /^(nivaro_|directus_|staging_)/i

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/** "my-work" → "My work"; an id or odd value → null. */
function valueWords(v: string): string | null {
  const s = decode(v).trim()
  if (!s || !SAFE_VALUE.test(s) || isIdLikeSegment(s)) return null
  return readableTitle(s) || null
}

const tabWords = (v: string) => {
  const w = valueWords(v)
  return w ? `${w} tab` : null
}

/** Query parameters that say what the person was doing. Everything else is dropped. */
const QUERY_WORDS: Record<string, (v: string) => string | null> = {
  addendum: () => 'Addendum open',
  tab: tabWords,
  p: tabWords,
  section: tabWords,
  view: tabWords,
  focus: valueWords,
  edit: () => 'Editing',
  watch: () => 'Watching a video',
  recording: () => 'Watching a recording',
  ticket: () => 'Ticket open',
  q: () => 'Searching',
  search: () => 'Searching',
  autofill: () => 'From a document',
  prefill: () => 'Prefilled'
}

/** `?addendum=<guid>&layout=3` → ["Addendum open"]. */
export function queryMeaning(search: string): string[] {
  const q = search.startsWith('?') ? search.slice(1) : search
  if (!q) return []
  const out: string[] = []
  for (const part of q.split('&')) {
    const [rawKey, ...rest] = part.split('=')
    const read = QUERY_WORDS[decode(rawKey ?? '').toLowerCase()]
    const w = read?.(rest.join('='))
    if (w && !out.includes(w)) out.push(w)
  }
  return out
}

/** What a stored route IS — pure, no lookups. */
export function parseJourneyPath(path: string): JourneyPlace {
  const [bare, ...q] = String(path ?? '').split('?')
  const pathname = bare.split('#')[0]
  const details = queryMeaning(q.join('?').split('#')[0])
  const segs = pathname.split('/').filter(Boolean).map(decode)

  const [a, b, c] = segs
  if ((a === 'records' || a === 'collections') && b && IDENT.test(b)) {
    if (!c || (c === 'classic' && segs.length === 3))
      return { kind: 'list', collection: b, details }
    if (c === 'new') return { kind: 'new-record', collection: b, details }
    return { kind: 'record', collection: b, id: c, details }
  }
  if (a === 'queues' && b) return { kind: 'queue', id: b, details }
  if ((a === 'users' || a === 'profile') && b && isIdLikeSegment(b)) {
    return { kind: 'person', id: b, details }
  }

  const words = segs.filter((s) => !isIdLikeSegment(s)).map((s) => readableTitle(s))
  const named = words.filter(Boolean)
  const key = `page:${segs.join('/').toLowerCase()}`
  if (named.length === 0) return { kind: 'page', title: 'Home', section: null, key, details }
  if (named.length === 1) return { kind: 'page', title: named[0], section: null, key, details }
  return {
    kind: 'page',
    title: named[named.length - 1],
    section: named[0],
    key,
    details
  }
}

export interface JourneyQueueRow {
  id: string
  name: string | null
  owner?: string | null
  is_shared?: boolean | number | null
  role_id?: string | null
}

export interface JourneyLabelDeps {
  /** Registered collections among `names`, with their nouns. Unregistered names are absent. */
  collections(
    names: string[]
  ): Promise<Map<string, { singular: string | null; plural: string | null }>>
  /** `collection:id` → label, read as `viewer` (ai-link-labels). */
  recordLabels(viewer: User, byTarget: Map<string, Set<string>>): Promise<Record<string, string>>
  queues(ids: string[]): Promise<JourneyQueueRow[]>
}

export const JOURNEY_LABEL_CAPS = {
  collections: 25,
  recordsPerCollection: 200,
  queues: 100,
  people: 100
}

const defaultDeps: JourneyLabelDeps = {
  async collections(names) {
    if (!names.length) return new Map()
    const rows = (await db('nivaro_collections')
      .whereIn('collection', names)
      .select('collection', 'display_name', 'singular', 'plural')) as Array<{
      collection: string
      display_name: string | null
      singular: string | null
      plural: string | null
    }>
    return new Map(
      rows.map((r) => [
        r.collection,
        { singular: r.singular ?? null, plural: r.plural ?? r.display_name ?? null }
      ])
    )
  },
  async recordLabels(viewer, byTarget) {
    const { linkLabelsAsUser } = await import('./ai-link-labels.js')
    return linkLabelsAsUser(viewer, byTarget)
  },
  async queues(ids) {
    if (!ids.length) return []
    return (await db('nivaro_queues')
      .whereIn('id', ids)
      .select('id', 'name', 'owner', 'is_shared', 'role_id')) as JourneyQueueRow[]
  }
}

const TTL_MS = 30_000
const CACHE_MAX = 5_000
type CacheEntry = { label: JourneyLabel; at: number }
const moduleCache = new Map<string, CacheEntry>()

const nounsFor = (
  collection: string,
  names: { singular: string | null; plural: string | null } | undefined
) => collectionNouns(collection, names ? { collections: { [collection]: names } } : null)

const aRecord = (singular: string) => `A ${singular.toLowerCase()} record`

/** A fold key never carries the id itself — the card must not be a way to read ids back. */
const idKey = (kind: string, scope: string, id: string) =>
  `${kind}:${scope}:${createHash('sha256').update(id.toLowerCase()).digest('base64url').slice(0, 12)}`

const detailOf = (p: JourneyPlace) => (p.details.length ? p.details.join(' · ') : null)

/** Labels for many stored routes at once, as `viewer` may read them. Never throws. */
export async function resolveJourneyLabels(
  paths: Iterable<string>,
  viewer: User,
  isAdmin: boolean,
  opts: { deps?: JourneyLabelDeps; cache?: Map<string, CacheEntry> | null; now?: number } = {}
): Promise<Map<string, JourneyLabel>> {
  const deps = opts.deps ?? defaultDeps
  const cache = opts.cache === undefined ? moduleCache : opts.cache
  const now = opts.now ?? Date.now()
  const prefix = `${currentTenantKey()}|${String(viewer?.id ?? '').toUpperCase()}|${isAdmin ? 1 : 0}|`
  const out = new Map<string, JourneyLabel>()

  const todo = new Map<string, JourneyPlace>()
  for (const path of new Set(paths)) {
    const hit = cache?.get(prefix + path)
    if (hit && now - hit.at < TTL_MS) out.set(path, hit.label)
    else todo.set(path, parseJourneyPath(path))
  }
  if (todo.size === 0) return out

  // ── What to look up ──
  const collectionNames = new Set<string>()
  const queueIds = new Set<string>()
  const personIds = new Set<string>()
  for (const p of todo.values()) {
    if (
      (p.kind === 'record' || p.kind === 'new-record' || p.kind === 'list') &&
      !SYSTEM_TABLE.test(p.collection)
    )
      collectionNames.add(p.collection)
    if (p.kind === 'queue' && queueIds.size < JOURNEY_LABEL_CAPS.queues) queueIds.add(p.id)
    if (p.kind === 'person' && personIds.size < JOURNEY_LABEL_CAPS.people)
      personIds.add(p.id.toUpperCase())
  }
  const asked = [...collectionNames].slice(0, JOURNEY_LABEL_CAPS.collections)

  const registered = await deps
    .collections(asked)
    .catch(() => new Map<string, { singular: string | null; plural: string | null }>())

  // The client wrote the path, so a collection named in it must be registered before it is read.
  const byTarget = new Map<string, Set<string>>()
  for (const p of todo.values()) {
    if (p.kind !== 'record' || !registered.has(p.collection)) continue
    const set = byTarget.get(p.collection) ?? new Set<string>()
    if (set.size < JOURNEY_LABEL_CAPS.recordsPerCollection) set.add(p.id)
    byTarget.set(p.collection, set)
  }
  if (personIds.size) byTarget.set('nivaro_users', personIds)

  const [records, queues] = await Promise.all([
    byTarget.size
      ? deps.recordLabels(viewer, byTarget).catch(() => ({}) as Record<string, string>)
      : Promise.resolve({} as Record<string, string>),
    queueIds.size ? deps.queues([...queueIds]).catch(() => []) : Promise.resolve([])
  ])
  const queueName = new Map<string, string>()
  for (const q of queues) {
    if (!q?.id || !canUserReadQueue(q, viewer, isAdmin)) continue
    const name = String(q.name ?? '').trim()
    if (name) queueName.set(String(q.id).toLowerCase(), name)
  }

  // ── Words ──
  for (const [path, p] of todo) {
    let label: JourneyLabel
    if (p.kind === 'record' || p.kind === 'new-record' || p.kind === 'list') {
      const known = registered.get(p.collection)
      if (!known) {
        // Not a registered collection: say the words of the route, never its ids.
        const title = readableTitle(p.collection.replace(/^(nivaro|directus|staging)_/i, ''))
        label = {
          title: title || 'A page',
          section: null,
          detail: detailOf(p),
          kind: 'page',
          key: `page:${p.collection.toLowerCase()}`
        }
      } else {
        const n = nounsFor(p.collection, known)
        if (p.kind === 'record') {
          const name = records[`${p.collection}:${p.id}`]
          label = {
            title: name ? `${n.singular} ${name}` : aRecord(n.singular),
            section: n.plural,
            detail: detailOf(p),
            kind: 'record',
            key: idKey('record', p.collection, String(p.id)),
            ...(name ? { record: { collection: p.collection, id: p.id } } : {})
          }
        } else if (p.kind === 'new-record') {
          label = {
            title: `New ${n.singular.toLowerCase()}`,
            section: n.plural,
            detail: detailOf(p),
            kind: 'new-record',
            key: `new:${p.collection}`
          }
        } else {
          label = {
            title: n.plural,
            section: 'List',
            detail: detailOf(p),
            kind: 'list',
            key: `list:${p.collection}`
          }
        }
      }
    } else if (p.kind === 'queue') {
      const name = queueName.get(p.id.toLowerCase())
      label = {
        title: name ?? 'A queue',
        section: 'Queue',
        detail: detailOf(p),
        kind: 'queue',
        key: idKey('queue', '', p.id),
        ...(name ? { queue_id: p.id } : {})
      }
    } else if (p.kind === 'person') {
      const name = records[`nivaro_users:${p.id.toUpperCase()}`]
      label = {
        title: name ?? 'A profile',
        section: 'Profile',
        detail: detailOf(p),
        kind: 'person',
        key: idKey('person', '', p.id),
        ...(name ? { person_id: p.id } : {})
      }
    } else {
      label = {
        title: p.title,
        section: p.section,
        detail: detailOf(p),
        kind: 'page',
        key: p.key
      }
    }
    out.set(path, label)
    if (cache) {
      if (cache.size >= CACHE_MAX) cache.clear()
      cache.set(prefix + path, { label, at: now })
    }
  }
  return out
}
