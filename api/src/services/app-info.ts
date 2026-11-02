import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { mobileClients, mobileSignInEnabled } from '../lib/mobile-clients.js'
import { NIVARO_VERSION } from '../version.js'
import { chaosAllowed } from './chaos/gate.js'
import { phonePushEnabled } from './phone-push.js'
import { overlaySettings } from './settings-overrides.js'

export interface AppInfo {
  name: string
  color: string | null
  logo_url: string | null
  version: string
  cloud: boolean
  environment: 'production' | 'staging' | 'development' | 'test' | 'other'
  min_app_version: string | null
  sign_in: { mobile: boolean; client_ids: string[] }
  push: { mode: 'off' | 'direct' | 'relay' }
  features: string[]
  blocked: null | 'suspended' | 'provisioning' | 'maintenance'
}

/** What a tenant hook already knows when it lets the probe through a blocked tenant. */
export interface AppInfoBlock {
  kind: 'suspended' | 'provisioning'
  name: string
}

export function appEnvironment(): AppInfo['environment'] {
  const v = (process.env.NIVARO_ENVIRONMENT ?? '').trim().toLowerCase()
  if (v) {
    return v === 'production' || v === 'staging' || v === 'development' || v === 'test'
      ? v
      : 'other'
  }
  return process.env.NODE_ENV === 'production' ? 'production' : 'development'
}

// Replaced by phonePushMode() from services/phone-push.ts once Task 5 merges.
async function pushMode(): Promise<AppInfo['push']['mode']> {
  return phonePushEnabled() ? 'direct' : 'off'
}

/** Areas the phone app may show, from the switches the admin already uses. */
export function enabledFeatures(env: NodeJS.ProcessEnv = process.env): string[] {
  const cloud = !!env.CLOUD_META_DB_URL
  const out = ['chat', 'ask_ai', 'huddles', 'command_center', 'help_videos', 'support']
  out.push('session_replay')
  if (!cloud) out.push('infrastructure')
  if (chaosAllowed(env)) out.push('chaos')
  if (!cloud && (env.TEAMS_BOT ?? '').trim().toLowerCase() !== 'off') out.push('teams_bot')
  out.push('traffic_map')
  return out
}

async function readBranding(): Promise<{
  name: string | null
  color: string | null
  logo: string | null
}> {
  try {
    const row = (await db('nivaro_settings')
      .where({ id: 1 })
      .first('project_name', 'project_color', 'brand_logo')) as Record<string, unknown> | undefined
    const s = (await overlaySettings(row)) ?? {}
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    return { name: str(s.project_name), color: str(s.project_color), logo: str(s.brand_logo) }
  } catch {
    return { name: null, color: null, logo: null }
  }
}

async function maintenanceOn(): Promise<boolean> {
  try {
    const { maintenanceState } = await import('./security.js')
    return !!(await maintenanceState()).on
  } catch {
    return false
  }
}

export async function buildAppInfo(opts: { block?: AppInfoBlock | null } = {}): Promise<AppInfo> {
  const block = opts.block ?? null
  // A blocked tenant has no database to read: the hook hands over its name.
  const brand = block ? { name: block.name, color: null, logo: null } : await readBranding()
  const base = adminBaseUrl() ?? ''
  return {
    name: brand.name ?? 'Nivaro',
    color: brand.color,
    logo_url: brand.logo ? `${base}/api/files/${brand.logo}` : null,
    version: NIVARO_VERSION,
    cloud: !!process.env.CLOUD_META_DB_URL,
    environment: appEnvironment(),
    min_app_version: process.env.MOBILE_MIN_APP_VERSION?.trim() || null,
    sign_in: {
      mobile: mobileSignInEnabled(),
      client_ids: mobileClients().map((c) => c.client_id)
    },
    push: { mode: await pushMode() },
    features: enabledFeatures(),
    blocked: block ? block.kind : (await maintenanceOn()) ? 'maintenance' : null
  }
}
