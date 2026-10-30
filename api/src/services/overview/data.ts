import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { NIVARO_VERSION } from '../../version.js'
import { type ActivityEntryInput, renderActivitySentence } from '../activity-sentence.js'
import { tenantState } from '../ai-tenant-state.js'
import { CONFIG_TABLES } from '../config-inventory.js'
import { isDbHealthy } from '../db-health.js'
import { listInstances } from '../instance-roster.js'
import { isMachineAccount } from '../machine-accounts.js'
import { poolPressure } from '../pool-attribution.js'
import { readGateStats, sharedGatedRead, withReadGate } from '../read-gate.js'
import { readReadiness } from '../readiness.js'
import { collectionTitle } from '../record-label-fallback.js'
import {
  type AdminNeedsFacts,
  adminNeedsYou,
  bucketTimeline,
  type DayAsk,
  dayBounds,
  healthStatus,
  isSlow,
  type JobRunFact,
  jobProblems,
  orderNeedsYou,
  type PersonalNeedsFacts,
  type ProblemCandidate,
  personalNeedsYou,
  plural,
  rankProblems,
  type Timeline,
  type TimelineMark
} from './logic.js'

/**
 * Overview section loaders. Every figure about a person is counted AS that person (My Work's own
 * waiting-on-me service, their own tasks and notifications); the admin-only loaders are called
 * only behind requireAdmin. Heavy reads hold a read-gate slot and are memoised briefly — per
 * person for personal facts, per tenant for admin-wide facts (every administrator sees the same).
 */

const DAY_MS = 86_400_000

// ─── Small helpers ───────────────────────────────────────────────────────────

const memoStore = tenantState(() => new Map<string, { at: number; value: Promise<unknown> }>())

/** Remember `fn`'s answer for `ttlMs` (per tenant); a failed answer is never kept. */
export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const store = memoStore()
  const hit = store.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>
  const value = fn()
  store.set(key, { at: Date.now(), value })
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key)
  })
  if (store.size > 2000) {
    for (const [k, v] of store) if (Date.now() - v.at >= ttlMs) store.delete(k)
  }
  return value
}

const tableProbe = tenantState(() => new Map<string, Promise<boolean>>())

function hasTable(name: string): Promise<boolean> {
  const store = tableProbe()
  let p = store.get(name)
  if (!p) {
    p = db.schema.hasTable(name).catch(() => false)
    store.set(name, p)
  }
  return p
}

