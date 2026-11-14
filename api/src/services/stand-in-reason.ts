import { db } from '../db/index.js'
import type { User } from '../types.js'
import { fieldLabel, labelledValue, listPhrase, personName } from './access-words.js'
import {
  clusterOwnerGapRecords,
  coerceBool,
  type OwnerGapCluster,
  type OwnerResolutionTrace,
  resolveStateOwnersBatch
} from './pipeline-engine.js'

/**
 * Why a record's current step is held by a stand-in (Rob 2026-11-14): the
 * binding's owner fallback field named someone because NOBODY is assigned —
 * and the pipeline panel and the record header say both halves plainly:
 *
 *  - why nobody is assigned (no owner groups on the step, no group covers the
 *    record's values, the winning group has nobody in it);
 *  - why THIS person stands in (they created the record, or the record names
 *    them in its fallback field).
 *
 * Nothing is re-derived: the owner resolver's own trace (the one the owner
 * simulator reads) says whether a stand-in holds the step and which groups
 * won, and the no-owner report's clustering + gap explainer name the values
 * no group covers and the closest group. Asked only for ONE record + step, and
 * only when the binding has a fallback field — a pipeline without one never
 * pays for it.
 *
 * Visibility: the stand-in's name is already on the panel; the record's
 * dimension values are named only when the viewer may read that field; the
 * group's name, the closest group and the matrix link go to administrators
 * only (never inside a View-as or as-person preview — the caller decides).
 */

export type WhyUnassignedKind =
  | 'no_groups'
  | 'uncovered'
  | 'no_match'
  | 'empty_group'
  | 'not_required'
export type WhyThisPersonKind = 'creator' | 'field'

export interface StandInReason {
  state: { id: string; label: string }
  /** The people standing in (one per fallback field — usually one). */
  people: Array<{ id: string; name: string }>
  why_unassigned: {
    kind: WhyUnassignedKind
    sentence: string
    /** The record's values the sentence names, with their dimension labels. */
    values?: Array<{ label: string; value: string }>
  }
  why_this_person: { kind: WhyThisPersonKind; sentence: string }
  /** Administrators only: the closest group and what it misses, or the empty group's name. */
  detail?: string
  /** Administrators only: where the step's owners are set. */
  matrix_href?: string
}

export interface StandInGap {
  /** The record's values on the step's dimensions (label + display value). */
  dims: Array<{ field: string; label: string; value: string }>
  /** The values no candidate group names at all. */
  uncovered: Array<{ field: string; label: string; value: string }>
  suggestion: { group_label: string | null; missing_labels: string[] } | null
}

