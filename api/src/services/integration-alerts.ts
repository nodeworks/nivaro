/**
 * Telling a person an obligation is unmet.
 *
 * The reconcile sweep runs every fifteen minutes and an unmet obligation
 * stays unmet on every pass until someone (or something) resolves it, so the
 * dedupe window is what stops this from being noise: one message per record
 * per kind per twelve hours, tracked on the ledger row itself
 * (`nivaro_integration_obligations.notified_at`).
 *
 * Recipients are the record's resolved owners — batched via
 * `resolveStateOwnersBatch`, never per record — plus whoever owns the API
 * (`nivaro_external_apis.owner_user`). Nothing here sends to a partner; it
 * only tells a person the ledger already knows something is wrong.
 *
 * A brand-new instance can wake up with a backlog the sweep finds all at
 * once, so the whole thing is gated behind
 * `nivaro_settings.integration_notifications_enabled` (migration 345, off by
 * default) — an admin turns it on once the ledger looks sane.
 */
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { type DigestLine, type DigestSection, registerDigestSection } from './daily-digest.js'
import { type NotifyUserOptions, notifyUser } from './notification-channels.js'

const DEDUPE_HOURS = 12
/** Outcomes worth waking someone up for — `sent`, `pending`, `skipped` and
 *  `superseded` are all either resolved or not this feature's business. */
const UNMET = ['failed', 'missing', 'overdue'] as const
/** Per sweep. Reconciliation's own EXPECT_CEILING is the honest precedent —
 *  a run past this reports a partial pass rather than quietly working an
 *  arbitrary slice; the row order (oldest due_at first) means the ones
 *  waiting longest are never the ones left out. */
const BATCH = 200
/** How many lines the digest section shows — same cap style as every other
 *  provider in daily-digest.ts (buildNotificationDigestSection's 50, the
 *  ownership bucket's 25). */
const DIGEST_LIMIT = 20

// Module-level app reference — the same `setApp()` shape as hooks/sla.ts and
// hooks/alerts.ts, because `alertUnmetObligations()` is called from
// `runIntegrationReconcile()` (services/integration-reconcile.ts), which has
// no FastifyInstance of its own to thread through: it is the pure sweep body
// `runIntegrationReconcileForCron` wraps, and its own unit tests call it
// bare. `server.ts` calls `setApp(app)` once at boot, before the cron that
// would ever invoke this can tick.
let _app: FastifyInstance | null = null

export function setApp(app: FastifyInstance): void {
  _app = app
}

interface ObligationAlertRow {
  id: number
  api: string
  kind: string
  collection: string
  item: string
  outcome: string
  reason: string | null
  notified_at: Date | null
}

/** The exact instant `windowHours` before `now` — the one boundary both
 *  `shouldNotify` (JS, decides which rows are candidates this sweep) and the
 *  atomic claim UPDATE (SQL, decides which candidate actually gets to send)
 *  must agree on. A row `notified_at` exactly here is "the window has
 *  passed" in both places — `shouldNotify` treats `notified_at <= cutoff` as
 *  true, and the claim's WHERE uses the identical `<=` on this same value,
 *  so a row that qualifies here can never lose its own claim for having
 *  qualified. */
export function dedupeCutoff(now: Date, windowHours: number): Date {
  return new Date(now.getTime() - windowHours * 3_600_000)
}

/** Pure — who hears about this row, and has the dedupe window passed? */
export function shouldNotify(
  row: { outcome: string; notified_at: Date | null },
  now: Date,
  windowHours: number
): boolean {
  if (!(UNMET as readonly string[]).includes(row.outcome)) return false
  if (!row.notified_at) return true
  return new Date(row.notified_at).getTime() <= dedupeCutoff(now, windowHours).getTime()
}

