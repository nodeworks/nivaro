/**
 * Environment refresh — THE registry of what belongs to an environment.
 *
 * A refresh copies one environment's whole database over another (production → staging, …).
 * Everything comes from the source EXCEPT what this registry says the TARGET keeps: its endpoints,
 * credentials, switches, test accounts and own operations state. The table classification itself
 * is not forked: every nivaro_* table is already CONFIG / DERIVED / RUNTIME in config-inventory.ts
 * (the generic half of promote-config's classification); a refresh adds one decision on top —
 * "the target keeps it" — and everything without that decision follows the source.
 *
 * The guard test (env-refresh-registry.test.ts) fails when:
 *   - a nivaro_* table is in none of config-inventory's lists,
 *   - a nivaro_settings column is in neither SETTINGS_KEEP nor SETTINGS_FROM_SOURCE,
 *   - a credential column of a config table has no refresh decision,
 *   - an entry names a table or column that does not exist.
 *
 * Extensions add entries with `ctx.environments.registerKeep` (and the host runner reads the same
 * entries from the extension's refresh config module).
 */
import type { EnvKeepEntryInput } from '@nivaro/extension-kit'

export type EnvKeepEntry = EnvKeepEntryInput & { source: 'core' | string }

/**
 * nivaro_settings columns the TARGET keeps: where it sends mail/SMS/push/Teams, its AI provider and
 * keys, storage, directory + sign-in, maintenance state, scheduled-job switches, integration
 * remediation/notification switches, its own monitoring settings and recording switches.
 */
export const SETTINGS_KEEP: readonly string[] = [
  // who and where this environment is
  'project_name',
  'project_url',
  'project_color',
  'environment_label',
  'brand_login_message',
  'portal_url',
  'portal_routes',
  'gateway_url',
  'provision_secret',
  // mail
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
  'smtp_secure',
  'mail_test_mode',
  'mail_test_recipient',
  'mail_test_allowlist',
  // SMS
  'sms_provider',
  'sms_account_sid',
  'sms_auth_token',
  'sms_from',
  'sms_region',
  'sms_test_mode',
  'sms_test_recipient',
  'sms_test_allowlist',
  // browser / phone push
  'vapid_public_key',
  'vapid_private_key',
  'vapid_subject',
  'push_test_mode',
  'push_test_recipient',
  'push_test_allowlist',
  // Microsoft Teams
  'teams_webhook_url',
  'teams_test_mode',
  'teams_test_webhook_url',
  'teams_bot_enabled',
  'teams_bot_app_id',
  'teams_bot_app_secret',
  'teams_bot_tenant_id',
  'teams_bot_app_type',
  // AI provider + keys
  'anthropic_api_key',
  'ai_provider',
  'ai_gateway_format',
  'ai_gateway_model',
  'ai_gateway_base_url',
  'ai_gateway_token_url',
  'ai_gateway_client_id',
  'ai_gateway_client_secret',
  'ai_gateway_chat_model',
  'ai_gateway_extract_model',
  'ai_models',
  'ai_prompt_caching',
  // file storage
  'storage_provider',
  'storage_s3_bucket',
  'storage_s3_endpoint',
  'storage_s3_access_key',
  'storage_s3_secret',
  'storage_s3_region',
  'storage_cdn_url',
  'storage_key_prefix',
  'storage_driver',
  'storage_config',
  // directory sync + sign-in
  'directory_sync_enabled',
  'directory_sync_suspend',
  'directory_sync_last_run',
  'directory_sync_last_summary',
  'directory_auth_mode',
  'directory_username',
  'directory_password',
  'directory_refresh_token',
  'directory_connected_user',
  'directory_connected_at',
  'oidc_primary_disabled',
  // maintenance state of THIS environment
  'maintenance_mode',
  'maintenance_message',
  'maintenance_display',
  'maintenance_until',
  // scheduled jobs + integration switches
  'paused_crons',
  'cron_overrides',
  'cron_chains',
  'integration_notifications_enabled',
  'integration_remediation_enabled',
  'integration_obligations_epoch',
  // this environment's own monitoring + assistants
  'ops_channel',
  'traffic_map_settings',
  'traffic_history',
  'db_tuning',
  'sql_checks',
  'mcp_settings',
  // recording switches and volume
  'session_recording_enabled',
  'error_replay_enabled',
  'session_recording_retention_days',
  'replay_daily_cap_mb',
  'replay_sampling',
  'replay_cold_after_days',
  // help videos are recorded per environment (keep-help-videos keeps the tables)
  'help_video_author_roles',
  'help_video_card_logo_image',
  'help_video_settings'
]

