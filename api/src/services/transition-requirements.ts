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
  /** M2M alias required fields (e.g. per-line supporting warehouses): the
   *  dialog renders a multi-select and writes junction rows instead of a
   *  scalar PATCH. Completeness = at least one junction row per child.
   *  'm2o' marks a record-level FK field — the dialog renders a single-select
   *  over related_collection. */
  kind?: 'm2m' | 'm2o'
  related_collection?: string
  junction?: string
  fk_to_child?: string
  junction_field?: string
  /** Display formatting hint for read-only context columns (entry.display_formats). */
  format?: 'currency' | 'number'
  /** m2m selection cap (entry.max_values map) — 1 renders a single-select. */
  max_values?: number
  /** entry.optional_when rule: this field is NOT required (and the dialog
   *  disables it) when the row's controlling field matches one of `in` —
   *  e.g. sales_order_id waived for lines whose warehouse is MDSi. */
  optional_when?: { field: string; in: Array<string | number>; placeholder?: string }
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
  /** entry.prefill_from_record resolved against the transitioning record —
   *  {childField: recordValue}; the dialog seeds EMPTY inputs from these. */
  prefill_values?: Record<string, unknown>
}

/** Record-level required fields — collected on the TRANSITIONING record itself
 *  (e.g. order number + supporting warehouse at warehouse submission). The
 *  dialog renders header inputs above any child tables and PATCHes the record. */
export interface RecordFieldsBlockResult {
  type: 'record_fields'
  collection: string
  item: string
  title: string
  fields: RequirementFieldMeta[]
  values: Record<string, unknown>
  /** Resolved display labels for currently-set m2o values. */
  display: Record<string, unknown>
  /** Optional entries render (with current values) but never BLOCK the
   *  transition — e.g. the header order number kept for copy-to-lines. */
  optional?: boolean
  /** {recordField: childField} — the dialog renders an "apply to lines"
   *  button copying the header value into every non-waived line input. */
  copy_to_lines?: Record<string, string>
}

export type TransitionRequirementBlock = RequirementBlockResult | RecordFieldsBlockResult

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

