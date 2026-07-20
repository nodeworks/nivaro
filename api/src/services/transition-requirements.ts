import type { FastifyBaseLogger } from 'fastify'
import type { db } from '../db/index.js'
import { getCollection } from './collections.js'
import { extractTemplateFields, resolveDisplayValue } from './display-value.js'

// ─── Transition requirements (child-field gates) ───────────────────────────
//
// Enforces the "requirements" gate stored on a workflow transition: before the
// transition is allowed to run, every child row related to the item (via
// fk_field) must have all of the listed fields filled in. Shared by every
// mutation path that can execute a transition — the single-item pipeline
// route, the bulk-transition route, and both GraphQL transition mutations —
// so the gate can't be bypassed by calling a different endpoint.

type Logger = Pick<FastifyBaseLogger, 'warn'>

// Callers that don't have a Fastify request logger on hand (GraphQL resolvers
// have no `req.log` in context) fall back to console, matching the idiom used
// by other services without direct Fastify access (activity.ts, rollups.ts,
// webhook-dispatch.ts, queue-snapshots.ts).
const consoleLogger: Logger = {
  warn: ((...args: unknown[]) => {
    console.warn(...args)
  }) as unknown as Logger['warn']
}

export const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export interface RequirementFieldMeta {
  field: string
  label: string
  type: string | null
}

export interface RequirementRow {
  id: unknown
  label: string
  complete: boolean
  values: Record<string, unknown>
  /** Read-only context values for the entry's display_fields. */
  display: Record<string, unknown>
}

export interface RequirementBlockResult {
  type: 'child_fields'
  collection: string
  fk_field: string
  title: string
  fields: RequirementFieldMeta[]
  /** Context columns shown read-only per row in the dialog. */
  display_fields: RequirementFieldMeta[]
  rows: RequirementRow[]
}

function parseJson(val: string | null | undefined): unknown {
  if (!val) return null
  try {
    return JSON.parse(val)
  } catch {
    return null
  }
}

function isEmptyRequirementValue(v: unknown): boolean {
  return v == null || String(v).trim() === ''
}

// Pure. Row ids (from `rows`) where any of `fields` is empty per the Global
// Constraints definition: null, '' or whitespace-only after String().
function findIncompleteRows(rows: Array<Record<string, unknown>>, fields: string[]): Set<unknown> {
  const incomplete = new Set<unknown>()
  for (const row of rows) {
    if (fields.some((f) => isEmptyRequirementValue(row[f]))) incomplete.add(row.id)
  }
  return incomplete
}

