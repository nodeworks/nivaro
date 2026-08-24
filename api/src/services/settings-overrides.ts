/**
 * Per-instance settings overrides (Rob, 2026-08-24): local dev and staging can
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

export function instanceKey(): string {
  return (
    process.env.NIVARO_INSTANCE?.trim() || process.env.NODE_ENV?.trim() || 'default'
  )
}

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
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) map = obj
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
