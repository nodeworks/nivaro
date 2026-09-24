import { db } from '../db/index.js'
import { type RelatedNoteFeedEntry, relatedNoteRegistry } from '../extensions/related-notes.js'
import { hasChainColumns } from './chain-columns.js'
import { chainIdsForRoots } from './chain-roots.js'
import { requesterSelectColumns } from './erp-requester-columns.js'
import { resolveFriendlyIds } from './workflow-transitions.js'

/**
 * The Integrations console's Events feed: one registry of event sources.
 * Core registers the outbound pushes (nivaro_erp_submissions) and the
 * inbound token / API-key writes (nivaro_api_logs); every note provider
 * that can list across records joins as a poll source; an extension may
 * register its own through ctx.integrations.registerEventSource.
 */

export type EventDirection = 'in' | 'out' | 'poll'

export interface EventEntry {
  id: string
  source: string
  direction: EventDirection
  label: string
  text: string
  context?: string | null
  created_at: string
  status?: 'ok' | 'error' | 'info' | null
  user?: string | null
  collection: string | null
  item_id: string | null
  item_label?: string | null
  record_count?: number
  partner?: string | null
  caller?: string | null
  chain_id?: string | null
  replayable?: boolean
}

export interface EventListOpts {
  limit: number
  status?: 'ok' | 'error' | 'info' | null
  before?: string | null
  partner?: string | null
  caller?: string | null
  includePeople?: boolean
  /** Record search: restrict to these chains. */
  chainIds?: string[] | null
  record?: { collection: string; item: string } | null
}

export interface EventSourceDef {
  id: string
  label: string
  direction: EventDirection
  list(opts: EventListOpts): Promise<EventEntry[]>
  get?(id: string): Promise<EventEntry | null>
}

const sources = new Map<string, EventSourceDef>()

export function registerEventSource(def: EventSourceDef): void {
  sources.set(def.id, def)
}

/** A feed without a cursor answers a single lookup from its newest window. */
const LOOKUP_WINDOW = 500

/** Note providers with list() become poll sources; their rows map to chains via nivaro_chain_roots. */
function noteProviderSources(): EventSourceDef[] {
  return relatedNoteRegistry
    .describe()
    .filter((p) => p.can_list && !sources.has(p.id))
    .map((p) => {
      // One mapping for list() and get() — the two must never disagree on
      // chain_id or replayable.
      const toEntries = async (rows: RelatedNoteFeedEntry[]): Promise<EventEntry[]> => {
        const chains = await chainIdsForRoots(
          p.id,
          rows.map((r) => String(r.id))
        )
        return rows.map((r) => ({
          id: String(r.id),
          source: p.id,
          direction: 'poll' as const,
          label: r.label,
          text: r.text,
          context: r.context ?? null,
          created_at: new Date(r.created_at).toISOString(),
          status: r.status ?? null,
          user: r.user ?? null,
          collection: r.collection ?? null,
          item_id: r.item_id != null && r.item_id !== '' ? String(r.item_id) : null,
          item_label: r.item_label ?? null,
          record_count: r.item_id ? 1 : 0,
          partner: p.label,
          chain_id: chains.get(String(r.id)) ?? null,
          replayable: r.replayable === true && p.can_replay
        }))
      }
      const list = async (opts: EventListOpts): Promise<EventEntry[]> =>
        toEntries(
          await relatedNoteRegistry.listRecent({
            limit: opts.limit,
            provider: p.id,
            status: opts.status ?? null,
            before: opts.before ?? null
          })
        )
      return {
        id: p.id,
        label: p.label,
        direction: 'poll' as const,
        list,
        async get(id: string) {
          // A provider that can look one entry up answers for any age; the
          // newest-window scan is only the fallback for one that cannot.
          const provider = relatedNoteRegistry.get(p.id)
          if (provider?.get) {
            const row = await provider.get(id)
            if (!row) return null
            return (await toEntries([row]))[0] ?? null
          }
          const found = await list({ limit: LOOKUP_WINDOW })
          return found.find((r) => r.id === id) ?? null
        }
      }
    })
}

function allSources(): EventSourceDef[] {
  return [...sources.values(), ...noteProviderSources()]
}

export function describeEventSources(): Array<{
  id: string
  collection: string | null
  label: string
  direction: EventDirection
  can_list: boolean
  can_replay: boolean
}> {
  const replayable = new Set(
    relatedNoteRegistry
      .describe()
      .filter((p) => p.can_replay)
      .map((p) => p.id)
  )
  const collections = new Map(relatedNoteRegistry.describe().map((p) => [p.id, p.collection]))
  // Every registered source can list — that is what makes it a source; the
  // console's source picker keys on can_list.
  return allSources().map((s) => ({
    id: s.id,
    collection: collections.get(s.id) ?? null,
    label: s.label,
    direction: s.direction,
    can_list: true,
    can_replay: replayable.has(s.id)
  }))
}