// Evaluates a transition's stored `requirements` JSON against the item's
// current child-row data. Returns null when the gate passes (nothing blocks)
// or the 422 payload's `requirements` array when it doesn't. Malformed JSON,
// malformed entries, and unrecognized `type` values are all treated as "no
// requirement" — logged, never thrown, never blocking a transition on bad config.
export async function evaluateTransitionRequirements(
  database: typeof db,
  requirementsJson: string | null,
  itemId: string,
  logger: Logger = consoleLogger,
  recordCollection?: string | null
): Promise<TransitionRequirementBlock[] | null> {
  if (!requirementsJson) return null
  const parsed = parseJson(requirementsJson)
  if (parsed === null) {
    logger.warn({ requirementsJson }, 'transition requirements: malformed JSON, ignoring')
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null

  const blocking: TransitionRequirementBlock[] = []
  let hasBlockingEntry = false

  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (entry.type === 'record_fields') {
      const block = await evaluateRecordFieldsEntry(database, entry, itemId, recordCollection, logger)
      if (block) {
        blocking.push(block)
        if (!block.optional) hasBlockingEntry = true
      }
      continue
    }
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

    const displayFormats =
      entry.display_formats &&
      typeof entry.display_formats === 'object' &&
      !Array.isArray(entry.display_formats)
        ? (entry.display_formats as Record<string, unknown>)
        : {}
    const maxValuesMap =
      entry.max_values && typeof entry.max_values === 'object' && !Array.isArray(entry.max_values)
        ? (entry.max_values as Record<string, unknown>)
        : {}
    // optional_when: {targetField: {field, in, placeholder?}} — validated
    // per-entry; malformed rules are dropped (never block on bad config).
    const optionalWhen = new Map<
      string,
      { field: string; in: Array<string | number>; placeholder?: string }
    >()
    if (
      entry.optional_when &&
      typeof entry.optional_when === 'object' &&
      !Array.isArray(entry.optional_when)
    ) {
      for (const [target, ruleRaw] of Object.entries(entry.optional_when as Record<string, unknown>)) {
        const rule = ruleRaw as { field?: unknown; in?: unknown; placeholder?: unknown }
        if (
          IDENTIFIER_RE.test(target) &&
          typeof rule?.field === 'string' &&
          IDENTIFIER_RE.test(rule.field) &&
          Array.isArray(rule.in) &&
          rule.in.length > 0
        ) {
          optionalWhen.set(target, {
            field: rule.field,
            in: rule.in as Array<string | number>,
            ...(typeof rule.placeholder === 'string' ? { placeholder: rule.placeholder } : {})
          })
        }
      }
    }
    const toMeta = (f: string): RequirementFieldMeta => {
      const info = nivaroFieldByField.get(f)
      const override = labelsOverride[f]
      const label = (typeof override === 'string' && override.trim()) || info?.label || f
      const fmt = displayFormats[f]
      return {
        field: f,
        label,
        type: info?.type ?? null,
        ...(fmt === 'currency' || fmt === 'number' ? { format: fmt } : {})
      }
    }
    // fieldMeta is built after relation detection below so m2m required fields
    // can carry their junction wiring — placeholder assigned here for ordering.
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
    // Alias companion rows (junction → related collection) live on the junction
    // collection, which the child-scoped query above can't see — load them.
    const juncNames = [
      ...new Set(
        childRels
          .filter((r) => r.one_collection === collection && r.junction_field != null)
          .map((r) => r.many_collection)
      )
    ]
    if (juncNames.length > 0) {
      try {
        const companions = (await database('nivaro_relations')
          .whereIn('many_collection', juncNames)
          .select(
            'many_collection',
            'many_field',
            'one_collection',
            'one_field',
            'junction_field'
          )) as typeof childRels
        for (const c of companions) {
          if (
            !childRels.some(
              (r) => r.many_collection === c.many_collection && r.many_field === c.many_field
            )
          ) {
            childRels.push(c)
          }
        }
      } catch (err) {
        logger.warn({ err, collection }, 'transition requirements: junction companion query failed')
      }
    }
    const m2oByField = new Map<string, string>()
    const m2mByField = new Map<
      string,
      { junction: string; fkToChild: string; junctionField: string; relatedCollection: string }
    >()
    for (const f of [...displayFields, ...requiredFields]) {
      if (m2oByField.has(f) || m2mByField.has(f)) continue
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
    // M2M alias REQUIRED fields (e.g. per-line warehouses) complete on ≥1
    // junction row and edit via junction writes, not a scalar PATCH.
    const m2mRequired = requiredFields.filter((f) => m2mByField.has(f))
    const scalarRequired = requiredFields.filter((f) => !m2mByField.has(f))
    const fieldMeta: RequirementFieldMeta[] = requiredFields.map((f) => {
      const rule = optionalWhen.get(f)
      const base = { ...toMeta(f), ...(rule ? { optional_when: rule } : {}) }
      const cfg = m2mByField.get(f)
      if (!cfg) return base
      const maxRaw = Number(maxValuesMap[f])
      return {
        ...base,
        type: 'm2m',
        kind: 'm2m' as const,
        related_collection: cfg.relatedCollection,
        junction: cfg.junction,
        fk_to_child: cfg.fkToChild,
        junction_field: cfg.junctionField,
        ...(Number.isInteger(maxRaw) && maxRaw > 0 ? { max_values: maxRaw } : {})
      }
    })
    // Alias fields are not real columns — keep them out of the child SELECT.
    const columnDisplayFields = displayFields.filter((f) => !m2mByField.has(f))

    const templateFields = extractTemplateFields(displayTemplate)
    const selectFields = [
      ...new Set(['id', ...scalarRequired, ...columnDisplayFields, ...templateFields])
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

    // Junction ids per child row for every m2m required field — both for
    // completeness and for the dialog's multi-select initial values.
    const m2mIdsByField = new Map<string, Map<string, string[]>>()
    for (const f of m2mRequired) {
      const cfg = m2mByField.get(f)
      if (!cfg) continue
      try {
        const childIds = childRows.map((r) => String(r.id))
        const junctionRows = (await database(cfg.junction)
          .whereIn(cfg.fkToChild, childIds)
          .limit(2000)
          .select(cfg.fkToChild, cfg.junctionField)) as Array<Record<string, unknown>>
        const byChild = new Map<string, string[]>()
        for (const j of junctionRows) {
          const childId = String(j[cfg.fkToChild])
          const arr = byChild.get(childId) ?? []
          arr.push(String(j[cfg.junctionField]))
          byChild.set(childId, arr)
        }
        m2mIdsByField.set(f, byChild)
      } catch (err) {
        logger.warn({ err, collection, field: f }, 'transition requirements: m2m ids query failed')
        m2mIdsByField.set(f, new Map())
      }
    }

    // A field with a matched optional_when rule is waived for that row — the
    // controlling value comes from the row itself (scalar) or its junction
    // ids (m2m alias like per-line warehouses).
    const ruleWaived = (row: Record<string, unknown>, f: string): boolean => {
      const rule = optionalWhen.get(f)
      if (!rule) return false
      const allowed = new Set(rule.in.map(String))
      const ctlVals: unknown[] = m2mByField.has(rule.field)
        ? (m2mIdsByField.get(rule.field)?.get(String(row.id)) ?? [])
        : [row[rule.field]]
      return ctlVals.some((v) => v != null && allowed.has(String(v)))
    }
    const incompleteIds = new Set<unknown>()
    for (const row of childRows) {
      if (
        scalarRequired.some((f) => isEmptyRequirementValue(row[f]) && !ruleWaived(row, f))
      ) {
        incompleteIds.add(row.id)
      }
      for (const f of m2mRequired) {
        if ((m2mIdsByField.get(f)?.get(String(row.id)) ?? []).length === 0) {
          incompleteIds.add(row.id)
        }
      }
    }
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
      for (const f of scalarRequired) values[f] = row[f] ?? null
      for (const f of m2mRequired) values[f] = m2mIdsByField.get(f)?.get(String(row.id)) ?? []
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

    // Optional prefill map {childField: recordField} — resolve the record's
    // current values so the dialog can seed empty line inputs (e.g. each
    // line's warehouses from the already-chosen supporting_warehouse).
    let prefillValues: Record<string, unknown> | undefined
    const prefillMap =
      entry.prefill_from_record &&
      typeof entry.prefill_from_record === 'object' &&
      !Array.isArray(entry.prefill_from_record)
        ? (entry.prefill_from_record as Record<string, unknown>)
        : null
    if (prefillMap && recordCollection && IDENTIFIER_RE.test(recordCollection)) {
      const recordFields = [
        ...new Set(
          Object.values(prefillMap).filter(
            (v): v is string => typeof v === 'string' && IDENTIFIER_RE.test(v)
          )
        )
      ]
      if (recordFields.length > 0) {
        try {
          const rec = (await database(recordCollection)
            .where({ id: itemId })
            .first(recordFields)) as Record<string, unknown> | undefined
          if (rec) {
            prefillValues = {}
            for (const [childField, recordField] of Object.entries(prefillMap)) {
              if (typeof recordField !== 'string' || !IDENTIFIER_RE.test(childField)) continue
              const v = rec[recordField]
              if (v != null && String(v).trim() !== '') prefillValues[childField] = v
            }
            if (Object.keys(prefillValues).length === 0) prefillValues = undefined
          }
        } catch (err) {
          logger.warn({ err, collection }, 'transition requirements: prefill query failed')
        }
      }
    }

    hasBlockingEntry = true
    blocking.push({
      type: 'child_fields',
      collection,
      fk_field: fkField,
      title,
      fields: fieldMeta,
      display_fields: displayFieldMeta,
      rows,
      ...(prefillValues ? { prefill_values: prefillValues } : {})
    })
  }

  // Optional display-only blocks alone never trigger the dialog.
  return hasBlockingEntry ? blocking : null
}

// Evaluates one record_fields entry against the transitioning record itself.
// Returns null when every listed field is filled (or the entry is malformed /
// the record collection is unknown) — same fail-open posture as child_fields.
async function evaluateRecordFieldsEntry(
  database: typeof db,
  entry: Record<string, unknown>,
  itemId: string,
  recordCollection: string | null | undefined,
  logger: Logger
): Promise<RecordFieldsBlockResult | null> {
  const { fields } = entry
  if (
    !Array.isArray(fields) ||
    fields.length === 0 ||
    !fields.every((f) => typeof f === 'string' && IDENTIFIER_RE.test(f))
  ) {
    logger.warn({ entry }, 'transition requirements: malformed record_fields entry, ignoring')
    return null
  }
  if (!recordCollection || !IDENTIFIER_RE.test(recordCollection)) {
    logger.warn({ entry }, 'transition requirements: record_fields without record collection, ignoring')
    return null
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

  let record: Record<string, unknown> | undefined
  try {
    record = (await database(recordCollection)
      .where({ id: itemId })
      .first(['id', ...requiredFields])) as Record<string, unknown> | undefined
  } catch (err) {
    logger.warn(
      { err, recordCollection },
      'transition requirements: record_fields query failed, ignoring'
    )
    return null
  }
  if (!record) return null
  const optional = entry.optional === true
  // A required entry with everything filled doesn't block; an optional entry
  // is included regardless (its inputs render for editing/copy-to-lines).
  if (!optional && !requiredFields.some((f) => isEmptyRequirementValue(record![f]))) return null

  let fieldInfoRows: Array<{ field: string; label: string | null; type: string | null }> = []
  try {
    fieldInfoRows = (await database('nivaro_fields')
      .where({ collection: recordCollection })
      .select('field', 'label', 'type')) as typeof fieldInfoRows
  } catch {
    fieldInfoRows = []
  }
  const infoByField = new Map(fieldInfoRows.map((r) => [r.field, r]))

  // M2O detection so the dialog can render pickers for FK fields.
  let rels: Array<{ many_field: string; one_collection: string | null }> = []
  try {
    rels = (await database('nivaro_relations')
      .where({ many_collection: recordCollection })
      .whereNull('junction_field')
      .select('many_field', 'one_collection')) as typeof rels
  } catch {
    rels = []
  }
  const m2oByField = new Map(
    rels.filter((r) => r.one_collection).map((r) => [r.many_field, r.one_collection as string])
  )

  const fieldMeta: RequirementFieldMeta[] = requiredFields.map((f) => {
    const info = infoByField.get(f)
    const override = labelsOverride[f]
    const label = (typeof override === 'string' && override.trim()) || info?.label || f
    const related = m2oByField.get(f)
    return related
      ? { field: f, label, type: info?.type ?? null, kind: 'm2o' as const, related_collection: related }
      : { field: f, label, type: info?.type ?? null }
  })

  const values: Record<string, unknown> = {}
  for (const f of requiredFields) values[f] = record[f] ?? null

  // Display labels for m2o values that are already set.
  const display: Record<string, unknown> = {}
  for (const f of requiredFields) {
    const related = m2oByField.get(f)
    const raw = record[f]
    if (!related || raw == null) continue
    try {
      const template = (await getCollection(related))?.display_template ?? null
      const row = (await database(related).where({ id: raw }).first('*')) as
        | Record<string, unknown>
        | undefined
      if (row) display[f] = resolveDisplayValue(row, template)
    } catch {
      // display polish only — never blocks
    }
  }

  const copyToLines =
    entry.copy_to_lines &&
    typeof entry.copy_to_lines === 'object' &&
    !Array.isArray(entry.copy_to_lines)
      ? Object.fromEntries(
          Object.entries(entry.copy_to_lines as Record<string, unknown>).filter(
            ([k, v]) =>
              IDENTIFIER_RE.test(k) && typeof v === 'string' && IDENTIFIER_RE.test(v)
          )
        )
      : undefined

  return {
    type: 'record_fields',
    collection: recordCollection,
    item: itemId,
    title,
    fields: fieldMeta,
    values,
    display,
    ...(optional ? { optional: true } : {}),
    ...(copyToLines && Object.keys(copyToLines).length > 0
      ? { copy_to_lines: copyToLines as Record<string, string> }
      : {})
  }
}