async function notificationsEnabled(): Promise<boolean> {
  try {
    const row = (await db('nivaro_settings').first('integration_notifications_enabled')) as
      | { integration_notifications_enabled?: boolean | number | null }
      | undefined
    return (
      row?.integration_notifications_enabled === true ||
      row?.integration_notifications_enabled === 1
    )
  } catch {
    return false
  }
}

/**
 * Resolved current-state owners for a batch of (collection, item) pairs, in
 * one round trip per distinct collection plus ONE call to
 * `resolveStateOwnersBatch` — never a per-record lookup. A pair with no open
 * workflow instance simply contributes no owners; the API's own owner still
 * reaches them.
 *
 * Returned ids are UPPERCASED (same normalization `recipientOwnsRecord` in
 * notification-channels.ts already uses for the same reason): a uuid can
 * come back from SQL Server in either case depending on the column, and an
 * unnormalized comparison would either double-notify the same person under
 * two spellings of their id, or silently miss that a digest row is theirs.
 * Every caller of this function compares against an ALSO-uppercased id.
 */
async function batchRecordOwners(
  pairs: Array<{ collection: string; item: string }>
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (pairs.length === 0) return out

  const byCollection = new Map<string, Set<string>>()
  for (const p of pairs) {
    if (!p.collection || !p.item) continue
    const set = byCollection.get(p.collection) ?? new Set<string>()
    set.add(p.item)
    byCollection.set(p.collection, set)
  }
  if (byCollection.size === 0) return out

  const instances: Array<{
    collection: string
    item: string
    id: string
    current_state: string
  }> = []
  for (const [collection, items] of byCollection) {
    try {
      const rows = (await db('nivaro_workflow_instances')
        .where({ collection })
        .whereIn('item', [...items])
        .whereNull('completed_at')
        .select('collection', 'item', 'id', 'current_state')) as typeof instances
      instances.push(...rows)
    } catch {
      /* one broken collection lookup must not lose the rest */
    }
  }
  if (instances.length === 0) return out

  const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
  const key = (collection: string, item: string) => `${collection}::${item}`
  const requests = instances.map((inst) => ({
    key: key(inst.collection, inst.item),
    stateId: String(inst.current_state),
    instanceId: String(inst.id),
    collection: inst.collection,
    itemId: String(inst.item)
  }))
  const resolved = await resolveStateOwnersBatch(requests, db)
  for (const inst of instances) {
    const k = key(inst.collection, inst.item)
    out.set(
      k,
      (resolved.get(k) ?? []).map((o) => String(o.id).toUpperCase())
    )
  }
  return out
}

/** Newest first, oldest due_at first — the rows waiting longest are the ones
 *  the batch cap must never silently drop. */
async function fetchUnmetRows(limit: number): Promise<ObligationAlertRow[]> {
  return (await db('nivaro_integration_obligations')
    .whereIn('outcome', UNMET)
    .orderBy('due_at', 'asc')
    .limit(limit)
    .select(
      'id',
      'api',
      'kind',
      'collection',
      'item',
      'outcome',
      'reason',
      'notified_at'
    )) as ObligationAlertRow[]
}

async function apiOwnerMap(): Promise<Map<string, string | null>> {
  const rows = (await db('nivaro_external_apis').select('name', 'owner_user')) as Array<{
    name: string
    owner_user: string | null
  }>
  return new Map(rows.map((a) => [a.name, a.owner_user]))
}

const recordKey = (collection: string, item: string) => `${collection}::${item}`

/**
 * Does this obligation point at a record a person can actually open?
 *
 * Not every kind's `item` is a record id. An inbound kind derived from the
 * API log carries `collection: 'nivaro_api_logs'` and a BUCKET KEY for an
 * item (`workflows:371396`, `/graphql@2026-09-23T14`) — a `nivaro_` table is
 * never a registered collection, so a record link built from that pair lands
 * on an error page. Those rows link to the board instead, which is where the
 * row actually lives. */
function isRoutableRecord(collection: string): boolean {
  return !!collection && !/^nivaro_/i.test(collection)
}

