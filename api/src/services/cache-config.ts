/**
 * Cache switches as CONFIGURATION, not only environment (2026-10-27).
 *
 * Every cache switch used to be an env var, so turning the permission cache on for
 * staging meant a stack redeploy. Each switch below now resolves, per setting:
 *
 *   1. the env var, when it is set to a valid value (env always WINS — an
 *      operator's pin survives a database restore and needs no running UI);
 *   2. this instance's stored value: the `cache` key of its
 *      `nivaro_settings_overrides` row (services/settings-overrides.ts, keyed by
 *      NIVARO_INSTANCE / NODE_ENV — every replica of one environment shares it);
 *   3. the built-in default.
 *
 * The stored layer is re-read at most every REFRESH_MS (15 s) — on a timer started
 * by the cache-config route plugin, and at once when another process moves the
 * configuration epoch (a save writes nivaro_settings_overrides, a watched table)
 * — so every replica converges within ~30 s without a restart. Readers call
 * `cacheSetting()` synchronously on their hot path; it never touches the database.
 *
 * Cloud mode: the stored layer is never read (one process serves many tenants and
 * these switches are per process): env, then default. The permission cache stays
 * off in cloud whatever is set.
 *
 * Leaf module: no static import of db/index.ts (metadata-l2.ts reads it).
 */
import { registerCache } from './cache-registry.js'

export const CACHE_OVERRIDE_KEY = 'cache'
const REFRESH_MS = 15_000
const CLOUD = () => !!process.env.CLOUD_META_DB_URL

type Kind = 'bool' | 'int' | 'mode'
export type CacheWarmModeSetting = 'on' | 'off' | 'auto'
type Value = boolean | number | string

export interface CacheSettingDef {
  /** `<group>.<field>` — the stored JSON path under `cache`. */
  key: string
  group: string
  label: string
  hint: string
  env: string
  kind: Kind
  default: Value
  min?: number
  max?: number
  /** Allowed values for kind 'mode'. */
  options?: string[]
}

const ON = ['on', 'true', '1', 'yes']
const OFF = ['off', 'false', '0', 'no']

