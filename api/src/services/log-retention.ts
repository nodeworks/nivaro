import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { hasColumn } from '../lib/column-probe.js'
import { getApp } from './io-holder.js'
import { retentionPassSchedule } from './retention-schedule.js'

/**
 * Retention made visible (#17): every log Nivaro keeps, how long, where that is set, how big
 * it is now and when it is next purged. GET /api/log-retention (admin) → Security & privacy →
 * Log retention.
 *
 * Cheap by construction: row counts come from sys.partitions (SQL Server; no table read), the
 * oldest row is the first row by primary key (one seek), settings are one nivaro_settings read.
 * A log that is not a table (the slow-trace ring, the long-history store) is listed with
 * where it lives instead.
 *
 * Adding a log or changing a prune: add / adjust its entry in LOG_KINDS.
 */

export type PurgeWhen =
  | { kind: 'retention_pass' }
  | { kind: 'cron'; cron: string }
  | { kind: 'log_flush' }
  | { kind: 'never' }
  | { kind: 'elsewhere'; text: string }

export interface SettingsSnapshot {
  activity_retention_days: number | null
  revision_retention_count: number | null
  chat_history_retention_days: number | null
  ai_conversation_retention_days: number | null
  session_recording_retention_days: number | null
  erp_submission_payload_retention_days: number | null
  activity_overrides: number
  trash_overrides: number
}

export interface LogKind {
  key: string
  label: string
  what: string
  /** The table, or null when the log is not a table. */
  table: string | null
  /** Column the oldest-row read returns. */
  timeColumn?: string
  /** First row by this column is the oldest (an identity primary key); default 'id'. */
  orderColumn?: string
  /** Plain text of how long rows are kept, from the settings in force. */
  keep: (s: SettingsSnapshot) => string
  /** Where the window is set. */
  setting: string
  purge: PurgeWhen
  /** The purge skips records under legal hold. */
  holds?: boolean
}

const days = (n: number) => (n === 1 ? '1 day' : `${n} days`)
const envDays = (name: string, dflt: number, min = 1, max = 3650): number => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.trunc(n)) : dflt
}
const dayOr = (v: number | null, dflt: number, zeroForever = true): string => {
  if (v == null) return `${days(dflt)} (default)`
  if (v <= 0 && zeroForever) return 'Kept forever (0 = off)'
  return days(v)
}

