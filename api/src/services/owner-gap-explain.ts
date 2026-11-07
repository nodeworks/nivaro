import { db } from '../db/index.js'
import {
  fieldLabel,
  humanCollection,
  labelledValue,
  type OwnerGapFacts,
  ownerGapSentence
} from './access-words.js'
import { dimensionLabels } from './owner-explain.js'
import {
  getOwnerGroupsForStates,
  type OwnerGapCluster,
  type RecordFilter
} from './pipeline-engine.js'

/**
 * #2012 — the owner-gap advisor's clusters in words: "38 Zone 4 CMTS
 * requests in Finance Review match no owner group because no group covers
 * Zone 4. The closest group is …".
 *
 * Built only from what analyzeOwnerGaps already found (the cluster's
 * dimension values and its closest-group suggestion) plus the state's own
 * candidate groups, re-read through the same cached getOwnerGroupsForStates
 * the resolver uses. "No group covers Zone 4" means literally that no
 * candidate group in that state names Zone 4 on that dimension — so the
 * sentence can never claim a gap the matrix does not have.
 */

export interface ExplainedGapCluster extends OwnerGapCluster {
  /** The whole sentence, closest group included. */
  explanation: string
  /** Just the "why" — for a surface that already shows the closest group. */
  reason: string
  uncovered: Array<{ field: string; label: string; value: string }>
  /** `sample_items` as people know them (the collection's display template —
   *  "CR26INV-37438", not row 37821); same order, same length. */
  sample_labels: string[]
}

/** An owner group named by an import key ("legacy:inventory_request_owners:227")
 *  has no name a person can use — it is described by its filters instead. */
export function isImportKeyLabel(label: string | null | undefined): boolean {
  const v = String(label ?? '').trim()
  return /^legacy:/i.test(v) || /^[\w-]+:[\w-]+:\d+$/.test(v)
}

/** Field root of a dotted filter path ("project_type.name" → "project_type"). */
const rootOf = (field: string) => field.split('.')[0]

type IdDisplay = Map<string, string>
export const idKey = (collection: string, field: string, id: unknown) =>
  `${collection}|${rootOf(field)}|${String(id)}`