/** nivaro_settings columns that follow the source: product configuration, the same everywhere. */
export const SETTINGS_FROM_SOURCE: readonly string[] = [
  'id',
  'updated_at',
  'default_language',
  'project_description',
  'ad_group_role_map',
  'presence_session_ttl',
  'presence_sweep_interval',
  'presence_ping_interval',
  'presence_display',
  'ai_model',
  'ai_max_tokens_generate',
  'ai_max_tokens_summarize',
  'ai_disabled_features',
  'ai_chat_guide',
  'ai_answer_cache_minutes',
  'ai_conversation_retention_days',
  'sla_business_day_start',
  'sla_business_day_end',
  'sla_business_days',
  'sla_holidays',
  'sla_timezone',
  'sla_zone_map',
  'file_max_size_mb',
  'collection_page_size',
  'activity_retention_days',
  'revision_retention_count',
  'available_locales',
  'two_factor_enabled',
  'chat_bot_name',
  'chat_general',
  'chat_history_retention_days',
  'chat_archive_idle_days',
  'field_watch_enabled',
  'brand_logo',
  'brand_login_title',
  'login_links',
  'formula_constants',
  'fiscal_year_start_month',
  'welcome_message',
  'auto_index_fk',
  'lock_takeover_roles',
  'lock_idle_release_minutes',
  'default_timezone',
  'theme_radius',
  'theme_font',
  'theme_accents',
  'new_user_role',
  'access_request_role',
  'erp_submission_payload_retention_days',
  'transition_guard_seconds',
  'graphql_deprecation_days',
  'graphql_strict_mutations',
  'dashboard_role_defaults',
  'dashboard_headline',
  'team_stuck_hours',
  'session_policy',
  'slo_targets',
  'replay_masking',
  'frustration_weights',
  'replay_auto_signals',
  'mcp_tools',
  'nav_role_defaults',
  'overview_role_defaults',
  'command_center'
]

/** Machine accounts and test accounts (reserved test domains, RFC 2606 / 6761) on the target. */
export const KEPT_ACCOUNTS_WHERE =
  "[account_kind] IN ('service', 'integration', 'bot') OR [email] LIKE '%.test' OR [email] LIKE '%.invalid' OR [email] LIKE '%.example' OR [email] LIKE '%.internal' OR [email] LIKE '%@example.com'"

const NEWEST_QUALITY_RUN =
  '[run] IN (SELECT TOP 1 [id] FROM {{db}}.[nivaro_quality_runs] ORDER BY [captured_at] DESC)'

