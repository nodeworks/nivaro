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
}

export interface RequirementRow {
  id: unknown
  label: string
  complete: boolean
  values: Record<string, unknown>
}

export interface RequirementBlockResult {
  type: 'child_fields'
  collection: string
  fk_field: string
  title: string
  fields: RequirementFieldMeta[]
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
    const labelsOverride =
      entry.labels && typeof entry.labels === 'object' && !Array.isArray(entry.labels)
        ? (entry.labels as Record<string, unknown>)
        : {}
    const title =
      typeof entry.title === 'string' && entry.title.trim()
        ? entry.title
        : 'Required before continuing'

    let fieldLabelRows: Array<{ field: string; label: string | null }> = []
    try {
      fieldLabelRows = (await database('nivaro_fields')
        .where({ collection })
        .select('field', 'label')) as Array<{ field: string; label: string | null }>
    } catch {
      fieldLabelRows = []
    }
    const nivaroLabelByField = new Map(fieldLabelRows.map((r) => [r.field, r.label]))

    const fieldMeta: RequirementFieldMeta[] = requiredFields.map((f) => {
      const override = labelsOverride[f]
      const label =
        (typeof override === 'string' && override.trim()) || nivaroLabelByField.get(f) || f
      return { field: f, label }
    })

    let displayTemplate: string | null = null
    try {
      const childCol = await getCollection(collection)
      displayTemplate = childCol?.display_template ?? null
    } catch {
      displayTemplate = null
    }

    const templateFields = extractTemplateFields(displayTemplate)
    const selectFields = [...new Set(['id', ...requiredFields, ...templateFields])]

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

    const rows: RequirementRow[] = childRows.map((row) => {
      const values: Record<string, unknown> = {}
      for (const f of requiredFields) values[f] = row[f] ?? null
      let label = displayTemplate ? resolveDisplayValue(row, displayTemplate) : ''
      if (!label) label = `#${String(row.id)}`
      return { id: row.id, label, complete: !incompleteIds.has(row.id), values }
    })

    blocking.push({
      type: 'child_fields',
      collection,
      fk_field: fkField,
      title,
      fields: fieldMeta,
      rows
    })
  }

  return blocking.length > 0 ? blocking : null
}