export async function listEvents(
  opts: EventListOpts & { source?: string | null }
): Promise<EventEntry[]> {
  const picked = allSources().filter((s) => !opts.source || s.id === opts.source)
  const out: EventEntry[] = []
  await Promise.all(
    picked.map(async (s) => {
      try {
        out.push(...(await s.list(opts)))
      } catch {
        // one broken source never empties the feed
      }
    })
  )
  const beforeMs = opts.before ? new Date(opts.before).getTime() : Number.NaN
  const chainSet = opts.chainIds ? new Set(opts.chainIds) : null
  const filtered = out.filter((e) => {
    // A source that ignores the cursor must not leak newer rows onto an older page.
    if (Number.isFinite(beforeMs) && new Date(e.created_at).getTime() >= beforeMs) return false
    if (opts.partner && e.partner !== opts.partner) return false
    if (!chainSet && !opts.record) return true
    const direct =
      opts.record &&
      e.collection === opts.record.collection &&
      String(e.item_id) === String(opts.record.item)
    const viaChain = chainSet && e.chain_id && chainSet.has(e.chain_id)
    return Boolean(direct || viaChain)
  })
  return filtered
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, opts.limit)
}

export async function getEvent(source: string, id: string): Promise<EventEntry | null> {
  const s = allSources().find((x) => x.id === source)
  if (!s) return null
  if (s.get) return s.get(id)
  return (await s.list({ limit: LOOKUP_WINDOW })).find((e) => e.id === id) ?? null
}

