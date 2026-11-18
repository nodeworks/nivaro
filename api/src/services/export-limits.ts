/**
 * Export limits as CONFIGURATION (2026-11-18).
 *
 * Every export cap used to be a constant in its route, so raising one meant a release. Each
 * limit below now resolves, like the cache switches (services/cache-config.ts):
 *
 *   1. the env var, when set to a valid whole number in range (env always WINS);
 *   2. this instance's stored value: the `export_limits` key of its
 *      `nivaro_settings_overrides` row (keyed by NIVARO_INSTANCE / NODE_ENV — every replica of
 *      one environment shares it);
 *   3. the built-in default.
 *
 * Defaults (2026-11-18, streaming exports): the list CSV built in the browser and the files
 * built on the server (items/content export, export presets) have NO LIMIT. Server-built files
 * stream page by page to a temp file (services/export-files.ts) and big ones run in the
 * background, on the import worker when one runs (services/export-handoff.ts), so memory stays
 * flat whatever the size; a number set here is about time and database load, not memory.
 * file_rows / preset_rows bound BACKGROUND runs. A file answered in the request itself (no
 * background) holds at most `request_rows` (default 50,000, never unlimited — one request must
 * not read the database for minutes). `max_file_mb` caps one export's file on disk. The form
 * export is never unlimited (one request, any form user). `exportLimit()` answers
 * Infinity for "no limit"; the apps' read answers null.
 *
 * The stored layer is re-read at most every REFRESH_MS, and at once when the configuration
 * epoch moves (a save writes nivaro_settings_overrides, a watched table → registerCache bust).
 * `readExportLimit()` is the async reader for request handlers (the first call in a process
 * waits for the stored layer); `exportLimit()` is the sync one for text built after that.
 *
 * Cloud mode: the stored layer is never read (module state is shared by every tenant): env,
 * then default.
 *
 * Leaf module: no static import of db/index.ts.
 */
import { registerCache } from './cache-registry.js'

export const EXPORT_LIMITS_KEY = 'export_limits'
const REFRESH_MS = 15_000
const CLOUD = () => !!process.env.CLOUD_META_DB_URL

export type ExportLimitKey =
  | 'browser_rows'
  | 'file_rows'
  | 'preset_rows'
  | 'form_records'
  | 'background_per_person'
  | 'request_rows'
  | 'max_file_mb'

export interface ExportLimitDef {
  key: ExportLimitKey
  label: string
  hint: string
  env: string
  /** 0 = no limit. */
  default: number
  min: number
  max: number
  /** 0 may be stored / set in env to mean "no limit". */
  unlimited?: boolean
}

export const EXPORT_LIMIT_DEFS: ExportLimitDef[] = [
  {
    key: 'browser_rows',
    label: 'List CSV (built in the page)',
    hint: 'Rows the list page’s Export → CSV reads, page by page, in the browser. 0 = no limit. Was 50,000.',
    env: 'EXPORT_BROWSER_MAX_ROWS',
    default: 0,
    min: 1_000,
    max: 10_000_000,
    unlimited: true
  },
  {
    key: 'file_rows',
    label: 'Background export files',
    hint: 'Background runs of GET /items/:collection/export (and the cap of Ask AI downloads). 0 = no limit. Files stream to disk page by page, so memory stays flat at any size; set a number only to bound how long one export reads the database. Ask AI downloads are still built in memory: with no limit they hold at most 50,000 rows. Was 50,000 (10,000 before that).',
    env: 'EXPORT_FILE_MAX_ROWS',
    default: 0,
    min: 1_000,
    max: 10_000_000,
    unlimited: true
  },
  {
    key: 'preset_rows',
    label: 'Export presets',
    hint: 'Rows one saved export preset run in the background holds (a direct download holds the request limit below). 0 = no limit. Big ones run in the background (on the import worker when one runs) with progress and Cancel, streamed to disk, so memory stays flat; set a number only to bound time and database load. Was 200,000.',
    env: 'EXPORT_PRESET_MAX_ROWS',
    default: 0,
    min: 1_000,
    max: 10_000_000,
    unlimited: true
  },
  {
    key: 'request_rows',
    label: 'Exports answered in the request',
    hint: 'Rows a file answered directly in the request holds (no background: API calls without `background`, small exports, View-as). Never unlimited — a big export belongs in the background, where the two limits above apply.',
    env: 'EXPORT_REQUEST_MAX_ROWS',
    default: 50_000,
    min: 1_000,
    max: 500_000
  },
  {
    key: 'max_file_mb',
    label: 'Largest export file (MB)',
    hint: 'One export stops with “the file is too big — narrow it” past this many megabytes on disk, and its temp file is removed. Guards the server’s disk.',
    env: 'EXPORT_MAX_FILE_MB',
    default: 2048,
    min: 50,
    max: 51_200
  },
  {
    key: 'form_records',
    label: 'Form “Export records to Excel”',
    hint: 'Records the layout editor’s Outputs → Export records writes. One request, not a background job, so it always has a limit. Was 5,000 (and stopped at 1,000).',
    env: 'EXPORT_FORM_MAX_RECORDS',
    default: 10_000,
    min: 100,
    max: 50_000
  },
  {
    key: 'background_per_person',
    label: 'Background exports per person',
    hint: 'Exports and slow reads one person may run in the background at once. Was 3.',
    env: 'BACKGROUND_RUNS_PER_PERSON',
    default: 5,
    min: 1,
    max: 20
  }
]