// Evaluates a transition's stored `requirements` JSON against the item's
// current child-row data. Returns null when the gate passes (nothing blocks)
// or the 422 payload's `requirements` array when it doesn't. Malformed JSON,
// malformed entries, and unrecognized `type` values are all treated as "no
// requirement" — logged, never thrown, never blocking a transition on bad config.
export async function evaluateTransitionRequirements(
  database: typeof db,
  requirementsJson: string | null,
  itemId: string,
  logger: Logger = consoleLogger
): Promise<RequirementBlockResult[] | null> {
  if (!requirementsJson) return null
  const parsed = parseJson(requirementsJson)
  if (parsed === null) {
    logger.warn({ requirementsJson }, 'transition requirements: malformed JSON, ignoring')
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null

  const blocking: RequirementBlockResult[] = []

  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (entry.type !== 'child_fields') continue // unrecognized type — ignored, never an error

    const { collection, fk_field: fkField, fields } = entry
    if (
      typeof collection !== 'string' ||
      !IDENTIFIER_RE.test(collection) ||
      typeof fkField !== 'string' ||
      !IDENTIFIER_RE.test(fkField) ||
      !Array.isArray(fields) ||
      fields.length === 0 ||
      !fields.every((f) => typeof f === 'string' && IDENTIFIER_RE.test(f))
    ) {
      logger.warn({ entry }, 'transition requirements: malformed child_fields entry, ignoring')
      continue
    }

    const requiredFields = fields as string[]
    // Optional context columns. Invalid names are filtered (with a log), never
    // fatal — display config must not block a transition.
    const rawDisplay = Array.isArray(entry.display_fields) ? entry.display_fields : []
    const displayFields = rawDisplay.filter(
      (f): f is string =>
        typeof f === 'string' && IDENTIFIER_RE.test(f) && !requiredFields.includes(f)
    )
    if (displayFields.length !== rawDisplay.length) {
      logger.warn({ entry }, 'transition requirements: dropped invalid display_fields entries')
    }
    const labelsOverride =
      entry.labels && typeof entry.labels === 'object' && !Array.isArray(entry.labels)
        ? (entry.labels as Record<string, unknown>)
        : {}
    const title =
      typeof entry.title === 'string' && entry.title.trim()
        ? entry.title
        : 'Required before continuing'

    let fieldInfoRows: Array<{ field: string; label: string | null; type: string | null }> = []
    try {
      fieldInfoRows = (await database('nivaro_fields')
        .where({ collection })
        .select('field', 'label', 'type')) as Array<{
        field: string
        label: string | null
        type: string | null
      }>
    } catch {
      fieldInfoRows = []
    }
    const nivaroFieldByField = new Map(fieldInfoRows.map((r) => [r.field, r]))

    const toMeta = (f: string): RequirementFieldMeta => {
      const info = nivaroFieldByField.get(f)
      const override = labelsOverride[f]
      const label = (typeof override === 'string' && override.trim()) || info?.label || f
      return { field: f, label, type: info?.type ?? null }
    }
    const fieldMeta: RequirementFieldMeta[] = requiredFields.map(toMeta)
    const displayFieldMeta: RequirementFieldMeta[] = displayFields.map(toMeta)

    let displayTemplate: string | null = null
    try {
      const childCol = await getCollection(collection)
      displayTemplate = childCol?.display_template ?? null
    } catch {
      displayTemplate = null
    }

    // Relation metadata for the child collection: M2O display fields resolve to
    // the related record's display value; M2M alias fields resolve to a joined
    // list via the junction. Failures fall back to raw values — display polish
    // must never block a transition.
    let childRels: Array<{
      many_collection: string
      many_field: string
      one_collection: string | null
      one_field: string | null
      junction_field: string | null
    }> = []
    try {
      childRels = (await database('nivaro_relations')
        .where({ many_collection: collection })
        .orWhere({ one_collection: collection })
        .select(
          'many_collection',
          'many_field',
          'one_collection',
          'one_field',
          'junction_field'
        )) as typeof childRels
    } catch {
      childRels = []
    }
    const m2oByField = new Map<string, string>()
    const m2mByField = new Map<
      string,
      { junction: string; fkToChild: string; junctionField: string; relatedCollection: string }
    >()
    for (const f of displayFields) {
      const m2o = childRels.find(
        (r) => r.many_collection === collection && r.many_field === f && r.junction_field == null
      )
      if (m2o?.one_collection) {
        m2oByField.set(f, m2o.one_collection)
        continue
      }
      const alias = childRels.find(
        (r) =>
          r.one_collection === collection &&
          r.junction_field != null &&
          (r.one_field === f || r.many_collection === f)
      )
      if (alias?.junction_field) {
        const companion = childRels.find(
          (r) =>
            r.many_collection === alias.many_collection && r.many_field === alias.junction_field
        )
        if (companion?.one_collection) {
          m2mByField.set(f, {
            junction: alias.many_collection,
            fkToChild: alias.many_field,
            junctionField: alias.junction_field,
            relatedCollection: companion.one_collection
          })
        }
      }
    }
    // Alias fields are not real columns — keep them out of the child SELECT.
    const columnDisplayFields = displayFields.filter((f) => !m2mByField.has(f))

    const templateFields = extractTemplateFields(displayTemplate)
    const selectFields = [
      ...new Set(['id', ...requiredFields, ...columnDisplayFields, ...templateFields])
    ]

    let childRows: Array<Record<string, unknown>> = []
    try {
      childRows = (await database(collection)
        .where({ [fkField]: itemId })
        .limit(2000)
        .select(selectFields)) as Array<Record<string, unknown>>
    } catch (err) {
      // Misconfigured requirement (e.g. fk_field doesn't exist on the child
      // collection) — fail open rather than blocking every transition, but
      // log loudly so the misconfiguration gets noticed and fixed.
      logger.warn(
        { err, collection, fkField },
        'transition requirements: child row query failed, ignoring'
      )
      childRows = []
    }

    if (childRows.length === 0) continue // zero child rows — nothing to require

    const incompleteIds = findIncompleteRows(childRows, requiredFields)
    if (incompleteIds.size === 0) continue // every row already filled in

    const relatedLabel = async (
      relatedCollection: string,
      ids: unknown[]
    ): Promise<Map<string, string>> => {
      const out = new Map<string, string>()
      const distinct = [...new Set(ids.filter((v) => v != null).map(String))]
      if (distinct.length === 0) return out
      let template: string | null = null
      try {
        template = (await getCollection(relatedCollection))?.display_template ?? null
      } catch {
        template = null
      }
      const related = (await database(relatedCollection)
        .whereIn('id', distinct)
        .limit(500)
        .select('*')) as Array<Record<string, unknown>>
      for (const r of related) out.set(String(r.id), resolveDisplayValue(r, template))
      return out
    }

    const m2oResolved = new Map<string, Map<string, string>>()
    for (const [f, relatedCollection] of m2oByField) {
      try {
        m2oResolved.set(
          f,
          await relatedLabel(
            relatedCollection,
            childRows.map((r) => r[f])
          )
        )
      } catch (err) {
        logger.warn(
          { err, collection, field: f },
          'transition requirements: m2o display resolve failed'
        )
      }
    }

    const m2mResolved = new Map<string, Map<string, string>>()
    for (const [f, cfg] of m2mByField) {
      try {
        const childIds = childRows.map((r) => String(r.id))
        const junctionRows = (await database(cfg.junction)
          .whereIn(cfg.fkToChild, childIds)
          .limit(2000)
          .select(cfg.fkToChild, cfg.junctionField)) as Array<Record<string, unknown>>
        const labels = await relatedLabel(
          cfg.relatedCollection,
          junctionRows.map((j) => j[cfg.junctionField])
        )
        const byChild = new Map<string, string[]>()
        for (const j of junctionRows) {
          const childId = String(j[cfg.fkToChild])
          const label = labels.get(String(j[cfg.junctionField]))
          if (!label) continue
          const arr = byChild.get(childId) ?? []
          arr.push(label)
          byChild.set(childId, arr)
        }
        m2mResolved.set(f, new Map([...byChild].map(([k, v]) => [k, v.join(', ')])))
      } catch (err) {
        logger.warn(
          { err, collection, field: f },
          'transition requirements: m2m display resolve failed'
        )
      }
    }

    const rows: RequirementRow[] = childRows.map((row) => {
      const values: Record<string, unknown> = {}
      for (const f of requiredFields) values[f] = row[f] ?? null
      const display: Record<string, unknown> = {}
      for (const f of displayFields) {
        if (m2mByField.has(f)) {
          display[f] = m2mResolved.get(f)?.get(String(row.id)) ?? null
        } else if (m2oByField.has(f)) {
          const raw = row[f]
          display[f] = raw == null ? null : (m2oResolved.get(f)?.get(String(raw)) ?? raw)
        } else {
          display[f] = row[f] ?? null
        }
      }
      let label = displayTemplate ? resolveDisplayValue(row, displayTemplate) : ''
      if (!label) label = `#${String(row.id)}`
      return { id: row.id, label, complete: !incompleteIds.has(row.id), values, display }
    })

    blocking.push({
      type: 'child_fields',
      collection,
      fk_field: fkField,
      title,
      fields: fieldMeta,
      display_fields: displayFieldMeta,
      rows
    })
  }

  return blocking.length > 0 ? blocking : null
}