export const LOG_KINDS: LogKind[] = [
  {
    key: 'activity',
    label: 'Activity log',
    what: 'Who did what to which record, sign-ins, admin actions, legal holds, chat compliance reads (sealed into the tamper-evident trail)',
    table: 'nivaro_activity',
    timeColumn: 'timestamp',
    keep: (s) =>
      `${s.activity_retention_days ? days(s.activity_retention_days) : 'Kept forever'}${
        s.activity_overrides
          ? ` · ${s.activity_overrides} collection${s.activity_overrides === 1 ? '' : 's'} with their own window`
          : ''
      } · imported history and entries a revision points at are kept`,
    setting:
      'Settings → nivaro_settings.activity_retention_days; per collection: Data model → collection → Activity retention',
    purge: { kind: 'retention_pass' },
    holds: true
  },
  {
    key: 'revisions',
    label: 'Revisions (record history)',
    what: 'Field-by-field before/after of every saved change',
    table: 'nivaro_revisions',
    keep: (s) =>
      s.revision_retention_count
        ? `Newest ${s.revision_retention_count} per record`
        : 'Kept forever',
    setting: 'nivaro_settings.revision_retention_count',
    purge: { kind: 'retention_pass' },
    holds: true
  },
  {
    key: 'trash',
    label: 'Trash',
    what: 'Deleted records, restorable until purged',
    table: 'nivaro_trash',
    timeColumn: 'deleted_at',
    keep: (s) =>
      `30 days${s.trash_overrides ? ` · ${s.trash_overrides} collection${s.trash_overrides === 1 ? '' : 's'} with their own window` : ''}`,
    setting: 'Fixed 30 days; per collection: nivaro_collections.trash_retention_days',
    purge: { kind: 'retention_pass' },
    holds: true
  },
  {
    key: 'api_logs',
    label: 'API request log',
    what: 'Every /api request: route, caller, status, time (Traffic Map, SLOs, API analytics)',
    table: 'nivaro_api_logs',
    timeColumn: 'created_at',
    keep: () => {
      const h = Number(process.env.API_LOGS_DEV_TTL_HOURS)
      const dev = Number.isFinite(h) && h >= 0 ? h : 3
      return `14 days · development-instance rows ${dev === 0 ? 'kept 14 days' : `${dev} hours`}`
    },
    setting: 'Fixed 14 days; API_LOGS_DEV_TTL_HOURS / API_LOGS_DEV_INSTANCES (env)',
    purge: { kind: 'log_flush' }
  },
  {
    key: 'rum_events',
    label: 'Browser timing (RUM)',
    what: 'Page-load and interaction timings browsers report',
    table: 'nivaro_rum_events',
    timeColumn: 'created_at',
    keep: () => '14 days',
    setting: 'Fixed (same pass as the API request log)',
    purge: { kind: 'log_flush' }
  },
  {
    key: 'search_log',
    label: 'Search log',
    what: 'What people searched for and what they opened (search analytics)',
    table: 'nivaro_search_log',
    timeColumn: 'created_at',
    keep: () => days(envDays('SEARCH_LOG_RETENTION_DAYS', 60)),
    setting: 'SEARCH_LOG_RETENTION_DAYS (env, default 60)',
    purge: { kind: 'log_flush' }
  },
  {
    key: 'mail_log',
    label: 'Mail log',
    what: 'Every email sent: recipient, subject, outcome',
    table: 'nivaro_mail_log',
    timeColumn: 'created_at',
    keep: () => '30 days',
    setting: 'Fixed',
    purge: { kind: 'log_flush' }
  },
  {
    key: 'external_api_logs',
    label: 'External API call log',
    what: 'Calls to configured external APIs, with request and response bodies',
    table: 'nivaro_external_api_logs',
    timeColumn: 'created_at',
    keep: () => '30 days',
    setting: 'Fixed',
    purge: { kind: 'log_flush' }
  },
  {
    key: 'outbound_log',
    label: 'Outbound call recorder',
    what: 'Every outbound HTTP call (partners, webhooks, AI); bodies kept a day',
    table: 'nivaro_outbound_log',
    timeColumn: 'created_at',
    keep: () => '31 days · recorded bodies 24 hours',
    setting: 'Fixed',
    purge: { kind: 'log_flush' }
  },
  {
    key: 'job_runs',
    label: 'Background job runs',
    what: 'Every cron / background job run with its outcome',
    table: 'nivaro_job_runs',
    timeColumn: 'started_at',
    keep: () => 'Newest 50 per job, at most 30 days',
    setting: 'Fixed',
    purge: { kind: 'retention_pass' }
  },
  {
    key: 'ai_calls',
    label: 'AI call log',
    what: 'Every AI model call: feature, model, tokens, cost, outcome',
    table: 'nivaro_ai_calls',
    timeColumn: 'created_at',
    keep: () => '30 days',
    setting: 'Fixed',
    purge: { kind: 'retention_pass' }
  },
  {
    key: 'ai_conversations',
    label: 'Ask AI conversations',
    what: 'Ask AI threads (pinned ones are kept)',
    table: 'nivaro_ai_conversations',
    timeColumn: 'updated_at',
    orderColumn: 'updated_at',
    keep: (s) => dayOr(s.ai_conversation_retention_days, 180),
    setting: 'nivaro_settings.ai_conversation_retention_days',
    purge: { kind: 'retention_pass' }
  },
  {
    key: 'chat_history',
    label: 'Chat edit/delete history',
    what: 'Earlier versions of edited and deleted chat messages',
    table: 'nivaro_chat_message_history',
    timeColumn: 'changed_at',
    keep: (s) => dayOr(s.chat_history_retention_days, 90),
    setting: 'nivaro_settings.chat_history_retention_days',
    purge: { kind: 'retention_pass' }
  },
  {
    key: 'session_recordings',
    label: 'Session recordings (replay)',
    what: 'Recorded browser sessions; saved clips are kept until deleted',
    table: 'nivaro_session_recordings',
    timeColumn: 'started_at',
    orderColumn: 'started_at',
    keep: (s) =>
      s.session_recording_retention_days && s.session_recording_retention_days > 0
        ? days(Math.min(365, s.session_recording_retention_days))
        : '7 days (default)',
    setting: 'nivaro_settings.session_recording_retention_days',
    purge: { kind: 'retention_pass' }
  },
  {
    key: 'erp_payloads',
    label: 'Partner push payloads',
    what: 'Request/response bodies of partner submissions (the submission row itself is kept)',
    table: 'nivaro_erp_submissions',
    timeColumn: 'created_at',
    keep: (s) =>
      s.erp_submission_payload_retention_days
        ? `Bodies blanked after ${days(s.erp_submission_payload_retention_days)}`
        : 'Kept forever',
    setting: 'nivaro_settings.erp_submission_payload_retention_days',
    purge: { kind: 'retention_pass' }
  },
  {
    key: 'event_journal',
    label: 'Realtime event journal',
    what: 'Record events kept so reconnecting tabs can catch up',
    table: 'nivaro_event_journal',
    timeColumn: 'at',
    keep: () => '24 hours',
    setting: 'Fixed',
    purge: { kind: 'cron', cron: 'event-journal-prune' }
  },
  {
    key: 'admin_journeys',
    label: 'Admin page journeys',
    what: 'Which admin pages people moved through (navigation analytics)',
    table: 'nivaro_admin_journeys',
    timeColumn: 'entered_at',
    keep: () => '30 days',
    setting: 'Fixed',
    purge: { kind: 'retention_pass' }
  },
  {
    key: 'agent_trigger_deliveries',
    label: 'Agent trigger deliveries',
    what: 'Events pushed to connected agents and their delivery outcome',
    table: 'nivaro_agent_trigger_deliveries',
    timeColumn: 'created_at',
    keep: () => 'Delivered/discarded 30 days · skipped 7 · dead 90',
    setting: 'Fixed',
    purge: { kind: 'elsewhere', text: 'Hourly, while deliveries run' }
  },
  {
    key: 'notifications',
    label: 'Notifications',
    what: 'In-app notifications and their read state',
    table: 'nivaro_notifications',
    timeColumn: 'timestamp',
    keep: () => 'Kept forever (people delete their own)',
    setting: 'No retention setting',
    purge: { kind: 'never' }
  },
  {
    key: 'webhook_deliveries',
    label: 'Webhook deliveries',
    what: 'Every webhook call and its response',
    table: 'nivaro_webhook_deliveries',
    timeColumn: 'created_at',
    keep: () => 'Kept until the webhook is deleted',
    setting: 'No retention setting',
    purge: { kind: 'never' }
  },
  {
    key: 'alert_log',
    label: 'Alert log',
    what: 'Every alert that fired',
    table: 'nivaro_alert_log',
    timeColumn: 'triggered_at',
    keep: () => 'Kept until the alert is deleted',
    setting: 'No retention setting',
    purge: { kind: 'never' }
  },
  {
    key: 'trail_checkpoints',
    label: 'Activity trail checkpoints',
    what: 'Daily verification results of the tamper-evident activity trail',
    table: 'nivaro_activity_seals',
    timeColumn: 'verified_at',
    keep: () => 'Kept forever',
    setting: 'No retention setting',
    purge: { kind: 'never' }
  },
  {
    key: 'slow_traces',
    label: 'Slow request traces',
    what: 'Per-request phase timings of slow requests (Telemetry → Slowest requests)',
    table: null,
    keep: () => {
      const n = Number(process.env.TRACE_BUFFER)
      return `Newest ${Number.isFinite(n) && n > 0 ? n : 200} per process, in memory (gone on restart)`
    },
    setting: 'TRACE_BUFFER / TRACE_SLOW_MS (env); exported spans: TRACE_EXPORT_URL',
    purge: { kind: 'elsewhere', text: 'Ring buffer — oldest drops as new ones arrive' }
  },
  {
    key: 'long_history',
    label: 'Long-history log store',
    what: 'Access log lines shipped to VictoriaLogs (Traffic Map search, SLO windows past 14 days)',
    table: null,
    keep: () =>
      process.env.TELEMETRY_STORE_URL ? 'Set on the store itself' : 'Not configured here',
    setting: 'TELEMETRY_ACCESS_LOG / TELEMETRY_STORE_URL (env); retention on the store',
    purge: { kind: 'elsewhere', text: 'Managed by the log store' }
  }
]

