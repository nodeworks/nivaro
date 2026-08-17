import { createHash } from 'node:crypto'
import { db as defaultDb } from '../db/index.js'

/**
 * The configuration layer of a Nivaro instance, and how to compare two of them.
 *
 * "What is different between staging and production?" has had no answer. App
 * Blueprints export schema only, Content Promotion moves data rows only, and
 * neither tells you that a queue's sources drifted or that a layout gained a
 * field on one instance and not the other. The EFP go-live scripts carry a
 * classification of every nivaro_* table for exactly this reason; that
 * knowledge is generic to the product, so it lives here rather than in a
 * deployment-specific script.
 *
 * Classification is TOTAL by construction: a nivaro_* table that appears in
 * none of the three lists is reported as `unclassified` rather than silently
 * ignored, so a new migration surfaces here instead of quietly producing an
 * incomplete diff.
 */

/** Authored configuration. This is what a diff is actually about. */
export const CONFIG_TABLES: string[] = [
  // identity & access
  'nivaro_roles',
  'nivaro_policies',
  'nivaro_users',
  'nivaro_scope_dimensions',
  'nivaro_user_scopes',
  'nivaro_workspaces',
  'nivaro_workspace_templates',
  // schema registry
  'nivaro_collections',
  'nivaro_fields',
  'nivaro_relations',
  'nivaro_field_groups',
  'nivaro_collection_layouts',
  'nivaro_layout_field_assignments',
  'nivaro_field_rules',
  'nivaro_attribute_definitions',
  // workflow / pipeline config
  'nivaro_workflow_templates',
  'nivaro_workflow_states',
  'nivaro_workflow_transitions',
  'nivaro_workflow_bindings',
  'nivaro_workflow_template_versions',
  'nivaro_pipeline_owner_dimensions',
  'nivaro_pipeline_owner_groups',
  'nivaro_pipeline_owner_group_users',
  // queues
  'nivaro_queues',
  'nivaro_queue_sources',
  'nivaro_queue_views',
  'nivaro_queue_column_prefs',
  // automation
  'nivaro_flows',
  'nivaro_flow_operations',
  'nivaro_flow_versions',
  'nivaro_rules',
  'nivaro_webhooks',
  'nivaro_external_apis',
  'nivaro_external_api_endpoints',
  'nivaro_external_api_schemas',
  // imports
  'nivaro_import_definitions',
  'nivaro_import_templates',
  // reporting
  'nivaro_custom_queries',
  'nivaro_report_defs',
  'nivaro_report_widgets',
  'nivaro_report_alerts',
  'nivaro_report_subscriptions',
  'nivaro_report_filter_presets',
  'nivaro_report_widget_presets',
  'nivaro_metric_definitions',
  'nivaro_metric_alert_rules',
  'nivaro_metric_alert_subscriptions',
  'nivaro_anomaly_definitions',
  'nivaro_anomaly_rules',
  // monitoring config
  'nivaro_sla_rules',
  'nivaro_alert_definitions',
  'nivaro_alert_subscriptions',
  'nivaro_at_risk_rules',
  'nivaro_access_audits',
  'nivaro_dq_rules',
  'nivaro_retention_policies',
  'nivaro_notification_subscriptions',
  'nivaro_field_watches',
  'nivaro_field_watch_subscribers',
  // structure
  'nivaro_tree_configs',
  'nivaro_tree_permissions',
  'nivaro_hierarchy_configs',
  // chat
  'nivaro_chat_channels',
  'nivaro_chat_room_types',
  'nivaro_chat_memberships',
  // pages / dashboards / widgets
  'nivaro_pages',
  'nivaro_dashboards',
  'nivaro_dashboard_widgets',
  'nivaro_widgets',
  'nivaro_widget_feeds',
  // misc config
  'nivaro_settings',
  'nivaro_ai_collection_settings',
  'nivaro_approval_chains',
  'nivaro_approval_chain_steps',
  'nivaro_record_templates',
  'nivaro_submission_forms',
  'nivaro_pdf_templates',
  'nivaro_persisted_queries',
  'nivaro_scheduled_reports',
  'nivaro_saved_views',
  'nivaro_blackout_dates',
  'nivaro_collection_presets',
  'nivaro_picker_exclusions',
  'nivaro_pinned_items',
  'nivaro_file_folders',
  'nivaro_sync_jobs'
]

