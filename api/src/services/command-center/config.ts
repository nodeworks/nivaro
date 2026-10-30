import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'

/**
 * Command Center configuration — `nivaro_settings.command_center` (migration 523). Every field
 * is optional: an unset field means "work it out from the data model" (geo collections = the
 * collections carrying latitude/longitude fields; regions = a collection those geo records link
 * to). No tenant table names live in core.
 *
 * normalizeCcConfig is the one shape: readers and the PUT route both go through it, so a key
 * added here survives every save (parsers that rebuild config objects drop new keys).
 */

export interface CcRegionSource {
  /** Collection whose rows are the regions (labels come from label_field). */
  collection: string
  label_field: string | null
  /** How a geo record sits in a region: a junction (M2M) or a direct M2O field on the geo collection. */
  via:
    | {
        kind: 'junction'
        junction: string
        region_field: string
        item_field: string
        item_collection: string
      }
    | { kind: 'field'; item_collection: string; field: string }
  /** User-scope dimension that places PEOPLE in a region (nivaro_user_scopes.dimension); null = people are not placed. */
  scope_dimension: string | null
}

export interface CcLayout {
  /** Panel keys in display order (shared command-center panel registry). */
  order: string[]
  hidden: string[]
}

export interface CcConfig {
  /** Collections offered on the map, first = default. Empty = auto-detected. */
  geo_collections: string[]
  /** null = auto-detect; false = no regions on this instance. */
  region: CcRegionSource | null | false
  /** A record counts as stuck after this many days in one state. */
  stuck_days: number
  role_defaults: Record<string, CcLayout>
}

export const CC_DEFAULTS: CcConfig = {
  geo_collections: [],
  region: null,
  stuck_days: 7,
  role_defaults: {}
}

const COLUMN = 'command_center'
const NAME = /^[A-Za-z0-9_]+$/

const strList = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? [...new Set(v.map(String).filter((s) => NAME.test(s)))].slice(0, max) : []

function normalizeLayout(v: unknown): CcLayout | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  return { order: strList(o.order), hidden: strList(o.hidden) }
}

function normalizeRegion(v: unknown): CcRegionSource | null | false {
  if (v === false) return false
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const via = (o.via ?? {}) as Record<string, unknown>
  const name = (x: unknown) => (typeof x === 'string' && NAME.test(x) ? x : null)
  const collection = name(o.collection)
  if (!collection) return null
  let parsedVia: CcRegionSource['via'] | null = null
  if (via.kind === 'junction') {
    const junction = name(via.junction)
    const region_field = name(via.region_field)
    const item_field = name(via.item_field)
    const item_collection = name(via.item_collection)
    if (junction && region_field && item_field && item_collection)
      parsedVia = { kind: 'junction', junction, region_field, item_field, item_collection }
  } else if (via.kind === 'field') {
    const item_collection = name(via.item_collection)
    const field = name(via.field)
    if (item_collection && field) parsedVia = { kind: 'field', item_collection, field }
  }
  if (!parsedVia) return null
  return {
    collection,
    label_field: name(o.label_field),
    via: parsedVia,
    scope_dimension: name(o.scope_dimension)
  }
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

export function normalizeCcConfig(raw: unknown): CcConfig {
  const o = parseObject(raw)
  if (!o) return { ...CC_DEFAULTS }
  const roles: Record<string, CcLayout> = {}
  if (o.role_defaults && typeof o.role_defaults === 'object') {
    for (const [k, v] of Object.entries(o.role_defaults as Record<string, unknown>)) {
      const l = normalizeLayout(v)
      if (l && /^[0-9A-Fa-f-]{36}$/.test(k)) roles[k.toLowerCase()] = l
    }
  }
  const stuck = Number(o.stuck_days)
  return {
    geo_collections: strList(o.geo_collections, 10),
    region: normalizeRegion(o.region),
    stuck_days: Number.isFinite(stuck) && stuck >= 1 && stuck <= 365 ? Math.round(stuck) : 7,
    role_defaults: roles
  }
}

export async function readCcConfig(): Promise<CcConfig> {
  if (!(await hasColumn('nivaro_settings', COLUMN).catch(() => false))) return { ...CC_DEFAULTS }
  const row = (await db('nivaro_settings').first(COLUMN)) as Record<string, unknown> | undefined
  return normalizeCcConfig(row?.[COLUMN] ?? null)
}

/** Read-modify-write; returns what is now stored. Throws when migration 523 has not run. */
export async function writeCcConfig(change: (current: CcConfig) => CcConfig): Promise<CcConfig> {
  if (!(await hasColumn('nivaro_settings', COLUMN))) {
    throw Object.assign(new Error('Command Center settings need migration 523'), {
      statusCode: 409,
      code: 'MIGRATION_PENDING'
    })
  }
  const next = normalizeCcConfig(change(await readCcConfig()))
  await db('nivaro_settings').update({ [COLUMN]: JSON.stringify(next) })
  return next
}