export interface StandInDeps {
  trace(req: {
    stateId: string
    instanceId: string
    collection: string
    itemId: string
  }): Promise<OwnerResolutionTrace | undefined>
  state(
    stateId: string
  ): Promise<{ id: string; key: string; label: string; owners_not_required?: unknown } | undefined>
  gap(input: {
    templateId: string
    collection: string
    item: string
    stateId: string
    stateKey: string
  }): Promise<StandInGap | null>
  creatorColumn(collection: string): Promise<string | null>
  fieldLabel(collection: string, field: string): Promise<string | null>
  /** The viewer may read this (possibly dotted) field path on the collection —
   *  EVERY hop, not just the root (a related record's value is named only when
   *  the viewer may read that field of that record's collection). */
  canReadPath(
    viewer: { user: User | undefined; isAdmin: boolean },
    collection: string,
    path: string
  ): Promise<boolean>
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

export const realStandInDeps: StandInDeps = {
  async trace(req) {
    const trace = new Map<string, OwnerResolutionTrace>()
    await resolveStateOwnersBatch([{ key: 'x', ...req }], db, { trace })
    return trace.get('x')
  },
  async state(stateId) {
    return (await db('nivaro_workflow_states')
      .where({ id: stateId })
      .first('id', 'key', 'label', 'owners_not_required')
      .catch(() => undefined)) as
      | { id: string; key: string; label: string; owners_not_required?: unknown }
      | undefined
  },
  async gap({ templateId, collection, item, stateId, stateKey }) {
    const clusters = new Map<string, OwnerGapCluster>()
    await clusterOwnerGapRecords(
      collection,
      [{ item, current_state: stateId }],
      new Map([[up(stateId), stateKey]]),
      clusters,
      { perStateCap: 1 }
    )
    const list = [...clusters.values()]
    if (list.length === 0) return null
    const [{ explainOwnerGapClusters }, { dimensionLabels }] = await Promise.all([
      import('./owner-gap-explain.js'),
      import('./owner-explain.js')
    ])
    const [explained, labels] = await Promise.all([
      explainOwnerGapClusters(templateId, list),
      dimensionLabels(templateId).catch(() => new Map<string, string>())
    ])
    const e = explained[0]
    if (!e) return null
    return {
      dims: Object.entries(e.dims)
        .filter(([, v]) => !!v)
        .map(([field, value]) => ({ field, label: fieldLabel(field, labels), value })),
      uncovered: e.uncovered,
      suggestion: e.suggestion
        ? {
            group_label: e.suggestion.group_label ?? null,
            missing_labels: (e.suggestion as { missing_labels?: string[] }).missing_labels ?? []
          }
        : null
    }
  },
  async creatorColumn(collection) {
    const { creatorColumns } = await import('./dashboard-feed.js')
    return (
      (await creatorColumns([collection]).catch(() => new Map<string, string>())).get(collection) ??
      null
    )
  },
  async fieldLabel(collection, field) {
    const row = (await db('nivaro_fields')
      .where({ collection, field })
      .first('label')
      .catch(() => undefined)) as { label?: string | null } | undefined
    return row?.label?.trim() || null
  },
  async canReadPath(viewer, collection, path) {
    if (viewer.isAdmin) return true
    if (!viewer.user) return false
    // The Ask AI guard: the base collection's readable fields, then every hop's
    // related collection (its own field list, row filters and User Scopes) —
    // anything it cannot check is refused, so the value is left out.
    try {
      const [{ chatFieldSet, chatRelationsFor }, guard] = await Promise.all([
        import('./ai-chat.js'),
        import('./ai-aggregate-guard.js')
      ])
      const all = await chatFieldSet(collection)
      const readable = await guard.readableFieldSet(viewer.user, collection, all)
      const root = path.split('.')[0]
      if (!readable.has(root)) return false
      const hidden = new Set([...all].filter((f) => !readable.has(f)))
      await guard.assertFilterReadable(
        viewer.user,
        collection,
        [path.split('.')],
        hidden,
        chatRelationsFor,
        { toMany: true }
      )
      return true
    } catch {
      return false
    }
  }
}

/** "Zone 3, Project 201979 or Region PNR" — each value with its dimension's label. */
const valuePhrase = (values: Array<{ label: string; value: string }>, conj: string) =>
  listPhrase(
    values.map((v) => labelledValue(v.label, v.value)),
    conj
  )

export interface StandInReasonInput {
  collection: string
  item: string
  instance: { id: string; template: string; current_state: string | null }
  /** The binding's owner_fallback_field — no field, no stand-in. */
  fallbackField: string | null | undefined
  /** Whose read access decides which values are named. */
  viewer: { user: User | undefined; isAdmin: boolean }
  /** The caller is a real administrator (not a preview / View-as): group names + the matrix link. */
  showAdmin: boolean
}

export async function standInReasonFor(
  input: StandInReasonInput,
  deps: StandInDeps = realStandInDeps
): Promise<StandInReason | null> {
  const field = String(input.fallbackField ?? '').trim()
  const stateId = input.instance.current_state
  if (!field || !stateId) return null

  const t = await deps.trace({
    stateId: String(stateId),
    instanceId: String(input.instance.id),
    collection: input.collection,
    itemId: String(input.item)
  })
  // Assigned owners (a group member or a hand-added owner) leave nothing to explain.
  if (!t || t.standIn.length === 0) return null

  const state = await deps.state(String(stateId))
  const step = state?.label?.trim() || 'this step'
  const people = t.standIn.map((o) => ({ id: String(o.id), name: personName(o) }))
  const who = people.map((p) => p.name).join(' and ')

  const canRead = (path: string) =>
    deps.canReadPath(input.viewer, input.collection, path).catch(() => false)
  const readableOnly = async <T extends { field: string }>(values: T[]): Promise<T[]> => {
    const ok = await Promise.all(values.map((v) => canRead(v.field)))
    return values.filter((_v, i) => ok[i])
  }
  const [creatorCol, readable] = await Promise.all([
    deps.creatorColumn(input.collection),
    canRead(field)
  ])

  // ── Why nobody is assigned ────────────────────────────────────────────────
  let whyUnassigned: StandInReason['why_unassigned']
  let detail: string | undefined
  const winner = t.winning[0] ?? null
  if (state && coerceBool(state.owners_not_required as boolean | number | null)) {
    whyUnassigned = { kind: 'not_required', sentence: `${step} does not need an owner.` }
  } else if (!t.hasGroups) {
    whyUnassigned = { kind: 'no_groups', sentence: `${step} has no owner groups at all.` }
  } else if (winner) {
    // A group (or the default) won, and nobody is in it.
    const name = winner.name?.trim() || null
    whyUnassigned = {
      kind: 'empty_group',
      sentence: `The owner group for ${step} has no members.`
    }
    if (input.showAdmin && name)
      detail = `${coerceBool(winner.is_default) ? 'Default group' : 'Group'} “${name}” has nobody in it.`
  } else {
    const gap = state
      ? await deps
          .gap({
            templateId: String(input.instance.template),
            collection: input.collection,
            item: String(input.item),
            stateId: String(stateId),
            stateKey: state.key
          })
          .catch(() => null)
      : null
    const rawUncovered = gap?.uncovered ?? []
    const rawDims = gap?.dims ?? []
    const [uncovered, dims] = await Promise.all([readableOnly(rawUncovered), readableOnly(rawDims)])
    // A value the viewer may not read is never named. "Covers … together" is
    // said only over the WHOLE combination (a partial one would point at the
    // wrong values), and an uncovered list with nothing readable says nothing.
    if (rawUncovered.length > 0 && uncovered.length > 0) {
      whyUnassigned = {
        kind: 'uncovered',
        sentence: `No owner group covers ${valuePhrase(uncovered, 'or')} for ${step}.`,
        values: uncovered.map(({ label, value }) => ({ label, value }))
      }
    } else if (rawUncovered.length === 0 && dims.length > 0 && dims.length === rawDims.length) {
      whyUnassigned = {
        kind: 'no_match',
        sentence: `No owner group covers ${valuePhrase(dims, 'and')} together for ${step}.`,
        values: dims.map(({ label, value }) => ({ label, value }))
      }
    } else {
      whyUnassigned = {
        kind: 'no_match',
        sentence: `No owner group matches this record for ${step}.`
      }
    }
    const s = gap?.suggestion
    if (input.showAdmin && s?.group_label) {
      detail = `Closest group: “${s.group_label}”${
        s.missing_labels.length > 0 ? `, which wants ${listPhrase(s.missing_labels)}` : ''
      }.`
    }
  }

  // ── Why this person ──────────────────────────────────────────────────────
  let whyThisPerson: StandInReason['why_this_person']
  if (readable && creatorCol && creatorCol.toLowerCase() === field.toLowerCase()) {
    whyThisPerson = {
      kind: 'creator',
      sentence: `${who} stands in as the person who created this record.`
    }
  } else {
    const label = readable
      ? ((await deps.fieldLabel(input.collection, field).catch(() => null)) ?? fieldLabel(field))
      : null
    whyThisPerson = {
      kind: 'field',
      sentence: label
        ? `${who} stands in as this record’s ${label}.`
        : `${who} stands in because this record names them.`
    }
  }

  return {
    state: { id: String(stateId), label: step },
    people,
    why_unassigned: whyUnassigned,
    why_this_person: whyThisPerson,
    ...(detail ? { detail } : {}),
    ...(input.showAdmin
      ? { matrix_href: `/pipelines/${input.instance.template}#owner-matrix` }
      : {})
  }
}
