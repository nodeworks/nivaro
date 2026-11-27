/**
 * The app settings a Nivaro Hub may set through the hub link (`POST /api/hub-link/settings/apply`,
 * Hub providers Task 13): an output of a managed resource (an SMTP password, an AI key, a LiveKit
 * secret) lands here without anyone copying it. Read by BOTH sides — the Hub refuses to bind any
 * other key, the app refuses to write any other key (400 SETTING_NOT_ALLOWED). A leaf module: no
 * imports, so the Hub's binding store can read it without pulling the app's settings code in.
 */

/** Exact keys. */
export const APP_SETTING_KEYS: readonly string[] = [
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
  'sms_provider',
  'sms_account_sid',
  'sms_auth_token',
  'sms_from',
  'sms_region',
  'anthropic_api_key',
  'sentry_dsn',
  'huddle_livekit_url',
  'huddle_livekit_key',
  'huddle_livekit_secret'
]

/** Key families: every `ai_gateway_*` column of nivaro_settings. */
const APP_SETTING_PATTERNS: readonly RegExp[] = [/^ai_gateway_[a-z][a-z0-9_]{0,40}$/]

/** Whether the Hub may set this app setting. Pure. */
export function appSettingAllowed(key: string): boolean {
  return APP_SETTING_KEYS.includes(key) || APP_SETTING_PATTERNS.some((re) => re.test(key))
}

/** The AI gateway columns a form offers by name (any other `ai_gateway_*` column binds too). */
const AI_GATEWAY_KEYS = [
  'ai_gateway_base_url',
  'ai_gateway_token_url',
  'ai_gateway_client_id',
  'ai_gateway_client_secret',
  'ai_gateway_model'
]

/** The allowed keys a form offers. */
export function appSettingChoices(): string[] {
  return [...APP_SETTING_KEYS, ...AI_GATEWAY_KEYS]
}