const DEFS = new Map(EXPORT_LIMIT_DEFS.map((d) => [d.key, d]))

/** A whole number inside the def's bounds, else undefined. */
export function coerceExportLimit(def: ExportLimitDef, raw: unknown): number | undefined {
  if (raw == null) return undefined
  const text = typeof raw === 'string' ? raw.trim().replace(/[,_]/g, '') : raw
  if (text === '') return undefined
  const n = typeof text === 'number' ? text : Number(text)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n === 0 && def.unlimited) return 0
  if (n < def.min || n > def.max) return undefined
  return n
}

export type ExportLimitSource = 'env' | 'config' | 'default'

export interface EffectiveExportLimit extends ExportLimitDef {
  value: number
  source: ExportLimitSource
  /** The env var's raw text when set (an operator sees what pins it). */
  env_value: string | null
  /** This instance's stored value, when one is stored. */
  stored: number | null
}

// ── stored layer ─────────────────────────────────────────────────────────────

let stored: Record<string, unknown> = {}
let loaded = false
let loadedAt = 0

function resolveOne(def: ExportLimitDef): EffectiveExportLimit {
  const envRaw = process.env[def.env]
  const env_value = envRaw != null && envRaw.trim() !== '' ? envRaw : null
  const fromStore = CLOUD() ? undefined : coerceExportLimit(def, stored[def.key])
  const base = { ...def, env_value, stored: fromStore ?? null }
  const fromEnv = env_value == null ? undefined : coerceExportLimit(def, env_value)
  if (fromEnv !== undefined) return { ...base, value: fromEnv, source: 'env' }
  if (fromStore !== undefined) return { ...base, value: fromStore, source: 'config' }
  return { ...base, value: def.default, source: 'default' }
}

/** The effective value of one limit (sync, no I/O); Infinity = no limit. Before the first
 *  stored read it is env/default. */
export function exportLimit(key: ExportLimitKey): number {
  if (!CLOUD() && loaded && Date.now() - loadedAt > REFRESH_MS) void refreshExportLimits()
  const def = DEFS.get(key)
  if (!def) return Number.POSITIVE_INFINITY
  const v = resolveOne(def).value
  return v === 0 && def.unlimited ? Number.POSITIVE_INFINITY : v
}

/**
 * Rows a file built in ONE process's memory may hold (the Ask AI download — not streamed): the
 * file_rows limit when one is set, else IN_MEMORY_EXPORT_ROWS. "No limit" applies to the
 * streamed exports only.
 */
export const IN_MEMORY_EXPORT_ROWS = 50_000
export function inMemoryExportRows(): number {
  const v = exportLimit('file_rows')
  return Number.isFinite(v) ? v : IN_MEMORY_EXPORT_ROWS
}