const num = (row: unknown): number => {
  const r = row as Record<string, unknown> | undefined
  if (!r) return 0
  const v = r.n ?? r.count ?? Object.values(r)[0]
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

async function count(fn: () => PromiseLike<unknown>): Promise<number> {
  try {
    const rows = (await fn()) as unknown
    return num(Array.isArray(rows) ? rows[0] : rows)
  } catch {
    return 0
  }
}

// ─── Needs you ───────────────────────────────────────────────────────────────

async function personalFacts(user: User, day: DayAsk): Promise<PersonalNeedsFacts> {
  const userId = String(user.id)
  const { start, end } = dayBounds(day.today, day.tzOffset)
  const waiting = memo(`needs:waiting:${userId}`, 60_000, () =>
    withReadGate(
      userId,
      async () => {
        const { waitingOnMe } = await import('../waiting-on-me.js')
        return waitingOnMe(user, { limit: 1 })
      },
      { label: 'overview:waiting-on-me' }
    )
  ).catch(() => null)
  const openTasks = () =>
    db('nivaro_tasks')
      .where('assignee', userId)
      .whereIn('status', ['open', 'in_progress'])
      .where((w) => w.whereNull('kind').orWhereNot('kind', 'support'))
  const [w, overdue, dueToday, mentions] = await Promise.all([
    waiting,
    count(() => openTasks().where('due_date', '<', start).count({ n: '*' })),
    count(() =>
      openTasks().where('due_date', '>=', start).where('due_date', '<', end).count({ n: '*' })
    ),
    count(() =>
      db('nivaro_notifications')
        .where({ recipient: userId, status: 'inbox', category: 'mentions' })
        .count({ n: '*' })
    )
  ])
  return {
    approvals: w?.approvals.length ?? 0,
    waiting: w?.total ?? 0,
    waitingBreached: w?.breached ?? 0,
    tasksOverdue: overdue,
    tasksDueToday: dueToday,
    mentionsUnread: mentions
  }
}

async function adminFacts(userId: string): Promise<AdminNeedsFacts> {
  const since = new Date(Date.now() - DAY_MS)
  const shared = memo('needs:admin', 60_000, async () => {
    const [failedJobs, queueErrors, jobErrors, erpRejects, unassigned, sqlCritical, readiness] =
      await Promise.all([
        count(() =>
          db('nivaro_job_runs')
            .where('status', 'error')
            .where('started_at', '>=', since)
            .count({ n: '*' })
        ),
        hasTable('nivaro_import_queue').then((ok) =>
          ok
            ? count(() =>
                db('nivaro_import_queue')
                  .where('status', 'error')
                  .where('created_at', '>=', since)
                  .count({ n: '*' })
              )
            : 0
        ),
        count(() =>
          db('nivaro_import_jobs')
            .where('status', 'failed')
            .where('created_at', '>=', since)
            .count({ n: '*' })
        ),
        hasTable('nivaro_erp_submissions').then((ok) =>
          ok
            ? count(() =>
                db('nivaro_erp_submissions')
                  .whereIn('status', ['rejected', 'failed'])
                  .where('updated_at', '>=', since)
                  .count({ n: '*' })
              )
            : 0
        ),
        count(() =>
          db('nivaro_tasks')
            .where('kind', 'support')
            .whereIn('status', ['open', 'in_progress'])
            .whereNull('assignee')
            .count({ n: '*' })
        ),
        hasTable('nivaro_sql_check_findings').then((ok) =>
          ok
            ? count(() =>
                db('nivaro_sql_check_findings')
                  .where({ status: 'open', severity: 'critical' })
                  .count({ n: '*' })
              )
            : 0
        ),
        readReadiness()
          .then((r) => r.counts.fail ?? 0)
          .catch(() => 0)
      ])
    return {
      failedJobs,
      failedImports: queueErrors + jobErrors,
      erpRejects,
      supportUnassigned: unassigned,
      sqlCritical,
      readinessFail: readiness
    }
  })
  const [facts, mine] = await Promise.all([
    shared,
    count(() =>
      db('nivaro_tasks')
        .where({ kind: 'support', assignee: userId })
        .whereIn('status', ['open', 'in_progress'])
        .count({ n: '*' })
    )
  ])
  return { ...facts, supportMine: mine }
}

export async function loadNeedsYou(user: User, isAdmin: boolean, day: DayAsk = {}) {
  const [personal, admin] = await Promise.all([
    personalFacts(user, day),
    isAdmin ? adminFacts(String(user.id)) : Promise.resolve(null)
  ])
  return {
    items: orderNeedsYou([...(admin ? adminNeedsYou(admin) : []), ...personalNeedsYou(personal)])
  }
}

// ─── Health ──────────────────────────────────────────────────────────────────

/** When the running version first started serving: the oldest live process on it. */
export async function currentDeploy(): Promise<{ version: string; deployed_at: string | null }> {
  const instances = await listInstances().catch(() => [] as Array<Record<string, unknown>>)
  const starts = instances
    .filter((i) => i.version === NIVARO_VERSION && typeof i.started_at === 'string')
    .map((i) => String(i.started_at))
    .sort()
  const fallback = new Date(Date.now() - process.uptime() * 1000).toISOString()
  return { version: NIVARO_VERSION, deployed_at: starts[0] ?? fallback }
}

export async function loadHealth(isAdmin: boolean) {
  const pool = poolPressure('main')
  const gate = readGateStats()
  const slow = isSlow({
    poolWaitP95Ms: pool.wait_p95_ms,
    poolSaturatedPct: pool.saturated_pct,
    gateQueued: gate.queued
  })
  const dbHealthy = isDbHealthy()
  if (!isAdmin) {
    const { status, headline } = healthStatus({ dbHealthy, slow })
    // A person who is not an administrator hears only whether things are working.
    return { status: status === 'attention' ? 'ok' : status, headline }
  }
  // The cached scorecard — never ?fresh (that runs every check live).
  const report = await readReadiness().catch(() => null)
  const readiness = report
    ? {
        fail: report.counts.fail ?? 0,
        warn: report.counts.warn ?? 0,
        error: report.counts.error ?? 0
      }
    : null
  const { status, headline } = healthStatus({ dbHealthy, slow, readiness })
  const deploy = await currentDeploy()
  return {
    status,
    headline,
    version: deploy.version,
    deployed_at: deploy.deployed_at,
    readiness: readiness
      ? {
          ...readiness,
          score: report?.score ?? null,
          computed_at: report?.computed_at ?? null,
          refreshing: !!report?.refreshing
        }
      : null
  }
}

// ─── Following ───────────────────────────────────────────────────────────────

export interface FollowedThing {
  key: string
  kind: 'record' | 'collection' | 'queue' | 'field'
  label: string
  detail: string | null
  href: string
  unread: number
  collection: string | null
  item: string | null
}

export async function loadFollowing(user: User, isAdmin: boolean): Promise<FollowedThing[]> {
  const userId = String(user.id)
  const [subs, watches] = await Promise.all([
    db('nivaro_notification_subscriptions')
      .where({ user: userId, is_active: true })
      .orderBy('created_at', 'desc')
      .limit(100)
      .select('id', 'collection', 'queue_id', 'filter_field', 'filter_value', 'label')
      .catch(() => [] as Array<Record<string, unknown>>),
    db('nivaro_field_watch_subscribers as s')
      .join('nivaro_field_watches as w', 'w.id', 's.watch')
      .where('s.user', userId)
      .where((q) => q.where('s.is_active', true).orWhereNull('s.is_active'))
      .where('w.is_active', true)
      .orderBy('w.id', 'desc')
      .limit(100)
      .select('w.id', 'w.collection', 'w.field', 'w.item_id', 'w.name')
      .catch(() => [] as Array<Record<string, unknown>>)
  ])
  type Raw = {
    kind: FollowedThing['kind']
    key: string
    collection: string | null
    item: string | null
    field?: string | null
    queue?: string | null
    label?: string | null
  }
  // A subscription saved as "Workflow state: waiting_on_po" names the state by its key; show the
  // state's label ("Workflow state: Waiting on PO") — pipeline state labels, else the key in words.
  const keyed = (subs as Array<Record<string, unknown>>).filter(
    (s) => typeof s.label === 'string' && /: [a-z0-9]+(?:_[a-z0-9]+)+$/.test(s.label as string)
  )
  const stateLabel = new Map<string, string>()
  if (keyed.length > 0) {
    const keys = [...new Set(keyed.map((s) => String(s.label).split(': ').pop() as string))]
    const rows = (await db('nivaro_workflow_states')
      .whereIn('key', keys)
      .select('key', 'label')
      .catch(() => [])) as Array<{ key: string; label: string | null }>
    for (const r of rows) if (r.label && !stateLabel.has(r.key)) stateLabel.set(r.key, r.label)
  }
  const plainLabel = (label: unknown): string | null => {
    if (typeof label !== 'string') return null
    const m = /^(.*): ([a-z0-9]+(?:_[a-z0-9]+)+)$/.exec(label)
    if (!m) return label
    const words = m[2].replace(/_/g, ' ')
    return `${m[1]}: ${stateLabel.get(m[2]) ?? words.charAt(0).toUpperCase() + words.slice(1)}`
  }
  const raw: Raw[] = []
  for (const s of subs as Array<Record<string, unknown>>) {
    if (s.queue_id) {
      raw.push({
        kind: 'queue',
        key: `queue:${s.queue_id}`,
        collection: null,
        item: null,
        queue: String(s.queue_id),
        label: plainLabel(s.label)
      })
    } else if (s.collection && s.filter_field === 'id' && s.filter_value != null) {
      raw.push({
        kind: 'record',
        key: `record:${s.collection}:${s.filter_value}`,
        collection: String(s.collection),
        item: String(s.filter_value),
        label: plainLabel(s.label)
      })
    } else if (s.collection) {
      raw.push({
        kind: 'collection',
        key: `collection:${s.collection}:${s.id}`,
        collection: String(s.collection),
        item: null,
        label: plainLabel(s.label)
      })
    }
  }
  for (const w of watches as Array<Record<string, unknown>>) {
    const c = String(w.collection ?? '')
    if (!c) continue
    if (w.item_id != null && String(w.item_id) !== '')
      raw.push({
        kind: 'record',
        key: `record:${c}:${w.item_id}`,
        collection: c,
        item: String(w.item_id),
        field: String(w.field ?? '')
      })
    else
      raw.push({
        kind: 'field',
        key: `field:${w.id}`,
        collection: c,
        item: null,
        field: String(w.field ?? ''),
        label: (w.name as string) ?? null
      })
  }
  // A record followed two ways (bell + field watch) is one line.
  const merged = new Map<string, Raw & { fields: string[] }>()
  for (const r of raw) {
    const prev = merged.get(r.key)
    if (prev) {
      if (r.field) prev.fields.push(r.field)
      continue
    }
    merged.set(r.key, { ...r, fields: r.field ? [r.field] : [] })
  }
  const list = [...merged.values()].slice(0, 60)
  if (list.length === 0) return []

  // Labels and visibility AS THE VIEWER: a record they can no longer read drops out.
  const { activityLabelsFor } = await import('../activity-readable.js')
  const refs = list
    .filter((r) => r.kind === 'record')
    .map((r) => ({ collection: r.collection, id: r.item }))
  const collections = [...new Set(list.map((r) => r.collection).filter((c): c is string => !!c))]
  const fields = list.flatMap((r) => r.fields.map((f) => ({ collection: r.collection, field: f })))
  const labels = await activityLabelsFor(user, { refs, collections, fields }, { isAdmin }).catch(
    () => null
  )
  const collName = (c: string): string | null => {
    const v = labels?.collections?.[c]
    if (!v) return null
    if (typeof v === 'string') return v
    const names = v as { plural?: string; singular?: string; display?: string }
    return names.plural ?? names.display ?? names.singular ?? null
  }
  const fieldName = (c: string, f: string) => labels?.fields?.[`${c}.${f}`] ?? f

  const queueIds = list.filter((r) => r.kind === 'queue').map((r) => r.queue as string)
  const queues = queueIds.length
    ? ((await db('nivaro_queues')
        .whereIn('id', queueIds)
        .select('id', 'name', 'owner', 'is_shared', 'role_id')
        .catch(() => [])) as Array<{
        id: string
        name: string
        owner: string | null
        is_shared: boolean | number | null
        role_id: string | null
      }>)
    : []
  const { canUserReadQueue } = await import('../queue-access.js')
  const queueById = new Map(
    queues
      .filter((q) => canUserReadQueue(q, user, isAdmin))
      .map((q) => [String(q.id).toLowerCase(), q])
  )

  // Unread changes: the person's own inbox, per record and per collection.
  const unreadRows = (await db('nivaro_notifications')
    .where({ recipient: userId, status: 'inbox' })
    .whereNotNull('collection')
    .whereIn('collection', collections.length ? collections : ['__none__'])
    .groupBy('collection', 'item')
    .select('collection', 'item')
    .count({ n: '*' })
    .catch(() => [])) as Array<{ collection: string; item: string | null; n: number | string }>
  const unreadByRecord = new Map<string, number>()
  const unreadByCollection = new Map<string, number>()
  for (const u of unreadRows) {
    const n = Number(u.n) || 0
    unreadByCollection.set(u.collection, (unreadByCollection.get(u.collection) ?? 0) + n)
    if (u.item != null) unreadByRecord.set(`${u.collection}:${u.item}`, n)
  }

  const out: FollowedThing[] = []
  for (const r of list) {
    if (r.kind === 'queue') {
      const q = queueById.get(String(r.queue).toLowerCase())
      if (!q) continue
      out.push({
        key: r.key,
        kind: 'queue',
        label: q.name,
        detail: 'Queue',
        href: `/queues/${q.id}`,
        unread: 0,
        collection: null,
        item: null
      })
      continue
    }
    const c = r.collection as string
    const name = collName(c)
    if (!name) continue // the viewer can no longer read this collection
    if (r.kind === 'record') {
      const label = labels?.records?.[`${c}:${r.item}`]
      if (label == null) continue // hidden from the viewer (or gone)
      out.push({
        key: r.key,
        kind: 'record',
        label,
        detail: r.fields.length
          ? `${name} · watching ${r.fields.map((f) => fieldName(c, f)).join(', ')}`
          : name,
        href: `/collections/${c}/${encodeURIComponent(String(r.item))}`,
        unread: unreadByRecord.get(`${c}:${r.item}`) ?? 0,
        collection: c,
        item: r.item
      })
    } else {
      out.push({
        key: r.key,
        kind: r.kind,
        label:
          r.label?.trim() ||
          (r.kind === 'field' ? `${fieldName(c, r.fields[0] ?? '')} on ${name}` : `All ${name}`),
        detail: r.kind === 'field' ? `Any ${name} record` : name,
        href: `/collections/${c}`,
        unread: unreadByCollection.get(c) ?? 0,
        collection: c,
        item: null
      })
    }
  }
  return out.sort((a, b) => b.unread - a.unread)
}

// ─── Problems (admin) ────────────────────────────────────────────────────────

export async function loadProblems(): Promise<ProblemCandidate[]> {
  return memo('problems', 60_000, async () => {
    const since = new Date(Date.now() - DAY_MS)
    const [runs, sql, readiness] = await Promise.all([
      db('nivaro_job_runs')
        .where('started_at', '>=', since)
        .whereIn('job_id', function () {
          this.from('nivaro_job_runs')
            .distinct('job_id')
            .where('status', 'error')
            .where('started_at', '>=', since)
        })
        .whereIn('status', ['completed', 'error'])
        .orderBy('started_at', 'desc')
        .limit(2000)
        .select('job_id', 'label', 'status', 'started_at')
        .catch(() => []) as Promise<Array<Record<string, unknown>>>,
      hasTable('nivaro_sql_check_findings').then((ok) =>
        ok
          ? db('nivaro_sql_check_findings')
              .where({ status: 'open', severity: 'critical' })
              .count({ n: '*' })
              .min({ since: 'first_seen_at' })
              .first()
              .catch(() => null)
          : null
      ),
      readReadiness().catch(() => null)
    ])
    const out: ProblemCandidate[] = jobProblems(
      (runs as Array<Record<string, unknown>>).map(
        (r): JobRunFact => ({
          job_id: String(r.job_id),
          label: (r.label as string | null) ?? null,
          status: String(r.status),
          started_at: new Date(r.started_at as string).toISOString()
        })
      )
    )
    const sqlRow = sql as { n?: number | string; since?: Date | string | null } | null
    const critical = Number(sqlRow?.n ?? 0)
    if (critical > 0)
      out.push({
        key: 'sql:critical',
        source: 'sql',
        severity: 'critical',
        since: sqlRow?.since ? new Date(sqlRow.since).toISOString() : null,
        sentence: `${plural(critical, 'critical SQL finding')} ${critical === 1 ? 'is' : 'are'} open`,
        href: '/database/sql-checks?tab=findings&severity=critical'
      })
    for (const c of readiness?.checks ?? []) {
      if (c.status !== 'fail') continue
      out.push({
        key: `readiness:${c.id}`,
        source: 'readiness',
        severity: 'critical',
        since: c.computed_at,
        sentence: c.detail ? `${c.label}: ${c.detail}` : `${c.label} is failing`,
        href: '/environments/readiness'
      })
    }
    return rankProblems(out).slice(0, 10)
  })
}

// ─── Timeline (admin) ────────────────────────────────────────────────────────

const CONFIG_CHANGE_TABLES = CONFIG_TABLES.filter((t) => t !== 'nivaro_users')
const NOISE_ACTIONS = ['read', 'login', 'logout', 'config-epoch', 'config-snapshot-store', 'export']

/**
 * A config CHANGE is a write: create / update / delete (and their dashed forms such as
 * `layout-update`, `field-delete`), restore, publish. Running, testing, previewing or reading a
 * config row (a custom query run, a contract test) is not a change.
 */
function onlyConfigWrites(q: { where(cb: (b: any) => void): unknown }, col = 'action'): void {
  q.where((b: any) => {
    b.whereIn(col, ['create', 'update', 'delete', 'restore', 'publish', 'revert', 'adopt'])
    for (const verb of ['create', 'update', 'delete', 'publish', 'restore'])
      b.orWhere(col, 'like', `%-${verb}`)
  })
}

export async function loadTimeline(now = new Date()): Promise<Timeline> {
  return memo('timeline', 60_000, () =>
    sharedGatedRead('overview:timeline', 'overview', async () => {
      const since = new Date(now.getTime() - DAY_MS)
      const [jobs, queue, jobsImports, config, snapshots, deploy] = await Promise.all([
        db('nivaro_job_runs')
          .where('started_at', '>=', since)
          .whereIn('status', ['completed', 'error'])
          .orderBy('started_at', 'desc')
          .limit(3000)
          .select('id', 'job_id', 'label', 'status', 'started_at', 'kind')
          .catch(() => []) as Promise<Array<Record<string, unknown>>>,
        hasTable('nivaro_import_queue').then((ok) =>
          ok
            ? (db('nivaro_import_queue')
                .where('created_at', '>=', since)
                .whereIn('status', ['completed', 'error'])
                .orderBy('created_at', 'desc')
                .limit(300)
                .select('id', 'import_key', 'status', 'row_count', 'created_at', 'finished_at')
                .catch(() => []) as Promise<Array<Record<string, unknown>>>)
            : []
        ),
        db('nivaro_import_jobs')
          .where('created_at', '>=', since)
          .whereIn('status', ['complete', 'failed'])
          .orderBy('created_at', 'desc')
          .limit(200)
          .select('id', 'collection', 'file_name', 'status', 'created_at')
          .catch(() => []) as Promise<Array<Record<string, unknown>>>,
        db('nivaro_activity as a')
          .leftJoin('nivaro_users as u', 'u.id', 'a.user')
          .whereIn('a.collection', CONFIG_CHANGE_TABLES)
          .whereNotIn('a.action', NOISE_ACTIONS)
          .modify((q) => onlyConfigWrites(q, 'a.action'))
          .where('a.timestamp', '>=', since)
          .orderBy('a.timestamp', 'desc')
          .limit(300)
          .select(
            'a.id',
            'a.action',
            'a.user',
            'a.collection',
            'a.item',
            'a.comment',
            'a.timestamp',
            'u.first_name',
            'u.last_name'
          )
          .catch(() => []) as Promise<Array<Record<string, unknown>>>,
        hasTable('nivaro_config_snapshots').then((ok) =>
          ok
            ? (db('nivaro_config_snapshots')
                .where('taken_at', '>=', since)
                .whereIn('trigger', ['pre-deploy', 'pre-migration'])
                .select('id', 'version', 'trigger', 'taken_at')
                .catch(() => []) as Promise<Array<Record<string, unknown>>>)
            : []
        ),
        currentDeploy()
      ])
      const iso = (v: unknown) => new Date(v as string).toISOString()
      const marks: TimelineMark[] = []
      for (const j of jobs) {
        const failed = j.status === 'error'
        const name = String(j.label ?? '').trim() || String(j.job_id)
        marks.push({
          at: iso(j.started_at),
          kind: 'job',
          failed,
          sentence: failed ? `${name} failed` : `${name} ran`,
          href: '/jobs'
        })
      }
      for (const q of queue) {
        const failed = q.status === 'error'
        marks.push({
          at: iso(q.finished_at ?? q.created_at),
          kind: 'import',
          failed,
          sentence: failed
            ? `The ${q.import_key} import failed`
            : `The ${q.import_key} import loaded ${q.row_count != null ? plural(Number(q.row_count), 'row') : 'its rows'}`,
          href: '/imports'
        })
      }
      for (const q of jobsImports) {
        const failed = q.status === 'failed'
        marks.push({
          at: iso(q.created_at),
          kind: 'import',
          failed,
          sentence: failed
            ? `Importing ${q.file_name ?? 'a file'} into ${q.collection} failed`
            : `${q.file_name ?? 'A file'} was imported into ${q.collection}`,
          href: `/imports/${q.id}`
        })
      }
      for (const a of config) {
        marks.push({
          at: iso(a.timestamp),
          kind: 'config',
          failed: false,
          // The shared sentence renderer, without record labels (an id where a name would go).
          sentence: renderActivitySentence(a as unknown as ActivityEntryInput),
          href: `/activity/${a.id}`
        })
      }
      for (const s of snapshots) {
        marks.push({
          at: iso(s.taken_at),
          kind: 'deploy',
          failed: false,
          sentence:
            s.trigger === 'pre-migration'
              ? `Migrations ran for ${s.version ?? 'a new version'}`
              : `A deploy of ${s.version ?? 'a new version'} started`,
          href: '/environments/config'
        })
      }
      if (deploy.deployed_at && new Date(deploy.deployed_at).getTime() >= since.getTime())
        marks.push({
          at: deploy.deployed_at,
          kind: 'deploy',
          failed: false,
          sentence: `Version ${deploy.version} started serving`,
          href: '/environments'
        })
      return bucketTimeline(marks, now)
    }).then((r) => r.value)
  )
}

// ─── Config changes (admin) ──────────────────────────────────────────────────

export async function loadConfigChanges(limit = 5): Promise<Array<Record<string, unknown>>> {
  const since = new Date(Date.now() - 30 * DAY_MS)
  const ids = (await db('nivaro_activity')
    .whereIn('collection', CONFIG_CHANGE_TABLES)
    .whereNotIn('action', NOISE_ACTIONS)
    .modify((q) => onlyConfigWrites(q))
    .where('timestamp', '>=', since)
    .orderBy([
      { column: 'timestamp', order: 'desc' },
      { column: 'id', order: 'desc' }
    ])
    .limit(limit)
    .select('id')) as Array<{ id: number }>
  const { activityPageRows } = await import('../../routes/activity.js')
  return activityPageRows(ids.map((r) => Number(r.id)))
}

// ─── People waiting (admin) ──────────────────────────────────────────────────

export interface WaitingPerson {
  id: string
  name: string
  email: string
  role: string | null
  role_name: string | null
  requested: boolean
  waiting_since: string | null
  reason: string | null
  requested_role: string | null
}

export async function loadPeopleWaiting() {
  const settings = (await db('nivaro_settings')
    .first('new_user_role', 'access_request_role')
    .catch(() => null)) as {
    new_user_role?: string | null
    access_request_role?: string | null
  } | null
  const provisional = [settings?.access_request_role, settings?.new_user_role]
    .filter((r): r is string => !!r)
    .map((r) => String(r).toUpperCase())
  const roles = (await db('nivaro_roles')
    .select('id', 'name', 'admin_access')
    .catch(() => [])) as Array<{
    id: string
    name: string
    admin_access: boolean | number | null
  }>
  const roleName = new Map(roles.map((r) => [String(r.id).toUpperCase(), r.name]))
  const grantable = roles
    .filter((r) => !r.admin_access && !provisional.includes(String(r.id).toUpperCase()))
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (provisional.length === 0)
    return {
      people: [] as WaitingPerson[],
      total: 0,
      grantable_roles: grantable,
      configured: false
    }

  const rows = (await db('nivaro_users')
    .whereIn('role', provisional)
    .where((w) => w.whereNull('status').orWhereNot('status', 'suspended'))
    .orderBy('created_at', 'asc')
    .limit(200)
    .select(
      'id',
      'first_name',
      'last_name',
      'email',
      'role',
      'status',
      'account_kind',
      'preferences',
      'created_at'
    )
    .catch(() => [])) as Array<Record<string, unknown>>
  const people: WaitingPerson[] = []
  for (const r of rows) {
    if (isMachineAccount(r as { account_kind?: string | null; email?: string | null })) continue
    let prefs: Record<string, unknown> = {}
    try {
      prefs =
        typeof r.preferences === 'string'
          ? (JSON.parse(r.preferences) as Record<string, unknown>)
          : ((r.preferences as Record<string, unknown>) ?? {})
    } catch {
      prefs = {}
    }
    const req = (prefs.access_request ?? null) as Record<string, unknown> | null
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
    const role = r.role ? String(r.role).toUpperCase() : null
    const askedRole = req?.role ?? req?.requested_role
    people.push({
      id: String(r.id),
      name: name || String(r.email ?? 'Someone'),
      email: String(r.email ?? ''),
      role,
      role_name: role ? (roleName.get(role) ?? null) : null,
      requested: !!req,
      waiting_since:
        typeof req?.submitted_at === 'string'
          ? req.submitted_at
          : r.created_at
            ? new Date(r.created_at as string).toISOString()
            : null,
      reason: typeof req?.reason === 'string' ? req.reason.slice(0, 300) : null,
      requested_role:
        typeof askedRole === 'string' ? (roleName.get(askedRole.toUpperCase()) ?? null) : null
    })
  }
  // Asked first, then whoever has waited longest.
  people.sort(
    (a, b) =>
      Number(b.requested) - Number(a.requested) ||
      String(a.waiting_since ?? '').localeCompare(String(b.waiting_since ?? ''))
  )
  return {
    people: people.slice(0, 20),
    total: people.length,
    grantable_roles: grantable,
    configured: true
  }
}

// ─── Usage (admin) ───────────────────────────────────────────────────────────

export async function loadUsage() {
  return memo('usage', 5 * 60_000, () =>
    sharedGatedRead('overview:usage', 'overview', async () => {
      const since = new Date(Date.now() - DAY_MS)
      const [busiest, screens, rum] = await Promise.all([
        // The same record changes the "Records changed today" stat counts (overview/stats.ts).
        import('./stats.js')
          .then((m) => m.busiestCollections({ from: since, to: new Date() }, 5))
          .catch((err) => {
            console.warn('[overview] busiest collections failed', (err as Error)?.message)
            return []
          }) as Promise<Array<{ collection: string; n: number | string }>>,
        hasTable('nivaro_page_views').then((ok) =>
          ok
            ? (db('nivaro_page_views')
                .where('viewed_at', '>=', since)
                .groupBy('page_url')
                .select('page_url')
                .count({ n: '*' })
                .countDistinct({ people: 'session_id' })
                .orderBy('n', 'desc')
                .limit(5)
                .catch(() => []) as Promise<
                Array<{ page_url: string; n: number | string; people: number | string }>
              >)
            : []
        ),
        hasTable('nivaro_rum_events').then(async (ok) => {
          if (!ok) return null
          const { rumSummary } = await import('../rum-summary.js')
          return rumSummary(7).catch(() => null)
        })
      ])
      const names = busiest.length
        ? ((await db('nivaro_collections')
            .whereIn(
              'collection',
              busiest.map((b) => b.collection)
            )
            .select('collection', 'display_name')
            .catch(() => [])) as Array<{ collection: string; display_name: string | null }>)
        : []
      const display = new Map(names.map((n) => [n.collection, n.display_name]))
      // Screens with too few samples say more about one slow laptop than about the page.
      const slowest =
        rum?.data
          .filter((r) => r.samples >= 5 && (r.lcp_p75 ?? r.route_p75) != null)
          .slice(0, 1)
          .map((r) => ({
            route: r.route,
            p75_ms: (r.lcp_p75 ?? r.route_p75) as number,
            samples: r.samples
          }))[0] ?? null
      // Most-used screens fall back to RUM route counts where page views are not collected.
      const usedScreens = screens.length
        ? screens.map((s) => ({
            route: s.page_url,
            views: Number(s.n) || 0,
            people: Number(s.people) || 0
          }))
        : (rum?.data ?? [])
            .slice()
            .sort((a, b) => b.samples - a.samples)
            .slice(0, 5)
            .map((r) => ({ route: r.route, views: r.samples, people: null as number | null }))
      return {
        busiest_collections: busiest.map((b) => ({
          collection: b.collection,
          // A collection without a display name reads as words (warehouse_forecast → Warehouse Forecast).
          label: collectionTitle(b.collection, display.get(b.collection)),
          changes: Number(b.n) || 0
        })),
        screens: usedScreens,
        screens_source: screens.length ? 'page_views' : rum ? 'rum' : null,
        slowest_page: slowest
      }
    }).then((r) => r.value)
  )
}