/** Derived from business data — differing between environments proves nothing. */
export const DERIVED_TABLES: string[] = [
  'nivaro_activity',
  'nivaro_revisions',
  'nivaro_workflow_instances',
  'nivaro_workflow_history',
  'nivaro_pipeline_instance_owners',
  'nivaro_queue_items',
  'nivaro_queue_item_owners',
  'nivaro_embeddings',
  'nivaro_files',
  'nivaro_import_queue',
  'nivaro_sequences'
]

/** Operational / ephemeral. Never meaningful to compare across environments. */
export const RUNTIME_TABLES: string[] = [
  'nivaro_migrations',
  'nivaro_migrations_lock',
  'nivaro_sessions',
  'nivaro_api_logs',
  'nivaro_page_views',
  'nivaro_admin_journeys',
  'nivaro_session_recordings',
  'nivaro_session_events',
  'nivaro_item_locks',
  'nivaro_notifications',
  'nivaro_deferred_emails',
  'nivaro_comments',
  'nivaro_comment_mentions',
  'nivaro_tasks',
  'nivaro_erp_submissions',
  'nivaro_flow_runs',
  'nivaro_external_api_logs',
  'nivaro_issues',
  'nivaro_trash',
  'nivaro_metric_alert_log',
  'nivaro_anomaly_log',
  'nivaro_report_alert_log',
  'nivaro_alert_log',
  'nivaro_dq_runs',
  'nivaro_retention_runs',
  'nivaro_access_audit_runs',
  'nivaro_access_audit_findings',
  'nivaro_queue_claims',
  'nivaro_queue_stat_snapshots',
  'nivaro_queue_owner_snapshots',
  'nivaro_ai_proposals',
  'nivaro_push_subscriptions',
  'nivaro_share_links',
  'nivaro_dashboard_links',
  'nivaro_webhook_deliveries',
  'nivaro_submissions',
  'nivaro_scheduled_changes',
  'nivaro_import_jobs',
  'nivaro_sub_rows',
  'nivaro_sub_row_templates',
  'nivaro_field_translations',
  'nivaro_attribute_values',
  'nivaro_usage_counters',
  'nivaro_addendums',
  'nivaro_addendum_approvals',
  'nivaro_approval_instances',
  'nivaro_approval_decisions',
  'nivaro_api_keys'
]

/**
 * Columns stripped from every snapshot, unconditionally.
 *
 * A snapshot is a file an operator downloads and mails to a colleague, so the
 * threat model is simply "this leaves the building". Secrets are removed
 * rather than masked with a constant, because a constant mask makes two
 * different secrets compare EQUAL and the diff would then claim the
 * environments agree about a credential when they do not. A dropped column is
 * absent on both sides and honestly compares as "not covered".
 *
 * `'*'` drops the column from every table.
 */
const REDACTED: Record<string, string[]> = {
  '*': ['password_hash', 'static_token', 'totp_secret', 'key_hash', 'signing_secret'],
  nivaro_settings: [
    'smtp_pass',
    'anthropic_api_key',
    'vapid_private_key',
    'sms_auth_token',
    'sms_account_sid'
  ],
  nivaro_external_apis: ['auth_config'],
  nivaro_users: ['external_id', 'preferences'],
  nivaro_submission_forms: ['password_hash'],
  nivaro_widget_feeds: ['token'],
  nivaro_persisted_queries: []
}

export function redactRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set([...(REDACTED['*'] ?? []), ...(REDACTED[table] ?? [])])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (drop.has(k)) continue
    out[k] = v
  }
  return out
}