/** "50,000 rows" / "every row" — for text that names a limit. */
export function describeExportLimit(key: ExportLimitKey, noun = 'rows'): string {
  const v = exportLimit(key)
  return Number.isFinite(v)
    ? `${v.toLocaleString('en-US')} ${noun}`
    : `every ${noun.replace(/s$/, '')}`
}

/** The effective value for a request handler: the first call in a process waits for the stored layer. */
export async function readExportLimit(key: ExportLimitKey): Promise<number> {
  if (!CLOUD() && !loaded) await refreshExportLimits()
  return exportLimit(key)
}

/** Every limit with its value and where it came from (admin card). */
export function effectiveExportLimits(): EffectiveExportLimit[] {
  return EXPORT_LIMIT_DEFS.map(resolveOne)
}

/** The values alone, for the apps (signed-in read); null = no limit. */
export function exportLimitValues(): Record<ExportLimitKey, number | null> {
  const out = {} as Record<ExportLimitKey, number | null>
  for (const d of EXPORT_LIMIT_DEFS) {
    const v = resolveOne(d).value
    out[d.key] = v === 0 && d.unlimited ? null : v
  }
  return out
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

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

let inflight: Promise<void> | null = null
let registered = false

/** Re-read this instance's stored limits (background pool; never throws). */
export function refreshExportLimits(): Promise<void> {
  if (!registered) {
    registered = true
    // Another process saved the limits (the configuration epoch moved) or the cache console
    // asked for a bust: read them again now rather than at the next tick.
    registerCache('export-limits', 'Export limits stored for this instance', () => {
      void refreshExportLimits()
    })
  }
  if (CLOUD()) return Promise.resolve()
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const { runInBackgroundPool } = await import('../db/pool-context.js')
      const row = await runInBackgroundPool(() => readRow())
      stored = asObject(row?.data[EXPORT_LIMITS_KEY])
    } catch {
      // Table absent / DB not ready: keep the last stored values.
    } finally {
      loaded = true
      loadedAt = Date.now()
      inflight = null
    }
  })()
  return inflight
}

export class ExportLimitError extends Error {
  constructor(
    message: string,
    readonly field: string
  ) {
    super(message)
  }
}

/** Apply a patch `{ file_rows: 100000, form_records: null }` (null clears back to env/default). */
export function mergeExportLimitsPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, number> {
  const next: Record<string, number> = {}
  for (const [k, v] of Object.entries(current)) {
    const def = DEFS.get(k as ExportLimitKey)
    const n = def ? coerceExportLimit(def, v) : undefined
    if (n !== undefined) next[k] = n
  }
  for (const [key, raw] of Object.entries(patch)) {
    const def = DEFS.get(key as ExportLimitKey)
    if (!def) throw new ExportLimitError(`Unknown export limit: ${key}`, key)
    if (raw === null) {
      delete next[key]
      continue
    }
    const n = coerceExportLimit(def, raw)
    if (n === undefined)
      throw new ExportLimitError(
        `${def.label} must be a whole number from ${def.min.toLocaleString('en-US')} to ${def.max.toLocaleString('en-US')}${def.unlimited ? ', or 0 for no limit' : ''}`,
        key
      )
    next[key] = n
  }
  return next
}

/** Store limits for THIS instance (admin card). Env still wins where set. */
export async function saveExportLimits(
  patch: Record<string, unknown>
): Promise<EffectiveExportLimit[]> {
  if (CLOUD()) throw new ExportLimitError('Export limits are platform-managed in cloud mode', '')
  const { db } = await import('../db/index.js')
  const { instanceKey } = await import('./instance-key.js')
  const row = await readRow()
  const nextLimits = mergeExportLimitsPatch(asObject(row?.data[EXPORT_LIMITS_KEY]), patch)
  const data = { ...(row?.data ?? {}), [EXPORT_LIMITS_KEY]: nextLimits }
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
  stored = nextLimits
  loaded = true
  loadedAt = Date.now()
  return effectiveExportLimits()
}

/** Tests only: set the stored layer directly (null = not loaded yet). */
export function setStoredExportLimitsForTests(next: Record<string, unknown> | null): void {
  stored = next ?? {}
  loaded = next !== null
  loadedAt = next === null ? 0 : Date.now()
}
