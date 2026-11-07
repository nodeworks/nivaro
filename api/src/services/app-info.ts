import type { FastifyRequest } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { tenantOrigin } from '../db/tenant-context.js'
import { mobileClients, mobileSignInEnabled } from '../lib/mobile-clients.js'
import { NIVARO_VERSION } from '../version.js'
import { chaosAllowed } from './chaos/gate.js'
import { phonePushMode } from './phone-push.js'
import { overlaySettings } from './settings-overrides.js'
import { currentTenantKey } from './tenant-rooms.js'

export interface AppInfo {
  name: string
  /** Where this instance is reached: adminBaseUrl() self-hosted, the tenant's canonical (or
   *  verified) origin in cloud. */
  origin: string
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
export type AppInfoBlock = NonNullable<FastifyRequest['nvrTenantBlock']>

export function appEnvironment(env: NodeJS.ProcessEnv = process.env): AppInfo['environment'] {
  const v = (env.NIVARO_ENVIRONMENT ?? '').trim().toLowerCase()
  if (v) {
    return v === 'production' || v === 'staging' || v === 'development' || v === 'test'
      ? v
      : 'other'
  }
  // army7 b10: staging runs NODE_ENV=production and told apps it was production.
  // With no NIVARO_ENVIRONMENT, an instance named for an environment
  // (NIVARO_INSTANCE=staging) says which one it is before NODE_ENV does.
  const named = INSTANCE_ENVIRONMENTS[(env.NIVARO_INSTANCE ?? '').trim().toLowerCase()]
  if (named) return named
  return env.NODE_ENV === 'production' ? 'production' : 'development'
}

const INSTANCE_ENVIRONMENTS: Record<string, AppInfo['environment']> = {
  production: 'production',
  prod: 'production',
  staging: 'staging',
  stage: 'staging',
  development: 'development',
  dev: 'development',
  test: 'test'
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

/** Push mode per tenant for a short while: the probe is anonymous and the relay key a read. */
const PUSH_MODE_TTL_MS = 30_000
const PUSH_MODE_MAX = 1000
const pushModes = new Map<string, { at: number; mode: AppInfo['push']['mode'] }>()

async function cachedPushMode(): Promise<AppInfo['push']['mode']> {
  const key = currentTenantKey()
  const hit = pushModes.get(key)
  if (hit && Date.now() - hit.at < PUSH_MODE_TTL_MS) return hit.mode
  const mode = await phonePushMode()
  if (pushModes.size >= PUSH_MODE_MAX) pushModes.clear()
  pushModes.set(key, { at: Date.now(), mode })
  return mode
}

/** Test hook: forget cached push modes. */
export function resetAppInfoCache(): void {
  pushModes.clear()
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
  const origin = process.env.CLOUD_META_DB_URL ? (block?.origin ?? tenantOrigin() ?? '') : base
  return {
    name: brand.name ?? 'Nivaro',
    origin,
    color: brand.color,
    // Cloud: on the tenant's own origin, never the shared process's address.
    logo_url: brand.logo
      ? `${process.env.CLOUD_META_DB_URL ? origin : base}/api/files/${brand.logo}`
      : null,
    version: NIVARO_VERSION,
    cloud: !!process.env.CLOUD_META_DB_URL,
    environment: appEnvironment(),
    min_app_version: process.env.MOBILE_MIN_APP_VERSION?.trim() || null,
    sign_in: {
      mobile: mobileSignInEnabled(),
      client_ids: mobileClients().map((c) => c.client_id)
    },
    // The relay key may live in the tenant's settings; a blocked tenant sends nothing anyway.
    push: { mode: block ? 'off' : await cachedPushMode() },
    features: enabledFeatures(),
    blocked: block ? block.kind : (await maintenanceOn()) ? 'maintenance' : null
  }
}
