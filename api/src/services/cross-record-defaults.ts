/**
 * Cross-record defaults on writes.
 *
 * A field's `cross_record_defaults` says: when this link is set, copy these
 * values from the linked record. The record form has always done that at the
 * moment a person picks the link. A write through the API never did, so the
 * same record came out different depending on who created it.
 *
 * Rules, the same as the form's:
 *   - the watched link must be in the write, with a value
 *   - a target the caller sent is never touched
 *   - `a||b` takes the first source field that holds a value; `id` is the
 *     linked record itself
 *   - a target that is itself a watched link applies its own defaults, two
 *     levels deep at most
 *   - a many-to-many target is filled only while it holds no link
 *
 * Opt-out: `"on_write": false` in the config keeps the form behaviour and
 * leaves writes alone (an integration that sends whole rows).
 *
 * This module must not import the items service (the items service calls it).
 */
import { db } from '../db/index.js'
import type { CMSRelation, User } from '../types.js'
import { getFields, getRelations } from './collections.js'
import { can } from './permissions.js'
import { declaredLinkLimits } from './relation-limits.js'

interface CrossConfig {
  source_collection?: string
  source_fk_field?: string
  field_map?: Record<string, string>
  on_write?: boolean
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_DEPTH = 2
const MAX_LINKS = 200

const empty = (v: unknown) => v === null || v === undefined || v === ''

function parseConfig(raw: unknown): CrossConfig | null {
  if (!raw) return null
  try {
    const cfg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as CrossConfig
    if (!cfg || typeof cfg !== 'object') return null
    if (!cfg.source_collection || !IDENT.test(cfg.source_collection)) return null
    if (/^nivaro_|^directus_/i.test(cfg.source_collection)) return null
    if (!cfg.field_map || typeof cfg.field_map !== 'object') return null
    if (cfg.on_write === false) return null
    return cfg
  } catch {
    return null
  }
}

interface Alias {
  junction: string
  parentFk: string
  relatedFk: string
}

function aliasOf(collection: string, field: string, rels: CMSRelation[]): Alias | null {
  const r = rels.find(
    (x) => x.one_collection === collection && x.one_field === field && x.junction_field
  )
  if (!r?.many_collection || !r.many_field || !r.junction_field) return null
  if (![r.many_collection, r.many_field, r.junction_field].every((s) => IDENT.test(String(s))))
    return null
  return {
    junction: r.many_collection,
    parentFk: r.many_field,
    relatedFk: String(r.junction_field)
  }
}

async function linkedIds(alias: Alias, parentId: unknown): Promise<unknown[]> {
  const rows = (await db(alias.junction)
    .where({ [alias.parentFk]: parentId as string | number })
    .whereNotNull(alias.relatedFk)
    .limit(MAX_LINKS)
    .select(alias.relatedFk)) as Array<Record<string, unknown>>
  return [...new Set(rows.map((r) => r[alias.relatedFk]))]
}

const columnsCache = new Map<string, { at: number; cols: Set<string> }>()
async function columnsOf(table: string): Promise<Set<string>> {
  const hit = columnsCache.get(table)
  if (hit && Date.now() - hit.at < 60_000) return hit.cols
  const info = (await db(table).columnInfo()) as Record<string, unknown>
  const cols = new Set(Object.keys(info))
  columnsCache.set(table, { at: Date.now(), cols })
  return cols
}

export interface CrossDefaultsInput {
  collection: string
  /** The write, changed in place. */
  payload: Record<string, unknown>
  /** Keys the caller sent. A target among them is never touched. */
  callerFields: Set<string>
  user: User
  /** The stored row on an update; the defaults apply when the link changed. */
  previous?: Record<string, unknown> | null
  /** The record's id on an update (many-to-many targets are checked for links). */
  id?: string | number | null
}

/** Fields this pass filled. Never throws: a default that cannot be read is left out. */
export async function applyCrossRecordDefaults(input: CrossDefaultsInput): Promise<string[]> {
  const { collection, payload, callerFields, user, previous, id } = input
  const filled: string[] = []
  let configs: Array<{ field: string; cfg: CrossConfig }>
  try {
    configs = (await getFields(collection))
      .map((f) => ({
        field: f.field,
        cfg: parseConfig(
          (f as unknown as { cross_record_defaults?: unknown }).cross_record_defaults
        )
      }))
      .filter((x): x is { field: string; cfg: CrossConfig } => x.cfg !== null)
  } catch {
    return filled
  }
  if (configs.length === 0) return filled

  let rels: CMSRelation[] | null = null
  const relsHere = async () => {
    if (!rels) rels = await getRelations(collection)
    return rels
  }
  const cols = await columnsOf(collection).catch(() => new Set<string>())

  const run = async (linkField: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    const value = payload[linkField]
    if (empty(value) || typeof value === 'object') return
    for (const { field, cfg } of configs) {
      if ((cfg.source_fk_field || field) !== linkField) continue
      const source = cfg.source_collection as string
      const map = cfg.field_map as Record<string, string>
      try {
        if (!(await can(user, 'read', source))) continue
        const srcCols = await columnsOf(source)
        const srcRels = await getRelations(source)
        const wanted = new Set<string>(['id'])
        for (const s of Object.values(map))
          for (const c of String(s).split('||')) {
            const name = c.trim()
            if (IDENT.test(name) && srcCols.has(name)) wanted.add(name)
          }
        const src = (await db(source)
          .where({ id: value as string | number })
          .first([...wanted])) as Record<string, unknown> | undefined
        if (!src) continue

        const next: string[] = []
        for (const [target, sourceField] of Object.entries(map)) {
          if (!IDENT.test(target) || callerFields.has(target)) continue
          // A target an earlier link filled is replaced only by a value (the
          // form's order: the more specific link is picked later and wins).
          const refill = filled.includes(target)
          const candidates = String(sourceField)
            .split('||')
            .map((c) => c.trim())
            .filter(Boolean)
          const targetAlias = aliasOf(collection, target, await relsHere())
          const sourceAlias = aliasOf(source, candidates[0] ?? '', srcRels)

          if (targetAlias) {
            // Filled only while the record holds no link of that kind.
            if (id != null && (await linkedIds(targetAlias, id)).length > 0) continue
            let ids: unknown[] = []
            if (sourceAlias) ids = await linkedIds(sourceAlias, value)
            else
              for (const c of candidates) {
                if (!empty(src[c])) {
                  ids = [src[c]]
                  break
                }
              }
            if (ids.length === 0) continue
            // More links than the field takes would be a guess at which to keep.
            const limit = (await declaredLinkLimits(collection)).get(target)
            if (limit != null && ids.length > limit) continue
            payload[target] = ids
            if (!refill) filled.push(target)
            continue
          }
          if (!cols.has(target)) continue
          let v: unknown = null
          if (sourceAlias) {
            // Several links would be a guess: only a single one is copied.
            const ids = await linkedIds(sourceAlias, value)
            if (ids.length !== 1) continue
            v = ids[0]
          } else {
            for (const c of candidates) {
              if (!empty(src[c])) {
                v = src[c]
                break
              }
            }
          }
          if (refill && empty(v)) continue
          const before = previous ? previous[target] : undefined
          // An update writes the default only when it differs from what is stored.
          if (previous && !refill && String(before ?? '') === String(v ?? '')) continue
          // A create writes nothing for an empty default.
          if (!previous && empty(v)) continue
          payload[target] = v ?? null
          if (!refill) filled.push(target)
          if (target !== linkField && !empty(v)) next.push(target)
        }
        for (const t of next) await run(t, depth + 1)
      } catch {
        // A source that cannot be read leaves its targets as they are.
      }
    }
  }

  const changed = (f: string) => !previous || String(previous[f] ?? '') !== String(payload[f] ?? '')
  const links = new Set(configs.map(({ field, cfg }) => cfg.source_fk_field || field))
  for (const link of links) {
    if (!(link in payload) || empty(payload[link])) continue
    if (!changed(link)) continue
    await run(link, 0)
  }
  return filled
}