export function isGraphqlMutation(body: string | null | undefined): boolean {
  if (!body) return false
  let query: unknown
  try {
    query = (JSON.parse(body) as { query?: unknown }).query
  } catch {
    return false
  }
  if (typeof query !== 'string') return false
  // The operation type is the first token of the document (ignoring comments).
  const first = query.replace(/#[^\n]*/g, '').trimStart()
  return /^mutation\b/.test(first)
}

export function itemFromPath(path: string): { collection: string; item: string } | null {
  const m = /^\/api\/items\/([A-Za-z0-9_]+)\/([^/?]+)$/.exec(path)
  if (!m) return null
  let item = m[2]
  try {
    item = decodeURIComponent(item)
  } catch {
    // a malformed escape keeps the raw segment
  }
  return { collection: m[1], item }
}

/**
 * Entries a source sent without a record label get the record's friendly id
 * (the human id the entity-room registry names), one batched lookup per
 * collection over the page. Never throws — a failed lookup leaves the entry
 * unlabelled and the client falls back to the raw id.
 */
export async function fillEventLabels(
  entries: Array<Pick<EventEntry, 'collection' | 'item_id' | 'item_label'>>
): Promise<void> {
  const byCollection = new Map<string, Set<string>>()
  for (const e of entries) {
    if (e.item_label || !e.collection || e.item_id == null || e.item_id === '') continue
    const set = byCollection.get(e.collection) ?? new Set<string>()
    set.add(String(e.item_id))
    byCollection.set(e.collection, set)
  }
  for (const [collection, ids] of byCollection) {
    try {
      const labels = await resolveFriendlyIds(collection, [...ids])
      for (const e of entries) {
        if (e.item_label || e.collection !== collection || e.item_id == null) continue
        const label = labels.get(String(e.item_id))
        // resolveFriendlyIds echoes the id when it finds nothing better.
        if (label && label !== String(e.item_id)) e.item_label = label
      }
    } catch {
      /* the entry keeps no label */
    }
  }
}

// ── core:outbound — partner pushes ────────────────────────────────────────

function mapSubmission(r: Record<string, unknown>): EventEntry {
  let endpoint = ''
  try {
    endpoint = String(
      (JSON.parse(String(r.payload ?? '{}')) as { endpoint_path?: string }).endpoint_path ?? ''
    )
  } catch {
    // an unparseable payload just names no endpoint
  }
  const status = String(r.status ?? '')
  const failed = status === 'failed' || status === 'rejected'
  const attempts = Number(r.attempts)
  return {
    id: String(r.id),
    source: 'core:outbound',
    direction: 'out',
    label: String(r.api_name ?? 'Partner'),
    text: `${endpoint || 'push'} · ${status}${attempts > 1 ? ` · ${attempts} attempts` : ''}`,
    context: failed
      ? String(r.last_error ?? '').slice(0, 200)
      : ((r.requested_via as string | null | undefined) ?? null),
    created_at: new Date(r.created_at as string).toISOString(),
    status: failed ? 'error' : 'ok',
    user: (r.requested_by as string | null | undefined) ?? null,
    collection: (r.collection as string | null) ?? null,
    item_id: r.item != null ? String(r.item) : null,
    record_count: r.item != null ? 1 : 0,
    partner: (r.api_name as string | null) ?? null,
    chain_id: (r.chain_id as string | null | undefined) ?? null
  }
}

async function submissionColumns(): Promise<string[]> {
  const [stamp, requester] = await Promise.all([
    hasChainColumns('nivaro_erp_submissions'),
    requesterSelectColumns('nivaro_erp_submissions')
  ])
  return [
    's.id',
    's.collection',
    's.item',
    's.status',
    's.attempts',
    's.last_error',
    's.created_at',
    's.payload',
    'a.name as api_name',
    ...requester.map((c) => `s.${c}`),
    ...(stamp ? ['s.chain_id'] : [])
  ]
}

/** A record search's chains, capped under the bound-parameter limit. */
function chainList(opts: EventListOpts): string[] {
  return (opts.chainIds ?? []).slice(0, 1000)
}

const outbound: EventSourceDef = {
  id: 'core:outbound',
  label: 'Outbound pushes',
  direction: 'out',
  async list(opts) {
    const stamp = await hasChainColumns('nivaro_erp_submissions')
    const q = db('nivaro_erp_submissions as s')
      .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
      .select(...(await submissionColumns()))
      .orderBy('s.created_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(Math.min(opts.limit, 500))
    if (opts.before) q.where('s.created_at', '<', new Date(opts.before))
    if (opts.status === 'error') q.whereIn('s.status', ['failed', 'rejected'])
    if (opts.status === 'ok') q.whereIn('s.status', ['accepted', 'pending'])
    if (opts.status === 'info') return []
    if (opts.partner) q.where('a.name', opts.partner)
    if (opts.record) {
      const { collection, item } = opts.record
      const chains = stamp ? chainList(opts) : []
      // The record's own pushes, plus any push on a chain that touched it.
      q.where((w) => {
        w.where({ 's.collection': collection, 's.item': item })
        if (chains.length) w.orWhereIn('s.chain_id', chains)
      })
    }
    const rows = (await q) as Array<Record<string, unknown>>
    return rows.map(mapSubmission)
  },
  async get(id) {
    if (!/^\d+$/.test(id)) return null
    const r = (await db('nivaro_erp_submissions as s')
      .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
      .where('s.id', Number(id))
      .first(...(await submissionColumns()))) as Record<string, unknown> | undefined
    return r ? mapSubmission(r) : null
  }
}

// ── core:inbound — partner writes that reached us ─────────────────────────

/** Rows per inbound batch, and how many batches one page may scan. */
const INBOUND_BATCH_MAX = 1000
export const INBOUND_MAX_BATCHES = 5

export function inboundBatchSize(limit: number): number {
  return Math.min(Math.max(limit * 2, 20), INBOUND_BATCH_MAX)
}

const inbound: EventSourceDef = {
  id: 'core:inbound',
  label: 'Inbound calls',
  direction: 'in',
  async list(opts) {
    if (opts.status === 'info') return []
    const stamp = await hasChainColumns('nivaro_api_logs')
    const chainSet = new Set(stamp ? chainList(opts) : [])
    const batch = inboundBatchSize(opts.limit)

    // One batch older than `cursor` (the oldest row the previous batch
    // scanned, id as the tiebreak) — or older than the page cursor first.
    const fetchBatch = (cursor: { at: Date; id: number } | null) => {
      const q = db('nivaro_api_logs as l')
        .leftJoin('nivaro_users as u', 'u.id', 'l.user')
        .leftJoin('nivaro_api_keys as k', 'k.id', 'l.api_key_id')
        .whereIn('l.auth', ['token', 'api_key'])
        .whereNot('l.method', 'GET')
        // Candidates only, so the limit counts rows that can make the page:
        // a GraphQL call is a candidate when its body mentions a mutation
        // (isGraphqlMutation below confirms it).
        .where((w) =>
          w.whereNot('l.path', 'like', '%graphql%').orWhere('l.request_body', 'like', '%mutation%')
        )
        .select(
          'l.id',
          'l.method',
          'l.path',
          'l.status',
          'l.user',
          'l.api_key_id',
          'l.created_at',
          'l.request_body',
          'l.collection',
          'u.first_name',
          'u.last_name',
          'u.email',
          'u.account_kind',
          'k.name as key_name',
          ...(stamp ? ['l.chain_id'] : [])
        )
        .orderBy('l.created_at', 'desc')
        .orderBy('l.id', 'desc')
        .limit(batch)
      // A request that adopted a caller's chain (an in-process app.inject) is
      // an internal step of that chain, not a partner call.
      if (stamp) q.whereNull('l.chain_parent')
      if (!opts.includePeople) {
        q.where((w) => w.whereNotNull('u.account_kind').orWhereNotNull('l.api_key_id'))
      }
      if (cursor) {
        const { at, id } = cursor
        q.where((w) =>
          w
            .where('l.created_at', '<', at)
            .orWhere((w2) => w2.where('l.created_at', '=', at).andWhere('l.id', '<', id))
        )
      } else if (opts.before) {
        q.where('l.created_at', '<', new Date(opts.before))
      }
      if (opts.record) {
        const { collection, item } = opts.record
        // The record's own REST writes, plus any call on a chain that
        // touched it (GraphQL paths carry no item, so only chain-linked
        // GraphQL calls can match).
        const path = `/api/items/${collection}/${encodeURIComponent(item)}`
        q.where((w) => {
          w.where('l.path', path)
          if (chainSet.size) w.orWhereIn('l.chain_id', [...chainSet])
        })
      }
      if (opts.status === 'error') q.where('l.status', '>=', 400)
      if (opts.status === 'ok') q.where('l.status', '<', 400)
      if (opts.caller) {
        const caller = opts.caller
        q.where((w) => {
          w.where('l.user', caller)
          if (/^\d+$/.test(caller)) w.orWhere('l.api_key_id', Number(caller))
        })
      }
      return q as unknown as Promise<Array<Record<string, unknown>>>
    }

    const out: EventEntry[] = []
    let cursor: { at: Date; id: number } | null = null
    for (let n = 0; n < INBOUND_MAX_BATCHES && out.length < opts.limit; n++) {
      const rows = await fetchBatch(cursor)
      for (const r of rows) {
        const path = String(r.path ?? '')
        if (/graphql/i.test(path) && !isGraphqlMutation(r.request_body as string | null)) continue
        const target = itemFromPath(path)
        if (opts.record && !(r.chain_id && chainSet.has(String(r.chain_id)))) {
          if (target?.collection !== opts.record.collection || target.item !== opts.record.item)
            continue
        }
        const person = [r.first_name, r.last_name].filter(Boolean).join(' ')
        const who =
          (r.key_name as string | null) || person || (r.email as string | null) || 'Unknown caller'
        out.push({
          id: String(r.id),
          source: 'core:inbound',
          direction: 'in',
          label: who,
          text: `${r.method} ${path} · ${r.status}`,
          created_at: new Date(r.created_at as string).toISOString(),
          status: Number(r.status) >= 400 ? 'error' : 'ok',
          user: (r.user as string | null) ?? null,
          collection: target?.collection ?? (r.collection as string | null) ?? null,
          item_id: target?.item ?? null,
          record_count: target ? 1 : 0,
          caller: r.api_key_id != null ? String(r.api_key_id) : ((r.user as string | null) ?? null),
          chain_id: (r.chain_id as string | null | undefined) ?? null
        })
        if (out.length >= opts.limit) break
      }
      // Fewer rows than asked for = nothing older left to scan.
      if (rows.length < batch) break
      const last = rows[rows.length - 1]
      cursor = { at: new Date(last.created_at as string), id: Number(last.id) }
    }
    return out
  },
  async get(id) {
    if (!/^\d+$/.test(id)) return null
    const stamp = await hasChainColumns('nivaro_api_logs')
    const r = (await db('nivaro_api_logs')
      .where('id', id)
      .first(
        'id',
        'method',
        'path',
        'status',
        'user',
        'api_key_id',
        'created_at',
        'collection',
        ...(stamp ? ['chain_id'] : [])
      )) as Record<string, unknown> | undefined
    if (!r) return null
    const target = itemFromPath(String(r.path))
    return {
      id: String(r.id),
      source: 'core:inbound',
      direction: 'in',
      label: 'Inbound call',
      text: `${r.method} ${r.path} · ${r.status}`,
      created_at: new Date(r.created_at as string).toISOString(),
      status: Number(r.status) >= 400 ? 'error' : 'ok',
      user: (r.user as string | null) ?? null,
      collection: target?.collection ?? (r.collection as string | null) ?? null,
      item_id: target?.item ?? null,
      caller: r.api_key_id != null ? String(r.api_key_id) : ((r.user as string | null) ?? null),
      chain_id: (r.chain_id as string | null | undefined) ?? null
    }
  }
}

registerEventSource(outbound)
registerEventSource(inbound)