export interface TableClassification {
  config: string[]
  derived: string[]
  runtime: string[]
  /** Present in the database but in none of the lists — a new migration. */
  unclassified: string[]
  /** Classified but absent from this database — an older instance. */
  absent: string[]
}

export function classifyTables(present: string[]): TableClassification {
  const presentSet = new Set(present)
  const known = new Set([...CONFIG_TABLES, ...DERIVED_TABLES, ...RUNTIME_TABLES])
  return {
    config: CONFIG_TABLES.filter((t) => presentSet.has(t)),
    derived: DERIVED_TABLES.filter((t) => presentSet.has(t)),
    runtime: RUNTIME_TABLES.filter((t) => presentSet.has(t)),
    unclassified: present.filter((t) => !known.has(t)).sort(),
    absent: [...known].filter((t) => !presentSet.has(t)).sort()
  }
}

export interface SnapshotRow {
  hash: string
  data: Record<string, unknown>
}

export interface ConfigSnapshot {
  format: 1
  generated_at: string
  instance: { version: string; environment: string; database: string; label?: string }
  classification: TableClassification
  tables: Record<string, Record<string, SnapshotRow>>
  /** Tables that were requested but could not be read, with the reason. */
  errors: Record<string, string>
}

/**
 * Stable hash of a row's redacted content.
 *
 * Keys are sorted so column order cannot make identical rows look different,
 * and values are normalized: Dates to ISO, everything else through JSON.
 *
 * NULL AND ABSENT HASH IDENTICALLY, deliberately, because that is how the
 * field-level comparison treats them. Without this, a migration adding a
 * nullable column makes every row of that table hash differently against an
 * older snapshot, so the whole table reports as changed while showing no field
 * differences at all — thousands of phantom rows burying the handful of real
 * ones. A value moving from something to null still changes the hash, so no
 * genuine change is lost.
 */
export function hashRow(row: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(row).sort()) {
    const v = row[key]
    if (v === null || v === undefined) continue
    normalized[key] = v instanceof Date ? v.toISOString() : v
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)
}

/**
 * Rows are keyed by primary key. Config tables all have an `id`; the handful
 * of junction tables without a natural single key fall back to a hash of the
 * whole row, which still diffs correctly (a changed row reads as one removed
 * plus one added, which for a link row is exactly what happened).
 */
function rowKey(row: Record<string, unknown>, hash: string): string {
  const id = row.id
  return id == null || id === '' ? `#${hash}` : String(id)
}

export async function buildConfigSnapshot(
  opts: { label?: string; tables?: string[]; version: string; environment: string },
  database: typeof defaultDb = defaultDb
): Promise<ConfigSnapshot> {
  const presentRows = (await database.raw(
    `SELECT name FROM sys.tables WHERE name LIKE 'nivaro[_]%'`
  )) as Array<{ name: string }>
  const present = presentRows.map((r) => r.name)
  const classification = classifyTables(present)

  const requested = opts.tables?.length
    ? classification.config.filter((t) => opts.tables?.includes(t))
    : classification.config

  const dbNameRows = (await database.raw('SELECT DB_NAME() AS n')) as Array<{ n: string }>

  const tables: ConfigSnapshot['tables'] = {}
  const errors: Record<string, string> = {}

  for (const table of requested) {
    try {
      const rows = (await database(table).select('*')) as Record<string, unknown>[]
      const byKey: Record<string, SnapshotRow> = {}
      for (const raw of rows) {
        const data = redactRow(table, raw)
        const hash = hashRow(data)
        byKey[rowKey(raw, hash)] = { hash, data }
      }
      tables[table] = byKey
    } catch (err) {
      // One unreadable table must not cost the operator the whole snapshot.
      errors[table] = err instanceof Error ? err.message : String(err)
    }
  }

  return {
    format: 1,
    generated_at: new Date().toISOString(),
    instance: {
      version: opts.version,
      environment: opts.environment,
      database: dbNameRows[0]?.n ?? 'unknown',
      label: opts.label
    },
    classification,
    tables,
    errors
  }
}

