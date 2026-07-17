import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { getRelations } from '../services/collections.js'
import { chunkArray, selectInChunks } from '../services/db-batch.js'
import { uploadFileBuffer } from '../services/files.js'
import { IMPORT_ROW_CAP, readSpreadsheet } from '../services/import-spreadsheet.js'
import type {
  CreateMiss,
  ImportIssue,
  LineDraft,
  LookupFetcher
} from '../services/import-templates.js'
import {
  collectCreateMisses,
  resolveCreateDefaults,
  runImportPipeline
} from '../services/import-templates.js'
import type {
  ConfigError,
  ImportHeaderRule,
  ImportLineConfig,
  ImportStep,
  ImportTemplateConfig
} from '../services/import-templates-config.js'
import { normalizeImportTemplateConfig } from '../services/import-templates-config.js'
import { applyFieldRules, createOne, findM2MRelation, getActualColumns } from '../services/items.js'
import { can } from '../services/permissions.js'
import { getRollupContributors, recalcRollupsForParent } from '../services/rollups.js'

const MAX_FILE_BYTES = 25 * 1024 * 1024
const MODES = ['prefill', 'direct', 'both'] as const

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

function formatTemplate(row: Record<string, unknown>) {
  return {
    ...row,
    file_types: parseJsonSafe(row.file_types) ?? ['xlsx', 'xlsm', 'csv'],
    header_map: parseJsonSafe(row.header_map) ?? [],
    line_map: parseJsonSafe(row.line_map),
    is_active: !!row.is_active,
    is_shared: !!row.is_shared
  }
}

/** Reconstructs the ImportTemplateConfig shape from a saved template row's JSON columns. */
function templateRowToConfig(row: Record<string, unknown>): ImportTemplateConfig {
  return {
    file_types: (parseJsonSafe(row.file_types) as ImportTemplateConfig['file_types'] | null) ?? [
      'xlsx',
      'xlsm',
      'csv'
    ],
    sheet_match: (row.sheet_match as string | null) ?? null,
    header_row: Number(row.header_row) || 1,
    header_map: (parseJsonSafe(row.header_map) as ImportHeaderRule[] | null) ?? [],
    line_map: parseJsonSafe(row.line_map) as ImportLineConfig | null,
    attach_file_field: (row.attach_file_field as string | null) ?? null
  }
}

const COLLECTION_NAME_RE = /^[A-Za-z0-9_]+$/

/** Post-processes fetched rows: MSSQL nvarchar-JSON array columns (e.g. a disperse
 *  map's values list) arrive as plain strings — reparse any string value that looks
 *  like a JSON array so it reaches the pipeline as a real array. Never throws. */
function parseArrayStrings(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const val = row[key]
      if (typeof val !== 'string' || !val.trim().startsWith('[')) continue
      try {
        const parsed = JSON.parse(val)
        if (Array.isArray(parsed)) row[key] = parsed
      } catch {
        // not valid JSON — leave the raw string untouched
      }
    }
  }
  return rows
}

/** Case-insensitive matching happens in the pipeline map, not here — MSSQL's default
 *  collation is already case-insensitive, but the pipeline normalizes anyway.
 *  `onError` lets a stale-config lookup failure (dropped/renamed column) degrade to an
 *  error issue the route appends, instead of throwing a 500 out of the pipeline. */
export function makeLookupFetcher(onError?: (message: string) => void): LookupFetcher {
  return async ({ collection, match_field, values, scope_filters }) => {
    // $users is a sentinel, not a real collection — resolved against nivaro_users directly,
    // scoped to non-redacted rows, ignoring scope_filters entirely. Must run BEFORE the
    // nivaro_/identifier guards below (the sentinel's leading "$" fails COLLECTION_NAME_RE).
    if (collection === '$users') {
      return selectInChunks(values, 500, (chunk) =>
        db('nivaro_users')
          .select('id', 'email')
          .where({ is_redacted: 0 })
          .whereIn(match_field, chunk)
      )
    }
    if (/^nivaro_/i.test(collection) || !COLLECTION_NAME_RE.test(collection)) return []
    try {
      const rows = await selectInChunks(values, 500, (chunk) => {
        let q = db(collection).select('*').whereIn(match_field, chunk)
        for (const f of scope_filters) {
          q =
            f.op === 'neq'
              ? q.whereNot(f.field, f.value as never)
              : q.where(f.field, f.value as never)
        }
        return q
      })
      return parseArrayStrings(rows)
    } catch {
      onError?.(
        `Lookup against "${collection}" failed — the collection or a mapped field may have changed`
      )
      return []
    }
  }
}

/** Resolves the O2M child relation for a line_map target_field: the relation row
 *  where `one_collection = collection AND one_field = target_field`. Returns both
 *  the child collection and its FK field back to the parent. */
async function resolveLineChildRelation(
  collection: string,
  targetField: string
): Promise<{ collection: string; fkField: string } | null> {
  const relation = (await db('nivaro_relations')
    .where({ one_collection: collection, one_field: targetField })
    .first()) as { many_collection: string; many_field: string } | undefined
  return relation ? { collection: relation.many_collection, fkField: relation.many_field } : null
}

/** Resolves just the O2M child collection for a line_map target_field — used where
 *  the FK field itself isn't needed (e.g. applying field rules to the child shape). */
async function resolveLineChildCollection(
  collection: string,
  targetField: string
): Promise<string | null> {
  const relation = await resolveLineChildRelation(collection, targetField)
  return relation?.collection ?? null
}

/** Resolves the nested/disperse target field (nested + disperse share one target when
 *  either is relation-mode, per validateNestedTarget) against the already-resolved line
 *  child collection. Null when there's no nested/disperse config, the line child
 *  collection didn't resolve, or the target is a physical repeater/JSON column rather
 *  than an O2M relation. */
async function resolveNestedRelation(
  lineMap: ImportLineConfig | null,
  childCollection: string | null
): Promise<{ collection: string; fk_field: string } | null> {
  const nestedTarget = lineMap?.nested?.target_field ?? lineMap?.disperse?.nested_target ?? null
  if (!nestedTarget || !childCollection) return null
  const relation = await resolveLineChildRelation(childCollection, nestedTarget)
  return relation ? { collection: relation.collection, fk_field: relation.fkField } : null
}

type M2mAliasInfo = { junction: string; fkToParent: string; fkToOther: string }

/** Shallow-validates an execute request's optional `m2m` body: a plain object whose
 *  every value is an array of string|number ids to link via M2M junction rows. */