export interface LogRetentionEntry {
  key: string
  label: string
  what: string
  table: string | null
  keep: string
  setting: string
  rows: number | null
  oldest_at: string | null
  purge: { how: string; next_run_at: string | null; last_run_at: string | null }
  legal_holds: boolean
  present: boolean
}

const SETTING_COLUMNS = [
  'activity_retention_days',
  'revision_retention_count',
  'chat_history_retention_days',
  'ai_conversation_retention_days',
  'session_recording_retention_days',
  'erp_submission_payload_retention_days'
] as const

async function readSettings(): Promise<SettingsSnapshot> {
  const cols: string[] = []
  for (const c of SETTING_COLUMNS) if (await hasColumn('nivaro_settings', c)) cols.push(c)
  const row = (
    cols.length
      ? await db('nivaro_settings')
          .first(cols)
          .catch(() => null)
      : null
  ) as Record<string, unknown> | null
  const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v))
  const countWhere = async (col: string): Promise<number> => {
    if (!(await hasColumn('nivaro_collections', col))) return 0
    const r = (await db('nivaro_collections')
      .whereNotNull(col)
      .count({ n: '*' })
      .first()
      .catch(() => null)) as { n: number | string } | null
    return Number(r?.n ?? 0)
  }
  return {
    activity_retention_days: num(row?.activity_retention_days),
    revision_retention_count: num(row?.revision_retention_count),
    chat_history_retention_days: num(row?.chat_history_retention_days),
    ai_conversation_retention_days: num(row?.ai_conversation_retention_days),
    session_recording_retention_days: num(row?.session_recording_retention_days),
    erp_submission_payload_retention_days: num(row?.erp_submission_payload_retention_days),
    activity_overrides: await countWhere('activity_retention_days'),
    trash_overrides: await countWhere('trash_retention_days')
  }
}