export const CACHE_SETTINGS: CacheSettingDef[] = [
  {
    key: 'permission.enabled',
    group: 'Permission cache',
    label: 'Enabled',
    hint: 'Compiled permissions per person (#2442). Turn on for every replica of an environment together.',
    env: 'PERMISSION_CACHE',
    kind: 'bool',
    default: false
  },
  {
    key: 'permission.ttl_ms',
    group: 'Permission cache',
    label: 'Hard TTL (ms)',
    hint: 'No entry is served past this, whatever the access versions say.',
    env: 'PERMISSION_CACHE_TTL_MS',
    kind: 'int',
    default: 30_000,
    min: 1_000,
    max: 60_000
  },
  {
    key: 'permission.max',
    group: 'Permission cache',
    label: 'Max entries',
    hint: 'Entries kept per process (oldest dropped first).',
    env: 'PERMISSION_CACHE_MAX',
    kind: 'int',
    default: 20_000,
    min: 100,
    max: 200_000
  },
  {
    key: 'metadata_l2.enabled',
    group: 'Metadata L2 (Redis)',
    label: 'Enabled',
    hint: 'Configuration reads shared across processes in Redis (#2441).',
    env: 'METADATA_L2',
    kind: 'bool',
    default: true
  },
  {
    key: 'metadata_l2.ttl_s',
    group: 'Metadata L2 (Redis)',
    label: 'TTL (s)',
    hint: 'How long a stored configuration read lives in Redis.',
    env: 'METADATA_L2_TTL_S',
    kind: 'int',
    default: 600,
    min: 10,
    max: 86_400
  },
  {
    key: 'warm.mode',
    group: 'Cache warm',
    label: 'Mode',
    hint: 'Boot + 06:30 weekday warm. auto = only where scheduled jobs tick.',
    env: 'CACHE_WARM',
    kind: 'mode',
    default: 'auto',
    options: ['auto', 'on', 'off']
  },
  {
    key: 'warm.budget_ms',
    group: 'Cache warm',
    label: 'Budget (ms)',
    hint: 'Time budget for one usage-ranked warm run.',
    env: 'CACHE_WARM_BUDGET_MS',
    kind: 'int',
    default: 240_000,
    min: 1_000,
    max: 3_600_000
  },
  {
    key: 'list_total.ttl_ms',
    group: 'List reads',
    label: 'Approximate totals TTL (ms)',
    hint: 'count=approx list totals (#2443). 0 = off.',
    env: 'LIST_TOTAL_CACHE_MS',
    kind: 'int',
    default: 30_000,
    min: 0,
    max: 300_000
  },
  {
    key: 'label.ttl_ms',
    group: 'List reads',
    label: 'Relation label rows TTL (ms)',
    hint: 'labels=1 relation-label rows (#2444). 0 = off.',
    env: 'LABEL_CACHE_MS',
    kind: 'int',
    default: 30_000,
    min: 0,
    max: 300_000
  },
  {
    key: 'identity.enabled',
    group: 'Sign-in identity rows',
    label: 'Enabled',
    hint: 'The user row each request signs in with, shared by requests for a few seconds.',
    env: 'IDENTITY_CACHE',
    kind: 'bool',
    default: true
  },
  {
    key: 'identity.ttl_ms',
    group: 'Sign-in identity rows',
    label: 'TTL (ms)',
    hint: 'At most 5 s: a suspension or role change on another replica shows within this.',
    env: 'IDENTITY_CACHE_TTL_MS',
    kind: 'int',
    default: 5_000,
    min: 0,
    max: 5_000
  },
  {
    key: 'layout_bundle.enabled',
    group: 'Record form layouts',
    label: 'Enabled',
    hint: 'Sections + field assignments behind /active and /summary, per layout and configuration epoch.',
    env: 'LAYOUT_BUNDLE_CACHE',
    kind: 'bool',
    default: true
  },
  {
    key: 'layout_bundle.ttl_ms',
    group: 'Record form layouts',
    label: 'TTL (ms)',
    hint: 'Backstop for layout edits made outside this process.',
    env: 'LAYOUT_BUNDLE_CACHE_TTL_MS',
    kind: 'int',
    default: 30_000,
    min: 1_000,
    max: 300_000
  }
]

const DEFS = new Map(CACHE_SETTINGS.map((d) => [d.key, d]))

export type CacheSettingKey =
  | 'permission.enabled'
  | 'permission.ttl_ms'
  | 'permission.max'
  | 'metadata_l2.enabled'
  | 'metadata_l2.ttl_s'
  | 'warm.mode'
  | 'warm.budget_ms'
  | 'list_total.ttl_ms'
  | 'label.ttl_ms'
  | 'identity.enabled'
  | 'identity.ttl_ms'
  | 'layout_bundle.enabled'
  | 'layout_bundle.ttl_ms'

/** Exported for tests: one raw value checked against its definition (undefined = not valid). */
export function coerceSetting(def: CacheSettingDef, raw: unknown): Value | undefined {
  if (raw == null) return undefined
  if (def.kind === 'bool') {
    if (typeof raw === 'boolean') return raw
    const s = String(raw).trim().toLowerCase()
    if (s === '') return undefined
    if (ON.includes(s)) return true
    if (OFF.includes(s)) return false
    return undefined
  }
  if (def.kind === 'mode') {
    const s = String(raw).trim().toLowerCase()
    if (ON.includes(s)) return 'on'
    if (OFF.includes(s)) return 'off'
    return def.options?.includes(s) ? s : undefined
  }
  if (typeof raw === 'string' && raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  const v = Math.floor(n)
  if (def.min != null && v < def.min) return def.min
  if (def.max != null && v > def.max) return def.max
  return v
}

/** Env reading per definition. Bool switches keep their historical meaning: PERMISSION_CACHE
 *  is on only for 'on' (any other non-empty value pins it off), METADATA_L2 is off only for
 *  'off' (any other non-empty value pins it on). */
export function envSetting(def: CacheSettingDef, env = process.env): Value | undefined {
  const raw = env[def.env]
  if (raw == null || raw.trim() === '') return undefined
  if (def.key === 'permission.enabled') return raw.trim() === 'on'
  if (def.key === 'metadata_l2.enabled') return raw.trim() !== 'off'
  if (def.kind === 'int') {
    // A non-positive or junk value used to mean "the default" for these; keep it unset.
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0 || (n === 0 && (def.min ?? 0) > 0)) return undefined
  }
  return coerceSetting(def, raw)
}