function isValidM2mBody(value: unknown): value is Record<string, Array<string | number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (arr) => Array.isArray(arr) && arr.every((v) => typeof v === 'string' || typeof v === 'number')
  )
}

/** Resolves every M2M alias field (a virtual `one_field` on a junction relation) for a
 *  collection, keyed by field name — reuses the same mutual-pair matching
 *  `findM2MRelation()` already performs for item reads/filters, so a one-sided/broken
 *  junction row (see the junction_field gotcha) never resolves as a usable alias.
 *  Called once per collection: parse/test call it unconditionally to build the
 *  pipeline's m2mFields set; save-time validation only calls it lazily, once a header
 *  target turns out not to be a plain column (see `getM2mAliasFieldsCached`). */
async function resolveM2mAliasFields(collection: string): Promise<Map<string, M2mAliasInfo>> {
  const rels = await getRelations(collection)
  // Candidates include the junction-table-name fallback aliases (legacy fields named
  // after the junction) — findM2MRelation resolves both spellings.
  const candidateFields = new Set(
    rels
      .filter((r) => r.one_collection === collection && r.junction_field != null)
      .flatMap((r) => [r.one_field as string, r.many_collection])
      .filter(Boolean)
  )
  const map = new Map<string, M2mAliasInfo>()
  for (const field of candidateFields) {
    const match = findM2MRelation(field, collection, rels)
    if (match) {
      map.set(field, {
        junction: match.junction,
        fkToParent: match.fkToParent,
        fkToOther: match.fkToOther
      })
    }
  }
  return map
}

interface CreateGroup {
  step: CreateMiss['step']
  defaultsPayload: Record<string, unknown>
  applies: Array<(id: unknown) => void>
}

/** Groups collectCreateMisses() output into one create per dedupe_by tuple, scoped
 *  per lookup rule (a Map keyed by the step object itself, not just its collection —
 *  two different columns creating into the same collection stay separate groups).
 *  `resolvedCtx` is the execute body's header-resolved `values`. */
function buildCreateGroups(
  misses: CreateMiss[],
  resolvedCtx: Record<string, unknown>
): CreateGroup[] {
  const groups: CreateGroup[] = []
  const groupsByStep = new Map<CreateMiss['step'], Map<string, CreateGroup>>()
  for (const miss of misses) {
    // Seed the match field with the value that was actually searched for (the sheet
    // cell, trimmed to match the lookup layer's own trim+lowercase normalization) BEFORE
    // folding in create.defaults — otherwise the created record never carries the value
    // that missed, and the next import of the same name misses again, creating a
    // duplicate every time. An explicit defaults rule targeting the match field (rare,
    // but legal) still wins since it's spread in after and only overwrites when defined.
    const defaultsPayload = {
      [miss.step.match_field]: String(miss.name).trim(),
      ...resolveCreateDefaults(miss.step.create.defaults, miss.values, resolvedCtx)
    }
    // Normalized like the lookup matchMap (trim + lowercase) so values the lookup
    // layer would treat as one match never dedupe into two created records.
    const dedupeKey = JSON.stringify(
      miss.step.create.dedupe_by.map((field) =>
        String(defaultsPayload[field] ?? '')
          .trim()
          .toLowerCase()
      )
    )
    let stepGroups = groupsByStep.get(miss.step)
    if (!stepGroups) {
      stepGroups = new Map()
      groupsByStep.set(miss.step, stepGroups)
    }
    let group = stepGroups.get(dedupeKey)
    if (!group) {
      group = { step: miss.step, defaultsPayload, applies: [] }
      stepGroups.set(dedupeKey, group)
      groups.push(group)
    }
    group.applies.push(miss.apply)
  }
  return groups
}

const DELETE_CHUNK_SIZE = 1000

/** `whereIn('id', ids).del()`, chunked under MSSQL's 2100-parameter limit — a
 *  large failed import's compensation can carry thousands of created ids, well
 *  past what a single whereIn can bind. Sequential (not parallel) to keep
 *  compensation's error handling and logging straightforward. */
export async function chunkedDelete(table: string, ids: (string | number)[]): Promise<void> {
  if (ids.length === 0) return
  for (const chunk of chunkArray(ids, DELETE_CHUNK_SIZE)) {
    await db(table).whereIn('id', chunk).del()
  }
}

/** Deletes a mixed set of records grouped by collection — shared by the create-records
 *  compensation path and the main execute compensation path. */
async function deleteGroupedByCollection(
  records: Array<{ collection: string; id: string | number }>
): Promise<void> {
  const byCollection = new Map<string, (string | number)[]>()
  for (const rec of records) {
    const ids = byCollection.get(rec.collection) ?? []
    ids.push(rec.id)
    byCollection.set(rec.collection, ids)
  }
  for (const [coll, ids] of byCollection) {
    await chunkedDelete(coll, ids)
  }
}

/** Recalcs every stored rollup whose contributor FK (`entry.parentFk`) is present on
 *  one of `rows`' own payloads — even when the FK points at a record OUTSIDE the
 *  created tree entirely (e.g. a lookup-resolved `product_id`, an M2M junction's
 *  far-side id, or a `create.defaults` constant FK). Every row here was created with
 *  `skipRollupRecalc: true`, so this is the only recalc it gets — deduped per
 *  `(parentCollection, rollupField, parentId)` so the same rollup is never recomputed
 *  twice across rows/entries. Two callers:
 *  - Happy path (once, after the full create phase succeeds): also covers the PRIMARY
 *    parent-child FK (a child's fk to the created parent, a grandchild's fk to its
 *    child) generically, since that FK lives on the row's own payload same as any
 *    other contributor — the created parent's own rollup gets exactly one recalc here
 *    instead of the N it would have gotten from N per-row createOne recalcs.
 *  - Compensation (after a raw delete): the primary parent-child FK is a no-op there
 *    (the parent was just deleted), but the same generic pass also catches secondary
 *    FKs a raw delete never re-triggers, which is the case that matters there.
 *  Recalcing a parent id that was itself deleted in the same compensation pass is a
 *  harmless no-op — the update simply matches zero rows. */
async function recalcContributorsForRows(
  rows: Array<{ collection: string; payload: Record<string, unknown> }>
): Promise<void> {
  const seen = new Set<string>()
  for (const row of rows) {
    const entries = await getRollupContributors(row.collection)
    for (const entry of entries) {
      const parentId = row.payload[entry.parentFk]
      if (parentId == null) continue
      const key = `${entry.parentCollection}::${entry.rollupField}::${String(parentId)}`
      if (seen.has(key)) continue
      seen.add(key)
      await recalcRollupsForParent(entry, parentId)
    }
  }
}

