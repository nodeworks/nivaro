import type { FastifyInstance } from 'fastify'
import { db } from '../../../db/index.js'
import { logActivity } from '../../activity.js'
import { hubModeEnabled } from '../mode.js'
import { makeProviderContext } from './context.js'
import { type HubActor, ResourceChangeError } from './engine/contract.js'
import { ensureCoreProviders } from './index.js'
import { findType, getProvider } from './registry.js'
import {
  APP_CONNECTIONS,
  type HubConnectionRow,
  HubProviderStoreError,
  type HubResourceRow,
  insertResource,
  listChanges,
  listResources,
  openConnectionSecrets,
  readConnection,
  readResource,
  updateResource
} from './store.js'
import {
  type FieldSpec,
  type ListPage,
  type Observed,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceScope,
  type ResourceTypeSpec
} from './types.js'

/**
 * Drift, the Unmanaged list and Adopt (spec "Drift and adoption").
 *
 *  - The cron `hub-resources-observe` (every 15 minutes) observes every managed resource and
 *    stores `observed` + a drift flag. It NEVER re-applies: a person chooses Re-apply or Accept.
 *  - Drift = observed differs from desired on the type's declared fields only. A secret field is
 *    compared by fingerprint only (and only when the provider answers a fingerprint; a write-only
 *    secret is never drift). A field the provider does not return is not compared. A resource
 *    the provider no longer has → observed null + drift.
 *  - Unmanaged lists what a connection can see that the Hub does not manage; Hub-tagged
 *    resources (`nivaro-hub:*` tags) and external ids already managed are left out.
 *  - Adopt binds one to an app + environment (or shared) with NO provider write.
 */

export const OBSERVE_JOB = 'hub-resources-observe'
export const OBSERVE_CRON = '*/15 * * * *'

const HUB_TAG_PREFIX = 'nivaro-hub:'
/** The most time one connection gets per tick; the rest waits for the next one. */
export const CONNECTION_BUDGET_MS = 5 * 60_000
/** One observe call never holds a tick longer than this. */
const OBSERVE_CALL_MS = 60_000
const CONNECTIONS_AT_ONCE = 4
const RESOURCES_AT_ONCE = 3
const MAX_PER_CONNECTION = 300
/** A connection that fails this many calls in a row is left for the next tick. */
const FAIL_STREAK_STOP = 5
const UNMANAGED_PAGES = 5

// ── Pure drift comparison ──

const SKIP = Symbol('skip')
type Norm = unknown | typeof SKIP

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isRecord(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0)

/**
 * Puts one value into a comparable form: refs become provider ids (desired holds `RefValue`,
 * observed holds ids), lists compare without order, empty strings/lists/null are the same, numbers
 * and numeric strings agree, secret and read-only parts drop out. SKIP = cannot judge.
 */
function normalize(
  spec: FieldSpec,
  v: unknown,
  resolve: (resourceId: number) => string | null
): Norm {
  if (spec.kind === 'secret') return SKIP
  if (isEmpty(v)) return null
  switch (spec.kind) {
    case 'ref': {
      if (isRecord(v) && 'resourceId' in v) return resolve(Number(v.resourceId)) ?? SKIP
      return String(v)
    }
    case 'number': {
      const n = Number(v)
      return Number.isFinite(n) ? n : String(v)
    }
    case 'boolean':
      return v === true || v === 'true' || v === 1 || v === '1'
    case 'list': {
      const items = Array.isArray(v) ? v : [v]
      const item: FieldSpec = spec.items ?? { key: 'item', label: 'item', kind: 'string' }
      const out: unknown[] = []
      for (const x of items) {
        const n = normalize(item, x, resolve)
        if (n === SKIP) return SKIP
        if (n !== null) out.push(n)
      }
      out.sort((a, b) => canonical(a).localeCompare(canonical(b)))
      return out.length ? out : null
    }
    case 'object': {
      if (!isRecord(v)) return String(v)
      if (!spec.fields) return v
      const out: Record<string, unknown> = {}
      for (const sub of spec.fields) {
        if (sub.readOnly || sub.kind === 'secret') continue
        const n = normalize(sub, v[sub.key], resolve)
        if (n === SKIP) return SKIP
        if (n !== null) out[sub.key] = n
      }
      return Object.keys(out).length ? out : null
    }
    default:
      return isRecord(v) || Array.isArray(v) ? canonical(v) : String(v)
  }
}

