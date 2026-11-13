/**
 * Collection imports: a cell mapped to a relation field names the related record(s) the way a
 * person types them — by name, not by id (Rob 2026-11-13: Unit Types with a "Project Type"
 * column of "Cran, HQ Funded" links each unit type to both project types).
 *
 *   M2O  one related record: the cell is its id or its label.
 *   M2M  several: the cell is a comma-separated list of ids or labels. A cell that is itself
 *        one record's label ("Smith, John") stays whole — it is split only when it is not.
 *
 * Labels match case- and space-insensitively against the related collection's label column
 * (its display template's single field, else the first of name/title/label/… it has). A value
 * that matches nothing or more than one record refuses the row with a sentence naming it;
 * nothing is created or linked half-way.
 */
import { db } from '../db/index.js'
import type { CMSRelation } from '../types.js'
import { getCollection, getPhysicalColumns, getRelations } from './collections.js'
import { extractTemplateFields, LABEL_FALLBACK } from './display-value.js'

type Db = typeof db

export interface ImportLinkField {
  field: string
  kind: 'm2o' | 'm2m'
  related: string
  /** The column a cell's text is matched against; null = ids only. */
  labelColumn: string | null
  /** M2M only. */
  junction?: string
  fkToParent?: string
  fkToOther?: string
}

/** The mapped fields that are relations an import can resolve, by field name. */
export async function importLinkFields(
  collection: string,
  fields: string[]
): Promise<Map<string, ImportLinkField>> {
  const out = new Map<string, ImportLinkField>()
  if (fields.length === 0) return out
  const rels = await getRelations(collection)
  for (const field of new Set(fields)) {
    const m2o = rels.find(
      (r) =>
        r.many_collection === collection &&
        r.many_field === field &&
        !!r.one_collection &&
        r.junction_field == null
    )
    if (m2o?.one_collection) {
      out.set(field, {
        field,
        kind: 'm2o',
        related: m2o.one_collection,
        labelColumn: await labelColumnOf(m2o.one_collection)
      })
      continue
    }
    const leg = rels.find(
      (r) => r.one_collection === collection && r.one_field === field && r.junction_field != null
    )
    if (!leg?.many_collection || !leg.many_field || !leg.junction_field) continue
    const far = (await getRelations(leg.many_collection)).find(
      (r: CMSRelation) =>
        r.many_collection === leg.many_collection && r.many_field === leg.junction_field
    )
    // A link to several collections (M2A) has no one target to look names up in.
    if (!far?.one_collection) continue
    out.set(field, {
      field,
      kind: 'm2m',
      related: far.one_collection,
      labelColumn: await labelColumnOf(far.one_collection),
      junction: leg.many_collection,
      fkToParent: leg.many_field,
      fkToOther: String(leg.junction_field)
    })
  }
  return out
}

async function labelColumnOf(collection: string): Promise<string | null> {
  const cols = await getPhysicalColumns(collection).catch(() => null)
  const has = (c: string) => !cols || cols.has(c.toLowerCase())
  const template = (await getCollection(collection).catch(() => undefined))?.display_template
  const own = template ? extractTemplateFields(template).filter((f) => f !== 'id') : []
  if (own.length === 1 && has(own[0])) return own[0]
  for (const f of LABEL_FALLBACK) if (cols?.has(f)) return f
  return null
}

/** A cell as separate values: split on commas, trimmed, empties and repeats dropped. */
export function splitLinkCell(cell: unknown): string[] {
  if (cell == null) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of String(cell).split(',')) {
    const v = part.trim()
    if (!v || seen.has(v.toUpperCase())) continue
    seen.add(v.toUpperCase())
    out.push(v)
  }
  return out
}

