import { randomUUID } from 'node:crypto'
import { db } from '../../db/index.js'
import { getApp } from '../io-holder.js'
import {
  type FaultParams,
  type FaultTarget,
  getFault,
  type HypothesisRule,
  validateParams,
  validateTarget
} from './catalog.js'
import { ChaosError } from './gate.js'
import { SHIPPED_PRESETS } from './presets-shipped.js'

/**
 * Fault presets (#2855): saved scenarios — a fault, its target, strength, duration and the
 * steady-state hypothesis — each with what it proves and the scorecard claims (#2830) it tests.
 *
 * Two sources merged into one list:
 *   shipped  in code (presets-shipped.ts), one per common claim; read-only
 *   saved    `nivaro_chaos_presets` (migration 497, CONFIG — promoted between instances); when
 *            the table is missing, a Redis hash `nvr:chaos:presets` (no expiry: it is config),
 *            else this process's memory
 * A saved preset with a shipped preset's key replaces it (customise a shipped preset); deleting
 * that saved row brings the shipped one back. Shipped presets themselves cannot be deleted.
 */

export interface PresetSpec {
  fault_key: string
  target?: FaultTarget
  params?: FaultParams
  seconds?: number
  hypothesis?: HypothesisRule[]
  note?: string | null
}

export interface ChaosPreset {
  id: string | null
  key: string
  label: string
  description: string | null
  proves: string | null
  claim_keys: string[]
  spec: PresetSpec
  source: 'shipped' | 'saved'
  /** A saved preset that replaces a shipped one of the same key. */
  overrides_shipped: boolean
  created_by: string | null
  updated_at: string | null
}

export type PresetStoreMode = 'db' | 'redis' | 'memory'

export interface PresetInput {
  key?: unknown
  label?: unknown
  description?: unknown
  proves?: unknown
  claim_keys?: unknown
  spec?: unknown
}

const TABLE = 'nivaro_chaos_presets'
const REDIS_KEY = 'nvr:chaos:presets'
const KEY_RE = /^[a-z][a-z0-9_.-]{1,79}$/
const CLAIM_RE = /^[a-z][a-z0-9_.-]{1,80}$/
const SAMPLER_RE = /^[\w.-]{1,60}$/
const OPS = new Set(['<', '<=', '>', '>='])
const MAX_SAVED = 500

// ─── Backing selection ────────────────────────────────────────────────────────

let tableSeen: { at: number; has: boolean } | null = null
let forcedMode: PresetStoreMode | null = null
const mem = new Map<string, ChaosPreset>()

async function hasTable(): Promise<boolean> {
  if (forcedMode) return forcedMode === 'db'
  if (tableSeen && Date.now() - tableSeen.at < 60_000) return tableSeen.has
  let has = false
  try {
    has = await db.schema.hasTable(TABLE)
  } catch {
    has = false
  }
  tableSeen = { at: Date.now(), has }
  return has
}

interface RedisHash {
  hgetall(k: string): Promise<Record<string, string>>
  hset(k: string, f: string, v: string): Promise<unknown>
  hdel(k: string, f: string): Promise<unknown>
}

function redis(): RedisHash | null {
  if (forcedMode && forcedMode !== 'redis') return null
  try {
    return (getApp()?.redis as RedisHash | undefined) ?? null
  } catch {
    return null
  }
}

export async function presetStoreMode(): Promise<PresetStoreMode> {
  if (await hasTable()) return 'db'
  return redis() ? 'redis' : 'memory'
}

/** Tests only: pin the backing and forget the table probe. */
export function _setPresetStoreForTests(mode: PresetStoreMode | null): void {
  forcedMode = mode
  tableSeen = null
  mem.clear()
}

// ─── Shapes ───────────────────────────────────────────────────────────────────

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const SHIPPED_KEYS = new Set(SHIPPED_PRESETS.map((p) => p.key))

function fromRow(r: Record<string, unknown>): ChaosPreset {
  const key = String(r.key)
  return {
    id: r.id ? String(r.id).toLowerCase() : null,
    key,
    label: String(r.label ?? key),
    description: (r.description as string) ?? null,
    proves: (r.proves as string) ?? null,
    claim_keys: parseJson<string[]>(r.claim_keys, []),
    spec: parseJson<PresetSpec>(r.spec, { fault_key: '' }),
    source: 'saved',
    overrides_shipped: SHIPPED_KEYS.has(key),
    created_by: r.created_by ? String(r.created_by).toLowerCase() : null,
    updated_at: iso(r.updated_at)
  }
}

