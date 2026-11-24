import { config } from '../../config.js'
import { db } from '../../db/index.js'
import { appBox } from '../app-state.js'
import { isNivaroCloud, perAppJobs } from '../deployment-mode.js'
import { decryptValue, encryptValue, isEncrypted } from '../encryption.js'
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

// One cache per app (a Hub shared deployment serves many apps from this process, each with its
// own bot). A bust swaps the slot object, so a load that started before it never fills the new.
interface Slot {
  cached: { at: number; value: TeamsBotConfig } | null
  inflight: Promise<TeamsBotConfig> | null
}
const slot = appBox<Slot>(() => ({ cached: null, inflight: null }))

/** Called by the settings PATCH so a change applies at once on this process: the current app's
 *  cache inside an app, every app's outside one. */
export function bustTeamsBotConfig(): void {
  slot.reset()
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
  // A multi-tenant sign-in authority names no tenant to pin inbound activities to.
  if (!tenantId || /^(common|organizations|consumers)$/i.test(tenantId)) return null
  return {
    appId: clean(config.OIDC_CLIENT_ID),
    appSecret: clean(config.OIDC_CLIENT_SECRET),
    tenantId
  }
}

type Picked = {
  appId: string
  appSecret: string
  tenantId: string
  appType: TeamsBotAppType
  source: TeamsBotSource
}

async function readRow(): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = (await db('nivaro_settings')
      .select(
        'id',
        'teams_bot_enabled',
        'teams_bot_app_id',
        'teams_bot_app_secret',
        'teams_bot_tenant_id',
        'teams_bot_app_type'
      )
      .first()) as Record<string, unknown> | undefined
    await sealSavedSecret(raw)
    // On a shared deployment the deployment's NIVARO_SETTINGS_OVERRIDES never names an app's bot.
    return await overlaySettings(raw, { appOwnPrefix: 'teams_bot_' })
  } catch {
    return undefined
  }
}

/** A secret saved before it was sealed on save (clear text) is sealed in place, once, when the
 *  server has the key. The update matches the clear value, so a save in between is never undone;
 *  a failure (no key, read-only database) leaves the row as it was and the clear value works. */
async function sealSavedSecret(raw: Record<string, unknown> | undefined): Promise<void> {
  const v = raw?.teams_bot_app_secret
  if (typeof v !== 'string' || !v.trim() || isEncrypted(v) || raw?.id == null) return
  try {
    const sealed = encryptValue(v.trim())
    await db('nivaro_settings')
      .where({ id: raw.id, teams_bot_app_secret: v })
      .update({ teams_bot_app_secret: sealed })
    raw.teams_bot_app_secret = sealed
  } catch {
    /* left in clear; read as before */
  }
}

/** The saved secret in clear: sealed (enc:v1) or legacy clear text. One this server cannot open
 *  (another key) reads as no secret, so the bot reports itself not configured. */
function openSecret(v: unknown): string {
  const s = clean(v)
  if (!s) return ''
  try {
    return clean(decryptValue(s))
  } catch {
    return ''
  }
}

function savedSource(row: Record<string, unknown> | undefined): Picked | null {
  if (!clean(row?.teams_bot_app_id)) return null
  return {
    appId: clean(row?.teams_bot_app_id),
    appSecret: openSecret(row?.teams_bot_app_secret),
    tenantId: clean(row?.teams_bot_tenant_id),
    appType: parseAppType(row?.teams_bot_app_type) ?? 'MultiTenant',
    source: 'settings'
  }
}

/**
 * The one source pick, independent of the enable switch: first source that supplies an app id
 * wins and its secret, tenant and app type come with it (env TEAMS_BOT_* family, else the Bot
 * Framework SDK's MICROSOFT_APP_* family, else settings, else the sign-in app). Families never
 * mix: an id from one is never paired with a secret, tenant or type from another.
 *
 * On a Hub shared deployment the process env and its sign-in app are the deployment's, not any
 * app's: each app's bot is only what that app saved in Settings.
 */
function pickSource(row: Record<string, unknown> | undefined): Picked | null {
  if (perAppJobs()) return savedSource(row)
  if (clean(process.env.TEAMS_BOT_APP_ID))
    return {
      appId: clean(process.env.TEAMS_BOT_APP_ID),
      appSecret: clean(process.env.TEAMS_BOT_APP_SECRET),
      tenantId: clean(process.env.TEAMS_BOT_TENANT_ID),
      appType: parseAppType(process.env.TEAMS_BOT_APP_TYPE) ?? 'MultiTenant',
      source: 'env'
    }
  if (clean(process.env.MICROSOFT_APP_ID))
    return {
      appId: clean(process.env.MICROSOFT_APP_ID),
      appSecret: clean(process.env.MICROSOFT_APP_PASSWORD),
      tenantId: clean(process.env.MICROSOFT_APP_TENANT_ID),
      appType: parseAppType(process.env.MICROSOFT_APP_TYPE) ?? 'MultiTenant',
      source: 'env'
    }
  const saved = savedSource(row)
  if (saved) return saved
  const s = signInApp()
  return s?.appId ? { ...s, appType: 'SingleTenant', source: 'sign_in_app' } : null
}

/** What is saved/supplied for the bot, whether or not it is switched on (admin status, package). */
export async function teamsBotSetup(): Promise<Picked | null> {
  if (isNivaroCloud()) return null
  return pickSource(await readRow())
}

async function load(): Promise<TeamsBotConfig> {
  const none = {
    appId: '',
    appSecret: '',
    tenantId: '',
    appType: 'MultiTenant' as const,
    source: null
  }
  if (isNivaroCloud()) return { ...none, enabled: false, reason: 'cloud' }
  // TEAMS_BOT=off turns the bot off for the whole deployment (every app of a shared one). Its
  // `on` forces this process's one app on; on a shared deployment each app's own switch decides.
  const flag = clean(process.env.TEAMS_BOT).toLowerCase()
  if (flag === 'off') return { ...none, enabled: false, reason: 'off' }

  const row = await readRow()
  const on =
    (flag === 'on' && !perAppJobs()) ||
    row?.teams_bot_enabled === true ||
    row?.teams_bot_enabled === 1
  if (!on) return { ...none, enabled: false, reason: 'disabled' }

  const picked = pickSource(row)
  // tenantId is required for both app types: it is the inbound tenant pin.
  if (!picked?.appId || !picked.appSecret || !picked.tenantId)
    return { ...none, enabled: false, reason: 'not_configured' }
  return { enabled: true, ...picked }
}

export async function getTeamsBotConfig(): Promise<TeamsBotConfig> {
  const s = slot.value
  if (s.cached && Date.now() - s.cached.at < TTL_MS) return s.cached.value
  if (!s.inflight) {
    const p = load()
      .then((value) => {
        // A bust since this load started replaced the slot: its answer may be stale.
        if (slot.value === s) s.cached = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        if (s.inflight === p) s.inflight = null
      })
    s.inflight = p
  }
  return s.inflight
}

/** The app id the package should carry (an admin downloads it while still setting up). */
export async function configuredAppId(): Promise<string> {
  return (await teamsBotSetup())?.appId ?? ''
}