/**
 * The declared fields on which `observed` differs from `desired`. `desired` null (an adopted row
 * nobody has edited) never drifts on fields. Fields absent from `desired` were never declared and
 * fields absent from `observed.fields` are not readable: neither is compared.
 */
export function driftFields(
  type: ResourceTypeSpec,
  desired: Record<string, unknown> | null,
  observed: Observed,
  resolve: (resourceId: number) => string | null
): string[] {
  if (!desired) return []
  const out: string[] = []
  for (const spec of type.fields) {
    if (spec.readOnly) continue
    const d = desired[spec.key]
    if (d === undefined) continue
    if (!(spec.key in observed.fields)) continue
    const o = observed.fields[spec.key]
    if (spec.kind === 'secret') {
      // Fingerprint only: both sides must carry one; a write-only secret never drifts.
      const df = isRecord(d) ? d.fingerprint : null
      const of = isRecord(o) ? o.fingerprint : null
      if (typeof df === 'string' && typeof of === 'string' && df !== of) out.push(spec.key)
      continue
    }
    const nd = normalize(spec, d, resolve)
    const no = normalize(spec, o, resolve)
    if (nd === SKIP || no === SKIP) continue
    if (canonical(nd) !== canonical(no)) out.push(spec.key)
  }
  return out
}

/** The observed state as stored: secret fields can never be kept (only a `{fingerprint}` form). */
function scrubObserved(type: ResourceTypeSpec | null, o: Observed): Observed {
  if (!type) return o
  const fields = { ...o.fields }
  for (const spec of type.fields) {
    if (spec.kind !== 'secret' || !(spec.key in fields)) continue
    const v = fields[spec.key]
    if (isRecord(v) && typeof v.fingerprint === 'string')
      fields[spec.key] = { fingerprint: v.fingerprint }
    else delete fields[spec.key]
  }
  return { ...o, fields }
}

/** `desired` for an adopted resource: its current readable values, so later changes show as drift. */
function desiredFromObserved(
  type: ResourceTypeSpec,
  o: Observed,
  managedByExternalId: (type: string, externalId: string) => number | null
): { desired: Record<string, unknown>; refs: Array<{ field: string; resourceId: number }> } {
  const desired: Record<string, unknown> = {}
  const refs: Array<{ field: string; resourceId: number }> = []
  for (const spec of type.fields) {
    if (spec.readOnly || spec.kind === 'secret' || !(spec.key in o.fields)) continue
    const v = o.fields[spec.key]
    const refType =
      spec.kind === 'ref'
        ? spec.refType
        : spec.kind === 'list' && spec.items?.kind === 'ref'
          ? spec.items.refType
          : null
    if (spec.kind === 'ref' || (spec.kind === 'list' && spec.items?.kind === 'ref')) {
      // Provider ids → Hub rows; a referenced resource the Hub does not manage cannot be a ref,
      // so the field is left out (not compared) rather than guessed.
      const ids = (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String)
      const rows = ids.map((id) => managedByExternalId(refType ?? '', id))
      if (rows.some((r) => r === null)) continue
      const values = rows.map((resourceId) => ({ resourceId: resourceId as number }))
      for (const r of values) refs.push({ field: spec.key, resourceId: r.resourceId })
      desired[spec.key] = spec.kind === 'ref' ? (values[0] ?? null) : values
      continue
    }
    desired[spec.key] = v
  }
  return { desired, refs }
}

// ── Context ──

function regionOf(config: Record<string, unknown>, observed: Observed | null): string | null {
  const own = observed?.fields?.region
  if (typeof own === 'string' && own) return own
  if (typeof config.region === 'string' && config.region) return config.region
  const list = config.regions
  if (Array.isArray(list) && typeof list[0] === 'string') return list[0]
  return null
}

interface OpenConn {
  row: HubConnectionRow
  adapter: ProviderAdapter
  secrets: Record<string, string>
}

async function openConnection(row: HubConnectionRow): Promise<OpenConn | null> {
  ensureCoreProviders()
  const found = getProvider(row.provider)
  if (!found) return null
  return { row, adapter: found, secrets: await openConnectionSecrets(row) }
}