export async function alertUnmetObligations(): Promise<{ notified: number }> {
  const app = _app
  if (!app) return { notified: 0 }
  if (!(await notificationsEnabled())) return { notified: 0 }

  const now = new Date()
  const rows = await fetchUnmetRows(BATCH)
  const due = rows.filter((r) => shouldNotify(r, now, DEDUPE_HOURS))
  if (due.length === 0) return { notified: 0 }

  const [apiOwners, recordOwners] = await Promise.all([
    apiOwnerMap().catch(() => new Map<string, string | null>()),
    batchRecordOwners(due.map((r) => ({ collection: r.collection, item: r.item })))
  ])

  const cutoff = dedupeCutoff(now, DEDUPE_HOURS)
  let notified = 0
  let recipientless = 0

  for (const r of due) {
    // Claim the row FIRST, atomically, with the exact same dedupe boundary
    // `shouldNotify` just evaluated (`<=`, not `<` — a row exactly at the
    // cutoff already passed `shouldNotify` and must not lose its own claim
    // for it) — a second replica racing this row loses the claim (0 rows
    // affected) and skips instead of notifying twice. Claimed REGARDLESS of
    // whether a recipient resolves below: a row nobody can be told about
    // right now (no API owner, no open record instance) would otherwise
    // never get `notified_at` stamped and would occupy this sweep's BATCH
    // cap on every future 15-minute pass, forever, starving genuinely
    // notifiable rows out of the batch.
    let claimed = 0
    try {
      claimed = await db('nivaro_integration_obligations')
        .where({ id: r.id })
        .where((qb) => qb.whereNull('notified_at').orWhere('notified_at', '<=', cutoff))
        .update({ notified_at: now })
    } catch {
      claimed = 0
    }
    if (!claimed) continue

    const recipients = new Set<string>()
    const apiOwner = apiOwners.get(r.api)
    if (apiOwner) recipients.add(apiOwner.toUpperCase())
    for (const uid of recordOwners.get(recordKey(r.collection, r.item)) ?? []) recipients.add(uid)
    if (recipients.size === 0) {
      recipientless++
      continue
    }

    const routable = isRoutableRecord(r.collection)
    const { resolveFriendlyId } = await import('./workflow-transitions.js')
    const label = routable
      ? await resolveFriendlyId(r.collection, r.item).catch(() => `${r.collection} #${r.item}`)
      : `${r.kind} · ${r.item}`
    const why = r.reason
      ? `${r.api} was never told — ${r.reason}`
      : `${r.api} has not received this — it is ${r.outcome}.`

    for (const userId of recipients) {
      const opts: NotifyUserOptions = {
        subject: `Integration: ${r.api} has not got ${label}`,
        message: r.reason ?? `${r.kind} is ${r.outcome}.`,
        category: 'integrations',
        collection: r.collection,
        item: r.item,
        // `action: 'review'` (rather than the default 'open') is what makes
        // notifyUser's own lane computation land on `needs_you` — a plain
        // record target with no action, or one only an owner reads as
        // "theirs", would leave the API owner (who may not own the record)
        // sitting in the FYI lane, which spec §2.4.4 does not want.
        //
        // A row whose "record" is not one (an inbound bucket key) carries no
        // record id at all: `kind: 'integration'` without one resolves to the
        // board, rather than to a record URL that cannot open.
        target: routable
          ? { kind: 'record', collection: r.collection, id: r.item, action: 'review' }
          : { kind: 'integration', action: 'review' },
        source: { kind: 'integration', label: `${r.api} · ${r.kind}`, id: r.id },
        why
      }
      await notifyUser(app, userId, opts).catch(() => undefined)
      notified++
    }
  }
  if (recipientless > 0) {
    console.warn(
      `[integration-alerts] ${recipientless} unmet obligation(s) claimed this sweep with no ` +
        'resolvable recipient (no API owner, no open record instance to own it) — skipped, and ' +
        'will not be reconsidered until the 12h dedupe window opens again'
    )
  }
  return { notified }
}

