import { db } from '../db/index.js'
import { type ClientVersion, judgeable } from './client-version.js'
import type { BuildJudge } from './client-versions-cluster.js'
import { instanceKey } from './instance-key.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Reload old tabs when idle (#2937). After a release, a tab still on an older build reloads by
 * itself once nobody has typed or clicked in it for a while and nothing in it is unsaved
 * (packages/shared lib/idle-reload.ts decides that in the browser). The server only answers
 * "is this tab old?" — with the one notion of "current build" there is (makeBuildJudge: instance
 * roster + 10 minute settle window, never the newest page load alone) — and the setting.
 *
 * The setting lives under the `idle_reload` key of THIS instance's nivaro_settings_overrides row
 * (next to `huddle` and `recovery`), never a migration. `AUTO_RELOAD_IDLE=on|off` wins over it
 * (a database rebuilt nightly from another one loses a hand-flipped setting).
 */

export const IDLE_RELOAD_OVERRIDE_KEY = 'idle_reload'
export const DEFAULT_IDLE_SECONDS = 60
export const MIN_IDLE_SECONDS = 30
export const MAX_IDLE_SECONDS = 3600

export interface IdleReloadSettings {
  /** Old tabs reload by themselves when idle (default on). */
  auto_reload_idle: boolean
  /** Seconds without typing or clicking before a tab counts as idle. */
  idle_seconds: number
}

export const IDLE_RELOAD_DEFAULTS: IdleReloadSettings = {
  auto_reload_idle: true,
  idle_seconds: DEFAULT_IDLE_SECONDS
}

/** Stored JSON → settings (pure; anything unreadable falls back to the default). */
export function normalizeIdleReloadSettings(raw: unknown): IdleReloadSettings {
  const src =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const n = Number(src.idle_seconds)
  return {
    auto_reload_idle: src.auto_reload_idle !== false,
    idle_seconds: Number.isFinite(n)
      ? Math.min(MAX_IDLE_SECONDS, Math.max(MIN_IDLE_SECONDS, Math.round(n)))
      : DEFAULT_IDLE_SECONDS
  }
}

/** AUTO_RELOAD_IDLE=on|off, or null when unset / unreadable. */
export function idleReloadEnv(raw = process.env.AUTO_RELOAD_IDLE): boolean | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(v)) return true
  if (['off', 'false', '0', 'no'].includes(v)) return false
  return null
}

/** The env switch over the stored value. */
export function effectiveIdleReload(stored: IdleReloadSettings): IdleReloadSettings & {
  env: boolean | null
} {
  const env = idleReloadEnv()
  return { ...stored, auto_reload_idle: env ?? stored.auto_reload_idle, env }
}

// ── Storage (30 s cache per tenant; the PATCH route busts it) ─────────────────
const cache = new Map<string, { at: number; value: IdleReloadSettings }>()

export function bustIdleReloadSettingsCache(): void {
  cache.clear()
}

async function readRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  if (!row) return null
  try {
    const obj = row.data ? JSON.parse(row.data) : {}
    return { id: row.id, data: obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {} }
  } catch {
    return { id: row.id, data: {} }
  }
}

/** This instance's stored setting (defaults when the table is missing or unreadable). */
export async function getIdleReloadSettings(): Promise<IdleReloadSettings> {
  const tenant = currentTenantKey()
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < 30_000) return hit.value
  let value = IDLE_RELOAD_DEFAULTS
  try {
    value = normalizeIdleReloadSettings((await readRow())?.data[IDLE_RELOAD_OVERRIDE_KEY])
  } catch {
    /* table absent / DB not ready — defaults */
  }
  cache.set(tenant, { at: Date.now(), value })
  if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  return value
}

export async function saveIdleReloadSettings(patch: unknown): Promise<IdleReloadSettings> {
  const row = await readRow()
  const stored = normalizeIdleReloadSettings(row?.data[IDLE_RELOAD_OVERRIDE_KEY])
  const p =
    patch && typeof patch === 'object' && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {}
  const next = normalizeIdleReloadSettings({
    auto_reload_idle: 'auto_reload_idle' in p ? p.auto_reload_idle : stored.auto_reload_idle,
    idle_seconds: 'idle_seconds' in p ? p.idle_seconds : stored.idle_seconds
  })
  const data = { ...(row?.data ?? {}), [IDLE_RELOAD_OVERRIDE_KEY]: next }
  if (row) {
    await db('nivaro_settings_overrides')
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  } else {
    await db('nivaro_settings_overrides').insert({
      instance_key: instanceKey(),
      data: JSON.stringify(data),
      updated_at: new Date()
    })
  }
  bustIdleReloadSettingsCache()
  return next
}

// ── Is this tab old? ─────────────────────────────────────────────────────────

export interface IdleReloadVerdict {
  /** Why the tab is old (the judge's own answer); null = current, unknown or not judged now. */
  older: 'build' | 'api' | null
  /** The build (or API version) the tab would reload onto; null when not old. */
  target: string | null
  /** The per-tab marker id a reload for this target carries (one automatic reload per target). */
  id: string | null
  /** Why the tab was not judged old, for the client's own log line. */
  reason: 'old' | 'current' | 'unknown' | 'settling' | 'partial'
}

/**
 * Pure: judge one tab against the cluster's BuildJudge. Never old when only this replica's tabs
 * were read (`partial`): a replica whose tabs are all old would call the old build current.
 */
export function idleReloadVerdict(
  judge: Pick<BuildJudge, 'older' | 'current' | 'api' | 'settlingOf'>,
  tab: { app: string | null; version: ClientVersion | null },
  partial: boolean
): IdleReloadVerdict {
  const none = (reason: IdleReloadVerdict['reason']): IdleReloadVerdict => ({
    older: null,
    target: null,
    id: null,
    reason
  })
  if (partial) return none('partial')
  // Dev and unreported builds are never judged.
  if (!tab.version || !judgeable(tab.version.build)) return none('unknown')
  const older = judge.older(tab)
  if (!older) return none(judge.settlingOf(tab) ? 'settling' : 'current')
  const app = tab.app ?? 'app'
  const target =
    (older === 'build' ? judge.current.get(app) : judge.api) ?? judge.current.get(app) ?? 'newer'
  return { older, target, id: `idle-${app}-${target}`.slice(0, 120), reason: 'old' }
}