function ctxFor(c: OpenConn, region: string | null, signal?: AbortSignal): ProviderContext {
  return makeProviderContext({
    adapter: c.adapter,
    connectionId: c.row.id,
    config: c.row.config,
    secrets: c.secrets,
    region,
    signal
  })
}

/** Runs `fn` but gives up (rejecting) after `ms` or when `signal` aborts. */
function withTimeout<T>(fn: () => Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('observe timed out')), ms)
    const onAbort = () => reject(new Error('observe aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    fn()
      .then(
        (v) => resolve(v),
        (e) => reject(e)
      )
      .finally(() => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      })
  })
}

// ── Observe ──

export type ObserveOutcome = 'ok' | 'gone' | 'failed' | 'skipped'

export interface ObserveResult {
  resourceId: number
  outcome: ObserveOutcome
  drift: boolean
  /** Declared fields that differ (empty when gone, failed or not drifted). */
  fields: string[]
  /** Why it failed (scrubbed), for a person looking at one resource. */
  error?: string
}

async function resourcesInFlight(): Promise<Set<number>> {
  const busy = new Set<number>()
  const changes = await listChanges({ status: 'applying', limit: 200 })
  for (const c of changes) for (const id of c.plan?.resourceIds ?? []) if (id != null) busy.add(id)
  return busy
}

async function observeRow(
  conn: OpenConn,
  row: HubResourceRow,
  resolve: (resourceId: number) => string | null,
  signal: AbortSignal
): Promise<ObserveResult> {
  const t = findType(row.type)
  if (!t || !row.external_id)
    return { resourceId: row.id, outcome: 'skipped', drift: row.drift, fields: [] }
  const externalId = row.external_id
  const ctx = ctxFor(conn, regionOf(conn.row.config, row.observed), signal)
  let seen: Observed | null
  try {
    seen = await withTimeout(
      () => conn.adapter.observe(ctx, row.type, externalId),
      OBSERVE_CALL_MS,
      signal
    )
  } catch (e) {
    const msg = ctx.scrub(e instanceof Error ? e.message : String(e))
    return { resourceId: row.id, outcome: 'failed', drift: row.drift, fields: [], error: msg }
  }
  const now = new Date()
  if (seen === null) {
    await updateResource(row.id, { observed: null, drift: true, observed_at: now })
    return { resourceId: row.id, outcome: 'gone', drift: true, fields: [] }
  }
  const stored = scrubObserved(t.type, seen)
  const fields = driftFields(t.type, row.desired, stored, resolve)
  const drift = fields.length > 0
  await updateResource(row.id, { observed: stored, drift, observed_at: now })
  return { resourceId: row.id, outcome: 'ok', drift, fields }
}

async function refResolver(rows: HubResourceRow[]): Promise<(id: number) => string | null> {
  const want = new Set<number>()
  for (const r of rows) for (const x of r.refs) want.add(x.resourceId)
  const have = new Map<number, string | null>(rows.map((r) => [r.id, r.external_id]))
  const missing = [...want].filter((id) => !have.has(id))
  if (missing.length)
    for (const r of await listResources({ ids: missing, includeDeleted: true }))
      have.set(r.id, r.external_id)
  return (id) => have.get(id) ?? null
}

/** Observes one resource now (the "Check now" button). Throws NOT_FOUND for an unknown row. */
export async function observeOne(resourceId: number): Promise<ObserveResult> {
  const row = await readResource(resourceId)
  if (!row || row.deleted_at) throw new ResourceChangeError('NOT_FOUND', 'Resource not found.')
  const connRow = await readConnection(row.connection_id)
  if (!connRow)
    throw new ResourceChangeError('CONNECTION_NOT_FOUND', 'The resource’s connection is gone.')
  if ((await resourcesInFlight()).has(row.id))
    return { resourceId: row.id, outcome: 'skipped', drift: row.drift, fields: [] }
  const conn = await openConnection(connRow)
  if (!conn)
    return {
      resourceId: row.id,
      outcome: 'failed',
      drift: row.drift,
      fields: [],
      error: `No provider ${connRow.provider} is registered.`
    }
  return observeRow(conn, row, await refResolver([row]), new AbortController().signal)
}