/** The core's own entries. */
export const CORE_KEEPS: readonly EnvKeepEntry[] = [
  {
    source: 'core',
    id: 'core:settings',
    label: 'Instance settings: mail, SMS, push, Teams, AI keys, storage, sign-in, job switches',
    reason:
      'Where this environment sends mail and alerts, its own keys and its switches — never the source’s.',
    table: 'nivaro_settings',
    kind: 'columns',
    key: ['id'],
    columns: [...SETTINGS_KEEP],
    secret_columns: [
      'smtp_pass',
      'sms_account_sid',
      'sms_auth_token',
      'vapid_private_key',
      'teams_bot_app_secret',
      'anthropic_api_key',
      'ai_gateway_client_secret',
      'storage_s3_access_key',
      'storage_s3_secret',
      'provision_secret',
      'directory_password',
      'directory_refresh_token'
    ]
  },
  {
    source: 'core',
    id: 'core:settings-overrides',
    label: 'Per-instance settings (caches, push relay, sign-in linking, daily report)',
    reason: 'Rows keyed by instance — they describe this environment’s processes.',
    table: 'nivaro_settings_overrides',
    kind: 'table',
    secret_columns: ['data']
  },
  {
    source: 'core',
    id: 'core:external-apis',
    label: 'External API endpoints, credentials, mocks and body secrets',
    reason:
      'Partners are reached at this environment’s endpoints with its own credentials (payload-template body secrets live in auth_config).',
    table: 'nivaro_external_apis',
    kind: 'columns',
    key: ['name'],
    columns: [
      'base_url',
      'auth_type',
      'auth_config',
      'headers',
      'enabled',
      'mock_config',
      'instance_overrides',
      'health_path',
      'health_method',
      'health_expect_status'
    ],
    secret_columns: ['auth_config', 'headers', 'instance_overrides']
  },
  {
    source: 'core',
    id: 'core:webhooks',
    label: 'Webhook targets and on/off',
    reason: 'Outgoing webhooks point at this environment’s receivers.',
    table: 'nivaro_webhooks',
    kind: 'columns',
    key: ['name'],
    columns: ['url', 'method', 'headers', 'secret', 'signing_secret', 'enabled'],
    secret_columns: ['headers', 'secret', 'signing_secret']
  },
  {
    source: 'core',
    id: 'core:sso',
    label: 'Sign-in providers (SSO / OIDC)',
    reason: 'Each environment signs in through its own app registration.',
    table: 'nivaro_sso_providers',
    kind: 'columns',
    key: ['key'],
    columns: ['issuer', 'client_id', 'client_secret', 'is_active'],
    secret_columns: ['client_secret']
  },
  {
    source: 'core',
    id: 'core:sync-jobs',
    label: 'Partner sync jobs on/off',
    reason: 'Scheduled partner syncs run only where this environment turned them on.',
    table: 'nivaro_sync_jobs',
    kind: 'columns',
    key: ['name'],
    columns: ['is_active']
  },
  {
    source: 'core',
    id: 'core:scheduled-reports',
    label: 'Scheduled report emails on/off',
    reason: 'Scheduled sends are a per-environment switch.',
    table: 'nivaro_scheduled_reports',
    kind: 'columns',
    key: ['name'],
    columns: ['is_active']
  },
  {
    source: 'core',
    id: 'core:accounts',
    label: 'Service, integration and test accounts',
    reason:
      'Accounts tooling signs in with (deploy, MCP, partner keys) and test accounts on reserved test domains keep this environment’s tokens.',
    table: 'nivaro_users',
    kind: 'rows',
    key: ['id'],
    where: KEPT_ACCOUNTS_WHERE,
    secret_columns: ['password_hash', 'static_token', 'totp_secret']
  },
  {
    source: 'core',
    id: 'core:api-keys',
    label: 'API keys of service and integration accounts',
    reason:
      'Keys handed to tooling and partners on this environment (the staging MCP key, deploy keys) must keep working.',
    table: 'nivaro_api_keys',
    kind: 'rows',
    key: ['id'],
    where: `[user] IN (SELECT [id] FROM {{db}}.[nivaro_users] WHERE ${KEPT_ACCOUNTS_WHERE})`,
    secret_columns: ['key_hash']
  },
  {
    source: 'core',
    id: 'core:environments',
    label: 'Environments registry',
    reason: 'The tiers, probes and their tokens as this environment knows them.',
    table: 'nivaro_environments',
    kind: 'table'
  },
  {
    source: 'core',
    id: 'core:environment-components',
    label: 'Environment components (probe and git tokens)',
    reason: 'The tiers, probes and their tokens as this environment knows them.',
    table: 'nivaro_environment_components',
    kind: 'table',
    secret_columns: ['api_token', 'git_token', 'db_config']
  },
  {
    source: 'core',
    id: 'core:push-subscriptions',
    label: 'Browser and phone push registrations',
    reason:
      'Devices registered here keep getting this environment’s alerts; the source’s devices never do.',
    table: 'nivaro_push_subscriptions',
    kind: 'table',
    secret_columns: ['endpoint', 'keys_p256dh', 'keys_auth']
  },
  {
    source: 'core',
    id: 'core:teams-links',
    label: 'Teams bot conversations',
    reason: 'Teams chats belong to this environment’s bot; the source’s would message real people.',
    table: 'nivaro_teams_links',
    kind: 'table'
  },
  ...(
    [
      'nivaro_runbook_queue',
      'nivaro_runbook_queue_lines',
      'nivaro_runbook_agents',
      'nivaro_runbook_step_timings',
      'nivaro_quality_runs',
      'nivaro_quality_rows',
      'nivaro_quality_results',
      'nivaro_quality_known'
    ] as const
  ).map(
    (table): EnvKeepEntry => ({
      source: 'core',
      id: `core:${table.replace(/^nivaro_/, '')}`,
      label: table.startsWith('nivaro_runbook')
        ? `Runbook queue (${table.replace(/^nivaro_runbook_/, '').replace(/_/g, ' ')})`
        : `Quality checks (${table.replace(/^nivaro_quality_/, '')})`,
      reason:
        'This database holds the host runbook queue and quality results — including the refresh that is running.',
      table,
      kind: 'table',
      only_when: 'runbook-queue-db',
      // Baselines are large (gz snapshots, ~860 MB on EFP_Development 2026-11-16): only the newest
      // run's are kept — the one a quality re-run diffs against.
      ...(table === 'nivaro_quality_rows' || table === 'nivaro_quality_results'
        ? { where: NEWEST_QUALITY_RUN }
        : {})
    })
  )
]