interface DigestPassData {
  rows: ObligationAlertRow[]
  apiOwners: Map<string, string | null>
  recordOwners: Map<string, string[]>
  at: number
}

/** daily-digest.ts calls this provider once PER USER, within one digest
 *  tick — `registerDigestSection` gives it no notion of "this run" to key a
 *  cache on, so a short TTL memo does the same job: the unmet-row fetch,
 *  every API's owner and the batched record-owner resolution happen ONCE
 *  for the whole pass, and every user in that pass reads the same three
 *  maps instead of re-querying and re-resolving them from scratch. 60s
 *  (same duration as notification-channels.ts's own prefsCache) comfortably
 *  covers one pass's per-user loop; a pass that somehow outlives it just
 *  re-fetches for whoever is left — self-healing, never a correctness
 *  issue, only ever a cost one. */
const DIGEST_PASS_CACHE_TTL_MS = 60_000
let digestPassCache: DigestPassData | null = null

async function digestPassData(): Promise<DigestPassData> {
  if (digestPassCache && Date.now() - digestPassCache.at < DIGEST_PASS_CACHE_TTL_MS) {
    return digestPassCache
  }
  const rows = await fetchUnmetRows(BATCH)
  const [apiOwners, recordOwners] = await Promise.all([
    apiOwnerMap().catch(() => new Map<string, string | null>()),
    batchRecordOwners(rows.map((r) => ({ collection: r.collection, item: r.item })))
  ])
  digestPassCache = { rows, apiOwners, recordOwners, at: Date.now() }
  return digestPassCache
}

/** Rows relevant to ONE user: obligations on an API they own, or on a
 *  record they resolve as an owner of — read from the one shared pass
 *  computed above, never a fresh query per user. */
async function integrationsForUser(userId: string): Promise<ObligationAlertRow[]> {
  const { rows, apiOwners, recordOwners } = await digestPassData()
  if (rows.length === 0) return []
  const me = userId.toUpperCase()
  return rows.filter((r) => {
    const apiOwner = apiOwners.get(r.api)
    if (apiOwner && apiOwner.toUpperCase() === me) return true
    return (recordOwners.get(recordKey(r.collection, r.item)) ?? []).includes(me)
  })
}

async function buildIntegrationDigestSection(userId: string): Promise<DigestSection | null> {
  // The SAME gate `alertUnmetObligations` checks, for the same reason: a
  // deployment that has not turned integration notifications on must not be
  // told about its backlog through the back door of the daily digest. Off is
  // off on every path, not only the one that sends immediately.
  if (!(await notificationsEnabled())) return null

  const mine = await integrationsForUser(userId)
  if (mine.length === 0) return null

  const { resolveFriendlyId } = await import('./workflow-transitions.js')
  const board = `${config.ADMIN_URL.replace(/\/$/, '')}/integration-health`
  const lines: DigestLine[] = []
  for (const r of mine.slice(0, DIGEST_LIMIT)) {
    // Same rule as the alert target above: a bucket key is not a record, so
    // its line points at the board rather than at a URL that cannot open.
    const routable = isRoutableRecord(r.collection)
    const label = routable
      ? await resolveFriendlyId(r.collection, r.item).catch(() => `${r.collection} #${r.item}`)
      : `${r.kind} · ${r.item}`
    lines.push({
      text: `${r.api} — ${label}: ${r.outcome}`,
      sub: r.reason,
      url: routable ? `${config.ADMIN_URL}/collections/${r.collection}/${r.item}` : board
    })
  }
  return { title: 'Integrations waiting on a human', lines }
}

/** "Integrations waiting on a human" in the daily action digest — the
 *  unmet obligations on records or APIs THIS person owns, gathered once a
 *  day instead of arriving one at a time. */
export function registerIntegrationDigest(): void {
  registerDigestSection(buildIntegrationDigestSection)
}
