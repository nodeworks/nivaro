/**
 * Per-instance settings overrides (2026-08-24): local dev and staging can
 * share ONE database, which means they share ONE nivaro_settings row — so the
 * staging SMTP relay config is also what local mail resolution finds, and it
 * only works from the staging box.
 *
 * Two override layers, applied at the settings-read choke points (mail, SMS):
 *
 *  1. `nivaro_settings_overrides` — one DB row per INSTANCE KEY holding a JSON
 *     map of settings-column overrides, edited in Settings → Instance. The
 *     instance key is `NIVARO_INSTANCE` env, falling back to NODE_ENV — so a
 *     local dev process ("development") and the deployed box ("production")
 *     already read different rows with zero setup.
 *  2. `NIVARO_SETTINGS_OVERRIDES` — env JSON object, the emergency top layer
 *     (survives a DB restore, needs no running UI). Wins over layer 1.
 *
 * An explicit null override clears the DB value back to the env-var fallback
 * chain. The admin Settings page keeps showing/editing the shared row; the
 * Instance tab shows what THIS instance overlays on top.
 */

import { db } from '../db/index.js'
import { instanceKey } from './instance-key.js'

export { instanceKey }

// ── Env layer (parsed once) ─────────────────────────────────────────────────
let envParsed: Record<string, unknown> | null | undefined

function envOverrides(): Record<string, unknown> | null {
  if (envParsed !== undefined) return envParsed
  const raw = process.env.NIVARO_SETTINGS_OVERRIDES
  if (!raw || !raw.trim()) {
    envParsed = null
    return null
  }
  try {
    const obj = JSON.parse(raw)
    envParsed = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
    if (!envParsed)
      console.warn('[settings-overrides] NIVARO_SETTINGS_OVERRIDES is not a JSON object — ignored')
  } catch {
    envParsed = null
    console.warn('[settings-overrides] NIVARO_SETTINGS_OVERRIDES is invalid JSON — ignored')
  }
  return envParsed ?? null
}

/**
 * Keys in an instance's override row that are NOT settings columns: per-instance JSON a feature
 * owns (Traffic Map detector settings, #2223). Never overlaid onto a settings row, never shown or
 * written by Settings → Instance (which keeps them when it saves).
 */
export const INSTANCE_RESERVED_KEYS = [
  'traffic_detectors',
  'huddle',
  'chaos',
  'recovery',
  // Daily operations report (services/ops-report/settings.ts): on/off, window, model, cap.
  'ops_report',
  // Phone push relay (services/push-relay.ts): relay key + content mode.
  'mobile_push',
  // Label house style for the layout lint (services/layout-style.ts, #3184).
  'layout_style',
  // Cache switches (services/cache-config.ts): per-instance, never a settings column.
  'cache',
  // Providers that may link an existing account by email (auth/account-link-policy.ts).
  'sso_link_by_email',
  // Reload old tabs when idle (services/idle-reload.ts, #2937).
  'idle_reload',
  // Audience confirm threshold for configs that send to people (services/audience-gate.ts, #3080).
  'audience_confirm',
  // "This is staging" sign-in notice (services/environment-notice.ts).
  'environment_notice',
  // Config changed here, not from promotion (services/config-drift/store.ts): refuse, baseline.
  'config_drift'
] as const

export function withoutReservedKeys(map: Record<string, unknown>): Record<string, unknown> {
  const out = { ...map }
  for (const k of INSTANCE_RESERVED_KEYS) delete out[k]
  return out
}

// ── DB layer (30s cache; busted by the instance-overrides route) ────────────
let dbCache: { at: number; map: Record<string, unknown> | null } | null = null

export function bustInstanceOverridesCache(): void {
  dbCache = null
}