/** Resolves + caches a lookup target collection's field set. `null` means the
 *  collection is unknown, blocklisted, or not a valid identifier. */
async function resolveLookupFieldSet(
  collection: string,
  fieldSetCache: Map<string, Set<string> | null>
): Promise<Set<string> | null> {
  const cached = fieldSetCache.get(collection)
  if (cached !== undefined) return cached

  if (!COLLECTION_NAME_RE.test(collection) || /^nivaro_/i.test(collection)) {
    fieldSetCache.set(collection, null)
    return null
  }

  const collRow = await db('nivaro_collections').where({ collection }).first()
  if (!collRow) {
    fieldSetCache.set(collection, null)
    return null
  }

  const fieldRows = (await db('nivaro_fields').where({ collection }).select('field')) as {
    field: string
  }[]
  const fieldSet = new Set(fieldRows.map((r) => r.field))
  fieldSetCache.set(collection, fieldSet)
  return fieldSet
}

/** Validates one lookup step's collection + match_field + scope_filters fields
 *  against live schema metadata, appending ConfigError entries in place. */
async function validateLookupStep(
  step: Extract<ImportStep, { type: 'lookup' }>,
  path: string,
  errors: ConfigError[],
  fieldSetCache: Map<string, Set<string> | null>
): Promise<void> {
  // $users is a sentinel, not a real nivaro_collections row — the normalizer already
  // restricted match_field to the allowed set (email), so there's nothing left to check.
  if (step.collection === '$users') return

  const fieldSet = await resolveLookupFieldSet(step.collection, fieldSetCache)
  if (!fieldSet) {
    errors.push({ path, message: `Unknown lookup collection "${step.collection}"` })
    return
  }
  if (!fieldSet.has(step.match_field)) {
    errors.push({
      path: `${path}.match_field`,
      message: `Unknown field "${step.match_field}" on ${step.collection}`
    })
  }
  if (step.take === 'field' && !fieldSet.has(step.take_field ?? '')) {
    errors.push({
      path: `${path}.take_field`,
      message: `Unknown field "${step.take_field}" on ${step.collection}`
    })
  }
  step.scope_filters.forEach((f, i) => {
    if (!fieldSet.has(f.field)) {
      errors.push({
        path: `${path}.scope_filters[${i}].field`,
        message: `Unknown field "${f.field}" on ${step.collection}`
      })
    }
  })
  step.create?.defaults.forEach((rule, i) => {
    if (!fieldSet.has(rule.target)) {
      errors.push({
        path: `${path}.create.defaults[${i}].target`,
        message: `Unknown field "${rule.target}" on ${step.collection}`
      })
    }
  })
}

/** Finds every `lookup` step across a set of header rules and validates each. */
async function validateLookupStepsInRules(
  rules: ImportHeaderRule[],
  basePath: string,
  errors: ConfigError[],
  fieldSetCache: Map<string, Set<string> | null>
): Promise<void> {
  for (let i = 0; i < rules.length; i++) {
    const steps = rules[i].steps
    for (let j = 0; j < steps.length; j++) {
      const step = steps[j]
      if (step.type === 'lookup') {
        await validateLookupStep(step, `${basePath}[${i}].steps[${j}]`, errors, fieldSetCache)
      }
    }
  }
}

/** Lazily resolves + caches a collection's M2M alias field map — only called once a
 *  header target turns out not to be a plain column, since most templates never touch
 *  an M2M field and the lookup costs an extra nivaro_relations round trip. */
async function getM2mAliasFieldsCached(
  collection: string,
  cache: Map<string, Map<string, M2mAliasInfo>>
): Promise<Map<string, M2mAliasInfo>> {
  const cached = cache.get(collection)
  if (cached) return cached
  const resolved = await resolveM2mAliasFields(collection)
  cache.set(collection, resolved)
  return resolved
}

/** Validates a nested-rows target field (disperse's `nested_target` or
 *  `line_map.nested.target_field`) — accepted as EITHER a physical repeater/JSON
 *  column on the child collection (never an alias relation field, since nested rows
 *  written this way are a plain JSON array, not routed through relation machinery),
 *  OR an O2M alias resolvable via `nivaro_relations` (`one_collection = childCollection,
 *  one_field = field`), in which case the physical checks are skipped entirely — the
 *  pipeline writes those rows as real child records through the relation instead.
 *  Returns whether the target resolved in relation mode, so callers can cross-check
 *  disperse/nested targets that both land on a relation. */
async function validateNestedTarget(
  field: string,
  childCollection: string,
  path: string,
  ctx: { fieldSet: Set<string>; aliasFields: Set<string>; errors: ConfigError[] }
): Promise<{ isRelation: boolean }> {
  if (ctx.fieldSet.has(field)) {
    if (ctx.aliasFields.has(field)) {
      // A registered O2M alias is the NORMAL relation-mode target — execute resolves
      // it the same way. Only reject when no relation actually backs the alias.
      const relation = await resolveLineChildRelation(childCollection, field)
      if (relation) return { isRelation: true }
      ctx.errors.push({
        path,
        message: `Field "${field}" on ${childCollection} is an alias with no backing O2M relation — nested_target requires a relation or a repeater/JSON column`
      })
      return { isRelation: false }
    }
    // nivaro_fields metadata can drift from the physical table (e.g. a field row
    // registered for what is really a related table) — verify the column exists,
    // since createOne silently drops keys without a physical column. A drifted row
    // backed by a real O2M relation still validates in relation mode.
    const actualCols = await getActualColumns(childCollection)
    if (!actualCols.has(field)) {
      const relation = await resolveLineChildRelation(childCollection, field)
      if (relation) return { isRelation: true }
      ctx.errors.push({
        path,
        message: `Field "${field}" is registered on ${childCollection} but has no physical column — nested rows would be dropped on save. Use a repeater/JSON column.`
      })
    }
    return { isRelation: false }
  }

  const relation = await resolveLineChildRelation(childCollection, field)
  if (relation) return { isRelation: true }

  ctx.errors.push({
    path,
    message: `Unknown field "${field}" on ${childCollection} — nested_target requires a repeater/JSON column`
  })
  return { isRelation: false }
}

/** Validates a normalized config's field/collection targets against live schema
 *  metadata, appending ConfigError entries in place. Only called when the config
 *  normalized cleanly — no point validating targets on an already-invalid shape. */
