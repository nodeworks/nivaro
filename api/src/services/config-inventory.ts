import { createHash } from 'node:crypto'
import { db as defaultDb } from '../db/index.js'
import { isSensitiveHeaderName } from './secret-mask.js'

/**
 * The configuration layer of a Nivaro instance, and how to compare two of them.
 *
 * "What is different between staging and production?" has had no answer. App
 * Blueprints export schema only, Content Promotion moves data rows only, and
 * neither tells you that a queue's sources drifted or that a layout gained a
 * field on one instance and not the other. Deployment go-live scripts carry a
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
  'nivaro_quality_known', //           curated known differences (migration 404)
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
  'nivaro_layout_templates', //        saved form templates + section library (migration 458)
  'nivaro_layout_section_links', //    linked library sections per layout (migration 508)
  'nivaro_field_rules',
  'nivaro_attribute_definitions',
  // workflow / pipeline config
  'nivaro_workflow_templates',
  'nivaro_workflow_states',
  'nivaro_workflow_transitions',
  'nivaro_workflow_bindings',
  'nivaro_workflow_template_versions',
  'nivaro_owner_matrix_versions',
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
  'nivaro_bulk_actions',
  'nivaro_webhooks',
  'nivaro_external_apis',
  'nivaro_external_api_endpoints',
  'nivaro_external_api_schemas',
  'nivaro_payload_templates', //       partner payload templates (migration 501)
  'nivaro_payload_template_versions',
  'nivaro_payload_template_drafts', //  working copies (not epoch-watched; restored by id)
  'nivaro_integration_signal_settings',
  // imports
  'nivaro_import_definitions',
  'nivaro_import_templates',
  'nivaro_managed_procedures', //      app-managed procedure bodies (migration 507)
  'nivaro_managed_procedure_versions',
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
  'nivaro_sync_jobs',

  // ── classified 2026-09-17 (migrations 210–327 — authored config, incl. AI playbooks: learned question→plan pairs follow the instance) ──
  'nivaro_environments',
  'nivaro_environment_components',
  'nivaro_extension_settings',
  'nivaro_conformance_schedules',
  'nivaro_broadcast_templates',
  'nivaro_announcements',
  'nivaro_log_alert_rules',
  'nivaro_maintenance_windows',
  'nivaro_monitors',
  'nivaro_monitor_subscribers',
  'nivaro_report_templates',
  'nivaro_integration_contracts',
  'nivaro_feature_flags',
  'nivaro_user_groups',
  'nivaro_user_group_members',
  'nivaro_automation_tests',
  'nivaro_sso_providers',
  'nivaro_pipeline_owner_group_teams',
  'nivaro_team_scopes',
  'nivaro_custom_actions',
  'nivaro_mail_templates',
  'nivaro_inbound_mappings',
  'nivaro_inbound_mapping_versions',
  'nivaro_export_presets',
  'nivaro_import_mappings',
  'nivaro_bulk_recipes',
  'nivaro_task_categories', // support request types (admin-edited)
  'nivaro_queue_labels',
  'nivaro_settings_overrides',
  'nivaro_ai_playbooks',
  'nivaro_ai_glossary', // #1899 business terms (admin-curated)
  'nivaro_ai_data_guides', // #1847 per-collection Ask AI hints
  'nivaro_role_checklists', // #2472 first-week checklists an admin published per role
  'nivaro_search_synonyms', // #1581 admin-authored search synonym groups (migration 498)
  'nivaro_chaos_presets' // #2855 saved fault presets (migration 497) — promoted between instances
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
  'nivaro_import_run_items', // what each import run created and changed (migration 359)
  'nivaro_sequences',

  // ── classified 2026-09-17 — regenerable sweeps, snapshots, version history ──
  'nivaro_record_integrity',
  'nivaro_conformance_runs',
  'nivaro_conformance_findings',
  'nivaro_readiness_snapshots',
  'nivaro_config_health',
  'nivaro_report_snapshots',
  'nivaro_storage_snapshots',
  'nivaro_layout_versions',
  'nivaro_report_versions',
  'nivaro_import_definition_versions',
  'nivaro_graphql_schema_log',
  'nivaro_chat_embeddings' // chat search by meaning (migration 430) — re-embedded from messages
]

/** Operational / ephemeral. Never meaningful to compare across environments. */
export const RUNTIME_TABLES: string[] = [
  'nivaro_event_journal', //           durable realtime journal (migration 427) — 24 hours
  'nivaro_raw_writes', //              raw-write announcement inbox (migration 427)
  'nivaro_migrations',
  'nivaro_migrations_lock',
  'nivaro_migration_effects',
  'nivaro_extension_schema_steps',
  'nivaro_runbook_queue', //           host runbook runs (migration 403) — per database
  'nivaro_runbook_queue_lines',
  'nivaro_runbook_agents',
  'nivaro_runbook_step_timings',
  'nivaro_quality_runs', //            staging quality checks (migration 404) — per database
  'nivaro_quality_rows',
  'nivaro_quality_results',
  'nivaro_cache_epochs',
  'nivaro_config_snapshots',
  'nivaro_dashboard_snapshots',
  'nivaro_extension_registry_versions',
  'nivaro_sessions',
  'nivaro_api_logs',
  'nivaro_page_views',
  'nivaro_admin_journeys',
  'nivaro_session_recordings',
  'nivaro_help_videos',
  'nivaro_help_video_versions',
  'nivaro_help_video_contexts',
  'nivaro_help_video_pages',
  'nivaro_help_video_requirements',
  'nivaro_help_video_views',
  'nivaro_help_video_uploads',
  // help videos, migrations 412–417 — same rule: per environment
  'nivaro_help_video_clips',
  'nivaro_help_video_next',
  'nivaro_help_video_paths',
  'nivaro_help_video_path_items',
  'nivaro_help_video_path_roles',
  'nivaro_help_video_questions',
  'nivaro_help_video_ratings',
  'nivaro_help_video_release_videos',
  'nivaro_traffic_snapshots',
  'nivaro_traffic_minutes', // #2228 optional per-minute Traffic Map history (migration 448)
  'nivaro_traffic_investigations',
  'nivaro_tuning_proposals',
  'nivaro_tuning_param_sets',
  'nivaro_sql_check_runs', //          nightly SQL checks (migration 455) — per database
  'nivaro_sql_check_findings',
  'nivaro_sql_check_events',
  'nivaro_sql_check_fixes',
  'nivaro_infra_drift_baselines', //   stack drift baselines (migration 500) — per database
  'nivaro_infra_drift_findings',
  'nivaro_session_events',
  'nivaro_replay_clips', // session replay library (migration 422) — per environment, like its recordings
  'nivaro_replay_shares', // replay share links (migration 422)
  'nivaro_session_replay_usage', // replay storage usage (migration 424)
  'nivaro_session_replay_daily', // replay daily roll-up (migration 424)
  'nivaro_replay_index', // what each recording touched (migration 421) — goes with its recording
  // session replay heatmaps (migration 426) — folded from this environment's recordings
  'nivaro_replay_heat',
  'nivaro_replay_heat_frames',
  // frustration scores (migration 426) — per environment, like the journeys they score
  'nivaro_session_scores',
  // session replay notes, migration 423 (#1363) — per environment
  'nivaro_replay_notes',
  'nivaro_item_locks',
  'nivaro_notifications',
  'nivaro_deferred_emails',
  'nivaro_comments',
  'nivaro_comment_mentions',
  'nivaro_tasks',
  'nivaro_erp_submissions',
  'nivaro_erp_submission_attempts',
  'nivaro_auto_transition_failures', // #1217 per-instance failure memory of auto transitions
  'nivaro_chain_roots', // integration event chains — which feed row / replay started which chain
  'nivaro_integration_signal_rows',
  'nivaro_integration_signal_runs',
  'nivaro_integration_signal_snoozes',
  'nivaro_integration_signal_subscriptions',
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
  'nivaro_teams_links', //             per-person Teams link (migration 505) — never promoted
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
  'nivaro_api_keys',

  // ── classified 2026-09-17 — per-user state, logs, reactions, journals ──
  'nivaro_ai_calls',
  'nivaro_ai_feedback',
  'nivaro_ai_spend_days', // #2473/#2764 per-day AI spend rollup + bill reconciliation (migration 470)
  'nivaro_ai_model_catalogue', // #2732 models the provider lists, refreshed by the catalogue watch
  'nivaro_ai_knowledge_suggestions', // #1898/#1949 drafts awaiting an admin
  'nivaro_ai_docs_misses', // #1855 docs searches that found nothing
  'nivaro_ai_knowledge_findings', // #2480 glossary / data-guide conflicts
  'nivaro_ops_incidents', // #2016 incident threads (state + summary)
  'nivaro_ai_autofill_events',
  'nivaro_ai_conversations', // #1833 per-person Ask AI history (migration 433)
  'nivaro_ai_conversation_messages',
  'nivaro_ai_conversation_shares',
  'nivaro_concurrency_samples',
  'nivaro_outbox',
  'nivaro_action_journal',
  'nivaro_view_subscriptions',
  'nivaro_api_changelog',
  'nivaro_chat_reactions',
  'nivaro_notification_mutes',
  'nivaro_chat_pins',
  'nivaro_reminders',
  'nivaro_chat_saved',
  'nivaro_record_links',
  'nivaro_outbound_log',
  'nivaro_outbound_side_log',
  'nivaro_chat_auto_joins',
  'nivaro_chat_scheduled',
  'nivaro_chat_drafts', // #2474 unsent composer text per person per room
  'nivaro_chat_emoji', // #2459 rows point at nivaro_files ids, which promotion does not carry
  'nivaro_integration_obligations',
  'nivaro_announcement_acks',
  'nivaro_announcement_deliveries',
  'nivaro_report_annotations',
  'nivaro_job_runs',
  'nivaro_rum_events',
  'nivaro_search_log', // #1581 search analytics (migration 485)
  'nivaro_login_events',
  'nivaro_extension_events',
  'nivaro_legal_holds',
  'nivaro_sla_escalations',
  'nivaro_sla_acks',
  'nivaro_sla_overrides',
  'nivaro_comment_reactions',
  'nivaro_item_lock_queue',
  'nivaro_entry_reactions',
  'nivaro_access_requests',
  'nivaro_record_views',
  'nivaro_mail_log',
  'nivaro_mail_suppressions',
  'nivaro_drafts',
  'nivaro_collection_snapshots',

  // ── classified 2026-10-19 — per-person votes, edit history, occurrences ──
  'nivaro_chat_polls', // migration 430 — polls live in chat messages
  'nivaro_chat_poll_votes',
  'nivaro_chat_message_history', // migration 454 — edit history of chat messages
  'nivaro_comment_versions', // migration 454 — edit history of comments
  'nivaro_idea_votes', // migration 446 — one row per voter per idea
  'nivaro_issue_occurrences', // migration 445 — each sighting of a logged issue

  // ── classified 2026-10-23 — this environment's schedules, usage and drills ──
  'nivaro_layout_schedules', // migration 457 — layout changes queued against THIS instance's revs
  'nivaro_layout_usage_daily', // migration 461 — form usage per layout per day
  'nivaro_layout_usage_seen',
  'nivaro_chat_huddle_schedules', // migration 495 — huddles planned here, with invitees
  'nivaro_chat_huddle_sessions', // migration 496 — finished huddles, counts and timings
  'nivaro_chaos_runs', // migration 497 — fault drills run on this instance
  'nivaro_chaos_run_events',
  // Not a migration: a deployment's one-off data-move scratch table, staged by an extension
  // script and carried by database copies. Classified so it never reads as a new migration.
  'nivaro_forecast_stage'
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
    'sms_account_sid',
    'teams_bot_app_secret',
    // #2803 review — credentials the list had missed (stored in clear text, not enc:v1).
    'ai_gateway_client_secret',
    'storage_s3_access_key',
    'storage_s3_secret',
    'provision_secret',
    'directory_password',
    'directory_refresh_token'
  ],
  nivaro_external_apis: ['auth_config'],
  nivaro_environment_components: ['api_token', 'git_token'],
  nivaro_webhooks: ['secret'],
  nivaro_sso_providers: ['client_secret'],
  nivaro_users: ['external_id', 'preferences'],
  nivaro_submission_forms: ['password_hash'],
  nivaro_widget_feeds: ['token'],
  nivaro_persisted_queries: [],
  // Not secrets: per-database facts (what THIS database last got from config). A snapshot of
  // another instance must not claim them, and a restore keeps the live value.
  nivaro_managed_procedures: ['deployed_hash', 'deployed_at', 'deployed_by']
}

