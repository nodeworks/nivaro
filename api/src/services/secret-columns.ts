/**
 * Which config columns are credentials — the one rule config snapshots (config-inventory.ts) and
 * the environment-refresh plan (env-refresh/plan.ts) mask by. A leaf module (no database import),
 * so the host refresh runner can use it without opening the app pool.
 */

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
  // Nivaro Hub: sealed credentials. stack_settings.secrets (546) is the stack's secret map
  // (DB_PASSWORD, SESSION_SECRET, ENCRYPTION_KEY …) — `secrets` escapes the name rule. The driver
  // secret (GitLab / agent token) and the environment hub token are listed too, not left to it.
  nivaro_hub_stack_settings: ['secrets'],
  nivaro_hub_drivers: ['secret'],
  // hub_token_lookup: the token's SHA-256 (phase 7) — a key to the token, never shipped either.
  nivaro_hub_environments: ['hub_token', 'hub_token_lookup', 'encryption_key', 'encryption_key_fp'],
  // X-6c, phase 3: a database's sealed connection (user + password), a server's sealed admin
  // login and a target's sealed token (544), an app's sealed OIDC secret (545) — `connection`
  // escapes the name rule; the others are listed so none is left to it.
  nivaro_hub_databases: ['connection'],
  nivaro_hub_db_servers: ['admin_secret'],
  nivaro_hub_apps: ['oidc_secret'],
  nivaro_hub_targets: ['secret'],
  // X-6c, phase 7 (550): the Hub's sealed private signing keys (escapes the name rule) and the
  // per-environment OpenID client secrets.
  nivaro_hub_oidc_keys: ['private_jwk'],
  nivaro_hub_oidc_clients: ['client_secret'],
  // Phase 6 (552): a shared deployment's sealed token (+ the previous one during the rotation
  // grace), their SHA-256 lookups and the sealed secrets object; an environment's sealed
  // ENCRYPTION_KEY and its fingerprint (a check value for the key, never shipped either).
  nivaro_hub_shared_deployments: [
    'token',
    'token_lookup',
    'prev_token',
    'prev_token_lookup',
    'secrets'
  ],
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