/** Tokens of a display template ("{{inventory_request_id}} · {{name}}" → [inventory_request_id, name]). */
function templateFields(template: string | null | undefined): string[] {
  return [...String(template ?? '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
    .map((m) => m[1].split('.')[0])
    .filter((f, i, a) => a.indexOf(f) === i)
}
function renderTemplate(template: string, row: Record<string, unknown>): string {
  return template
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, f: string) => String(row[f.split('.')[0]] ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
}
const FALLBACK_LABEL_COLS = [
  'workflow_id',
  'inventory_request_id',
  'number',
  'name',
  'title',
  'label'
]

/**
 * Labels for records of one collection by their display template (falling
 * back to the usual id-ish columns). Best-effort: a failed read labels by id.
 */
export async function recordLabels(
  collection: string,
  ids: string[],
  templates: Map<string, string | null>
): Promise<Map<string, string>> {
  const out = new Map<string, string>(ids.map((id) => [id, id]))
  if (ids.length === 0 || !/^[a-z][a-z0-9_]*$/i.test(collection)) return out
  const template = templates.get(collection) ?? null
  const wanted = template ? templateFields(template) : []
  try {
    const cols = (await db(collection).columnInfo()) as Record<string, unknown>
    const have = new Set(Object.keys(cols))
    const fields = (wanted.length ? wanted : FALLBACK_LABEL_COLS).filter((f) => have.has(f))
    if (fields.length === 0) return out
    const rows = (await db(collection)
      .whereIn('id', ids)
      .select('id', ...fields)) as Array<Record<string, unknown>>
    for (const r of rows) {
      const label =
        template && wanted.every((f) => have.has(f))
          ? renderTemplate(template, r)
          : String(fields.map((f) => r[f]).find((v) => v != null && v !== '') ?? '')
      if (label) out.set(String(r.id), label)
    }
  } catch {
    /* labels are cosmetic */
  }
  return out
}

/**
 * Display values for the id-based filters of the closest groups ("wants 5" →
 * "Full Duplex"): the filter field's relation names the target collection,
 * whose display template names the row. Best-effort.
 */
async function idDisplays(
  wants: Array<{ collection: string; field: string; id: unknown }>,
  templates: Map<string, string | null>
): Promise<IdDisplay> {
  const out: IdDisplay = new Map()
  if (wants.length === 0) return out
  const roots = [...new Set(wants.map((w) => `${w.collection}|${rootOf(w.field)}`))]
  const relations = (await db('nivaro_relations')
    .whereIn(
      'many_collection',
      roots.map((r) => r.split('|')[0])
    )
    .select('many_collection', 'many_field', 'one_collection')
    .catch(() => [])) as Array<{
    many_collection: string
    many_field: string
    one_collection: string | null
  }>
  for (const root of roots) {
    const [collection, field] = root.split('|')
    const rel = relations.find((r) => r.many_collection === collection && r.many_field === field)
    if (!rel?.one_collection) continue
    const ids = [
      ...new Set(
        wants
          .filter((w) => w.collection === collection && rootOf(w.field) === field)
          .map((w) => String(w.id))
      )
    ]
    const labels = await recordLabels(rel.one_collection, ids, templates)
    for (const id of ids) {
      const label = labels.get(id)
      if (label && label !== id) out.set(idKey(collection, field, id), label)
    }
  }
  return out
}

const NAMING_OPS = new Set(['eq', 'in'])

function filterNames(f: RecordFilter, value: string, idValue: number | null): boolean {
  if (idValue != null && f.id_value != null && Number(f.id_value) === idValue) return true
  const want = value.trim().toLowerCase()
  const vals = Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',')
  return vals.some((v) => String(v).trim().toLowerCase() === want)
}

/**
 * The cluster's dimension values that NO candidate group in its state names.
 * A dimension no group filters on at all is not "uncovered" — any group
 * would match it — and a group using a non-naming op (neq, lt…) on the
 * field is treated as possibly covering it, so the claim stays conservative.
 */
export function uncoveredDimensions(
  cluster: Pick<OwnerGapCluster, 'filters'>,
  candidates: Array<{ filters: RecordFilter[] }>,
  labels?: Map<string, string>
): Array<{ field: string; label: string; value: string }> {
  const out: Array<{ field: string; label: string; value: string }> = []
  for (const cf of cluster.filters) {
    const onField = candidates.flatMap((c) => c.filters.filter((f) => f.field === cf.field))
    if (onField.length === 0) continue
    if (onField.some((f) => !NAMING_OPS.has(String(f.op)))) continue
    if (onField.some((f) => filterNames(f, cf.value, cf.id_value))) continue
    out.push({ field: cf.field, label: fieldLabel(cf.field, labels), value: cf.value })
  }
  return out
}

/** 'zone_id.name (wants Zone 3)' → 'Zone 3' with the field's label. */
function missingPhrase(raw: string, labels?: Map<string, string>): string {
  const m = /^(.+?) \(wants (.*)\)$/.exec(raw)
  if (!m) return fieldLabel(raw, labels)
  return labelledValue(fieldLabel(m[1], labels), m[2])
}

/**
 * What the closest group wants on each field it misses, by its DISPLAY
 * value: the advisor's mismatch strings carry the filter's id ("wants 19")
 * when the filter is id-based, which reads as nothing to a person.
 */
/** A filter's value as a person reads it: the resolved display of an id-based
 *  filter ("Full Duplex", never "5"), else its stored value(s). */
function filterDisplay(
  f: RecordFilter,
  collection: string | null,
  displays: IdDisplay | undefined
): string {
  const byId =
    f.id_value != null && collection ? displays?.get(idKey(collection, f.field, f.id_value)) : null
  if (byId) return byId
  const v = Array.isArray(f.value) ? f.value.join(' or ') : String(f.value ?? '')
  // An id-only filter with no display found says nothing rather than a number.
  return f.id_value != null && /^\d+$/.test(v) ? '' : v
}

function missingFromGroup(
  mismatched: string[],
  group: { filters: RecordFilter[] } | undefined,
  labels?: Map<string, string>,
  collection: string | null = null,
  displays?: IdDisplay
): string[] {
  return mismatched.map((raw) => {
    const field = /^(.+?) \(wants /.exec(raw)?.[1] ?? raw
    const f = group?.filters.find((x) => x.field === field)
    const v = f ? filterDisplay(f, collection, displays) : ''
    if (v) return labelledValue(fieldLabel(field, labels), v)
    // No display for the id: name the field alone ("Project Type"), never "wants 5".
    const wantsId = /\(wants (\d+)\)$/.test(raw) && (f?.id_value != null || !f)
    return wantsId ? fieldLabel(field, labels) : missingPhrase(raw, labels)
  })
}

/** What a group is called on screen: its name, or — for an import-keyed
 *  name — its filter values ("FRE · Zone 1 · Full Duplex"). */
function groupDisplayLabel(
  label: string | null | undefined,
  group: { filters: RecordFilter[] } | undefined,
  collection: string | null,
  displays?: IdDisplay
): string {
  const name = String(label ?? '').trim()
  if (name && !isImportKeyLabel(name)) return name
  const parts = (group?.filters ?? [])
    .map((f) => filterDisplay(f, collection, displays))
    .filter(Boolean)
  return parts.length ? parts.join(' · ') : name || 'an unnamed group'
}

export function gapFacts(
  cluster: OwnerGapCluster,
  stateLabel: string,
  noun: string | null,
  uncovered: Array<{ label: string; value: string }>,
  labels?: Map<string, string>,
  closest?: { filters: RecordFilter[] },
  displays?: IdDisplay
): OwnerGapFacts {
  return {
    count: cluster.count,
    noun,
    state_label: stateLabel,
    dims: Object.entries(cluster.dims)
      .filter(([, v]) => !!v)
      .map(([field, value]) => ({ label: fieldLabel(field, labels), value })),
    uncovered,
    suggestion: cluster.suggestion
      ? {
          group_label: groupDisplayLabel(
            cluster.suggestion.group_label,
            closest,
            cluster.collection,
            displays
          ),
          matched: cluster.suggestion.matched_filters.map((f) => fieldLabel(f, labels)),
          missing: missingFromGroup(
            cluster.suggestion.mismatched_filters,
            closest,
            labels,
            cluster.collection,
            displays
          )
        }
      : null
  }
}

export async function explainOwnerGapClusters(
  templateId: string,
  clusters: OwnerGapCluster[]
): Promise<ExplainedGapCluster[]> {
  if (clusters.length === 0) return []
  const stateIds = [...new Set(clusters.map((c) => c.state_id))]
  const collections = [...new Set(clusters.map((c) => c.collection))]
  const [labels, groupData, states, colls] = await Promise.all([
    dimensionLabels(templateId),
    getOwnerGroupsForStates(stateIds, db),
    db('nivaro_workflow_states')
      .whereIn('id', stateIds)
      .select('id', 'label')
      .catch(() => []) as Promise<Array<{ id: string; label: string }>>,
    db('nivaro_collections')
      .whereIn('collection', collections)
      .select('collection', 'display_name')
      .catch(() => []) as Promise<Array<{ collection: string; display_name: string | null }>>
  ])
  const stateLabel = new Map(states.map((s) => [String(s.id).toUpperCase(), s.label]))
  const nounOf = new Map(
    colls.map((c) => [c.collection, humanCollection(c.collection, c.display_name)])
  )
  const closestOf = (c: OwnerGapCluster) => {
    const candidates = groupData.get(c.state_id)?.prepared.candidates ?? []
    return c.suggestion?.group_id
      ? candidates.find(
          (x) => String(x.group.id).toUpperCase() === String(c.suggestion?.group_id).toUpperCase()
        )
      : undefined
  }
  // Army 8 b11 N-B7: the page showed "wants 5" (a project type id), group
  // names like "legacy:inventory_request_owners:227" and record ids ("e.g.
  // 36200"). Display values for every id the sentences name, read once.
  const templates = new Map<string, string | null>()
  try {
    const trows = (await db('nivaro_collections').select(
      'collection',
      'display_template'
    )) as Array<{
      collection: string
      display_template: string | null
    }>
    for (const t of trows) templates.set(t.collection, t.display_template)
  } catch {
    /* templates are cosmetic */
  }
  const wants: Array<{ collection: string; field: string; id: unknown }> = []
  for (const c of clusters)
    for (const f of closestOf(c)?.filters ?? [])
      if (f.id_value != null)
        wants.push({ collection: c.collection, field: f.field, id: f.id_value })
  const displays = await idDisplays(wants, templates).catch(() => new Map() as IdDisplay)
  const sampleLabels = new Map<string, Map<string, string>>()
  for (const collection of collections) {
    const ids = [
      ...new Set(clusters.filter((c) => c.collection === collection).flatMap((c) => c.sample_items))
    ]
    sampleLabels.set(collection, await recordLabels(collection, ids, templates))
  }
  return clusters.map((c) => {
    const candidates = groupData.get(c.state_id)?.prepared.candidates ?? []
    const uncovered = uncoveredDimensions(c, candidates, labels)
    const closest = closestOf(c)
    const facts = gapFacts(
      c,
      stateLabel.get(String(c.state_id).toUpperCase()) ?? c.state_key ?? 'this step',
      nounOf.get(c.collection) ?? null,
      uncovered,
      labels,
      closest,
      displays
    )
    const byId = sampleLabels.get(c.collection)
    return {
      ...c,
      // The suggestion's label as shown, so a surface that prints
      // suggestion.group_label never shows an import key either.
      suggestion: c.suggestion
        ? {
            ...c.suggestion,
            group_label: facts.suggestion?.group_label ?? c.suggestion.group_label
          }
        : null,
      uncovered,
      sample_labels: c.sample_items.map((id) => byId?.get(id) ?? id),
      explanation: ownerGapSentence(facts),
      reason: ownerGapSentence({ ...facts, suggestion: null })
    }
  })
}