export async function getInstanceOverrides(): Promise<Record<string, unknown> | null> {
  if (dbCache && Date.now() - dbCache.at < 30_000) return dbCache.map
  let map: Record<string, unknown> | null = null
  try {
    const row = (await db('nivaro_settings_overrides')
      .where({ instance_key: instanceKey() })
      .first('data')) as { data?: string | null } | undefined
    if (row?.data) {
      const obj = JSON.parse(row.data)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) map = withoutReservedKeys(obj)
    }
  } catch {
    // Table absent mid-migration / DB not ready — the shared row carries on.
    map = null
  }
  dbCache = { at: Date.now(), map }
  return map
}

/** Overlay this instance's overrides (DB row, then env on top) onto a
 *  nivaro_settings row or partial row. */
export async function overlaySettings<T extends Record<string, unknown> | undefined>(
  row: T
): Promise<T> {
  const dbLayer = await getInstanceOverrides()
  const envLayer = envOverrides()
  if (!dbLayer && !envLayer) return row
  const base: Record<string, unknown> = row ? { ...row } : {}
  for (const [k, v] of Object.entries(dbLayer ?? {})) base[k] = v
  for (const [k, v] of Object.entries(envLayer ?? {})) base[k] = v
  return base as NonNullable<T>
}

/** Synchronous env-only overlay — for call sites that cannot await. */
export function overlayEnvSettings<T extends Record<string, unknown> | undefined>(row: T): T {
  const o = envOverrides()
  if (!o) return row
  const base: Record<string, unknown> = row ? { ...row } : {}
  for (const [k, v] of Object.entries(o)) base[k] = v
  return base as NonNullable<T>
}

/** The override keys active on this instance (env layer — for provenance). */
export function envOverrideKeys(): string[] {
  const o = envOverrides()
  return o ? Object.keys(o) : []
}

/** The env layer as parsed (a copy) — for the Settings → This Instance read-only view. */
export function envOverrideMap(): Record<string, unknown> {
  const o = envOverrides()
  return o ? { ...o } : {}
}

/** Test seam: forget the parsed env layer so the next read parses NIVARO_SETTINGS_OVERRIDES again. */
export function resetEnvOverridesForTest(): void {
  envParsed = undefined
}

/** One NIVARO_SETTINGS_OVERRIDES key as Settings → This Instance shows it (read-only). */
export interface EnvOverrideView {
  key: string
  /** Display text: secrets masked, objects as JSON (secret-looking members masked), null = cleared. */
  value: string | null
  secret: boolean
  /** The DB override row on this instance names the same key — the env value wins over it. */
  shadows_db: boolean
}

// Names that read as credentials even when they are not in the settings secret list
// (the env layer may name any column, or a feature's per-instance JSON). Over-masking is the safe side.
const SECRET_NAME = /(pass(word)?|secret|token|(^|_)key$|private|credential|webhook)/i

function looksSecret(key: string, secretKeys: readonly string[]): boolean {
  return secretKeys.includes(key) || SECRET_NAME.test(key)
}

function maskDeep(v: unknown, mask: string): unknown {
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, mask))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_NAME.test(k) ? (x == null || x === '' ? x : mask) : maskDeep(x, mask)
    }
    return out
  }
  return v
}

/**
 * The env layer for display: every key it sets, its value masked the way GET /settings masks
 * credentials (a set secret = the mask, an unset one = null), and whether the DB override row
 * names the same key (that row value is shadowed — the env one is what this instance uses).
 * Pure: no env or DB reads.
 */
export function describeEnvOverrides(
  envMap: Record<string, unknown>,
  dbMap: Record<string, unknown>,
  secretKeys: readonly string[],
  mask: string
): EnvOverrideView[] {
  return Object.keys(envMap)
    .sort()
    .map((key) => {
      const raw = envMap[key]
      const secret = looksSecret(key, secretKeys)
      let value: string | null
      if (raw == null) value = null
      else if (secret) value = raw === '' ? null : mask
      else if (typeof raw === 'object') value = JSON.stringify(maskDeep(raw, mask))
      else value = String(raw)
      return { key, value, secret, shadows_db: Object.hasOwn(dbMap, key) }
    })
}