/**
 * Deny by name, so a credential column a later migration adds cannot slip into a snapshot
 * before someone lists it above: any column whose name has one of these words as a whole
 * `_`-separated part is dropped, unless SECRET_NAME_ALLOW says it is reviewed and harmless.
 */
export const SECRET_NAME_RE =
  /(^|_)(secret|password|passwd|pass|pwd|token|api_key|private_key|access_key|refresh_token|client_secret|credentials?)($|_)/i

/** Reviewed columns the name rule would catch that hold no credential (table.column). */
export const SECRET_NAME_ALLOW = new Set([
  'nivaro_settings.ai_gateway_token_url', // the token endpoint URL, not a token
  'nivaro_activity.api_key_id', // which key made the call — an id
  'nivaro_api_logs.api_key_id'
])

/** Whether a snapshot strips this column — a write path must never set it from a snapshot. */
export function isRedactedColumn(table: string, column: string): boolean {
  if ((REDACTED['*'] ?? []).includes(column) || (REDACTED[table] ?? []).includes(column)) {
    return true
  }
  return SECRET_NAME_RE.test(column) && !SECRET_NAME_ALLOW.has(`${table}.${column}`)
}

// ─── Redaction by value ─────────────────────────────────────────────────────
// Some config columns hold credentials INSIDE a JSON value next to plain config: per-instance
// overrides of an external API carry each instance's auth_config (tokens, body secrets) beside
// its base_url. Dropping the whole column would lose the base_url overrides from diffs and make a
// restore wipe them, so these columns are redacted by value: the snapshot keeps the plain parts,
// and a restore merges the credential parts back from the live row it writes to.

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** A JSON text / object column value as an object; undefined when it is not one. */
function jsonObject(v: unknown): Record<string, unknown> | undefined {
  if (isObj(v)) return v
  if (typeof v !== 'string' || v.trim() === '') return undefined
  try {
    const parsed = JSON.parse(v)
    return isObj(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function plainHeaders(h: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(h).filter(([k]) => !isSensitiveHeaderName(k)))
}

/**
 * `nivaro_external_apis.instance_overrides` without credentials: every `<instance>.auth_config`
 * dropped, every credential-looking `<instance>.headers` entry dropped (isSensitiveHeaderName —
 * the maskHeaders rule: Authorization, Cookie, *token*, *key*…; an emptied headers object
 * goes too). A value that is not a JSON object is dropped whole (it cannot be vouched for).
 */
export function redactInstanceOverrides(v: unknown): unknown {
  if (v === null || v === undefined) return v
  const all = jsonObject(v)
  if (!all) return null
  const out: Record<string, unknown> = {}
  for (const [inst, entry] of Object.entries(all)) {
    if (!isObj(entry)) {
      out[inst] = entry
      continue
    }
    const e: Record<string, unknown> = { ...entry }
    delete e.auth_config
    if (isObj(e.headers)) {
      const h = plainHeaders(e.headers)
      if (Object.keys(h).length) e.headers = h
      else delete e.headers
    }
    out[inst] = e
  }
  return typeof v === 'string' ? JSON.stringify(out) : out
}

/**
 * The value a restore writes for instance_overrides: the snapshot's plain parts, with each
 * instance's auth_config and secret-looking headers taken from the CURRENT live value (never from
 * the snapshot, even if an uploaded file carries them). An instance the snapshot lacks is gone;
 * one the live row lacks gets no credentials. Always JSON text (the column is text) or null.
 */
export function restoreInstanceOverrides(snapshotValue: unknown, currentValue: unknown): unknown {
  if (snapshotValue === null || snapshotValue === undefined) return null
  const snap = jsonObject(snapshotValue)
  if (!snap) return null
  const current = jsonObject(currentValue) ?? {}
  const out: Record<string, unknown> = {}
  for (const [inst, entry] of Object.entries(snap)) {
    if (!isObj(entry)) {
      out[inst] = entry
      continue
    }
    const e: Record<string, unknown> = { ...entry }
    delete e.auth_config
    const cur = isObj(current[inst]) ? (current[inst] as Record<string, unknown>) : {}
    const curHeaders = isObj(cur.headers) ? cur.headers : {}
    const secretHeaders = Object.fromEntries(
      Object.entries(curHeaders).filter(([k]) => isSensitiveHeaderName(k))
    )
    const headers = { ...(isObj(e.headers) ? plainHeaders(e.headers) : {}), ...secretHeaders }
    if (Object.keys(headers).length) e.headers = headers
    else delete e.headers
    if (isObj(cur.auth_config)) e.auth_config = cur.auth_config
    out[inst] = e
  }
  return Object.keys(out).length ? JSON.stringify(out) : null
}

const VALUE_REDACTED: Record<
  string,
  Record<
    string,
    { redact: (v: unknown) => unknown; restore: (snap: unknown, current: unknown) => unknown }
  >
> = {
  nivaro_external_apis: {
    instance_overrides: { redact: redactInstanceOverrides, restore: restoreInstanceOverrides }
  }
}

/** Whether a column is redacted by value (its credential parts come back from the live row). */
export function isValueRedactedColumn(table: string, column: string): boolean {
  return !!VALUE_REDACTED[table]?.[column]
}

/** What a restore writes for a value-redacted column, given the live row's current value. */
export function restoreRedactedValue(
  table: string,
  column: string,
  snapshotValue: unknown,
  currentValue: unknown
): unknown {
  const r = VALUE_REDACTED[table]?.[column]
  return r ? r.restore(snapshotValue, currentValue) : snapshotValue
}

export function redactRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const byValue = VALUE_REDACTED[table]
  for (const [k, v] of Object.entries(row)) {
    if (isRedactedColumn(table, k)) continue
    out[k] = byValue?.[k] ? byValue[k].redact(v) : v
  }
  return out
}

/**
 * A snapshot with today's redaction applied (hashes recomputed). Snapshots stored before a
 * column joined the list still carry it; every reader of a stored or uploaded snapshot goes
 * through this so the value is never shown, compared or written.
 */
export function redactSnapshot(snap: ConfigSnapshot): ConfigSnapshot {
  const tables: ConfigSnapshot['tables'] = {}
  for (const [table, rows] of Object.entries(snap.tables ?? {})) {
    const out: Record<string, SnapshotRow> = {}
    for (const [key, row] of Object.entries(rows ?? {})) {
      const data = redactRow(table, row?.data ?? {})
      out[key] = { hash: hashRow(data), data }
    }
    tables[table] = out
  }
  return { ...snap, tables }
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
  /** Stored restore points only (#2803): why this one was taken. */
  restore_point?: {
    trigger: string
    note?: string | null
    /** pre-deploy: the version being deployed. */
    target_version?: string | null
    /** pre-migration: the migrations about to run. */
    migrations?: string[]
    /** pre-restore: the snapshot being restored. */
    restore_of?: number | null
  }
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
  opts: {
    label?: string
    tables?: string[]
    version: string
    environment: string
    /** Tables read at once (default 1). Serial reads of ~120 tables pay one round trip each;
     *  the boot and restore paths read a few at a time. */
    concurrency?: number
    /** Stops between tables (the boot snapshot's time box): throws once aborted. */
    signal?: AbortSignal
    /** Read WITH (UPDLOCK, HOLDLOCK) — only inside the caller's transaction, one lane. */
    lock?: boolean
    /** With `lock`: SET LOCK_TIMEOUT in the same batch (a SET never outlives a knex.raw call). */
    lockTimeoutMs?: number
  },
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

  const readTable = async (table: string) => {
    try {
      if (!/^nivaro_[A-Za-z0-9_]+$/.test(table)) throw new Error('not a nivaro_* table')
      // Raw with a trailing ';' — the driver-seam metadata cache never answers it, so a
      // snapshot is the database's rows now, not a cached read up to 30 s old. `lock` holds
      // the rows (UPDLOCK, HOLDLOCK) for the caller's transaction (a config restore).
      const lead =
        opts.lock && opts.lockTimeoutMs !== undefined
          ? `SET LOCK_TIMEOUT ${Math.max(0, Math.floor(opts.lockTimeoutMs))}; `
          : ''
      const rows = (await database.raw(
        `${lead}SELECT * FROM [${table}]${opts.lock ? ' WITH (UPDLOCK, HOLDLOCK)' : ''};`
      )) as Record<string, unknown>[]
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
  const queue = [...requested]
  const lanes = Math.max(1, Math.min(opts.concurrency ?? 1, 8))
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        if (opts.signal?.aborted) throw new Error('config snapshot aborted')
        await readTable(t)
      }
    })
  )
  if (opts.signal?.aborted) throw new Error('config snapshot aborted')
  // Lanes finish out of order; keep the table order stable for anything that walks it.
  const ordered: ConfigSnapshot['tables'] = {}
  for (const t of requested) if (tables[t]) ordered[t] = tables[t]

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
    tables: ordered,
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
