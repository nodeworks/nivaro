import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'

// Instance-wide help-video settings, stored as one JSON object in
// nivaro_settings.help_video_settings (migration 410; NULL = every default).
//
//   { "encoder": { ... } }       — how renders are encoded (#1561), this file
//   { "house_style": { ... } }   — #1551, help-video-house-style.ts
//
// This module owns `encoder` only. Every save rewrites ONLY the keys it is
// handed and keeps every other top-level key exactly as stored, so a later
// owner (house_style) and this one never overwrite each other.
//
// A database behind migration 410 has no column: reads answer the defaults
// with `migrated: false`, saves are refused (HELP_VIDEO_SETTINGS_MIGRATION_PENDING).

export const HELP_VIDEO_SETTINGS_COLUMN = 'help_video_settings'

export const ENCODER_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower'
] as const
export type EncoderPreset = (typeof ENCODER_PRESETS)[number]
export const HARDWARE_MODES = ['off', 'auto'] as const
export type HardwareMode = (typeof HARDWARE_MODES)[number]

export interface EncoderSettings {
  /** libx264 speed/size trade-off. Hardware encoders have no presets. */
  preset: EncoderPreset
  /** libx264 constant quality, 16 (best) – 32 (smallest). Hardware encoders
   *  take a bitrate derived from it instead (help-video-encoder.ts). */
  crf: number
  /** Two-pass encoding for videos whose edited length is over this many
   *  minutes; 0 = never. Two-pass aims at a bitrate derived from the CRF. */
  two_pass_over_minutes: number
  /** 'auto' = a hardware H.264 encoder when this host has a working one
   *  (VideoToolbox, VAAPI), else libx264. 'off' = always libx264. */
  hardware: HardwareMode
}

/** Today's encode: veryfast / CRF 23, one pass, software. */
export const ENCODER_DEFAULTS: EncoderSettings = {
  preset: 'veryfast',
  crf: 23,
  two_pass_over_minutes: 0,
  hardware: 'off'
}
export const CRF_MIN = 16
export const CRF_MAX = 32
export const TWO_PASS_MAX_MINUTES = 240

/** Environment fallbacks, used for a key the settings do not set. */
export const ENCODER_ENV: Record<keyof EncoderSettings, string> = {
  preset: 'HELP_VIDEO_ENCODER_PRESET',
  crf: 'HELP_VIDEO_ENCODER_CRF',
  two_pass_over_minutes: 'HELP_VIDEO_TWO_PASS_OVER_MINUTES',
  hardware: 'HELP_VIDEO_HARDWARE_ENCODER'
}

export class HelpVideoSettingsError extends Error {
  statusCode: number
  code: string
  constructor(message: string, statusCode = 400, code = 'HELP_VIDEO_SETTINGS_INVALID') {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

type Raw = Record<string, unknown>

/** The stored JSON as an object; anything unreadable is treated as empty. */
export function parseStoredSettings(raw: unknown): Raw {
  if (raw == null || raw === '') return {}
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Raw) } : {}
}

/** One encoder value, or undefined when it is not a valid one. */
function readKey<K extends keyof EncoderSettings>(
  key: K,
  v: unknown
): EncoderSettings[K] | undefined {
  if (v === undefined || v === null || v === '') return undefined
  switch (key) {
    case 'preset': {
      const s = String(v).trim().toLowerCase()
      return (ENCODER_PRESETS as readonly string[]).includes(s)
        ? (s as EncoderSettings[K])
        : undefined
    }
    case 'crf': {
      const n = Number(v)
      return Number.isInteger(n) && n >= CRF_MIN && n <= CRF_MAX
        ? (n as EncoderSettings[K])
        : undefined
    }
    case 'two_pass_over_minutes': {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 && n <= TWO_PASS_MAX_MINUTES
        ? ((Math.round(n * 10) / 10) as EncoderSettings[K])
        : undefined
    }
    case 'hardware': {
      const s = String(v).trim().toLowerCase()
      return (HARDWARE_MODES as readonly string[]).includes(s)
        ? (s as EncoderSettings[K])
        : undefined
    }
  }
  return undefined
}

const KEYS = Object.keys(ENCODER_DEFAULTS) as Array<keyof EncoderSettings>

/** The encoder keys the settings set (lenient: a bad stored value is ignored). */
export function storedEncoder(stored: Raw): Partial<EncoderSettings> {
  const e = stored.encoder
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {}
  const out: Partial<EncoderSettings> = {}
  for (const k of KEYS) {
    const v = readKey(k, (e as Raw)[k])
    if (v !== undefined) (out as Raw)[k] = v
  }
  return out
}

export type EncoderSource = 'setting' | 'env' | 'default'

/** The encoder a render uses: each key from the settings, else the
 *  environment, else the default — and where each one came from. */
export function effectiveEncoder(
  stored: Partial<EncoderSettings>,
  env: NodeJS.ProcessEnv = process.env
): { encoder: EncoderSettings; sources: Record<keyof EncoderSettings, EncoderSource> } {
  const encoder = { ...ENCODER_DEFAULTS }
  const sources = {} as Record<keyof EncoderSettings, EncoderSource>
  for (const k of KEYS) {
    if (stored[k] !== undefined) {
      ;(encoder as Raw)[k] = stored[k]
      sources[k] = 'setting'
      continue
    }
    const fromEnv = readKey(k, env[ENCODER_ENV[k]])
    if (fromEnv !== undefined) {
      ;(encoder as Raw)[k] = fromEnv
      sources[k] = 'env'
    } else sources[k] = 'default'
  }
  return { encoder, sources }
}