export interface FieldDiff {
  field: string
  mine: unknown
  theirs: unknown
}

export interface RowDiff {
  key: string
  fields: FieldDiff[]
}

export interface TableDiff {
  table: string
  /** Present here, absent there. */
  added: string[]
  /** Absent here, present there. */
  removed: string[]
  changed: RowDiff[]
  same: number
  /** True when one side does not have the table at all. */
  only_on: 'mine' | 'theirs' | null
}

export interface SnapshotDiff {
  mine: ConfigSnapshot['instance']
  theirs: ConfigSnapshot['instance']
  generated_at: { mine: string; theirs: string }
  tables: TableDiff[]
  totals: { added: number; removed: number; changed: number; tables_differing: number }
  /** Tables one instance classifies that the other has never heard of. */
  schema_drift: { only_mine: string[]; only_theirs: string[] }
}

function fieldDiffs(mine: Record<string, unknown>, theirs: Record<string, unknown>): FieldDiff[] {
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)])
  const out: FieldDiff[] = []
  for (const field of [...keys].sort()) {
    const a = mine[field] instanceof Date ? (mine[field] as Date).toISOString() : mine[field]
    const b = theirs[field] instanceof Date ? (theirs[field] as Date).toISOString() : theirs[field]
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      out.push({ field, mine: a ?? null, theirs: b ?? null })
    }
  }
  return out
}

/**
 * Diff two snapshots. `mine` is this instance, `theirs` is the uploaded one —
 * the labels are deliberately possessive rather than "source/target", because
 * a diff is not a direction and reading it as one is how people promote the
 * wrong way.
 */
export function diffSnapshots(mine: ConfigSnapshot, theirs: ConfigSnapshot): SnapshotDiff {
  const allTables = [
    ...new Set([...Object.keys(mine.tables), ...Object.keys(theirs.tables)])
  ].sort()
  const tables: TableDiff[] = []
  let added = 0
  let removed = 0
  let changed = 0

  for (const table of allTables) {
    const a = mine.tables[table]
    const b = theirs.tables[table]
    const onlyOn = a && !b ? 'mine' : b && !a ? 'theirs' : null

    const aRows = a ?? {}
    const bRows = b ?? {}
    const keys = new Set([...Object.keys(aRows), ...Object.keys(bRows)])

    const tAdded: string[] = []
    const tRemoved: string[] = []
    const tChanged: RowDiff[] = []
    let same = 0

    for (const key of keys) {
      const ra = aRows[key]
      const rb = bRows[key]
      if (ra && !rb) tAdded.push(key)
      else if (!ra && rb) tRemoved.push(key)
      else if (ra && rb) {
        if (ra.hash === rb.hash) same++
        else tChanged.push({ key, fields: fieldDiffs(ra.data, rb.data) })
      }
    }

    if (tAdded.length || tRemoved.length || tChanged.length || onlyOn) {
      tables.push({
        table,
        added: tAdded.sort(),
        removed: tRemoved.sort(),
        changed: tChanged.sort((x, y) => x.key.localeCompare(y.key)),
        same,
        only_on: onlyOn
      })
      added += tAdded.length
      removed += tRemoved.length
      changed += tChanged.length
    }
  }

  const mineKnown = new Set([
    ...mine.classification.config,
    ...mine.classification.derived,
    ...mine.classification.runtime,
    ...mine.classification.unclassified
  ])
  const theirsKnown = new Set([
    ...theirs.classification.config,
    ...theirs.classification.derived,
    ...theirs.classification.runtime,
    ...theirs.classification.unclassified
  ])

  return {
    mine: mine.instance,
    theirs: theirs.instance,
    generated_at: { mine: mine.generated_at, theirs: theirs.generated_at },
    tables,
    totals: { added, removed, changed, tables_differing: tables.length },
    schema_drift: {
      only_mine: [...mineKnown].filter((t) => !theirsKnown.has(t)).sort(),
      only_theirs: [...theirsKnown].filter((t) => !mineKnown.has(t)).sort()
    }
  }
}