async function validateConfigAgainstSchema(
  config: ImportTemplateConfig,
  collection: string,
  errors: ConfigError[]
): Promise<void> {
  const collRow = await db('nivaro_collections').where({ collection }).first()
  if (!collRow) {
    errors.push({ path: 'collection', message: `Unknown collection "${collection}"` })
    return
  }

  const fieldRows = (await db('nivaro_fields').where({ collection }).select('field')) as {
    field: string
  }[]
  const fieldSet = new Set(fieldRows.map((r) => r.field))
  const m2mAliasCache = new Map<string, Map<string, M2mAliasInfo>>()
  for (let i = 0; i < config.header_map.length; i++) {
    const rule = config.header_map[i]
    if (fieldSet.has(rule.target)) continue
    const m2mMap = await getM2mAliasFieldsCached(collection, m2mAliasCache)
    if (!m2mMap.has(rule.target)) {
      errors.push({
        path: `header_map[${i}]`,
        message: `Header rule target "${rule.target}" is not a column or M2M field of ${collection}`
      })
    } else {
      // An M2M target must resolve to ids — a lookup taking the whole record ('record')
      // or an arbitrary field ('field') can't become a junction row.
      const lookupStep = rule.steps.find(
        (s): s is Extract<ImportStep, { type: 'lookup' }> => s.type === 'lookup'
      )
      if (lookupStep && (lookupStep.take === 'record' || lookupStep.take === 'field')) {
        errors.push({
          path: `header_map[${i}]`,
          message: 'M2M targets require lookups that resolve to ids (take "id")'
        })
      }
    }
  }

  const lookupFieldSetCache = new Map<string, Set<string> | null>()
  await validateLookupStepsInRules(config.header_map, 'header_map', errors, lookupFieldSetCache)

  if (config.line_map) {
    const childCollection = await resolveLineChildCollection(
      collection,
      config.line_map.target_field
    )
    if (!childCollection) {
      errors.push({
        path: 'line_map.target_field',
        message: `No one-to-many relation found for "${config.line_map.target_field}" on ${collection}`
      })
      return
    }
    const childFieldRows = (await db('nivaro_fields')
      .where({ collection: childCollection })
      .select('field', 'type')) as { field: string; type: string | null }[]
    const childFieldSet = new Set(childFieldRows.map((r) => r.field))
    const childAliasFields = new Set(
      childFieldRows.filter((r) => r.type === 'alias').map((r) => r.field)
    )
    config.line_map.columns.forEach((col, i) => {
      if (!childFieldSet.has(col.target)) {
        errors.push({
          path: `line_map.columns[${i}].target`,
          message: `Unknown field "${col.target}" on ${childCollection}`
        })
      }
    })

    await validateLookupStepsInRules(
      config.line_map.columns,
      'line_map.columns',
      errors,
      lookupFieldSetCache
    )

    let disperseIsRelation = false
    let nestedIsRelation = false

    const disperse = config.line_map.disperse
    if (disperse) {
      const result = await validateNestedTarget(
        disperse.nested_target,
        childCollection,
        'line_map.disperse',
        {
          fieldSet: childFieldSet,
          aliasFields: childAliasFields,
          errors
        }
      )
      disperseIsRelation = result.isRelation

      const mapFieldSet = await resolveLookupFieldSet(disperse.map_collection, lookupFieldSetCache)
      if (!mapFieldSet) {
        errors.push({
          path: 'line_map.disperse.map_collection',
          message: `Unknown lookup collection "${disperse.map_collection}"`
        })
      } else if (!mapFieldSet.has(disperse.map_key_field)) {
        errors.push({
          path: 'line_map.disperse.map_key_field',
          message: `Unknown field "${disperse.map_key_field}" on ${disperse.map_collection}`
        })
      }

      await validateLookupStepsInRules(
        disperse.member_columns,
        'line_map.disperse.member_columns',
        errors,
        lookupFieldSetCache
      )
    }

    const nested = config.line_map.nested
    if (nested) {
      // Member targets are keys inside the nested JSON value (like disperse
      // member_columns), not columns of the child collection — only their
      // lookup steps get schema validation.
      await validateLookupStepsInRules(
        nested.columns,
        'line_map.nested.columns',
        errors,
        lookupFieldSetCache
      )

      const result = await validateNestedTarget(
        nested.target_field,
        childCollection,
        'line_map.nested.target_field',
        { fieldSet: childFieldSet, aliasFields: childAliasFields, errors }
      )
      nestedIsRelation = result.isRelation
    }

    // A disperse and a nested block can independently target the same child field —
    // fine when both write plain JSON. But once either target resolves as an O2M
    // relation, the pipeline writes real child rows through that relation, and two
    // configs pointed at different relations would race to create/own the same rows.
    if (
      disperse &&
      nested &&
      (disperseIsRelation || nestedIsRelation) &&
      disperse.nested_target !== nested.target_field
    ) {
      errors.push({
        path: 'line_map',
        message: 'nested and disperse must target the same field when a relation target is used'
      })
    }
  }
}

