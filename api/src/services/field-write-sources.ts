import { registerAppKeyed } from './app-forget.js'
import type { RawWriteAnnouncement } from './raw-write-announcer.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Where a value came from when no revision says so (realtime round 7, item 7).
 *
 * Writes through the items service leave an activity row and a revision; "Set by Beth" and
 * "Set by ERP Sync" come from those (GET /revisions/field-touch). Procedures, rollup recalcs,
 * flows that refresh pages, extensions and the outside-write watcher write straight to the
 * tables and only ANNOUNCE (services/raw-write-announcer.ts) — nothing durable says who. This
 * keeps the last announcement per record field for a week: one small Redis hash per record
 * (`nvr:fsrc:<tenant>:<collection>:<item>`, field → {source, action, at}), a bounded memory
 * map when Redis is not there. Collection-wide announcements (no ids, or past the bulk cap)
 * are not kept — they name no record.
 *
 * The value never enters it: field NAMES and the writer's tag only. Readers apply the field
 * read rules (field-touch asks only about readable fields).
 */

export interface RawFieldSource {
  /** The announcement's tag: "procedure:reforecast", "rollup", "import:po-lines", … */
  source: string
  action?: string
  /** ms since epoch. */
  at: number
}

export type SourceVia = 'procedure' | 'outside' | 'import' | 'system'

const TTL_S = 7 * 24 * 3600
const MEM_MAX = 5000
/** Per-id fan-out cap per announcement (the announcer folds bigger sets into one '*' event). */
const IDS_MAX = 100
const WHOLE = '*'

/** The Redis calls used here (ioredis satisfies it; tests pass a fake). */
export interface SourceRedis {
  hset(key: string, values: Record<string, string>): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  expire(key: string, seconds: number): Promise<unknown>
}

let redisOverride: SourceRedis | null | undefined
/** Tests: use this Redis (null = memory only). */
export function setFieldSourceRedis(r: SourceRedis | null | undefined): void {
  redisOverride = r
}

async function redisNow(): Promise<SourceRedis | null> {
  if (redisOverride !== undefined) return redisOverride
  try {
    const { getApp } = await import('./io-holder.js')
    return (getApp()?.redis as SourceRedis | undefined) ?? null
  } catch {
    return null
  }
}

const mem = registerAppKeyed(new Map<string, Record<string, string>>())

function keyOf(collection: string, item: string): string {
  return `nvr:fsrc:${currentTenantKey()}:${collection}:${item}`
}

/** Tags that never describe a record's value source (a person's batch has its own revisions). */
function keeps(source: string | undefined): source is string {
  return !!source && !/^batch-/.test(source) && source !== 'raw'
}

/**
 * The per-record entries one batch of announcements leaves. Pure — exported for tests.
 * `fromInbox`: the rows came from `nivaro_raw_writes` (a procedure or script), so an
 * unprefixed tag is a procedure's own name.
 */
export function plannedSources(
  list: readonly RawWriteAnnouncement[],
  now: number,
  fromInbox = false
): Map<string, { collection: string; item: string; values: Record<string, string> }> {
  const out = new Map<
    string,
    { collection: string; item: string; values: Record<string, string> }
  >()
  for (const a of list) {
    const tag = a.source?.trim()
    if (!keeps(tag) || !a.collection) continue
    const ids = (a.ids ?? []).filter((i) => i != null && String(i).trim() !== '')
    if (ids.length === 0 || ids.length > IDS_MAX) continue
    const source = fromInbox && !tag.includes(':') && tag !== 'rollup' ? `procedure:${tag}` : tag
    const entry = JSON.stringify({
      source: source.slice(0, 120),
      ...(a.action ? { action: a.action } : {}),
      at: now
    })
    const fields = (a.changed_fields ?? []).filter((f) => typeof f === 'string' && f)
    for (const id of ids) {
      const item = String(id).trim().slice(0, 255)
      const k = `${a.collection}\u0001${item}`
      const row = out.get(k) ?? { collection: a.collection, item, values: {} }
      if (fields.length === 0) row.values[WHOLE] = entry
      else for (const f of fields.slice(0, 50)) row.values[f] = entry
      out.set(k, row)
    }
  }
  return out
}

