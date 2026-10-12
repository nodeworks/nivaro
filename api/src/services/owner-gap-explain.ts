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
function missingFromGroup(
  mismatched: string[],
  group: { filters: RecordFilter[] } | undefined,
  labels?: Map<string, string>
): string[] {
  return mismatched.map((raw) => {
    const field = /^(.+?) \(wants /.exec(raw)?.[1] ?? raw
    const f = group?.filters.find((x) => x.field === field)
    const v = f ? (Array.isArray(f.value) ? f.value.join(' or ') : String(f.value ?? '')) : ''
    return v ? labelledValue(fieldLabel(field, labels), v) : missingPhrase(raw, labels)
  })
}

export function gapFacts(
  cluster: OwnerGapCluster,
  stateLabel: string,
  noun: string | null,
  uncovered: Array<{ label: string; value: string }>,
  labels?: Map<string, string>,
  closest?: { filters: RecordFilter[] }
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
          group_label: cluster.suggestion.group_label ?? 'an unnamed group',
          matched: cluster.suggestion.matched_filters.map((f) => fieldLabel(f, labels)),
          missing: missingFromGroup(cluster.suggestion.mismatched_filters, closest, labels)
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
  return clusters.map((c) => {
    const candidates = groupData.get(c.state_id)?.prepared.candidates ?? []
    const uncovered = uncoveredDimensions(c, candidates, labels)
    const closest = c.suggestion?.group_id
      ? candidates.find(
          (x) => String(x.group.id).toUpperCase() === String(c.suggestion?.group_id).toUpperCase()
        )
      : undefined
    const facts = gapFacts(
      c,
      stateLabel.get(String(c.state_id).toUpperCase()) ?? c.state_key ?? 'this step',
      nounOf.get(c.collection) ?? null,
      uncovered,
      labels,
      closest
    )
    return {
      ...c,
      uncovered,
      explanation: ownerGapSentence(facts),
      reason: ownerGapSentence({ ...facts, suggestion: null })
    }
  })
}