const norm = (v: unknown) =>
  String(v ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()

export class ImportLinkError extends Error {}

/**
 * Resolves cell values to related ids for one import run. Every distinct value is looked up
 * once per run (a 5k-row file naming the same three project types reads them once).
 */
export class ImportLinkResolver {
  private readonly cache = new Map<string, string[]>()
  constructor(private readonly database: Db = db) {}

  /** ids per value (empty = no match), reading only values not seen yet. */
  private async lookup(lf: ImportLinkField, values: string[]): Promise<Map<string, string[]>> {
    const key = (v: string) => `${lf.related}\u0000${norm(v)}`
    const missing = [...new Set(values.filter((v) => !this.cache.has(key(v))))]
    if (missing.length > 0) {
      const found = new Map<string, Set<string>>(missing.map((v) => [norm(v), new Set()]))
      if (lf.labelColumn) {
        for (let i = 0; i < missing.length; i += 500) {
          const chunk = missing.slice(i, i + 500).map(norm)
          const rows = (await this.database(lf.related)
            .whereRaw(
              `UPPER(LTRIM(RTRIM(CAST(?? AS nvarchar(400))))) IN (${chunk.map(() => '?').join(', ')})`,
              [lf.labelColumn, ...chunk]
            )
            .select({ id: 'id', label: lf.labelColumn })) as Array<{ id: unknown; label: unknown }>
          for (const r of rows) found.get(norm(r.label))?.add(String(r.id))
        }
      }
      // A value no label matched may be an id. Its own read: a text value against a
      // numeric or uuid id is a conversion error, which only means "not an id".
      for (const v of missing) {
        const ids = found.get(norm(v))
        if (!ids || ids.size > 0) continue
        const row = (await this.database(lf.related)
          .where('id', v.trim())
          .first('id')
          .catch(() => undefined)) as { id: unknown } | undefined
        if (row) ids.add(String(row.id))
      }
      for (const v of missing) this.cache.set(key(v), [...(found.get(norm(v)) ?? [])])
    }
    return new Map(values.map((v) => [v, this.cache.get(key(v)) ?? []]))
  }

  /**
   * The related id(s) a cell names: one id for an M2O (null when the cell is empty), the
   * list for an M2M. Throws ImportLinkError naming the value that matched nothing or more
   * than one record.
   */
  async resolve(lf: ImportLinkField, cell: unknown, fieldLabel = lf.field): Promise<unknown> {
    const whole = cell == null ? '' : String(cell).trim()
    if (lf.kind === 'm2o') {
      if (!whole) return null
      return this.one(lf, whole, fieldLabel)
    }
    if (!whole) return []
    // "Smith, John" may be one record's label: kept whole when it is.
    if (whole.includes(',')) {
      const asOne = (await this.lookup(lf, [whole])).get(whole) ?? []
      if (asOne.length === 1) return asOne
    }
    const values = splitLinkCell(whole)
    const ids = await this.lookup(lf, values)
    const out: string[] = []
    const unknown: string[] = []
    const ambiguous: string[] = []
    for (const v of values) {
      const hit = ids.get(v) ?? []
      if (hit.length === 0) unknown.push(v)
      else if (hit.length > 1) ambiguous.push(v)
      else if (!out.includes(hit[0])) out.push(hit[0])
    }
    if (unknown.length > 0 || ambiguous.length > 0)
      throw new ImportLinkError(sentence(fieldLabel, lf, unknown, ambiguous))
    return out
  }

  private async one(lf: ImportLinkField, value: string, fieldLabel: string): Promise<string> {
    const hit = (await this.lookup(lf, [value])).get(value) ?? []
    if (hit.length === 1) return hit[0]
    throw new ImportLinkError(
      sentence(fieldLabel, lf, hit.length === 0 ? [value] : [], hit.length > 1 ? [value] : [])
    )
  }
}

function sentence(
  fieldLabel: string,
  lf: ImportLinkField,
  unknown: string[],
  ambiguous: string[]
): string {
  const related = lf.related.replace(/_/g, ' ')
  const q = (vs: string[]) => vs.map((v) => `"${v}"`).join(', ')
  const parts: string[] = []
  if (unknown.length > 0) parts.push(`no ${related} named ${q(unknown)}`)
  if (ambiguous.length > 0) parts.push(`more than one ${related} named ${q(ambiguous)}`)
  return `${fieldLabel}: ${parts.join('; ')}`
}

/** The ids a record is linked to now through an M2M field. */
export async function currentLinks(
  lf: ImportLinkField,
  parentId: unknown,
  database: Db = db
): Promise<string[]> {
  if (lf.kind !== 'm2m' || !lf.junction || !lf.fkToParent || !lf.fkToOther) return []
  const rows = (await database(lf.junction)
    .where(lf.fkToParent, parentId as string)
    .select({ other: lf.fkToOther })) as Array<{ other: unknown }>
  return [...new Set(rows.filter((r) => r.other != null).map((r) => String(r.other)))]
}

/**
 * Raw-mode link write (an import that does not go through the items service): adds the
 * missing junction rows; with `replace`, removes the record's other links. Returns whether
 * anything changed.
 */
export async function writeLinksRaw(
  lf: ImportLinkField,
  parentId: unknown,
  ids: string[],
  replace: boolean,
  database: Db = db
): Promise<boolean> {
  if (lf.kind !== 'm2m' || !lf.junction || !lf.fkToParent || !lf.fkToOther) return false
  const now = await currentLinks(lf, parentId, database)
  const add = ids.filter((id) => !now.includes(id))
  const drop = replace ? now.filter((id) => !ids.includes(id)) : []
  if (drop.length > 0)
    await database(lf.junction)
      .where(lf.fkToParent, parentId as string)
      .whereIn(lf.fkToOther, drop)
      .delete()
  if (add.length > 0)
    await database(lf.junction).insert(
      add.map((id) => ({ [lf.fkToParent as string]: parentId, [lf.fkToOther as string]: id }))
    )
  return add.length > 0 || drop.length > 0
}

/** Do two id lists name the same links (order ignored)? */
export function sameLinks(a: string[], b: string[]): boolean {
  const sa = new Set(a.map(String))
  const sb = new Set(b.map(String))
  return sa.size === sb.size && [...sa].every((x) => sb.has(x))
}