/** The declared fields on which a stored resource differs from its desired state (for the UI). */
export async function driftFieldsOf(row: HubResourceRow): Promise<string[]> {
  const t = findType(row.type)
  if (!t || !row.observed) return []
  return driftFields(t.type, row.desired, row.observed, await refResolver([row]))
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export interface ObserveSummary {
  checked: number
  drifted: number
  gone: number
  failed: number
}

/**
 * Observes every managed resource of every connection. One provider's slowness never blocks the
 * others: connections run side by side, each with its own time budget and a stop after a streak
 * of failures; the stalest resources go first so a budget cut still rotates through all of them.
 */
export async function observeAll(
  opts: { budgetMs?: number; now?: () => number } = {}
): Promise<ObserveSummary> {
  const budget = opts.budgetMs ?? CONNECTION_BUDGET_MS
  const clock = opts.now ?? Date.now
  const sum: ObserveSummary = { checked: 0, drifted: 0, gone: 0, failed: 0 }
  const all = await listResources()
  const live = all.filter((r) => r.external_id)
  if (!live.length) return sum
  const busy = await resourcesInFlight()
  const byConn = new Map<number, HubResourceRow[]>()
  for (const r of live) {
    if (busy.has(r.id)) continue
    const list = byConn.get(r.connection_id) ?? []
    list.push(r)
    byConn.set(r.connection_id, list)
  }
  const byId = new Map(all.map((r) => [r.id, r.external_id]))
  const resolve = (id: number) => byId.get(id) ?? null

  await mapLimit([...byConn.entries()], CONNECTIONS_AT_ONCE, async ([connectionId, rows]) => {
    const connRow = await readConnection(connectionId)
    if (!connRow || connRow.status === 'disabled') return
    let conn: OpenConn | null
    try {
      conn = await openConnection(connRow)
    } catch {
      sum.failed += 1
      return
    }
    if (!conn) return
    // Stalest first (never observed first), capped so one connection cannot own the tick.
    rows.sort((a, b) => (a.observed_at ?? '').localeCompare(b.observed_at ?? ''))
    const todo = rows.slice(0, MAX_PER_CONNECTION)
    const ac = new AbortController()
    const started = clock()
    const timer = setTimeout(() => ac.abort(), budget)
    let streak = 0
    try {
      await mapLimit(todo, RESOURCES_AT_ONCE, async (row) => {
        if (ac.signal.aborted || clock() - started >= budget || streak >= FAIL_STREAK_STOP) return
        const r = await observeRow(conn as OpenConn, row, resolve, ac.signal).catch(
          (): ObserveResult => ({
            resourceId: row.id,
            outcome: 'failed',
            drift: row.drift,
            fields: []
          })
        )
        if (r.outcome === 'failed') {
          sum.failed += 1
          streak += 1
          return
        }
        if (r.outcome === 'skipped') return
        streak = 0
        sum.checked += 1
        if (r.drift) sum.drifted += 1
        if (r.outcome === 'gone') sum.gone += 1
      })
    } finally {
      clearTimeout(timer)
    }
  })
  return sum
}

/**
 * Registers the 15-minute job. The cron plugin holds the one-leader Redis lease and ticks only
 * where cronTicksEnabled(); this adds the Hub-mode check. Call once from the Hub provider routes.
 */
export function registerResourceObserveCron(app: FastifyInstance): void {
  if (!hubModeEnabled() || !app.cron) return
  app.cron.schedule(
    'hub-resources-observe', // a literal: cron-scope.guard reads the id from the source
    OBSERVE_CRON,
    async () => {
      if (!hubModeEnabled()) return
      const r = await observeAll()
      if (r.drifted || r.gone || r.failed)
        app.log.info(
          `${OBSERVE_JOB}: ${r.checked} checked, ${r.drifted} drifted, ${r.gone} gone, ${r.failed} failed`
        )
    },
    {
      quiet: true,
      idempotent: 'safe',
      description:
        'Every 15 minutes (Hub only) — reads every provider resource the Hub manages and stores what it sees plus a drift flag. Never changes anything at a provider; a person chooses Re-apply or Accept.'
    }
  )
}

// ── Who may use a connection ──

async function ownedAppIds(userId: string): Promise<number[]> {
  const rows = (await db('nivaro_hub_app_owners')
    .where({ user_id: userId })
    .select('app_id')) as Array<{ app_id: unknown }>
  return rows.map((r) => Number(r.app_id))
}

async function allowedFor(appIds: number[], connectionId: number): Promise<boolean> {
  if (!appIds.length) return false
  const hit = await db(APP_CONNECTIONS)
    .where({ connection_id: connectionId })
    .whereIn('app_id', appIds)
    .first('app_id')
  return !!hit
}

function providerFailure(ctx: ProviderContext, e: unknown): ResourceChangeError {
  const msg = ctx.scrub(e instanceof Error ? e.message : String(e))
  const retryable = e instanceof ProviderError ? e.retryable : false
  return new ResourceChangeError('PROVIDER_ERROR', msg, { retryable })
}

const isHubTagged = (tags: Record<string, string> | undefined) =>
  Object.keys(tags ?? {}).some((k) => k.startsWith(HUB_TAG_PREFIX))

// ── Unmanaged ──

/**
 * What the connection can see of `type` that the Hub does not manage. Hub admins use any
 * connection; an owner only one allowed for an app they own. A page is filtered after the
 * adapter answers it, so it can hold fewer items than the provider's page; up to a few pages are
 * read to find something to show, and `cursor` continues from the last one read.
 */
export async function listUnmanaged(
  connectionId: number,
  type: string,
  cursor: string | undefined,
  actor: HubActor
): Promise<ListPage> {
  const connRow = await readConnection(connectionId)
  if (!connRow) throw new ResourceChangeError('CONNECTION_NOT_FOUND', 'Connection not found.')
  if (!actor.isAdmin && !(await allowedFor(await ownedAppIds(actor.id), connectionId)))
    throw new ResourceChangeError(
      'CONNECTION_NOT_ALLOWED',
      'This connection is not allowed for any of your apps.'
    )
  const t = findType(type)
  if (!t || t.provider.key !== connRow.provider)
    throw new ResourceChangeError(
      'UNKNOWN_TYPE',
      `Unknown resource type ${type} for this connection.`
    )
  if (!t.type.capabilities.adopt)
    throw new ResourceChangeError('CAPABILITY_MISSING', `${t.type.label} cannot be adopted.`)
  const conn = await openConnection(connRow)
  if (!conn)
    throw new ResourceChangeError('UNKNOWN_TYPE', 'This connection’s provider is not available.')

  const managed = new Set(
    (await listResources({ connectionId, type })).map((r) => r.external_id).filter(Boolean)
  )
  const items: Observed[] = []
  let next: string | null = cursor ?? null
  for (let page = 0; page < UNMANAGED_PAGES; page++) {
    const ctx = ctxFor(conn, regionOf(connRow.config, null))
    let got: ListPage
    try {
      got = await conn.adapter.list(ctx, type, next)
    } catch (e) {
      throw providerFailure(ctx, e)
    }
    for (const o of got.items) {
      if (managed.has(o.externalId) || isHubTagged(o.tags)) continue
      items.push(scrubObserved(t.type, o))
    }
    next = got.cursor
    if (items.length || !next) break
  }
  return { items, cursor: next }
}

// ── Adopt ──

export interface AdoptInput {
  type: string
  externalId: string
  scope: ResourceScope
  appId?: number
  environmentId?: number
}

/**
 * Binds an existing provider resource to an app + environment (or shared) with no write at the
 * provider. Shared scope is for Hub admins; an owner adopts only through a connection allowed for
 * their own app. Writes one row and the audit entry `hub-resource-adopt`.
 */
export async function adoptResource(
  connectionId: number,
  input: AdoptInput,
  actor: HubActor
): Promise<HubResourceRow> {
  if (actor.via === 'mcp')
    throw new ResourceChangeError(
      'HUB_WRITE_NOT_FOR_AGENTS',
      'Adopting is not available to agents.'
    )
  if (actor.via === 'view_as')
    throw new ResourceChangeError(
      'DELEGATED_NO_WRITE',
      'Adopting is not available while viewing as someone.'
    )
  const connRow = await readConnection(connectionId)
  if (!connRow) throw new ResourceChangeError('CONNECTION_NOT_FOUND', 'Connection not found.')
  const t = findType(input.type)
  if (!t || t.provider.key !== connRow.provider)
    throw new ResourceChangeError(
      'UNKNOWN_TYPE',
      `Unknown resource type ${input.type} for this connection.`
    )
  if (!t.type.capabilities.adopt)
    throw new ResourceChangeError('CAPABILITY_MISSING', `${t.type.label} cannot be adopted.`)
  if (typeof input.externalId !== 'string' || !input.externalId.trim())
    throw new ResourceChangeError('INVALID_FIELDS', 'externalId is required.')
  if (input.scope !== t.type.scope)
    throw new ResourceChangeError(
      'INVALID_FIELDS',
      `${t.type.label} is a ${t.type.scope} resource; it cannot be adopted as ${input.scope}.`
    )

  let appId: number | null = null
  let environmentId: number | null = null
  if (input.scope === 'shared') {
    if (!actor.isAdmin)
      throw new ResourceChangeError(
        'SHARED_ADMIN_ONLY',
        'Only Hub administrators manage shared resources.'
      )
  } else {
    if (!Number.isInteger(input.appId) || !Number.isInteger(input.environmentId))
      throw new ResourceChangeError('INVALID_FIELDS', 'An app and an environment are required.')
    appId = Number(input.appId)
    environmentId = Number(input.environmentId)
    const env = (await db('nivaro_hub_environments')
      .where({ id: environmentId })
      .first('id', 'app_id')) as { id: number; app_id: number } | undefined
    if (!env || Number(env.app_id) !== appId)
      throw new ResourceChangeError('NOT_FOUND', 'That environment is not part of that app.')
    if (!actor.isAdmin) {
      if (!(await ownedAppIds(actor.id)).includes(appId))
        throw new ResourceChangeError(
          'ADMIN_ONLY',
          'Only the app’s owners or Hub administrators can adopt for this app.'
        )
      if (!(await allowedFor([appId], connectionId)))
        throw new ResourceChangeError(
          'CONNECTION_NOT_ALLOWED',
          'This connection is not allowed for this app.'
        )
    }
  }

  const externalId = input.externalId.trim()
  if (await listResources({ connectionId, type: input.type, externalId }).then((r) => r.length))
    throw new ResourceChangeError(
      'RESOURCE_ALREADY_MANAGED',
      'The Hub already manages this resource.'
    )

  const conn = await openConnection(connRow)
  if (!conn)
    throw new ResourceChangeError('UNKNOWN_TYPE', 'This connection’s provider is not available.')
  const ctx = ctxFor(conn, regionOf(connRow.config, null))
  let seen: Observed | null
  try {
    seen = await conn.adapter.observe(ctx, input.type, externalId)
  } catch (e) {
    throw providerFailure(ctx, e)
  }
  if (!seen) throw new ResourceChangeError('NOT_FOUND', 'The provider does not have that resource.')
  if (isHubTagged(seen.tags) && seen.tags[`${HUB_TAG_PREFIX}resource`]) {
    const owner = await readResource(Number(seen.tags[`${HUB_TAG_PREFIX}resource`]))
    if (owner && !owner.deleted_at)
      throw new ResourceChangeError(
        'RESOURCE_ALREADY_MANAGED',
        'The Hub already manages this resource.'
      )
  }

  const stored = scrubObserved(t.type, seen)
  // Provider ids of other managed resources → rows, so ref fields become real refs.
  const peers = await listResources({ connectionId })
  const byExternal = new Map(peers.map((p) => [`${p.type}\0${p.external_id}`, p.id]))
  const { desired, refs } = desiredFromObserved(
    t.type,
    stored,
    (refType, id) => byExternal.get(`${refType}\0${id}`) ?? null
  )
  let row: HubResourceRow
  try {
    row = await insertResource({
      connection_id: connectionId,
      provider: connRow.provider,
      type: input.type,
      external_id: externalId,
      name: stored.name,
      scope: input.scope,
      app_id: appId,
      environment_id: environmentId,
      desired,
      observed: stored,
      drift: false,
      observed_at: new Date(),
      tags: stored.tags ?? {},
      refs,
      created_by: actor.id,
      adopted: true
    })
  } catch (e) {
    if (e instanceof HubProviderStoreError && e.code === 'RESOURCE_ALREADY_MANAGED')
      throw new ResourceChangeError('RESOURCE_ALREADY_MANAGED', e.message)
    throw e
  }
  await logActivity({
    action: 'hub-resource-adopt',
    user: actor.id,
    collection: 'nivaro_hub_resources',
    item: String(row.id),
    comment: JSON.stringify({
      connection_id: connectionId,
      type: input.type,
      external_id: externalId,
      scope: input.scope,
      app_id: appId,
      environment_id: environmentId
    })
  }).catch(() => null)
  return row
}