/**
 * Config tables with credential columns that FOLLOW the source on purpose. The guard test makes
 * every config table with a credential column either a keep entry or a line here.
 */
export const SOURCE_CREDENTIAL_DECISIONS: Readonly<Record<string, string>> = {
  nivaro_users:
    'People’s own accounts follow the source as they are (no scrubbing); service and test accounts are kept.',
  nivaro_submission_forms:
    'A public form’s token and password belong to the form; the links people were handed point at the source.',
  nivaro_widget_feeds: 'Embed tokens belong to the feed definition.',
  nivaro_custom_queries:
    'A public query’s token belongs to the query; links handed out point at the source.',
  nivaro_managed_procedures:
    'deployed_* describe the database the copy came from; the app-managed deploy re-checks by live definition.'
}

// ─── Extension registrations ────────────────────────────────────────────────

const extensionKeeps = new Map<string, EnvKeepEntry>()

export class EnvKeepError extends Error {}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validates an entry (throws EnvKeepError) — the same rules for core and extension entries. */
export function validateKeepEntry(e: EnvKeepEntryInput): void {
  if (!e || typeof e.id !== 'string' || !e.id.trim())
    throw new EnvKeepError('a keep entry needs an id')
  if (!IDENT.test(e.table)) throw new EnvKeepError(`${e.id}: table must be a plain name`)
  if (!['table', 'columns', 'rows', 'delegate'].includes(e.kind))
    throw new EnvKeepError(`${e.id}: kind must be table, columns, rows or delegate`)
  for (const c of [...(e.key ?? []), ...(e.columns ?? []), ...(e.secret_columns ?? [])])
    if (!IDENT.test(c)) throw new EnvKeepError(`${e.id}: column ${c} must be a plain name`)
  for (const t of e.tables ?? [])
    if (!IDENT.test(t)) throw new EnvKeepError(`${e.id}: table ${t} must be a plain name`)
  if (e.kind === 'columns' && (!e.key?.length || !e.columns?.length))
    throw new EnvKeepError(`${e.id}: a columns entry needs key and columns`)
  if (e.kind === 'columns' && e.columns?.some((c) => e.key?.includes(c)))
    throw new EnvKeepError(`${e.id}: a key column cannot also be kept`)
  if (e.where && e.kind !== 'rows' && e.kind !== 'table')
    throw new EnvKeepError(`${e.id}: only a rows or table entry takes where`)
  if (e.kind === 'rows' && (!e.key?.length || !e.where?.trim()))
    throw new EnvKeepError(`${e.id}: a rows entry needs key and where`)
  if (e.where && /;|--|\/\*/.test(e.where))
    throw new EnvKeepError(`${e.id}: where must be one predicate (no ; or comments)`)
  for (const cmd of [e.commands?.save, e.commands?.restore]) {
    if (!cmd) continue
    if (e.kind !== 'delegate')
      throw new EnvKeepError(`${e.id}: only a delegate entry runs commands`)
    if (!['npx', 'tsx', 'node', 'bash'].includes(cmd[0] ?? ''))
      throw new EnvKeepError(`${e.id}: a command starts with npx, tsx, node or bash`)
    if (cmd.some((a) => typeof a !== 'string' || a.includes('..')))
      throw new EnvKeepError(`${e.id}: command arguments are plain strings without ..`)
  }
}

export function registerExtensionKeep(extension: string, entry: EnvKeepEntryInput): void {
  validateKeepEntry(entry)
  if (CORE_KEEPS.some((c) => c.id === entry.id))
    throw new EnvKeepError(`${entry.id} is a core entry`)
  extensionKeeps.set(entry.id, { ...entry, source: extension })
}

/** Every entry: the core's, then the extensions' (registered or passed in by the host runner). */
export function allKeeps(extra: EnvKeepEntry[] = [...extensionKeeps.values()]): EnvKeepEntry[] {
  const seen = new Set<string>()
  const out: EnvKeepEntry[] = []
  for (const e of [...CORE_KEEPS, ...extra]) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}

/** The entries a refresh INTO this target applies. */
export function keepsForTarget(
  entries: EnvKeepEntry[],
  target: { runbook_queue?: boolean }
): EnvKeepEntry[] {
  return entries.filter((e) => e.only_when !== 'runbook-queue-db' || target.runbook_queue === true)
}

/** Every table an entry touches (delegates list several). */
export function entryTables(e: EnvKeepEntryInput): string[] {
  return [e.table, ...(e.tables ?? [])]
}

/** Test seam. */
export function _resetExtensionKeeps(): void {
  extensionKeeps.clear()
}