function toRow(p: ChaosPreset): Record<string, unknown> {
  return {
    id: p.id,
    key: p.key,
    label: p.label,
    description: p.description,
    proves: p.proves,
    claim_keys: JSON.stringify(p.claim_keys),
    spec: JSON.stringify(p.spec),
    created_by: p.created_by,
    updated_at: new Date(p.updated_at ?? Date.now())
  }
}

function shipped(): ChaosPreset[] {
  return SHIPPED_PRESETS.map((p) => ({
    id: null,
    key: p.key,
    label: p.label,
    description: p.description ?? null,
    proves: p.proves,
    claim_keys: [...p.claim_keys],
    spec: structuredClone(p.spec),
    source: 'shipped' as const,
    overrides_shipped: false,
    created_by: null,
    updated_at: null
  }))
}

// ─── Validation ───────────────────────────────────────────────────────────────

const str = (v: unknown, max: number): string | null => {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

function hypothesisOf(raw: unknown): HypothesisRule[] {
  if (!Array.isArray(raw)) return []
  const out: HypothesisRule[] = []
  for (const r of raw.slice(0, 20)) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const sampler = String(o.sampler ?? '').trim()
    const op = String(o.op ?? '<')
    const limit = Number(o.limit)
    if (!SAMPLER_RE.test(sampler) || !OPS.has(op) || !Number.isFinite(limit))
      throw new ChaosError(`hypothesis line "${sampler || '?'}" is not valid`, 400, 'CHAOS_PRESET')
    const tolerance = o.tolerance == null ? undefined : Math.max(0, Number(o.tolerance) || 0)
    out.push({ sampler, op: op as HypothesisRule['op'], limit, tolerance })
  }
  return out
}

/**
 * A checked spec. Against a fault this instance knows, the catalog's own validators run (target
 * shape, params clamped into the caps, seconds into [5, max]); a preset promoted from an instance
 * with more faults keeps its spec as written — the run start checks it again either way.
 */
export function validateSpec(raw: unknown): PresetSpec {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const faultKey = String(s.fault_key ?? '').trim()
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(faultKey))
    throw new ChaosError('spec.fault_key must name a fault', 400, 'CHAOS_PRESET')
  const def = getFault(faultKey)
  const hypothesis = s.hypothesis == null ? undefined : hypothesisOf(s.hypothesis)
  const note = str(s.note, 500)
  if (def) {
    const seconds =
      s.seconds == null
        ? undefined
        : Math.round(Math.min(def.max_seconds, Math.max(5, Number(s.seconds) || 0)))
    return {
      fault_key: faultKey,
      target: validateTarget(def, s.target ?? { kind: def.targets[0] ?? 'all' }),
      params: validateParams(def, s.params),
      ...(seconds != null ? { seconds } : {}),
      ...(hypothesis ? { hypothesis } : {}),
      ...(note ? { note } : {})
    }
  }
  const params: FaultParams = {}
  for (const [k, v] of Object.entries((s.params ?? {}) as Record<string, unknown>).slice(0, 20)) {
    if (/^[a-z_][a-z0-9_]{0,40}$/i.test(k) && ['number', 'string', 'boolean'].includes(typeof v))
      params[k] = typeof v === 'string' ? v.slice(0, 200) : (v as number | boolean)
  }
  const target =
    s.target && typeof s.target === 'object' && typeof (s.target as FaultTarget).kind === 'string'
      ? (s.target as FaultTarget)
      : undefined
  const seconds = s.seconds == null ? undefined : Math.max(5, Math.min(3600, Number(s.seconds)))
  return {
    fault_key: faultKey,
    ...(target ? { target } : {}),
    params,
    ...(seconds != null && Number.isFinite(seconds) ? { seconds: Math.round(seconds) } : {}),
    ...(hypothesis ? { hypothesis } : {}),
    ...(note ? { note } : {})
  }
}

function validateInput(
  input: PresetInput,
  existing?: ChaosPreset | null
): Omit<ChaosPreset, 'id' | 'source' | 'overrides_shipped' | 'created_by' | 'updated_at'> {
  const key = String(input.key ?? existing?.key ?? '').trim()
  if (!KEY_RE.test(key))
    throw new ChaosError(
      'key must be 2–80 lower-case letters, digits, dots, dashes or underscores',
      400,
      'CHAOS_PRESET'
    )
  const label = str(input.label, 200) ?? existing?.label ?? null
  if (!label) throw new ChaosError('label is required', 400, 'CHAOS_PRESET')
  const claims = Array.isArray(input.claim_keys)
    ? input.claim_keys.map((c) => String(c).trim()).filter((c) => CLAIM_RE.test(c))
    : (existing?.claim_keys ?? [])
  return {
    key,
    label,
    description:
      input.description === undefined
        ? (existing?.description ?? null)
        : str(input.description, 2000),
    proves: input.proves === undefined ? (existing?.proves ?? null) : str(input.proves, 2000),
    claim_keys: [...new Set(claims)].slice(0, 20),
    spec: validateSpec(input.spec ?? existing?.spec)
  }
}