export async function importTemplatesRoutes(app: FastifyInstance) {
  // GET /import-templates?collection=&mode= — visibility: created_by=me OR
  // (is_shared=1 AND (role_id IS NULL OR role_id=myRole)); only is_active=1 unless admin.
  app.get('/', { preHandler: authenticate }, async (req, reply) => {
    const { collection, mode } = req.query as { collection?: string; mode?: string }
    const userId = req.user!.id
    const userRole = req.user!.role
    const isAdmin = req.isAdmin ?? false

    const query = db('nivaro_import_templates').orderBy('created_at', 'desc')

    if (!isAdmin) {
      query.where(function () {
        this.where({ created_by: userId }).orWhere(function () {
          this.where({ is_shared: true }).andWhere(function () {
            this.whereNull('role_id')
            if (userRole) this.orWhere({ role_id: userRole })
          })
        })
      })
      query.andWhere({ is_active: true })
    }

    if (collection) query.andWhere({ collection })
    if (mode) query.andWhere({ mode })

    const rows = (await query) as Record<string, unknown>[]
    return reply.send({ data: rows.map(formatTemplate) })
  })

  // POST /import-templates — create
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name : ''
    const collection = typeof body.collection === 'string' ? body.collection : ''
    if (!name || !collection) {
      return reply.code(400).send({ error: 'name and collection are required' })
    }
    if (body.mode !== undefined && !MODES.includes(body.mode as (typeof MODES)[number])) {
      return reply
        .code(400)
        .send({ error: 'Invalid mode', details: [{ path: 'mode', message: 'Unknown mode' }] })
    }

    const { config, errors } = normalizeImportTemplateConfig(body)
    if (errors.length === 0) {
      await validateConfigAgainstSchema(config, collection, errors)
    }
    if (errors.length > 0) {
      return reply.code(400).send({ error: 'Invalid template config', details: errors })
    }

    const id = randomUUID()
    const now = new Date()
    await db('nivaro_import_templates').insert({
      id,
      name,
      collection,
      mode: typeof body.mode === 'string' ? body.mode : 'prefill',
      file_types: JSON.stringify(config.file_types),
      sheet_match: config.sheet_match,
      header_row: config.header_row,
      header_map: JSON.stringify(config.header_map),
      line_map: config.line_map ? JSON.stringify(config.line_map) : null,
      attach_file_field: config.attach_file_field,
      button_label:
        typeof body.button_label === 'string' && body.button_label.trim()
          ? body.button_label.trim().slice(0, 100)
          : null,
      is_active: body.is_active !== false,
      is_shared: !!body.is_shared,
      role_id: typeof body.role_id === 'string' ? body.role_id : null,
      created_by: req.user!.id,
      created_at: now,
      updated_at: now
    })

    const created = (await db('nivaro_import_templates').where({ id }).first()) as Record<
      string,
      unknown
    >

    await logActivity({
      action: 'import-template-create',
      user: req.user?.id,
      collection: 'nivaro_import_templates',
      item: id,
      req
    })

    return reply.code(201).send({ data: formatTemplate(created) })
  })

  // PATCH /import-templates/:id — update
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = (await db('nivaro_import_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Record<string, unknown>
    if (body.mode !== undefined && !MODES.includes(body.mode as (typeof MODES)[number])) {
      return reply
        .code(400)
        .send({ error: 'Invalid mode', details: [{ path: 'mode', message: 'Unknown mode' }] })
    }
    const collection =
      typeof body.collection === 'string' ? body.collection : (existing.collection as string)

    const rawConfig = {
      file_types: body.file_types ?? parseJsonSafe(existing.file_types),
      sheet_match: 'sheet_match' in body ? body.sheet_match : existing.sheet_match,
      header_row: body.header_row ?? existing.header_row,
      header_map: body.header_map ?? parseJsonSafe(existing.header_map),
      line_map: 'line_map' in body ? body.line_map : parseJsonSafe(existing.line_map),
      attach_file_field:
        'attach_file_field' in body ? body.attach_file_field : existing.attach_file_field
    }

    const { config, errors } = normalizeImportTemplateConfig(rawConfig)
    if (errors.length === 0) {
      await validateConfigAgainstSchema(config, collection, errors)
    }
    if (errors.length > 0) {
      return reply.code(400).send({ error: 'Invalid template config', details: errors })
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date(),
      file_types: JSON.stringify(config.file_types),
      sheet_match: config.sheet_match,
      header_row: config.header_row,
      header_map: JSON.stringify(config.header_map),
      line_map: config.line_map ? JSON.stringify(config.line_map) : null,
      attach_file_field: config.attach_file_field
    }
    if (typeof body.name === 'string') patch.name = body.name
    if (typeof body.collection === 'string') patch.collection = body.collection
    if (typeof body.mode === 'string') patch.mode = body.mode
    if ('button_label' in body) {
      patch.button_label =
        typeof body.button_label === 'string' && body.button_label.trim()
          ? body.button_label.trim().slice(0, 100)
          : null
    }
    if (typeof body.is_active === 'boolean') patch.is_active = body.is_active
    if (typeof body.is_shared === 'boolean') patch.is_shared = body.is_shared
    if ('role_id' in body) patch.role_id = typeof body.role_id === 'string' ? body.role_id : null

    await db('nivaro_import_templates').where({ id }).update(patch)
    const updated = (await db('nivaro_import_templates').where({ id }).first()) as Record<
      string,
      unknown
    >

    await logActivity({
      action: 'import-template-update',
      user: req.user?.id,
      collection: 'nivaro_import_templates',
      item: id,
      req
    })

    return reply.send({ data: formatTemplate(updated) })
  })

  // DELETE /import-templates/:id
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = (await db('nivaro_import_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_import_templates').where({ id }).delete()

    await logActivity({
      action: 'import-template-delete',
      user: req.user?.id,
      collection: 'nivaro_import_templates',
      item: id,
      req
    })

    return reply.code(204).send()
  })

  // POST /import-templates/:id/parse — run a saved template against an uploaded file
  app.post('/:id/parse', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const template = (await db('nivaro_import_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!template) return reply.code(404).send({ error: 'Not found' })

    const collection = template.collection as string
    if (!(await can(req.user!, 'create', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    let multipart: Awaited<ReturnType<typeof req.file>>
    try {
      multipart = await req.file()
    } catch {
      return reply.code(400).send({ error: 'No file provided' })
    }
    if (!multipart) return reply.code(400).send({ error: 'No file provided' })
    const buffer = await multipart.toBuffer()
    if (buffer.length > MAX_FILE_BYTES) {
      return reply.code(413).send({ error: 'File exceeds 25MB limit' })
    }

    const config = templateRowToConfig(template)
    const { rows, issues: sheetIssues } = readSpreadsheet(buffer, multipart.filename, config)
    const structuralErrors = sheetIssues.filter((i) => i.severity === 'error')
    if (structuralErrors.length > 0 && rows.length === 0) {
      return reply.code(422).send({ error: 'File could not be parsed', issues: sheetIssues })
    }

    let applyLineFieldRules: ((draft: Record<string, unknown>) => Promise<void>) | undefined
    let childCollection: string | null = null
    if (config.line_map) {
      childCollection = await resolveLineChildCollection(collection, config.line_map.target_field)
      if (childCollection) {
        const resolvedChildCollection = childCollection
        applyLineFieldRules = (draft) => applyFieldRules(resolvedChildCollection, draft)
      }
    }
    const nestedRelation = await resolveNestedRelation(config.line_map, childCollection)

    const m2mMap = await resolveM2mAliasFields(collection)

    const lookupIssues: ImportIssue[] = []
    const result = await runImportPipeline({
      config,
      rows,
      lookup: makeLookupFetcher((message) =>
        lookupIssues.push({ severity: 'error', rule: 'lookup', message })
      ),
      applyLineFieldRules,
      m2mFields: new Set(m2mMap.keys())
    })
    const issues = [...sheetIssues, ...result.issues, ...lookupIssues]

    let file_id: string | null = null
    if (config.attach_file_field) {
      try {
        const stored = await uploadFileBuffer(
          req.user!,
          buffer,
          multipart.filename,
          multipart.mimetype || 'application/octet-stream'
        )
        file_id = stored.id
      } catch {
        return reply.code(422).send({
          error: 'File upload failed',
          issues: [
            ...issues,
            {
              severity: 'error',
              rule: 'upload',
              message: 'The uploaded file could not be stored — no data was imported.'
            }
          ]
        })
      }
    }

    const values = { ...result.values }
    const m2m = { ...result.m2m }
    if (config.attach_file_field && file_id) {
      // An M2M alias attach field (e.g. a nivaro_files junction) rides the m2m
      // section so prefill stages it in the picker and execute creates the
      // junction row; a scalar file column stays in values as before.
      if (m2mMap.has(config.attach_file_field)) {
        m2m[config.attach_file_field] = [...(m2m[config.attach_file_field] ?? []), file_id]
      } else {
        values[config.attach_file_field] = file_id
      }
    }

    return reply.send({
      data: {
        values,
        lines: result.lines,
        issues,
        file_id,
        line_target_field: config.line_map?.target_field ?? null,
        nested_relation: nestedRelation,
        m2m
      }
    })
  })

  // POST /import-templates/:id/execute — all-or-nothing direct create: parent record
  // + line rows into the O2M child collection. Any failure compensates by deleting
  // everything created so far, leaving no partial import behind.
  app.post('/:id/execute', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const template = (await db('nivaro_import_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!template) return reply.code(404).send({ error: 'Not found' })

    const collection = template.collection as string
    if (!(await can(req.user!, 'create', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const mode = template.mode as string
    if (mode !== 'direct' && mode !== 'both') {
      return reply.code(403).send({ error: 'Template does not support direct execution' })
    }

    const body = req.body as {
      values?: unknown
      lines?: unknown
      issues?: unknown
      file_id?: string | null
      m2m?: unknown
    }
    if (
      typeof body.values !== 'object' ||
      body.values === null ||
      Array.isArray(body.values) ||
      !Array.isArray(body.lines) ||
      !Array.isArray(body.issues) ||
      (body.m2m !== undefined && !isValidM2mBody(body.m2m))
    ) {
      return reply.code(400).send({ error: 'values, lines, and issues are required' })
    }
    const m2mBody = (body.m2m as Record<string, Array<string | number>> | undefined) ?? {}
    const m2mEntries = Object.entries(m2mBody)

    const bodyIssues = body.issues as ImportIssue[]
    if (bodyIssues.some((issue) => issue.severity === 'error')) {
      return reply.code(422).send({
        error: 'Cannot execute import while unresolved errors remain',
        issues: bodyIssues
      })
    }

    const values = { ...(body.values as Record<string, unknown>) }
    const lines = body.lines as LineDraft[]
    const config = templateRowToConfig(template)
    const attachField = config.attach_file_field
    const wantsAttach = !!(attachField && body.file_id)

    // on_miss: 'create' misses resolved + deduped up front — pure/sync — so the
    // record-to-create count can join the row-cap guard below before anything is
    // created.
    const createMisses = collectCreateMisses(config, lines)
    const createGroups = buildCreateGroups(createMisses, values)

    // Lines with no way to be persisted must fail loudly before anything is created,
    // rather than silently dropping the submitted rows. Resolved before the row-cap
    // guard below so a relation-mode nested target's grandchild rows can join the total.
    let childRelation: { collection: string; fkField: string } | null = null
    let nestedRelation: { collection: string; fk_field: string } | null = null
    if (lines.length > 0) {
      childRelation = config.line_map
        ? await resolveLineChildRelation(collection, config.line_map.target_field)
        : null
      nestedRelation = await resolveNestedRelation(
        config.line_map,
        childRelation?.collection ?? null
      )
    }

    const totalM2mIds = m2mEntries.reduce((sum, [, ids]) => sum + ids.length, 0)
    // Relation-mode nested rows become real grandchild creates, so they count toward
    // the cap same as line items; JSON-mode nested rows stay a plain column on the
    // line and never count.
    const totalMembers = nestedRelation
      ? lines.reduce((sum, line) => sum + (line.nested?.rows.length ?? 0), 0)
      : 0
    const totalCreates = createGroups.length
    const totalRows = lines.length + totalM2mIds + totalMembers + totalCreates
    if (totalRows > IMPORT_ROW_CAP) {
      return reply.code(422).send({
        error: `Too many rows — the import cap is ${IMPORT_ROW_CAP} rows`,
        issues: [
          ...bodyIssues,
          {
            severity: 'error',
            rule: 'execute',
            message: `Submitted ${totalRows} rows (${lines.length} line items + ${totalM2mIds} linked records${totalMembers > 0 ? ` + ${totalMembers} nested members` : ''}${totalCreates > 0 ? ` + ${totalCreates} records to create` : ''}); the import cap is ${IMPORT_ROW_CAP} rows`
          }
        ]
      })
    }

    if (lines.length > 0 && !childRelation) {
      return reply.code(422).send({
        error: 'Template has no line mapping for the submitted lines',
        issues: [
          ...bodyIssues,
          {
            severity: 'error',
            rule: 'execute',
            message: 'Template has no line mapping for the submitted lines'
          }
        ]
      })
    }

    // Stale-template guard: every body.m2m key must still resolve to a real M2M
    // junction relation before anything is created — a dropped/renamed field would
    // otherwise fail mid-way through the create sequence, after the parent exists.
    let m2mAliasMap = new Map<string, M2mAliasInfo>()
    if (m2mEntries.length > 0 || wantsAttach) {
      m2mAliasMap = await resolveM2mAliasFields(collection)
      const unresolved = m2mEntries.filter(([field]) => !m2mAliasMap.has(field))
      if (unresolved.length > 0) {
        return reply.code(422).send({
          error: 'Template references an M2M field that could not be resolved',
          issues: [
            ...bodyIssues,
            ...unresolved.map(([field]) => ({
              severity: 'error' as const,
              rule: 'execute',
              message: `M2M field "${field}" could not be resolved to a relation on ${collection} — the template may be stale`
            }))
          ]
        })
      }
    }

    // Attach the uploaded file: M2M alias attach fields become a junction link
    // (deduped — the parse response usually already carried it in body.m2m);
    // scalar file columns take the id directly.
    if (wantsAttach) {
      const fileId = body.file_id as string
      if (m2mAliasMap.has(attachField as string)) {
        const existing = m2mEntries.find(([field]) => field === attachField)
        if (existing) {
          if (!existing[1].map(String).includes(String(fileId))) existing[1].push(fileId)
        } else {
          m2mEntries.push([attachField as string, [fileId]])
        }
      } else {
        values[attachField as string] = fileId
      }
    }

    const workspaceId = req.workspaceId ?? undefined
    // Every created-row bookkeeping array below carries `payload` (the exact object
    // passed to createOne) alongside `collection`/`id`. Every createOne call in this
    // route passes skipRollupRecalc: true — a happy-path success runs ONE deduped
    // recalcContributorsForRows pass over everything created instead of one recalc per
    // row; on failure, compensation's raw deletes bypass items-service hooks entirely,
    // so that same pass (over the rows that existed before compensation) is what
    // refreshes any stored rollup createOne would otherwise have bumped.
    const createdChildIds: (string | number)[] = []
    const createdChildren: Array<{
      collection: string
      id: string | number
      payload: Record<string, unknown>
    }> = []
    const createdJunctions: Array<{
      collection: string
      id: string | number
      payload: Record<string, unknown>
    }> = []
    const createdGrandchildren: Array<{
      collection: string
      id: string | number
      payload: Record<string, unknown>
    }> = []
    const createdLookupRecords: Array<{
      collection: string
      id: string | number
      payload: Record<string, unknown>
    }> = []
    let parent: { id: string | number } | null = null
    const childCollection: string | null = childRelation?.collection ?? null
    const fkField = childRelation?.fkField ?? null
    let failedAtLine = 0
    let failedM2mField: string | null = null

    // on_miss: 'create' — bulk-create the deduped missing lookup records BEFORE the
    // parent, so line/junction creates below can reference their ids. Nothing else
    // exists yet at this point, so a failure here only needs to compensate the
    // creates that already landed (no parent/children/junctions to unwind).
    if (createGroups.length > 0) {
      let failedCreateCollection: string | null = null
      try {
        for (const group of createGroups) {
          failedCreateCollection = group.step.collection
          const created = (await createOne(
            req.user!,
            group.step.collection,
            group.defaultsPayload,
            req,
            workspaceId,
            { skipRollupRecalc: true }
          )) as { id: string | number }
          createdLookupRecords.push({
            collection: group.step.collection,
            id: created.id,
            payload: group.defaultsPayload
          })
          for (const apply of group.applies) apply(created.id)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        try {
          await deleteGroupedByCollection(createdLookupRecords)
        } catch (compensationErr) {
          app.log.error(
            compensationErr,
            'import-template execute compensation failed — created rows may be orphaned'
          )
        }
        try {
          await recalcContributorsForRows(createdLookupRecords)
        } catch {
          // swallow — compensation already reported the real error
        }
        return reply.code(422).send({
          error: 'Import failed while creating referenced records — nothing was created',
          issues: [
            ...bodyIssues,
            {
              severity: 'error',
              rule: 'execute',
              message: `Creating a referenced record in "${failedCreateCollection}" failed: ${message}`
            }
          ]
        })
      }
    }

    // The parent create is isolated: createOne inserts then reads the row back, so a
    // throw here (e.g. a row-level filter hiding the freshly-created row from this user)
    // may mean the record WAS written but is unreadable. We don't know its id, so we
    // can't compensate — report honestly rather than claiming nothing was created.
    const orphanReply = () =>
      reply.code(422).send({
        error: 'The record may have been created but could not be read back',
        issues: [
          ...bodyIssues,
          {
            severity: 'error',
            rule: 'execute',
            message:
              'The record may have been created but could not be read back (check read permissions / row-level filters for your role); line items were not created.'
          }
        ]
      })

    try {
      parent = (await createOne(req.user!, collection, values, req, workspaceId, {
        skipRollupRecalc: true
      })) as {
        id: string | number
      }
    } catch {
      return orphanReply()
    }
    if (!parent || parent.id == null) {
      return orphanReply()
    }

    try {
      // Junction rows go before line items — a line's data never depends on an M2M
      // link, but keeping the order fixed makes compensation easy to reason about.
      for (const [field, ids] of m2mEntries) {
        failedM2mField = field
        const info = m2mAliasMap.get(field)!
        // Dedupe by string key while preserving each id's first original value — a
        // duplicated id would otherwise create redundant junction rows for one link.
        const seen = new Set<string>()
        const uniqueIds = ids.filter((idValue) => {
          const key = String(idValue)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        for (const idValue of uniqueIds) {
          const junctionPayload = { [info.fkToParent]: parent.id, [info.fkToOther]: idValue }
          const junctionRow = (await createOne(
            req.user!,
            info.junction,
            junctionPayload,
            req,
            workspaceId,
            { skipRollupRecalc: true }
          )) as { id: string | number }
          createdJunctions.push({
            collection: info.junction,
            id: junctionRow.id,
            payload: junctionPayload
          })
        }
      }
      failedM2mField = null

      if (childCollection && fkField) {
        for (let i = 0; i < lines.length; i++) {
          failedAtLine = i + 1
          const line = lines[i]
          // Relation-mode: nested rows become real grandchild creates below, so the
          // nested key is excluded from childData entirely. JSON-mode (nestedRelation
          // null): unchanged — nested rows ride along as a plain JSON column.
          const childData: Record<string, unknown> = nestedRelation
            ? { ...line.values, [fkField]: parent.id }
            : {
                ...line.values,
                [fkField]: parent.id,
                ...(line.nested ? { [line.nested.field]: line.nested.rows } : {})
              }
          const child = (await createOne(req.user!, childCollection, childData, req, workspaceId, {
            skipRollupRecalc: true
          })) as { id: string | number }
          createdChildIds.push(child.id)
          createdChildren.push({ collection: childCollection, id: child.id, payload: childData })

          if (nestedRelation && line.nested) {
            for (const member of line.nested.rows) {
              const grandchildPayload = { ...member, [nestedRelation.fk_field]: child.id }
              const grandchild = (await createOne(
                req.user!,
                nestedRelation.collection,
                grandchildPayload,
                req,
                workspaceId,
                { skipRollupRecalc: true }
              )) as { id: string | number }
              createdGrandchildren.push({
                collection: nestedRelation.collection,
                id: grandchild.id,
                payload: grandchildPayload
              })
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const compensationIssues: ImportIssue[] = failedM2mField
        ? [
            {
              severity: 'error',
              rule: 'execute',
              message: `Linking "${failedM2mField}" failed: ${message}`
            }
          ]
        : [{ severity: 'error', rule: 'execute', row: failedAtLine, message }]
      try {
        // Grandchildren first (they FK to the child rows), then junctions, then
        // children, then the parent — reverse of create order.
        const grandchildrenByCollection = new Map<string, (string | number)[]>()
        for (const grandchild of createdGrandchildren) {
          const ids = grandchildrenByCollection.get(grandchild.collection) ?? []
          ids.push(grandchild.id)
          grandchildrenByCollection.set(grandchild.collection, ids)
        }
        for (const [grandchildCollection, ids] of grandchildrenByCollection) {
          await chunkedDelete(grandchildCollection, ids)
        }
        const junctionsByCollection = new Map<string, (string | number)[]>()
        for (const junction of createdJunctions) {
          const ids = junctionsByCollection.get(junction.collection) ?? []
          ids.push(junction.id)
          junctionsByCollection.set(junction.collection, ids)
        }
        for (const [junctionCollection, ids] of junctionsByCollection) {
          await chunkedDelete(junctionCollection, ids)
        }
        if (childCollection && createdChildIds.length > 0) {
          await chunkedDelete(childCollection, createdChildIds)
        }
        if (parent) {
          await db(collection).where({ id: parent.id }).del()
        }
        // Lookup records created for on_miss: 'create' misses are deleted LAST — any
        // child/grandchild row created above may FK to them.
        if (createdLookupRecords.length > 0) {
          await deleteGroupedByCollection(createdLookupRecords)
        }
      } catch (compensationErr) {
        app.log.error(
          compensationErr,
          'import-template execute compensation failed — created rows may be orphaned'
        )
        compensationIssues.push({
          severity: 'error',
          rule: 'execute-compensation',
          row: failedAtLine,
          message: 'Compensation failed — some created rows may be orphaned'
        })
      }

      // The compensation deletes above are raw db calls that bypass items-service
      // hooks, so any stored rollup whose contributor FK lived on one of the deleted
      // rows' own payloads is now stale — including FKs pointing OUTSIDE the created
      // tree entirely (an M2M junction's far side, a lookup-resolved FK, a
      // create.defaults constant). Swallowed: compensation already reported the real
      // error; a recalc failure must not mask it.
      try {
        await recalcContributorsForRows([
          ...createdGrandchildren,
          ...createdJunctions,
          ...createdChildren,
          ...createdLookupRecords
        ])
      } catch {
        // swallow
      }

      return reply.code(422).send({
        error: failedM2mField
          ? `Import failed while linking "${failedM2mField}" — nothing was created`
          : `Import failed on line ${failedAtLine} — nothing was created`,
        issues: [...bodyIssues, ...compensationIssues]
      })
    }

    // The full create phase succeeded — every createOne call above skipped its own
    // per-row rollup recalc (skipRollupRecalc: true), so run ONE deduped pass over
    // everything just created, including the parent itself (children's fkField and
    // grandchildren's nested fk_field point at created ids in their own payloads, so
    // the generic contributor-FK scan already covers the parent-child relationship —
    // see recalcContributorsForRows). Never fails the response: the rows already
    // committed, and a stale rollup here is recoverable via backfill.
    try {
      await recalcContributorsForRows([
        { collection, payload: values },
        ...createdLookupRecords,
        ...createdChildren,
        ...createdJunctions,
        ...createdGrandchildren
      ])
    } catch (err) {
      console.error({ err }, 'import-template execute: happy-path rollup recalc failed')
    }

    await logActivity({
      action: 'import-template-execute',
      user: req.user?.id,
      collection,
      item: String(parent.id),
      req
    })

    return reply
      .code(201)
      .send({ data: { id: String(parent.id), line_ids: createdChildIds.map(String) } })
  })

  // POST /import-templates/test — builder "test panel": run an unsaved config, no persist
  app.post('/test', { preHandler: requireAdmin }, async (req, reply) => {
    let multipart: Awaited<ReturnType<typeof req.file>>
    try {
      multipart = await req.file()
    } catch {
      return reply.code(400).send({ error: 'No file provided' })
    }
    if (!multipart) return reply.code(400).send({ error: 'No file provided' })
    const buffer = await multipart.toBuffer()
    if (buffer.length > MAX_FILE_BYTES) {
      return reply.code(413).send({ error: 'File exceeds 25MB limit' })
    }

    const configField = multipart.fields.config
    const configPart = Array.isArray(configField) ? configField[0] : configField
    if (configPart?.type !== 'field') {
      return reply.code(400).send({ error: 'config field is required' })
    }

    let raw: unknown
    try {
      raw = JSON.parse(String(configPart.value))
    } catch {
      return reply.code(400).send({ error: 'config must be valid JSON' })
    }

    const { config, errors } = normalizeImportTemplateConfig(raw)
    if (errors.length > 0) {
      return reply.code(400).send({ error: 'Invalid template config', details: errors })
    }

    const { rows, issues: sheetIssues } = readSpreadsheet(buffer, multipart.filename, config)
    const structuralErrors = sheetIssues.filter((i) => i.severity === 'error')
    if (structuralErrors.length > 0 && rows.length === 0) {
      return reply.code(422).send({ error: 'File could not be parsed', issues: sheetIssues })
    }

    let applyLineFieldRules: ((draft: Record<string, unknown>) => Promise<void>) | undefined
    let childCollection: string | null = null
    const collection = (raw as { collection?: unknown })?.collection
    if (config.line_map && typeof collection === 'string') {
      childCollection = await resolveLineChildCollection(collection, config.line_map.target_field)
      if (childCollection) {
        const resolvedChildCollection = childCollection
        applyLineFieldRules = (draft) => applyFieldRules(resolvedChildCollection, draft)
      }
    }
    const nestedRelation = await resolveNestedRelation(config.line_map, childCollection)

    const m2mMap =
      typeof collection === 'string'
        ? await resolveM2mAliasFields(collection)
        : new Map<string, M2mAliasInfo>()

    const lookupIssues: ImportIssue[] = []
    const result = await runImportPipeline({
      config,
      rows,
      lookup: makeLookupFetcher((message) =>
        lookupIssues.push({ severity: 'error', rule: 'lookup', message })
      ),
      applyLineFieldRules,
      m2mFields: new Set(m2mMap.keys())
    })
    const issues = [...sheetIssues, ...result.issues, ...lookupIssues]

    return reply.send({
      data: {
        values: result.values,
        lines: result.lines,
        issues,
        file_id: null,
        line_target_field: config.line_map?.target_field ?? null,
        nested_relation: nestedRelation,
        m2m: result.m2m
      }
    })
  })
}
