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

/** Pure — who hears about this row, and has the dedupe window passed? */
export function shouldNotify(
  row: { outcome: string; notified_at: Date | null },
  now: Date,
  windowHours: number
): boolean {
  if (!(UNMET as readonly string[]).includes(row.outcome)) return false
  if (!row.notified_at) return true
  return now.getTime() - new Date(row.notified_at).getTime() >= windowHours * 3_600_000
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
      (resolved.get(k) ?? []).map((o) => String(o.id))
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

  const cutoff = new Date(now.getTime() - DEDUPE_HOURS * 3_600_000)
  let notified = 0

  for (const r of due) {
    const recipients = new Set<string>()
    const apiOwner = apiOwners.get(r.api)
    if (apiOwner) recipients.add(apiOwner)
    for (const uid of recordOwners.get(recordKey(r.collection, r.item)) ?? []) recipients.add(uid)
    if (recipients.size === 0) continue

    // Claim the row FIRST, atomically, with the exact same dedupe condition
    // `shouldNotify` just evaluated — a second replica racing this row loses
    // the claim (0 rows affected) and skips instead of notifying twice.
    let claimed = 0
    try {
      claimed = await db('nivaro_integration_obligations')
        .where({ id: r.id })
        .where((qb) => qb.whereNull('notified_at').orWhere('notified_at', '<', cutoff))
        .update({ notified_at: now })
    } catch {
      claimed = 0
    }
    if (!claimed) continue

    const { resolveFriendlyId } = await import('./workflow-transitions.js')
    const label = await resolveFriendlyId(r.collection, r.item).catch(
      () => `${r.collection} #${r.item}`
    )
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
        target: { kind: 'record', collection: r.collection, id: r.item, action: 'review' },
        source: { kind: 'integration', label: `${r.api} · ${r.kind}`, id: r.id },
        why
      }
      await notifyUser(app, userId, opts).catch(() => undefined)
      notified++
    }
  }
  return { notified }
}

/** Rows relevant to ONE user: obligations on an API they own, or on a
 *  record they resolve as an owner of. Called once per digest-eligible
 *  user by daily-digest.ts, same shape as its other section providers. */
async function integrationsForUser(userId: string): Promise<ObligationAlertRow[]> {
  const rows = await fetchUnmetRows(BATCH)
  if (rows.length === 0) return []

  const ownedApis = new Set(
    (
      (await db('nivaro_external_apis')
        .where({ owner_user: userId })
        .select('name')
        .catch(() => [])) as Array<{ name: string }>
    ).map((a) => a.name)
  )

  const byApi = rows.filter((r) => ownedApis.has(r.api))
  const rest = rows.filter((r) => !ownedApis.has(r.api))
  const recordOwners = await batchRecordOwners(
    rest.map((r) => ({ collection: r.collection, item: r.item }))
  )
  const byRecord = rest.filter((r) =>
    (recordOwners.get(recordKey(r.collection, r.item)) ?? []).includes(userId)
  )
  return [...byApi, ...byRecord]
}

async function buildIntegrationDigestSection(userId: string): Promise<DigestSection | null> {
  const mine = await integrationsForUser(userId)
  if (mine.length === 0) return null

  const { resolveFriendlyId } = await import('./workflow-transitions.js')
  const lines: DigestLine[] = []
  for (const r of mine.slice(0, DIGEST_LIMIT)) {
    const label = await resolveFriendlyId(r.collection, r.item).catch(
      () => `${r.collection} #${r.item}`
    )
    lines.push({
      text: `${r.api} — ${label}: ${r.outcome}`,
      sub: r.reason,
      url: `${config.ADMIN_URL}/collections/${r.collection}/${r.item}`
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
