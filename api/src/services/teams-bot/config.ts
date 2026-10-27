import { config } from '../../config.js'
import { db } from '../../db/index.js'
import { overlaySettings } from '../settings-overrides.js'

export type TeamsBotSource = 'env' | 'settings' | 'sign_in_app'

export type TeamsBotAppType = 'MultiTenant' | 'SingleTenant'

export interface TeamsBotConfig {
  enabled: boolean
  appId: string
  appSecret: string
  /** The customer's own tenant: the inbound tenant pin in BOTH app types. */
  tenantId: string
  /** How the bot app is registered: decides the outbound token authority (connector.ts). */
  appType: TeamsBotAppType
  /** Where the id/secret/tenant triple came from (always one source, never mixed). */
  source: TeamsBotSource | null
  reason?: 'cloud' | 'off' | 'disabled' | 'not_configured'
}

const TTL_MS = 30_000
let cached: { at: number; value: TeamsBotConfig } | null = null
let inflight: Promise<TeamsBotConfig> | null = null
let epoch = 0

/** Called by the settings PATCH so a change applies at once on this process. */
export function bustTeamsBotConfig(): void {
  cached = null
  inflight = null
  epoch++
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 'multitenant' / 'SingleTenant' in any case; anything else is "not said". */
function parseAppType(v: unknown): TeamsBotAppType | null {
  const t = clean(v).toLowerCase()
  if (t === 'multitenant') return 'MultiTenant'
  if (t === 'singletenant') return 'SingleTenant'
  return null
}

// Same rule as auth/oidc.ts isMicrosoftIssuer (kept local: importing oidc pulls openid-client).
function signInApp(): { appId: string; appSecret: string; tenantId: string } | null {
  const issuer = config.OIDC_ISSUER
  if (!/microsoftonline\.com|windows\.net/i.test(issuer)) return null
  const tenantId = /\.(?:microsoftonline\.com|windows\.net)\/([^/]+)/i.exec(issuer)?.[1] ?? ''
  return {
    appId: clean(config.OIDC_CLIENT_ID),
    appSecret: clean(config.OIDC_CLIENT_SECRET),
    tenantId
  }
}

async function load(): Promise<TeamsBotConfig> {
  const none = {
    appId: '',
    appSecret: '',
    tenantId: '',
    appType: 'MultiTenant' as const,
    source: null
  }
  if (process.env.CLOUD_META_DB_URL) return { ...none, enabled: false, reason: 'cloud' }
  const flag = clean(process.env.TEAMS_BOT).toLowerCase()
  if (flag === 'off') return { ...none, enabled: false, reason: 'off' }

  let row: Record<string, unknown> | undefined
  try {
    row = await overlaySettings(
      (await db('nivaro_settings')
        .select(
          'teams_bot_enabled',
          'teams_bot_app_id',
          'teams_bot_app_secret',
          'teams_bot_tenant_id',
          'teams_bot_app_type'
        )
        .first()) as Record<string, unknown> | undefined
    )
  } catch {
    row = undefined
  }

  const on = flag === 'on' || row?.teams_bot_enabled === true || row?.teams_bot_enabled === 1
  if (!on) return { ...none, enabled: false, reason: 'disabled' }

  // First source that supplies an app id wins; its secret and tenant come with it.
  let picked: {
    appId: string
    appSecret: string
    tenantId: string
    appType: TeamsBotAppType
    source: TeamsBotSource
  } | null = null
  // Env: TEAMS_BOT_* first, else the Bot Framework SDK's own names. One family supplies the whole
  // triple (an id from one family is never paired with a secret from the other).
  const envAppType =
    parseAppType(process.env.TEAMS_BOT_APP_TYPE) ??
    parseAppType(process.env.MICROSOFT_APP_TYPE) ??
    'MultiTenant'
  if (clean(process.env.TEAMS_BOT_APP_ID)) {
    picked = {
      appId: clean(process.env.TEAMS_BOT_APP_ID),
      appSecret: clean(process.env.TEAMS_BOT_APP_SECRET),
      tenantId: clean(process.env.TEAMS_BOT_TENANT_ID),
      appType: envAppType,
      source: 'env'
    }
  } else if (clean(process.env.MICROSOFT_APP_ID)) {
    picked = {
      appId: clean(process.env.MICROSOFT_APP_ID),
      appSecret: clean(process.env.MICROSOFT_APP_PASSWORD),
      tenantId: clean(process.env.MICROSOFT_APP_TENANT_ID),
      appType: envAppType,
      source: 'env'
    }
  } else if (clean(row?.teams_bot_app_id)) {
    picked = {
      appId: clean(row?.teams_bot_app_id),
      appSecret: clean(row?.teams_bot_app_secret),
      tenantId: clean(row?.teams_bot_tenant_id),
      appType: parseAppType(row?.teams_bot_app_type) ?? 'MultiTenant',
      source: 'settings'
    }
  } else {
    const s = signInApp()
    if (s?.appId) picked = { ...s, appType: 'SingleTenant', source: 'sign_in_app' }
  }

  // tenantId is required for both app types: it is the inbound tenant pin.
  if (!picked?.appId || !picked.appSecret || !picked.tenantId)
    return { ...none, enabled: false, reason: 'not_configured' }
  return { enabled: true, ...picked }
}

export async function getTeamsBotConfig(): Promise<TeamsBotConfig> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value
  if (!inflight) {
    const mine = epoch
    const p = load()
      .then((value) => {
        if (mine === epoch) cached = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        if (inflight === p) inflight = null
      })
    inflight = p
  }
  return inflight
}

/**
 * The app id the package should carry: the same pick order as the config, but regardless of the
 * enable switch or a missing secret (an admin downloads the package while still setting up).
 */
export async function configuredAppId(): Promise<string> {
  const env = clean(process.env.TEAMS_BOT_APP_ID) || clean(process.env.MICROSOFT_APP_ID)
  if (env) return env
  try {
    const row = overlaySettings(
      (await db('nivaro_settings').select('teams_bot_app_id').first()) as
        | Record<string, unknown>
        | undefined
    )
    const id = clean((await row)?.teams_bot_app_id)
    if (id) return id
  } catch {
    // fall through
  }
  return signInApp()?.appId ?? ''
}