/** Keep the sources of one batch of announcements. Never throws, never blocks a broadcast. */
export async function noteRawWriteSources(
  list: readonly RawWriteAnnouncement[],
  fromInbox = false
): Promise<void> {
  try {
    const planned = plannedSources(list, Date.now(), fromInbox)
    if (planned.size === 0) return
    const redis = await redisNow()
    for (const row of planned.values()) {
      const key = keyOf(row.collection, row.item)
      if (redis) {
        await redis.hset(key, row.values)
        await redis.expire(key, TTL_S)
      } else {
        if (mem.size >= MEM_MAX && !mem.has(key)) {
          const first = mem.keys().next().value
          if (first !== undefined) mem.delete(first)
        }
        mem.set(key, { ...(mem.get(key) ?? {}), ...row.values })
      }
    }
  } catch {
    /* best effort */
  }
}

/** The kept sources for one record: field (or '*' = the whole record) → source. */
export async function readRawWriteSources(
  collection: string,
  item: string
): Promise<Record<string, RawFieldSource>> {
  const key = keyOf(collection, item)
  let raw: Record<string, string> = {}
  try {
    const redis = await redisNow()
    raw = redis ? ((await redis.hgetall(key)) ?? {}) : (mem.get(key) ?? {})
  } catch {
    raw = mem.get(key) ?? {}
  }
  const out: Record<string, RawFieldSource> = {}
  for (const [field, text] of Object.entries(raw)) {
    try {
      const v = JSON.parse(text) as RawFieldSource
      if (v && typeof v.source === 'string' && Number.isFinite(Number(v.at)))
        out[field] = { source: v.source, action: v.action, at: Number(v.at) }
    } catch {
      /* a damaged entry says nothing */
    }
  }
  return out
}

/** The source of one field: its own entry, else the whole-record one, the newer of the two. */
export function sourceForField(
  sources: Record<string, RawFieldSource>,
  field: string
): RawFieldSource | null {
  const own = sources[field]
  const whole = sources[WHOLE]
  if (own && whole) return own.at >= whole.at ? own : whole
  return own ?? whole ?? null
}

/** How a tag reads to a person. Pure — exported for tests. */
export function describeRawSource(source: string): { via: SourceVia; who: string } {
  const [head, ...rest] = source.split(':')
  const tail = rest.join(':').trim()
  switch (head) {
    case 'procedure':
    case 'proc':
      return { via: 'procedure', who: tail ? `procedure ${tail}` : 'a database procedure' }
    case 'import':
      return { via: 'import', who: tail ? `import (${tail})` : 'an import' }
    case 'flow':
      return { via: 'system', who: tail ? `flow ${tail}` : 'a flow' }
    case 'extension':
      return { via: 'system', who: tail ? `${tail}` : 'an extension' }
    case 'rollup':
      return { via: 'system', who: 'the total recalculation' }
    case 'outside-write-watch':
      return { via: 'outside', who: 'a change outside the app' }
    default:
      return { via: 'system', who: source.slice(0, 60) }
  }
}

export interface FieldTouchEntry {
  at: string
  who: string
  via: 'import' | 'integration' | 'system' | 'user' | 'procedure' | 'outside'
  activity_id?: number
  caller?: { name: string; kind: string; key: string } | null
}

/**
 * Fold announced raw-write sources into field-touch answers: for each asked field, a source
 * newer than the field's last revision wins (it is the later write). Pure — exported for tests.
 */
export function mergeRawSources(
  out: Record<string, FieldTouchEntry>,
  fields: readonly string[],
  sources: Record<string, RawFieldSource>
): Record<string, FieldTouchEntry> {
  if (Object.keys(sources).length === 0) return out
  for (const f of fields) {
    const s = sourceForField(sources, f)
    if (!s) continue
    const have = out[f]
    const haveAt = have ? Date.parse(have.at) : Number.NaN
    if (have && Number.isFinite(haveAt) && haveAt >= s.at) continue
    const d = describeRawSource(s.source)
    out[f] = { at: new Date(s.at).toISOString(), who: d.who, via: d.via, caller: null }
  }
  return out
}

/** Tests: forget the memory store. */
export function resetFieldSourcesForTests(): void {
  mem.clear()
  redisOverride = undefined
}