export type CacheSettingSource = 'env' | 'config' | 'default' | 'cloud'

export interface EffectiveCacheSetting extends CacheSettingDef {
  value: Value
  source: CacheSettingSource
  /** The env var's raw text when set (shown so an operator sees what pins it). */
  env_value: string | null
  /** This instance's stored value, when one is stored. */
  stored: Value | null
}

// ── stored layer ─────────────────────────────────────────────────────────────

let stored: Record<string, unknown> = {}
let loadedAt = 0
let loaded = false
let effective = new Map<string, EffectiveCacheSetting>()
const listeners = new Set<(changed: Set<string>) => void>()

function storedValue(key: string): unknown {
  const [group, field] = key.split('.')
  const g = stored[group]
  return g && typeof g === 'object' ? (g as Record<string, unknown>)[field] : undefined
}

function resolveOne(def: CacheSettingDef): EffectiveCacheSetting {
  const envRaw = process.env[def.env]
  const env_value = envRaw != null && envRaw.trim() !== '' ? envRaw : null
  const fromStore = CLOUD() ? undefined : coerceSetting(def, storedValue(def.key))
  const base = { ...def, env_value, stored: fromStore ?? null }
  if (def.key === 'permission.enabled' && CLOUD()) return { ...base, value: false, source: 'cloud' }
  const fromEnv = envSetting(def)
  if (fromEnv !== undefined) return { ...base, value: fromEnv, source: 'env' }
  if (fromStore !== undefined) return { ...base, value: fromStore, source: 'config' }
  return { ...base, value: def.default, source: 'default' }
}

function recompute(): Set<string> {
  const next = new Map<string, EffectiveCacheSetting>()
  const changed = new Set<string>()
  for (const def of CACHE_SETTINGS) {
    const e = resolveOne(def)
    next.set(def.key, e)
    if (effective.get(def.key)?.value !== e.value) changed.add(def.key)
  }
  const first = effective.size === 0
  effective = next
  if (!first && changed.size > 0) {
    for (const fn of listeners) {
      try {
        fn(changed)
      } catch {
        /* one listener never stops the rest */
      }
    }
  }
  return changed
}

/** The effective value of one switch (sync, no I/O — safe on any hot path). */
export function cacheSetting(key: 'warm.mode'): CacheWarmModeSetting
export function cacheSetting(
  key: 'permission.enabled' | 'metadata_l2.enabled' | 'identity.enabled' | 'layout_bundle.enabled'
): boolean
export function cacheSetting(key: CacheSettingKey): number
export function cacheSetting(key: CacheSettingKey): Value {
  if (effective.size === 0) recompute()
  if (loaded && Date.now() - loadedAt > REFRESH_MS * 2) void refreshCacheConfig()
  const hit = effective.get(key)
  const def = DEFS.get(key)
  if (!hit || !def) return def?.default ?? false
  // One env read per call keeps env live (tests and operators that change it in-process)
  // without re-resolving every switch.
  const raw = process.env[def.env]
  const envNow = raw != null && raw.trim() !== '' ? raw : null
  if (envNow !== hit.env_value) {
    const e = resolveOne(def)
    effective.set(key, e)
    return e.value
  }
  return hit.value
}