/** A PATCH's `encoder` checked strictly: every bad key is named. `null` for a
 *  key = unset it (back to the environment / default). */
export function validateEncoderPatch(
  input: unknown
): Partial<Record<keyof EncoderSettings, unknown>> {
  if (input === null) return Object.fromEntries(KEYS.map((k) => [k, null]))
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HelpVideoSettingsError('encoder must be an object')
  }
  const out: Partial<Record<keyof EncoderSettings, unknown>> = {}
  const bad: string[] = []
  for (const [k, v] of Object.entries(input as Raw)) {
    if (!(KEYS as string[]).includes(k)) {
      bad.push(`encoder.${k} is not a setting`)
      continue
    }
    const key = k as keyof EncoderSettings
    if (v === null) {
      out[key] = null
      continue
    }
    const ok = readKey(key, v)
    if (ok === undefined) {
      bad.push(
        key === 'preset'
          ? `encoder.preset must be one of ${ENCODER_PRESETS.join(', ')}`
          : key === 'crf'
            ? `encoder.crf must be a whole number from ${CRF_MIN} to ${CRF_MAX}`
            : key === 'two_pass_over_minutes'
              ? `encoder.two_pass_over_minutes must be 0 (never) to ${TWO_PASS_MAX_MINUTES}`
              : `encoder.hardware must be one of ${HARDWARE_MODES.join(', ')}`
      )
      continue
    }
    out[key] = ok
  }
  if (bad.length) throw new HelpVideoSettingsError(bad.join('; '))
  return out
}

/** The stored JSON after a patch: only `encoder` changes, and only the keys
 *  named; every other top-level key (house_style, a newer image's keys) stays
 *  exactly as stored. An empty object stores NULL (all defaults). */
export function serializeSettings(
  storedRaw: unknown,
  patch: { encoder?: Partial<Record<keyof EncoderSettings, unknown>> }
): string | null {
  const next = parseStoredSettings(storedRaw)
  if (patch.encoder) {
    const cur = storedEncoder(next)
    for (const [k, v] of Object.entries(patch.encoder)) {
      if (v === null) delete (cur as Raw)[k]
      else (cur as Raw)[k] = v
    }
    if (Object.keys(cur).length) next.encoder = cur
    else delete next.encoder
  }
  return Object.keys(next).length ? JSON.stringify(next) : null
}

// ── storage ────────────────────────────────────────────────────────────────

const TTL_MS = 30_000
let cache: { at: number; value: { migrated: boolean; stored: Raw } } | null = null

export function bustHelpVideoSettings(): void {
  cache = null
}

async function columnExists(): Promise<boolean> {
  try {
    return await hasColumn('nivaro_settings', HELP_VIDEO_SETTINGS_COLUMN)
  } catch {
    return false
  }
}

/** The stored settings (30 s cache). Never throws: a failed read = defaults. */
export async function loadHelpVideoSettings(): Promise<{ migrated: boolean; stored: Raw }> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  let value: { migrated: boolean; stored: Raw } = { migrated: false, stored: {} }
  try {
    if (await columnExists()) {
      const row = (await db('nivaro_settings')
        .where({ id: 1 })
        .first(HELP_VIDEO_SETTINGS_COLUMN)) as Raw | undefined
      value = { migrated: true, stored: parseStoredSettings(row?.[HELP_VIDEO_SETTINGS_COLUMN]) }
    }
  } catch {
    // degraded: defaults
  }
  cache = { at: Date.now(), value }
  return value
}

/** The encoder a render uses right now. */
export async function renderEncoderSettings(): Promise<EncoderSettings> {
  const { stored } = await loadHelpVideoSettings()
  return effectiveEncoder(storedEncoder(stored)).encoder
}

/** Save a patch. Reads the CURRENT stored value (never the cache) so a key
 *  another owner wrote a moment ago survives. */
export async function saveHelpVideoSettings(patch: { encoder?: unknown }): Promise<Raw> {
  if (!(await columnExists())) {
    throw new HelpVideoSettingsError(
      'Help-video settings need migration 410, which this database has not run yet.',
      409,
      'HELP_VIDEO_SETTINGS_MIGRATION_PENDING'
    )
  }
  const clean: { encoder?: Partial<Record<keyof EncoderSettings, unknown>> } = {}
  if ('encoder' in patch) clean.encoder = validateEncoderPatch(patch.encoder)
  const row = (await db('nivaro_settings').where({ id: 1 }).first(HELP_VIDEO_SETTINGS_COLUMN)) as
    | Raw
    | undefined
  if (!row) throw new HelpVideoSettingsError('The settings row is missing', 500, 'SETTINGS_MISSING')
  const value = serializeSettings(row[HELP_VIDEO_SETTINGS_COLUMN], clean)
  await db('nivaro_settings')
    .where({ id: 1 })
    .update({ [HELP_VIDEO_SETTINGS_COLUMN]: value })
  bustHelpVideoSettings()
  return parseStoredSettings(value)
}