// ─── Saved presets ────────────────────────────────────────────────────────────

async function listSaved(): Promise<ChaosPreset[]> {
  if (await hasTable()) {
    try {
      const rows = (await db(TABLE).select('*').orderBy('label').limit(MAX_SAVED)) as Array<
        Record<string, unknown>
      >
      return rows.map(fromRow)
    } catch {
      /* the next backing */
    }
  }
  const r = redis()
  if (r) {
    try {
      const all = await r.hgetall(REDIS_KEY)
      return Object.values(all ?? {})
        .map((v) => parseJson<ChaosPreset | null>(v, null))
        .filter((p): p is ChaosPreset => !!p && typeof p.key === 'string')
        .map((p) => ({
          ...p,
          source: 'saved' as const,
          overrides_shipped: SHIPPED_KEYS.has(p.key)
        }))
    } catch {
      /* memory */
    }
  }
  return [...mem.values()]
}

async function writeSaved(p: ChaosPreset, isNew: boolean): Promise<void> {
  if (await hasTable()) {
    if (isNew) await db(TABLE).insert(toRow(p))
    else {
      const { id: _id, ...patch } = toRow(p)
      await db(TABLE).where({ key: p.key }).update(patch)
    }
    return
  }
  const r = redis()
  if (r) {
    await r.hset(REDIS_KEY, p.key, JSON.stringify(p))
    return
  }
  mem.set(p.key, p)
}

async function removeSaved(key: string): Promise<boolean> {
  if (await hasTable()) return (await db(TABLE).where({ key }).del()) > 0
  const r = redis()
  if (r) return Number(await r.hdel(REDIS_KEY, key)) > 0
  return mem.delete(key)
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Shipped and saved presets as one list (a saved preset replaces a shipped one by key). */
export async function listPresets(): Promise<ChaosPreset[]> {
  const saved = await listSaved()
  const byKey = new Map<string, ChaosPreset>()
  for (const p of shipped()) byKey.set(p.key, p)
  for (const p of saved) byKey.set(p.key, p)
  return [...byKey.values()]
}

/** One preset by key or id. */
export async function getPreset(keyOrId: string): Promise<ChaosPreset | null> {
  const k = String(keyOrId).toLowerCase()
  return (await listPresets()).find((p) => p.key === k || p.id === k) ?? null
}

/** Create, or replace by key (a shipped key makes a saved override). */
export async function savePreset(
  input: PresetInput,
  by: { id: string | null },
  opts: { mustBeNew?: boolean } = {}
): Promise<ChaosPreset> {
  const key = String(input.key ?? '').trim()
  const saved = (await listSaved()).find((p) => p.key === key) ?? null
  if (saved && opts.mustBeNew)
    throw new ChaosError(`a preset with key ${key} already exists`, 409, 'CHAOS_PRESET_EXISTS')
  const base = saved ?? shipped().find((p) => p.key === key) ?? null
  const v = validateInput(input, base)
  const preset: ChaosPreset = {
    ...v,
    id: saved?.id ?? randomUUID(),
    source: 'saved',
    overrides_shipped: SHIPPED_KEYS.has(v.key),
    created_by: saved?.created_by ?? by.id,
    updated_at: new Date().toISOString()
  }
  await writeSaved(preset, !saved)
  return preset
}

/** Patch a preset by key: a shipped one becomes a saved override. */
export async function updatePreset(
  key: string,
  patch: PresetInput,
  by: { id: string | null }
): Promise<ChaosPreset> {
  const current = await getPreset(key)
  if (!current) throw new ChaosError('No such preset', 404, 'CHAOS_PRESET_NOT_FOUND')
  return savePreset({ ...patch, key: current.key }, by)
}

/**
 * Delete a saved preset. A shipped preset cannot be deleted; deleting its saved override
 * restores it (`restored: true`).
 */
export async function deletePreset(key: string): Promise<{ deleted: boolean; restored: boolean }> {
  const current = await getPreset(key)
  if (!current) throw new ChaosError('No such preset', 404, 'CHAOS_PRESET_NOT_FOUND')
  if (current.source === 'shipped')
    throw new ChaosError('Shipped presets cannot be deleted', 400, 'CHAOS_PRESET_SHIPPED')
  const deleted = await removeSaved(current.key)
  return { deleted, restored: deleted && SHIPPED_KEYS.has(current.key) }
}