/** Hear a switch change (stored value saved here or on another replica, or env re-read). */
export function onCacheConfigChange(fn: (changed: Set<string>) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Every switch with its value and where it came from (admin card). */
export function effectiveCacheConfig(): EffectiveCacheSetting[] {
  if (effective.size === 0) recompute()
  return CACHE_SETTINGS.map((d) => effective.get(d.key) ?? resolveOne(d))
}

async function readRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const { db } = await import('../db/index.js')
  const { instanceKey } = await import('./instance-key.js')
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

function asStored(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

let inflight: Promise<void> | null = null

/** Re-read this instance's stored switches (background pool; never throws). */
export function refreshCacheConfig(): Promise<void> {
  if (CLOUD()) {
    recompute()
    return Promise.resolve()
  }
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const { runInBackgroundPool } = await import('../db/pool-context.js')
      const row = await runInBackgroundPool(() => readRow())
      stored = asStored(row?.data[CACHE_OVERRIDE_KEY])
    } catch {
      // Table absent / DB not ready: keep the last stored values.
    } finally {
      loaded = true
      loadedAt = Date.now()
      recompute()
      inflight = null
    }
  })()
  return inflight
}

let timer: NodeJS.Timeout | null = null
let registered = false

/** Start the periodic re-read (the cache-config route plugin, once per process). */
export function startCacheConfigRefresh(): void {
  if (!registered) {
    registered = true
    // Another process saved the switches (the configuration epoch moved) or the cache console
    // asked for a bust: read them again now rather than at the next tick.
    registerCache(
      'cache-config',
      'Cache switches stored for this instance (Database → Caches)',
      () => {
        void refreshCacheConfig()
      }
    )
  }
  if (timer || CLOUD()) return
  void refreshCacheConfig()
  timer = setInterval(() => void refreshCacheConfig(), REFRESH_MS)
  timer.unref?.()
}

export function stopCacheConfigRefresh(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export class CacheConfigError extends Error {
  constructor(
    message: string,
    readonly field: string
  ) {
    super(message)
  }
}

/** Exported for tests: apply a patch `{ "permission.enabled": true, "identity.ttl_ms": null }`
 *  (null clears a stored value back to env/default) onto a stored map. */
export function mergeCacheConfigPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, Record<string, unknown>> = {}
  for (const [g, v] of Object.entries(current)) next[g] = { ...asStored(v) }
  for (const [key, raw] of Object.entries(patch)) {
    const def = DEFS.get(key)
    if (!def) throw new CacheConfigError(`Unknown cache setting: ${key}`, key)
    const [group, field] = key.split('.')
    if (raw === null) {
      if (next[group]) delete next[group][field]
      continue
    }
    const v = coerceSetting(def, raw)
    if (v === undefined) throw new CacheConfigError(`Invalid value for ${key}`, key)
    next[group] ??= {}
    next[group][field] = v
  }
  for (const g of Object.keys(next)) if (Object.keys(next[g]).length === 0) delete next[g]
  return next
}

/** Store switches for THIS instance (admin card). Env still wins where set. */
export async function saveCacheConfig(
  patch: Record<string, unknown>
): Promise<EffectiveCacheSetting[]> {
  if (CLOUD()) throw new CacheConfigError('Cache switches are platform-managed in cloud mode', '')
  const { db } = await import('../db/index.js')
  const { instanceKey } = await import('./instance-key.js')
  const row = await readRow()
  const nextCache = mergeCacheConfigPatch(asStored(row?.data[CACHE_OVERRIDE_KEY]), patch)
  const data = { ...(row?.data ?? {}), [CACHE_OVERRIDE_KEY]: nextCache }
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
  stored = nextCache
  loaded = true
  loadedAt = Date.now()
  recompute()
  return effectiveCacheConfig()
}

/** Tests only: set the stored layer directly (fires change listeners like a refresh). */
export function setStoredCacheConfigForTests(next: Record<string, unknown> | null): void {
  stored = next ?? {}
  if (next === null) {
    loaded = false
    effective = new Map()
    return
  }
  loaded = true
  loadedAt = Date.now()
  recompute()
}

/** Tests only: re-read env (a test changed process.env). */
export function recomputeCacheConfigForTests(): Set<string> {
  return recompute()
}
