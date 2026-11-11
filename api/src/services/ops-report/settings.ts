/**
 * Daily operations report — settings (#ops-report, 2026-11-10).
 *
 * Per instance, under the `ops_report` key of THIS instance's `nivaro_settings_overrides` row
 * (INSTANCE_RESERVED_KEYS), so a database copied from another instance never turns the report
 * on or changes who gets it. Off by default.
 */
import { db } from '../../db/index.js'
import { instanceKey } from '../instance-key.js'

export const OPS_REPORT_KEY = 'ops_report'

export interface OpsReportSettings {
  /** The nightly run (cron `ops-daily-report`). Run now works either way. */
  enabled: boolean
  /** Hour of the instance day the report window opens (0–23). */
  window_start_hour: number
  /** Hour it closes (1–24, after the start); the nightly run fires 5 minutes later. */
  window_end_hour: number
  /** Model id for the investigation; null = the AI settings' chat model. */
  model: string | null
  /** Hard cap on input + output tokens for one run; the investigation stops early past it. */
  token_cap: number
  /** Email the report to administrators as well as the in-app notification. */
  email: boolean
  /** Notify administrators at all (off = the page only). */
  notify: boolean
}

export const OPS_REPORT_DEFAULTS: OpsReportSettings = {
  enabled: false,
  window_start_hour: 6,
  window_end_hour: 23,
  model: null,
  token_cap: 600_000,
  email: true,
  notify: true
}

export class OpsReportSettingsError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super(Object.values(fields).join('; '))
  }
}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function intIn(raw: unknown, min: number, max: number): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,120}$/

/** Stored JSON → settings (pure; anything unreadable falls back to its default). */
export function normalizeOpsReportSettings(raw: unknown): OpsReportSettings {
  const s = obj(raw)
  const start = intIn(s.window_start_hour, 0, 23) ?? OPS_REPORT_DEFAULTS.window_start_hour
  const end = intIn(s.window_end_hour, 1, 24)
  const model = typeof s.model === 'string' && MODEL_RE.test(s.model.trim()) ? s.model.trim() : null
  return {
    enabled: s.enabled === true,
    window_start_hour: start,
    window_end_hour:
      end != null && end > start ? end : Math.max(start + 1, OPS_REPORT_DEFAULTS.window_end_hour),
    model,
    token_cap: intIn(s.token_cap, 20_000, 5_000_000) ?? OPS_REPORT_DEFAULTS.token_cap,
    email: s.email === undefined ? OPS_REPORT_DEFAULTS.email : s.email === true,
    notify: s.notify === undefined ? OPS_REPORT_DEFAULTS.notify : s.notify === true
  }
}

/** An admin's PATCH: every bad field is named, never silently dropped. */
export function mergeOpsReportPatch(stored: OpsReportSettings, patch: unknown): OpsReportSettings {
  const p = obj(patch)
  const bad: Record<string, string> = {}
  for (const k of Object.keys(p)) if (!(k in OPS_REPORT_DEFAULTS)) bad[k] = `${k} is not a setting`
  for (const k of ['enabled', 'email', 'notify'] as const)
    if (p[k] !== undefined && typeof p[k] !== 'boolean') bad[k] = 'Must be on or off'
  if (p.window_start_hour !== undefined && intIn(p.window_start_hour, 0, 23) == null)
    bad.window_start_hour = 'Pick a whole hour from 0 to 23'
  if (p.window_end_hour !== undefined && intIn(p.window_end_hour, 1, 24) == null)
    bad.window_end_hour = 'Pick a whole hour from 1 to 24'
  const startNext =
    p.window_start_hour !== undefined ? Number(p.window_start_hour) : stored.window_start_hour
  const endNext =
    p.window_end_hour !== undefined ? Number(p.window_end_hour) : stored.window_end_hour
  if (Number.isInteger(startNext) && Number.isInteger(endNext) && endNext <= startNext)
    bad.window_end_hour = 'The window must end after it starts'
  if (p.token_cap !== undefined && intIn(p.token_cap, 20_000, 5_000_000) == null)
    bad.token_cap = 'Between 20,000 and 5,000,000'
  if (
    p.model !== undefined &&
    p.model !== null &&
    p.model !== '' &&
    !(typeof p.model === 'string' && MODEL_RE.test(p.model.trim()))
  )
    bad.model = 'Not a model id'
  if (Object.keys(bad).length) throw new OpsReportSettingsError(bad)
  return normalizeOpsReportSettings({
    ...stored,
    ...p,
    model: p.model === '' ? null : (p.model ?? stored.model)
  })
}

async function readRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  if (!row) return null
  try {
    return { id: row.id, data: obj(row.data ? JSON.parse(row.data) : {}) }
  } catch {
    return { id: row.id, data: {} }
  }
}

/** This instance's stored settings (defaults when unreadable). Never throws. */
export async function getOpsReportSettings(): Promise<OpsReportSettings> {
  try {
    return normalizeOpsReportSettings((await readRow())?.data[OPS_REPORT_KEY])
  } catch {
    return OPS_REPORT_DEFAULTS
  }
}

export async function saveOpsReportSettings(patch: unknown): Promise<OpsReportSettings> {
  const row = await readRow()
  const next = mergeOpsReportPatch(normalizeOpsReportSettings(row?.data[OPS_REPORT_KEY]), patch)
  const data = { ...(row?.data ?? {}), [OPS_REPORT_KEY]: next }
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
  return next
}