async function rowCounts(tables: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!isMssql(db) || tables.length === 0) return out
  try {
    const rows = rawRows<{ t: string; n: number | string | null }>(
      await db.raw(
        `SELECT OBJECT_NAME(object_id) AS t, SUM(rows) AS n FROM sys.partitions
          WHERE index_id IN (0, 1) AND object_id IN (${tables.map(() => 'OBJECT_ID(?)').join(', ')})
          GROUP BY object_id`,
        tables
      )
    )
    for (const r of rows) out.set(String(r.t).toLowerCase(), Number(r.n ?? 0))
  } catch {
    // no metadata visibility: counts stay unknown
  }
  return out
}

async function existingTables(tables: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  await Promise.all(
    tables.map(async (t) => {
      if (await db.schema.hasTable(t).catch(() => false)) out.add(t)
    })
  )
  return out
}

async function oldest(kind: LogKind): Promise<string | null> {
  if (!kind.table) return null
  try {
    let row: Record<string, unknown> | undefined
    if (kind.key === 'revisions') {
      row = (await db('nivaro_revisions as r')
        .join('nivaro_activity as a', 'a.id', 'r.activity')
        .orderBy('r.id', 'asc')
        .first({ t: 'a.timestamp' })) as Record<string, unknown> | undefined
    } else if (kind.timeColumn) {
      row = (await db(kind.table)
        .orderBy(kind.orderColumn ?? 'id', 'asc')
        .first({ t: kind.timeColumn })) as Record<string, unknown> | undefined
    }
    const v = row?.t
    if (v == null) return null
    const d = v instanceof Date ? v : new Date(String(v))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  } catch {
    return null
  }
}

export function purgeText(p: PurgeWhen): string {
  switch (p.kind) {
    case 'retention_pass':
      return 'Daily retention pass (each API process, 24 h after it starts)'
    case 'cron':
      return `Scheduled job ${p.cron}`
    case 'log_flush':
      return 'With the request-log writes (about 1 in 100 flushes, several times an hour)'
    case 'never':
      return 'Not purged'
    case 'elsewhere':
      return p.text
  }
}

function cronNext(id: string): string | null {
  try {
    const list = (getApp()?.cron?.list?.() ?? []) as Array<{ id: string; nextRun: Date | null }>
    const e = list.find((c) => c.id === id)
    return e?.nextRun ? new Date(e.nextRun).toISOString() : null
  } catch {
    return null
  }
}

/** The whole inventory (admin). */
export async function logRetentionInventory(): Promise<{
  entries: LogRetentionEntry[]
  retention_pass: ReturnType<typeof retentionPassSchedule>
  cloud: boolean
}> {
  const tables = LOG_KINDS.flatMap((k) => (k.table ? [k.table] : []))
  const [settings, present, counts] = await Promise.all([
    readSettings(),
    existingTables(tables),
    rowCounts(tables)
  ])
  const pass = retentionPassSchedule()
  const entries: LogRetentionEntry[] = []
  // Oldest-row reads a few at a time — each is one seek, but they add up.
  const oldestAt = new Map<string, string | null>()
  const queue = LOG_KINDS.filter((k) => k.table && present.has(k.table))
  for (let i = 0; i < queue.length; i += 4) {
    const slice = queue.slice(i, i + 4)
    const got = await Promise.all(slice.map((k) => oldest(k)))
    slice.forEach((k, j) => {
      oldestAt.set(k.key, got[j])
    })
  }
  for (const k of LOG_KINDS) {
    const isPresent = k.table == null || present.has(k.table)
    entries.push({
      key: k.key,
      label: k.label,
      what: k.what,
      table: k.table,
      keep: k.keep(settings),
      setting: k.setting,
      rows: k.table ? (counts.get(k.table.toLowerCase()) ?? null) : null,
      oldest_at: oldestAt.get(k.key) ?? null,
      purge: {
        how: purgeText(k.purge),
        next_run_at:
          k.purge.kind === 'retention_pass'
            ? pass.next_run_at
            : k.purge.kind === 'cron'
              ? cronNext(k.purge.cron)
              : null,
        last_run_at: k.purge.kind === 'retention_pass' ? pass.last_run_at : null
      },
      legal_holds: !!k.holds,
      present: isPresent
    })
  }
  return { entries, retention_pass: pass, cloud: !!process.env.CLOUD_META_DB_URL }
}
