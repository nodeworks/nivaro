import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { getAiClient, getAiModelSettings } from './ai-client.js'
import { type CascadeCheck, compileChecks } from './config-conformance.js'
import { RowRuleLookupCache } from './field-rules.js'
import { createOne, deleteOne, updateOne } from './items.js'
import { notifyUser } from './notification-channels.js'
import { resolveStateOwners } from './pipeline-engine.js'
import { getLabels } from './queues.js'
import {
  type GridRuleConfig,
  gridRuleConfigsFor,
  parentContextFrom,
  planRowRuleChanges
} from './row-rules-apply.js'
import { applyValidationRule, type ValidationRule } from './validation-rules.js'

/**
 * Data Integrity fix PROPOSALS — "what would repair this finding, and why".
 *
 * A finding used to have one blunt fix (clear the value, regenerate the id).
 * This turns every fix into a ranked list of concrete proposals the person
 * chooses from: each one names the writes it would make, the basis it rests
 * on ("only option under Region BLT", "9 of 10 lines use it", "was 'X' until
 * the PO import blanked it") and a confidence. Nothing is written until a
 * proposal is applied, and every apply goes through the items service so
 * RBAC, validation, locks, hooks and revisions all land like a hand edit.
 *
 * Proposal ids are content hashes of (kind + writes); the apply route
 * regenerates the list and matches by id, so a client can never smuggle in
 * writes the engine did not propose.
 */

export interface ProposalWrite {
  op: 'update' | 'create' | 'delete'
  collection: string
  item_id?: string
  data?: Record<string, unknown>
}

export interface ProposalPreview {
  collection: string
  item_id: string | null
  field: string
  label: string
  from: string
  to: string
}

export type ProposalKind =
  | 'set'
  | 'replace'
  | 'set-parent'
  | 'clear'
  | 'restore'
  | 'derive'
  | 'rederive'
  | 'regenerate'
  | 'pick'
  | 'normalize'
  | 'notify'
  | 'ai'

export interface Proposal {
  id: string
  kind: ProposalKind
  label: string
  basis: string
  confidence: 'high' | 'medium' | 'low'
  writes: ProposalWrite[]
  preview: ProposalPreview[]
  /** 'pick' proposals: the person chooses one; apply sends `choice`. */
  choices?: Array<{ id: string; label: string }>
  /** 'pick': which field on which row the choice writes to. */
  pick?: { collection: string; item_id: string; field: string; rederive?: boolean }
  /** 'notify': who gets the task. */
  notify?: { user_id: string; name: string }
}

export interface FindingRef {
  field: string
  rule: string
  message?: string | null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const isEmpty = (v: unknown) => v === null || v === undefined || v === ''

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

const titleCase = (field: string) =>
  field
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Po|Id|Sku|Cifa|Req|Mwf|Sla)\b/g, (m) => m.toUpperCase())

function proposalId(kind: string, writes: ProposalWrite[], extra = ''): string {
  return createHash('sha1')
    .update(`${kind}|${JSON.stringify(writes)}|${extra}`)
    .digest('hex')
    .slice(0, 16)
}

interface FieldMeta {
  field: string
  label: string
  type: string | null
  interface: string | null
  options: Record<string, unknown> | null
  validation_rules: ValidationRule[] | null
  cross_record_defaults: Record<string, unknown> | null
  related: string | null
}

async function fieldMetaFor(collection: string): Promise<Map<string, FieldMeta>> {
  const [fields, rels] = await Promise.all([
    db('nivaro_fields')
      .where({ collection })
      .select(
        'field',
        'label',
        'type',
        'interface',
        'options',
        'validation_rules',
        'cross_record_defaults'
      ) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_relations')
      .where({ many_collection: collection })
      .whereNull('junction_field')
      .whereNotNull('one_collection')
      .select('many_field', 'one_collection') as Promise<
      Array<{ many_field: string; one_collection: string }>
    >
  ])
  const out = new Map<string, FieldMeta>()
  for (const f of fields) {
    const field = String(f.field)
    out.set(field, {
      field,
      label: (f.label as string | null) || titleCase(field),
      type: (f.type as string | null) ?? null,
      interface: (f.interface as string | null) ?? null,
      options: parseJson<Record<string, unknown>>(f.options),
      validation_rules: parseJson<ValidationRule[]>(f.validation_rules),
      cross_record_defaults: parseJson<Record<string, unknown>>(f.cross_record_defaults),
      related: rels.find((r) => r.many_field === field)?.one_collection ?? null
    })
  }
  for (const r of rels) {
    if (!out.has(r.many_field)) {
      out.set(r.many_field, {
        field: r.many_field,
        label: titleCase(r.many_field),
        type: null,
        interface: null,
        options: null,
        validation_rules: null,
        cross_record_defaults: null,
        related: r.one_collection
      })
    }
  }
  return out
}

/** Human value for a preview: FK ids become labels, currency-ish fields get $. */
async function labelize(
  collection: string,
  meta: Map<string, FieldMeta>,
  field: string,
  value: unknown
): Promise<string> {
  if (isEmpty(value)) return 'empty'
  const m = meta.get(field)
  if (m?.related) {
    const labels = await getLabels(new Map([[m.related, new Set([String(value)])]])).catch(
      () => ({}) as Record<string, string>
    )
    return labels[`${m.related}:${String(value)}`] ?? `#${String(value)}`
  }
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(n) && String(value).trim() !== '' && typeof value !== 'boolean') {
    const currency = m?.options?.format === 'currency' || /price|amount|cost|total/i.test(field)
    return currency
      ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
      : n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  }
  void collection
  return String(value)
}

async function previewFor(
  collection: string,
  itemId: string | null,
  meta: Map<string, FieldMeta>,
  row: Record<string, unknown>,
  patch: Record<string, unknown>
): Promise<ProposalPreview[]> {
  const out: ProposalPreview[] = []
  for (const [field, to] of Object.entries(patch)) {
    out.push({
      collection,
      item_id: itemId,
      field,
      label: meta.get(field)?.label ?? titleCase(field),
      from: await labelize(collection, meta, field, row[field]),
      to: await labelize(collection, meta, field, to)
    })
  }
  return out
}

/** Newest revision that wrote a NON-EMPTY value to `field`, with who/when. */
async function lastNonEmptyRevision(
  collection: string,
  itemId: string,
  field: string
): Promise<{ value: unknown; who: string; when: Date | null } | null> {
  const rows = (await db('nivaro_revisions as r')
    .leftJoin('nivaro_activity as a', 'a.id', 'r.activity')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .where({ 'r.collection': collection, 'r.item': String(itemId) })
    .whereRaw(`r.delta LIKE ?`, [`%"${field}"%`])
    .orderBy('r.id', 'desc')
    .limit(20)
    .select('r.delta', 'a.timestamp', 'a.comment', 'u.first_name', 'u.last_name')
    .catch(() => [])) as Array<Record<string, unknown>>
  for (const r of rows) {
    const delta = parseJson<Record<string, unknown>>(r.delta)
    if (!delta || !(field in delta) || isEmpty(delta[field])) continue
    const who =
      [r.first_name, r.last_name].filter(Boolean).join(' ') ||
      (typeof r.comment === 'string' && r.comment.startsWith('import:') ? 'an import' : 'someone')
    return {
      value: delta[field],
      who,
      when: r.timestamp ? new Date(String(r.timestamp)) : null
    }
  }
  return null
}

/** Who last changed `field` (any value) — for "the parent was changed by…". */
async function lastTouch(
  collection: string,
  itemId: string,
  field: string
): Promise<{ who: string; when: Date | null } | null> {
  const r = (await db('nivaro_revisions as r')
    .leftJoin('nivaro_activity as a', 'a.id', 'r.activity')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .where({ 'r.collection': collection, 'r.item': String(itemId) })
    .whereRaw(`r.delta LIKE ?`, [`%"${field}"%`])
    .orderBy('r.id', 'desc')
    .first('a.timestamp', 'a.comment', 'u.first_name', 'u.last_name')
    .catch(() => undefined)) as Record<string, unknown> | undefined
  if (!r) return null
  const who =
    [r.first_name, r.last_name].filter(Boolean).join(' ') ||
    (typeof r.comment === 'string' && r.comment.startsWith('import:') ? 'an import' : 'someone')
  return { who, when: r.timestamp ? new Date(String(r.timestamp)) : null }
}

const fmtWhen = (d: Date | null) => (d ? ` on ${d.toLocaleDateString('en-US')}` : '')

// ─── cascade options ────────────────────────────────────────────────────────

interface CascadeOptions {
  target: string
  /** Options available under the CURRENT parent value(s). */
  options: Array<{ id: string; label: string }>
  /** Parent label + value label(s) that narrowed the list. */
  parentDesc: string
  rules: CascadeCheck[]
}

async function cascadeOptionsFor(
  collection: string,
  row: Record<string, unknown>,
  field: string
): Promise<CascadeOptions | null> {
  const checks = await compileChecks(collection)
  const rules = checks.cascades.filter((c) => c.field === field)
  if (rules.length === 0) return null
  let allowed = null as Set<string> | null
  const parentBits: string[] = []
  for (const c of rules) {
    let parents: string[] = []
    if (c.parentIsM2M && c.parentJunction) {
      parents = (
        (await db(c.parentJunction.table)
          .where(c.parentJunction.srcFk, String(row.id))
          .select(c.parentJunction.tgtFk)) as Array<Record<string, unknown>>
      ).map((l) => String(l[c.parentJunction?.tgtFk ?? '']))
    } else if (!isEmpty(row[c.parent_field])) {
      parents = [String(row[c.parent_field])]
    }
    if (parents.length === 0) continue
    let ids: string[]
    if (c.filterIsM2M && c.filterJunction) {
      ids = (
        (await db(c.filterJunction.table)
          .whereIn(c.filterJunction.tgtFk, parents)
          .select(c.filterJunction.srcFk)) as Array<Record<string, unknown>>
      ).map((l) => String(l[c.filterJunction?.srcFk ?? '']))
    } else {
      ids = (
        (await db(c.target).whereIn(c.filter_column, parents).limit(500).select('id')) as Array<{
          id: unknown
        }>
      ).map((t) => String(t.id))
    }
    const set = new Set<string>(ids)
    const prev: Set<string> | null = allowed
    allowed = prev ? new Set<string>([...prev].filter((i) => set.has(i))) : set
    const pc = await targetOfParent(collection, c)
    const parentLabels = pc
      ? await getLabels(new Map([[pc, new Set(parents)]])).catch(
          () => ({}) as Record<string, string>
        )
      : {}
    const parentValueLabels = parents.map((p) => parentLabels[`${pc}:${p}`] ?? p)
    parentBits.push(`${c.parentLabel} ${parentValueLabels.join(', ')}`)
  }
  if (!allowed) return null
  const target = rules[0].target
  const ids = [...allowed].slice(0, 200)
  const labels = await getLabels(new Map([[target, new Set(ids)]])).catch(
    () => ({}) as Record<string, string>
  )
  const options = ids
    .map((id) => ({ id, label: labels[`${target}:${id}`] ?? `#${id}` }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return { target, options, parentDesc: parentBits.join(' · '), rules }
}

/** Collection the cascade's parent field points at (for labelling parent values). */
async function targetOfParent(collection: string, c: CascadeCheck): Promise<string> {
  if (c.parentIsM2M && c.parentJunction) {
    const rel = (await db('nivaro_relations')
      .where({ many_collection: c.parentJunction.table, many_field: c.parentJunction.tgtFk })
      .first('one_collection')) as { one_collection: string } | undefined
    return rel?.one_collection ?? ''
  }
  const rel = (await db('nivaro_relations')
    .where({ many_collection: collection, many_field: c.parent_field })
    .whereNull('junction_field')
    .first('one_collection')) as { one_collection: string } | undefined
  return rel?.one_collection ?? ''
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// ─── owner / notify ─────────────────────────────────────────────────────────

async function ownerFor(
  collection: string,
  itemId: string,
  row: Record<string, unknown>
): Promise<{ user_id: string; name: string } | null> {
  try {
    const instance = (await db('nivaro_workflow_instances')
      .where({ collection, item: String(itemId) })
      .orderBy('started_at', 'desc')
      .first('id', 'current_state')) as { id: string; current_state: string | null } | undefined
    if (instance?.current_state) {
      const owners = await resolveStateOwners(
        instance.current_state,
        instance.id,
        collection,
        itemId
      )
      const o = owners[0]
      if (o)
        return {
          user_id: o.id,
          name: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
        }
    }
  } catch {
    /* no pipeline — fall through to the creator */
  }
  for (const col of ['user_created', 'creator', 'created_by']) {
    const v = row[col]
    if (typeof v === 'string' && v.length >= 32) {
      const u = (await db('nivaro_users')
        .where({ id: v })
        .first('id', 'first_name', 'last_name', 'email', 'status')) as
        | {
            id: string
            first_name: string | null
            last_name: string | null
            email: string
            status: string
          }
        | undefined
      if (u && u.status !== 'suspended')
        return {
          user_id: u.id,
          name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
        }
    }
  }
  return null
}

function notifyProposal(
  owner: { user_id: string; name: string } | null,
  finding: FindingRef
): Proposal | null {
  if (!owner) return null
  const writes: ProposalWrite[] = []
  return {
    id: proposalId('notify', writes, `${owner.user_id}|${finding.field}|${finding.rule}`),
    kind: 'notify',
    label: `Ask ${owner.name} to resolve it`,
    basis:
      'Creates a task on this record for its current owner with the finding text — for when nothing here can be derived.',
    confidence: 'low',
    writes,
    preview: [],
    notify: owner
  }
}

// ─── per-rule generators ────────────────────────────────────────────────────

async function cascadeProposals(
  collection: string,
  row: Record<string, unknown>,
  meta: Map<string, FieldMeta>,
  finding: FindingRef
): Promise<Proposal[]> {
  const out: Proposal[] = []
  const field = finding.field
  const fieldLabel = meta.get(field)?.label ?? titleCase(field)
  const opts = await cascadeOptionsFor(collection, row, field)
  const itemId = String(row.id)
  if (opts) {
    const current = row[field]
    const currentLabel = await labelize(collection, meta, field, current)
    if (opts.options.length === 1) {
      const o = opts.options[0]
      if (String(o.id) !== String(current ?? '')) {
        const patch = { [field]: o.id }
        const writes: ProposalWrite[] = [{ op: 'update', collection, item_id: itemId, data: patch }]
        out.push({
          id: proposalId('set', writes),
          kind: 'set',
          label: `Set ${fieldLabel} → ${o.label}`,
          basis: `The only option under ${opts.parentDesc}.`,
          confidence: 'high',
          writes,
          preview: await previewFor(collection, itemId, meta, row, patch)
        })
      }
    }
    // Same-name equivalent under the current parent (a sub type re-parented).
    if (!isEmpty(current)) {
      const cn = norm(currentLabel)
      const twin = opts.options.find(
        (o) =>
          String(o.id) !== String(current) &&
          (norm(o.label) === cn || (cn.length > 3 && norm(o.label).includes(cn)))
      )
      if (twin) {
        const patch = { [field]: twin.id }
        const writes: ProposalWrite[] = [{ op: 'update', collection, item_id: itemId, data: patch }]
        out.push({
          id: proposalId('replace', writes),
          kind: 'replace',
          label: `Replace with the equivalent "${twin.label}"`,
          basis: `Same name as the current value, but available under ${opts.parentDesc}.`,
          confidence: 'medium',
          writes,
          preview: await previewFor(collection, itemId, meta, row, patch)
        })
      }
    }
    // Flip the parent instead: which single parent value would make the
    // current child valid?
    const c = opts.rules[0]
    if (!isEmpty(current) && opts.rules.length === 1 && !c.parentIsM2M) {
      let parentIds: string[] = []
      if (c.filterIsM2M && c.filterJunction) {
        parentIds = (
          (await db(c.filterJunction.table)
            .where(c.filterJunction.srcFk, String(current))
            .select(c.filterJunction.tgtFk)) as Array<Record<string, unknown>>
        ).map((l) => String(l[c.filterJunction?.tgtFk ?? '']))
      } else {
        const t = (await db(c.target)
          .where({ id: String(current) })
          .first(c.filter_column)
          .catch(() => undefined)) as Record<string, unknown> | undefined
        if (t && !isEmpty(t[c.filter_column])) parentIds = [String(t[c.filter_column])]
      }
      const distinct = [...new Set(parentIds)]
      if (distinct.length === 1 && String(row[c.parent_field] ?? '') !== distinct[0]) {
        const patch = { [c.parent_field]: distinct[0] }
        const writes: ProposalWrite[] = [{ op: 'update', collection, item_id: itemId, data: patch }]
        const touch = await lastTouch(collection, itemId, c.parent_field)
        const pv = await previewFor(collection, itemId, meta, row, patch)
        out.push({
          id: proposalId('set-parent', writes),
          kind: 'set-parent',
          label: `Keep ${fieldLabel}, set ${c.parentLabel} → ${pv[0]?.to ?? distinct[0]}`,
          basis: `"${currentLabel}" belongs to that ${c.parentLabel}${touch ? ` — ${c.parentLabel} was last changed by ${touch.who}${fmtWhen(touch.when)}` : ''}.`,
          confidence: touch ? 'medium' : 'low',
          writes,
          preview: pv
        })
      }
    }
    if (opts.options.length > 1) {
      out.push({
        id: proposalId('pick', [], `${field}|${itemId}`),
        kind: 'pick',
        label: `Choose a ${fieldLabel} available under ${opts.parentDesc}`,
        basis: `${opts.options.length} options qualify.`,
        confidence: 'medium',
        writes: [],
        preview: [],
        choices: opts.options.slice(0, 50),
        pick: { collection, item_id: itemId, field }
      })
    }
  }
  if (!isEmpty(row[field])) {
    const patch = { [field]: null }
    const writes: ProposalWrite[] = [{ op: 'update', collection, item_id: itemId, data: patch }]
    out.push({
      id: proposalId('clear', writes),
      kind: 'clear',
      label: `Clear ${fieldLabel}`,
      basis:
        'The value is no longer an available option; leave it empty for someone to pick again.',
      confidence: 'low',
      writes,
      preview: await previewFor(collection, itemId, meta, row, patch)
    })
  }
  return out
}

/** Value inferred from the record's links: every related record that points
 *  at the target collection agrees on ONE value. */
async function inferFromLinks(
  row: Record<string, unknown>,
  meta: Map<string, FieldMeta>,
  target: string
): Promise<{ value: string; via: string } | null> {
  const candidates = new Map<string, Set<string>>() // value → via labels
  for (const m of meta.values()) {
    if (!m.related || isEmpty(row[m.field]) || m.related === target) continue
    const R = m.related
    const rid = String(row[m.field])
    // R has an M2O column pointing at target
    const m2o = (await db('nivaro_relations')
      .where({ many_collection: R, one_collection: target })
      .whereNull('junction_field')
      .select('many_field')) as Array<{ many_field: string }>
    if (m2o.length > 0) {
      const rrow = (await db(R)
        .where({ id: rid })
        .first(...m2o.map((x) => x.many_field))
        .catch(() => undefined)) as Record<string, unknown> | undefined
      for (const x of m2o) {
        const v = rrow?.[x.many_field]
        if (isEmpty(v)) continue
        const k = String(v)
        if (!candidates.has(k)) candidates.set(k, new Set())
        candidates.get(k)?.add(m.label)
      }
    }
    // R ⇄ target junction
    const legsR = (await db('nivaro_relations')
      .where({ one_collection: R })
      .whereNotNull('junction_field')
      .select('many_collection', 'many_field', 'junction_field')) as Array<{
      many_collection: string
      many_field: string
      junction_field: string
    }>
    for (const leg of legsR) {
      const companion = (await db('nivaro_relations')
        .where({
          many_collection: leg.many_collection,
          many_field: leg.junction_field,
          one_collection: target
        })
        .first('id')) as { id: number } | undefined
      if (!companion) continue
      const links = (await db(leg.many_collection)
        .where(leg.many_field, rid)
        .limit(50)
        .select(leg.junction_field)
        .catch(() => [])) as Array<Record<string, unknown>>
      for (const l of links) {
        const v = l[leg.junction_field]
        if (isEmpty(v)) continue
        const k = String(v)
        if (!candidates.has(k)) candidates.set(k, new Set())
        candidates.get(k)?.add(m.label)
      }
    }
  }
  if (candidates.size !== 1) return null
  const [value, via] = [...candidates.entries()][0]
  return { value, via: [...via].join(', ') }
}

async function requiredProposals(
  collection: string,
  row: Record<string, unknown>,
  meta: Map<string, FieldMeta>,
  finding: FindingRef
): Promise<Proposal[]> {
  const out: Proposal[] = []
  const field = finding.field
  const itemId = String(row.id)
  const m = meta.get(field)
  const fieldLabel = m?.label ?? titleCase(field)

  // Is the field an M2M alias (finding "has no linked records")?
  const alias = (await db('nivaro_relations')
    .where({ one_collection: collection, one_field: field })
    .whereNotNull('junction_field')
    .first('many_collection', 'many_field', 'junction_field')) as
    | { many_collection: string; many_field: string; junction_field: string }
    | undefined
  let aliasTarget: string | null = null
  if (alias) {
    const companion = (await db('nivaro_relations')
      .where({ many_collection: alias.many_collection, many_field: alias.junction_field })
      .first('one_collection')) as { one_collection: string | null } | undefined
    aliasTarget = companion?.one_collection ?? null
  }
  const target = alias ? aliasTarget : (m?.related ?? null)

  const pushSet = async (
    value: unknown,
    basis: string,
    confidence: Proposal['confidence'],
    kind: ProposalKind = 'set'
  ) => {
    if (alias) {
      const writes: ProposalWrite[] = [
        {
          op: 'create',
          collection: alias.many_collection,
          data: { [alias.many_field]: itemId, [alias.junction_field]: value }
        }
      ]
      const lbl = target
        ? ((
            await getLabels(new Map([[target, new Set([String(value)])]])).catch(
              () => ({}) as Record<string, string>
            )
          )[`${target}:${String(value)}`] ?? `#${String(value)}`)
        : String(value)
      out.push({
        id: proposalId(kind, writes),
        kind,
        label: `Link ${fieldLabel} → ${lbl}`,
        basis,
        confidence,
        writes,
        preview: [
          { collection, item_id: itemId, field, label: fieldLabel, from: 'no links', to: lbl }
        ]
      })
      return
    }
    const patch = { [field]: value }
    const writes: ProposalWrite[] = [{ op: 'update', collection, item_id: itemId, data: patch }]
    const pv = await previewFor(collection, itemId, meta, row, patch)
    out.push({
      id: proposalId(kind, writes),
      kind,
      label: `${kind === 'restore' ? 'Restore' : 'Set'} ${fieldLabel} → ${pv[0]?.to ?? String(value)}`,
      basis,
      confidence,
      writes,
      preview: pv
    })
  }

  // 1. cross_record_defaults — copy from a linked record the config names.
  for (const src of meta.values()) {
    const cfg = src.cross_record_defaults as {
      source_collection?: string
      source_fk_field?: string
      field_map?: Record<string, string>
    } | null
    if (!cfg?.field_map || !cfg.source_collection) continue
    const sourceExpr = cfg.field_map[field]
    if (!sourceExpr) continue
    const fk = cfg.source_fk_field ?? src.field
    const fkVal = row[fk]
    if (isEmpty(fkVal) || !IDENT.test(cfg.source_collection)) continue
    const srow = (await db(cfg.source_collection)
      .where({ id: String(fkVal) })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (!srow) continue
    const v = sourceExpr
      .split('||')
      .map((s) => s.trim())
      .map((s) => (s === 'id' ? srow.id : srow[s]))
      .find((x) => !isEmpty(x))
    if (isEmpty(v)) continue
    await pushSet(
      v,
      `Copied from the linked ${meta.get(fk)?.label ?? titleCase(fk)} — the same rule the form applies when that link is picked.`,
      'high'
    )
  }

  // 2. Layout default value.
  const layout = (await db('nivaro_collection_layouts')
    .where({ collection, layout_type: 'grouped', is_active: true })
    .first('default_values')) as { default_values: unknown } | undefined
  const defaults = parseJson<Record<string, unknown>>(layout?.default_values)
  if (defaults && !isEmpty(defaults[field]) && !alias) {
    await pushSet(defaults[field], 'The default the active layout stamps on new records.', 'medium')
  }

  // 3. History — the value it held before something blanked it.
  if (!alias) {
    const prev = await lastNonEmptyRevision(collection, itemId, field)
    if (prev) {
      await pushSet(
        prev.value,
        `Held this value until ${prev.who} changed it${fmtWhen(prev.when)}.`,
        'medium',
        'restore'
      )
    }
  }

  // 4. Inferred from the record's links (project → its one region, POs → one vendor).
  if (target) {
    const inf = await inferFromLinks(row, meta, target)
    if (inf && !out.some((p) => JSON.stringify(p.writes).includes(`"${inf.value}"`))) {
      await pushSet(inf.value, `Every linked record agrees: via ${inf.via}.`, 'medium')
    }
  }

  // 5. Pick from the options the form would offer (cascade-narrowed when configured).
  if (target && IDENT.test(target)) {
    const casc = alias ? null : await cascadeOptionsFor(collection, row, field)
    let choices = casc?.options ?? null
    let basis = casc ? `${casc.options.length} options qualify under ${casc.parentDesc}.` : ''
    if (!choices) {
      const ids = (
        (await db(target)
          .orderBy('id')
          .limit(60)
          .select('id')
          .catch(() => [])) as Array<{ id: unknown }>
      ).map((r) => String(r.id))
      const labels = await getLabels(new Map([[target, new Set(ids)]])).catch(
        () => ({}) as Record<string, string>
      )
      choices = ids
        .map((id) => ({ id, label: labels[`${target}:${id}`] ?? `#${id}` }))
        .sort((a, b) => a.label.localeCompare(b.label))
      basis = `First ${choices.length} ${titleCase(target)} records.`
    }
    if (choices.length > 0) {
      out.push({
        id: proposalId('pick', [], `${field}|${itemId}`),
        kind: 'pick',
        label: `Choose a ${fieldLabel}`,
        basis,
        confidence: 'medium',
        writes: [],
        preview: [],
        choices: choices.slice(0, 50),
        pick: { collection, item_id: itemId, field }
      })
    }
  }
  return out
}

async function validationProposals(
  collection: string,
  row: Record<string, unknown>,
  meta: Map<string, FieldMeta>,
  finding: FindingRef
): Promise<Proposal[]> {
  const out: Proposal[] = []
  const field = finding.field
  const itemId = String(row.id)
  const m = meta.get(field)
  const rules = m?.validation_rules ?? []
  if (rules.length === 0) return out
  const fieldLabel = m?.label ?? titleCase(field)
  const current = row[field]
  const passes = (v: unknown) =>
    rules.every((r) => !applyValidationRule(r, v, fieldLabel, { ...row, [field]: v }))
  const candidates: Array<{ value: unknown; basis: string; kind: ProposalKind }> = []
  const created = row.date_created ?? row.created_at
  for (const r of rules) {
    const n = typeof current === 'number' ? current : Number(current)
    if (r.type === 'min' && Number.isFinite(Number(r.value)))
      candidates.push({
        value: Number(r.value),
        basis: `The rule's minimum (${r.value}).`,
        kind: 'set'
      })
    if (r.type === 'max' && Number.isFinite(Number(r.value)))
      candidates.push({
        value: Number(r.value),
        basis: `The rule's maximum (${r.value}).`,
        kind: 'set'
      })
    if (
      (r.type === 'min_days_from_today' || r.type === 'max_days_from_today') &&
      Number.isFinite(Number(r.value))
    ) {
      const base = created ? new Date(String(created)) : new Date()
      if (!Number.isNaN(base.getTime())) {
        const d = new Date(
          Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + Number(r.value))
        )
        candidates.push({
          value: d.toISOString().slice(0, 10),
          basis: `${r.value} day(s) from ${created ? "the record's creation date" : 'today'} — the rule's boundary.`,
          kind: 'set'
        })
      }
    }
    void n
  }
  if (typeof current === 'string') {
    const forms: Array<[string, string]> = [
      ['trimmed', current.trim()],
      ['upper-cased', current.trim().toUpperCase()],
      ['lower-cased', current.trim().toLowerCase()],
      ['without spaces', current.replace(/\s+/g, '')],
      ['letters, digits and dashes only', current.trim().replace(/[^A-Za-z0-9-]+/g, '')]
    ]
    for (const [how, v] of forms) {
      if (v !== current && v !== '')
        candidates.push({ value: v, basis: `The current value ${how}.`, kind: 'normalize' })
    }
  }
  const seen = new Set<string>()
  for (const c of candidates) {
    const key = String(c.value)
    if (seen.has(key) || key === String(current ?? '')) continue
    seen.add(key)
    if (!passes(c.value)) continue
    const patch = { [field]: c.value }
    const writes: ProposalWrite[] = [{ op: 'update', collection, item_id: itemId, data: patch }]
    const pv = await previewFor(collection, itemId, meta, row, patch)
    out.push({
      id: proposalId(c.kind, writes),
      kind: c.kind,
      label: `Set ${fieldLabel} → ${pv[0]?.to ?? key}`,
      basis: `${c.basis} Passes every rule on the field.`,
      confidence: 'medium',
      writes,
      preview: pv
    })
  }
  return out
}

/** Majority value of `field` among `rows`, when it dominates. */
function majority(
  rows: Array<Record<string, unknown>>,
  field: string,
  minRows: number,
  minShare: number
) {
  const counts = new Map<string, number>()
  let n = 0
  for (const r of rows) {
    const v = r[field]
    if (isEmpty(v)) continue
    n++
    counts.set(String(v), (counts.get(String(v)) ?? 0) + 1)
  }
  if (n < minRows) return null
  const [value, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (count / n < minShare) return null
  return { value, count, n }
}

async function rowInputProposals(
  collection: string,
  row: Record<string, unknown>,
  finding: FindingRef
): Promise<Proposal[]> {
  const out: Proposal[] = []
  const cfg = (await gridRuleConfigsFor(collection)).find((c) => c.aliasField === finding.field)
  if (!cfg) return out
  const childMeta = await fieldMetaFor(cfg.childCollection)
  const lines = (await db(cfg.childCollection)
    .where({ [cfg.fkField]: String(row.id) })
    .orderBy('id')
    .limit(200)) as Array<Record<string, unknown>>
  const parentContext = parentContextFrom(cfg, row)
  const cache = new RowRuleLookupCache(db)
  const lineName = (l: Record<string, unknown>) =>
    !isEmpty(l.line_number) ? `Line ${String(l.line_number)}` : `Line #${String(l.id)}`
  // Which triggers are empty on which lines (same rule the sweep applies).
  const triggers = [
    ...new Set(
      cfg.rowRules
        .filter(
          (r) =>
            r.trigger_field &&
            !r.trigger_field.startsWith('$parent.') &&
            r.target_type !== 'lock' &&
            (r.trigger_op ?? 'nnull') !== 'null'
        )
        .map((r) => r.trigger_field as string)
    )
  ]
  // Sibling FKs the majority inference may lean on: real inputs (CIFA), never
  // a field the rules DERIVE from the missing one — "lines with the same PO
  // line type" is circular when PO line type comes from the category.
  const ruleTargets = new Set(cfg.rowRules.filter((r) => !r.seed_only).map((r) => r.target_field))
  const siblingFks = [...childMeta.values()].filter(
    (m) => m.related && m.field !== cfg.fkField && !ruleTargets.has(m.field)
  )
  // The finding names ONE line ("Line 4: …") — propose for that line only;
  // the other lines have their own findings and their own Fix buttons.
  const named = (finding.message ?? '').match(/^Line (#?)(\S+):/)
  const targetLines = named
    ? lines.filter((l) =>
        named[1] === '#' ? String(l.id) === named[2] : String(l.line_number ?? '') === named[2]
      )
    : lines
  // Pick lists are per trigger field, not per line — build each once.
  const pickCache = new Map<string, Array<{ id: string; label: string }>>()
  for (const line of targetLines.length > 0 ? targetLines : lines) {
    for (const tf of triggers) {
      if (!isEmpty(line[tf])) continue
      const tm = childMeta.get(tf)
      const tLabel = tm?.label ?? titleCase(tf)
      const cands: Array<{ value: string; basis: string; confidence: Proposal['confidence'] }> = []
      // a. lines elsewhere sharing another FK (same CIFA → same category)
      const usable = siblingFks.filter((x) => x.field !== tf && !isEmpty(line[x.field]))
      const peerSets = await Promise.all(
        usable.map(
          (x) =>
            db(cfg.childCollection)
              .where(x.field, String(line[x.field]))
              .whereNotNull(tf)
              .orderBy('id', 'desc')
              .limit(200)
              .select(tf)
              .catch(() => []) as Promise<Array<Record<string, unknown>>>
        )
      )
      for (const [k, s] of usable.entries()) {
        const mj = majority(peerSets[k], tf, 2, 0.6)
        if (mj && !cands.some((c) => c.value === mj.value)) {
          cands.push({
            value: mj.value,
            basis: `${mj.count} of ${mj.n} lines with the same ${s.label} use it.`,
            confidence: mj.count >= 3 && mj.count / mj.n >= 0.9 ? 'high' : 'medium'
          })
        }
      }
      // b. this record's other lines
      const mj = majority(
        lines.filter((l) => l !== line),
        tf,
        3,
        0.8
      )
      if (mj && !cands.some((c) => c.value === mj.value)) {
        cands.push({
          value: mj.value,
          basis: `${mj.count} of this record's ${mj.n} other lines use it.`,
          confidence: 'medium'
        })
      }
      for (const c of cands.slice(0, 3)) {
        // Derive everything downstream once the input is set, in the same write.
        const seeded = { ...line, [tf]: c.value }
        const plan = await planRowRuleChanges({
          collection: cfg.childCollection,
          rows: [seeded],
          parentContext,
          rules: cfg.rowRules,
          mode: 'all',
          cache
        })
        const patch: Record<string, unknown> = { [tf]: c.value, ...(plan.changes[0]?.patch ?? {}) }
        const writes: ProposalWrite[] = [
          { op: 'update', collection: cfg.childCollection, item_id: String(line.id), data: patch }
        ]
        const pv = await previewFor(cfg.childCollection, String(line.id), childMeta, line, patch)
        out.push({
          id: proposalId('derive', writes),
          kind: 'derive',
          label: `${lineName(line)}: set ${tLabel} → ${pv[0]?.to ?? c.value}${Object.keys(patch).length > 1 ? ` and derive ${Object.keys(patch).length - 1} more` : ''}`,
          basis: c.basis,
          confidence: c.confidence,
          writes,
          preview: pv
        })
      }
      // c. pick
      if (tm?.related && IDENT.test(tm.related)) {
        let choices = pickCache.get(tf)
        if (!choices) {
          const ids = (
            (await db(tm.related)
              .orderBy('id')
              .limit(60)
              .select('id')
              .catch(() => [])) as Array<{
              id: unknown
            }>
          ).map((r) => String(r.id))
          const labels = await getLabels(new Map([[tm.related, new Set(ids)]])).catch(
            () => ({}) as Record<string, string>
          )
          choices = ids
            .map((id) => ({ id, label: labels[`${tm.related}:${id}`] ?? `#${id}` }))
            .sort((a, b) => a.label.localeCompare(b.label))
          pickCache.set(tf, choices)
        }
        if (choices.length) {
          out.push({
            id: proposalId('pick', [], `${tf}|${String(line.id)}`),
            kind: 'pick',
            label: `${lineName(line)}: choose a ${tLabel}`,
            basis: 'Then the rules derive the rest of the line.',
            confidence: 'medium',
            writes: [],
            preview: [],
            choices: choices.slice(0, 50),
            pick: {
              collection: cfg.childCollection,
              item_id: String(line.id),
              field: tf,
              rederive: true
            }
          })
        }
      }
    }
    if (out.length >= 40) break
  }
  return out
}

async function rowRuleProposals(
  collection: string,
  row: Record<string, unknown>,
  finding: FindingRef
): Promise<Proposal[]> {
  const cfg = (await gridRuleConfigsFor(collection)).find((c) => c.aliasField === finding.field)
  if (!cfg) return []
  const childMeta = await fieldMetaFor(cfg.childCollection)
  const lines = (await db(cfg.childCollection)
    .where({ [cfg.fkField]: String(row.id) })
    .orderBy('id')
    .limit(500)) as Array<Record<string, unknown>>
  const plan = await planRowRuleChanges({
    collection: cfg.childCollection,
    rows: lines,
    parentContext: parentContextFrom(cfg, row),
    rules: cfg.rowRules,
    mode: 'all'
  })
  if (plan.changes.length === 0) return []
  const writes: ProposalWrite[] = plan.changes.map((c) => ({
    op: 'update',
    collection: cfg.childCollection,
    item_id: c.id,
    data: c.patch
  }))
  const preview: ProposalPreview[] = []
  for (const c of plan.changes.slice(0, 20)) {
    const line = lines.find((l) => String(l.id) === c.id) ?? {}
    preview.push(...(await previewFor(cfg.childCollection, c.id, childMeta, line, c.patch)))
  }
  return [
    {
      id: proposalId('rederive', writes),
      kind: 'rederive',
      label: `Re-run the rules on ${plan.changes.length} line(s)`,
      basis:
        'The same pass as the grid\'s "re-run rules" — every target re-derived from the line\'s inputs; a rule deriving nothing never erases a value.',
      confidence: 'high',
      writes,
      preview
    }
  ]
}

async function displayProposals(
  collection: string,
  row: Record<string, unknown>,
  finding: FindingRef,
  meta: Map<string, FieldMeta>
): Promise<Proposal[]> {
  const { autoIdFieldsFor } = await import('./auto-ids.js')
  const cfg = (await autoIdFieldsFor(db, collection)).find((f) => f.field === finding.field)
  if (!cfg) return []
  return [
    {
      id: proposalId('regenerate', [], `${finding.field}|${String(row.id)}`),
      kind: 'regenerate',
      label: `Regenerate ${meta.get(finding.field)?.label ?? titleCase(finding.field)} from its pattern`,
      basis:
        'A fresh value from the id pattern (new sequence when empty, prefix recompute otherwise).',
      confidence: 'high',
      writes: [],
      preview: []
    }
  ]
}

// ─── public: propose ────────────────────────────────────────────────────────

export async function proposeFixes(
  collection: string,
  itemId: string,
  finding: FindingRef
): Promise<Proposal[]> {
  if (!IDENT.test(collection) || !IDENT.test(finding.field)) return []
  const row = (await db(collection)
    .where({ id: String(itemId) })
    .first()) as Record<string, unknown> | undefined
  if (!row) return []
  const meta = await fieldMetaFor(collection)
  let out: Proposal[] = []
  try {
    switch (finding.rule) {
      case 'cascade':
        out = await cascadeProposals(collection, row, meta, finding)
        break
      case 'required':
        out = await requiredProposals(collection, row, meta, finding)
        break
      case 'validation':
        out = await validationProposals(collection, row, meta, finding)
        break
      case 'row-input':
        out = await rowInputProposals(collection, row, finding)
        break
      case 'row-rule':
        out = await rowRuleProposals(collection, row, finding)
        break
      case 'display':
        out = await displayProposals(collection, row, finding, meta)
        break
      default:
        out = []
    }
  } catch (err) {
    console.warn(`integrity proposals failed for ${collection}/${itemId} ${finding.rule}:`, err)
  }
  const rank = { high: 0, medium: 1, low: 2 }
  out.sort((a, b) => rank[a.confidence] - rank[b.confidence])
  const owner = await ownerFor(collection, itemId, row).catch(() => null)
  const n = notifyProposal(owner, finding)
  if (n) out.push(n)
  return out
}

// ─── public: AI suggestion (opt-in, last resort) ────────────────────────────

export async function aiProposal(
  collection: string,
  itemId: string,
  finding: FindingRef
): Promise<Proposal | null> {
  const client = await getAiClient()
  if (!client) return null
  const row = (await db(collection)
    .where({ id: String(itemId) })
    .first()) as Record<string, unknown> | undefined
  if (!row) return null
  const meta = await fieldMetaFor(collection)
  // Candidates the model may choose from — it never invents a value.
  const base = await proposeFixes(collection, itemId, finding)
  const pick = base.find((p) => p.kind === 'pick')
  const choices = pick?.choices ?? []
  if (choices.length === 0 || !pick?.pick) return null
  const label = meta.get(finding.field)?.label ?? titleCase(finding.field)
  const context = Object.fromEntries(
    Object.entries(row)
      .filter(
        ([k, v]) => !isEmpty(v) && typeof v !== 'object' && !/^(id|password|token|secret)$/i.test(k)
      )
      .slice(0, 40)
      .map(([k, v]) => [meta.get(k)?.label ?? titleCase(k), String(v).slice(0, 120)])
  )
  // When the choice lands on a CHILD row (a workflow line's category), the
  // line's own values are what the model needs — the parent alone says
  // nothing about which line this is.
  let lineContext = ''
  if (pick.pick.collection !== collection) {
    const lineRow = (await db(pick.pick.collection)
      .where({ id: pick.pick.item_id })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (lineRow) {
      const lineMeta = await fieldMetaFor(pick.pick.collection)
      const entries: string[] = []
      for (const [k, v] of Object.entries(lineRow)) {
        if (isEmpty(v) || typeof v === 'object' || /^(id|password|token|secret)$/i.test(k)) continue
        const lbl = lineMeta.get(k)?.label ?? titleCase(k)
        entries.push(`${lbl}: ${await labelize(pick.pick.collection, lineMeta, k, v)}`)
        if (entries.length >= 25) break
      }
      lineContext = `\nThe field belongs to this line of the record (label: value):\n${entries.join('\n')}\n`
    }
  }
  const { model } = await getAiModelSettings()
  const prompt = `A record in collection "${collection}" has a data-integrity finding on the field "${label}": ${finding.message ?? finding.rule}.${lineContext}
Record values (label: value):
${JSON.stringify(context, null, 1)}

Choose the single best option for "${label}" from this list, or answer null if none is clearly right. Reply with JSON only: {"id": "<option id or null>", "reason": "<one sentence>"}.
Options:
${choices.map((c) => `${c.id}: ${c.label}`).join('\n')}`
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = msg.content.map((c) => ('text' in c ? c.text : '')).join('')
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) {
      console.warn('integrity AI proposal: no JSON in reply:', text.slice(0, 200))
      return null
    }
    const parsed = JSON.parse(m[0]) as { id?: string | null; reason?: string }
    if (!parsed.id) return null
    const choice = choices.find((c) => String(c.id) === String(parsed.id))
    if (!choice) return null
    const target = {
      collection: pick.pick.collection,
      item_id: pick.pick.item_id,
      field: pick.pick.field
    }
    const targetRow = (await db(target.collection).where({ id: target.item_id }).first()) as
      | Record<string, unknown>
      | undefined
    const targetMeta =
      target.collection === collection ? meta : await fieldMetaFor(target.collection)
    const patch = { [target.field]: choice.id }
    const writes: ProposalWrite[] = [
      { op: 'update', collection: target.collection, item_id: target.item_id, data: patch }
    ]
    return {
      id: proposalId('ai', writes),
      kind: 'ai',
      label: `AI suggestion: ${targetMeta.get(target.field)?.label ?? titleCase(target.field)} → ${choice.label}`,
      basis: `AI suggestion — ${String(parsed.reason ?? '').slice(0, 240) || 'no reason given'}. Verify before applying.`,
      confidence: 'low',
      writes,
      preview: await previewFor(
        target.collection,
        target.item_id,
        targetMeta,
        targetRow ?? {},
        patch
      )
    }
  } catch (err) {
    console.warn('integrity AI proposal failed:', err)
    return null
  }
}

// ─── public: apply ──────────────────────────────────────────────────────────

export interface ApplyResult {
  applied: number
  failed: Array<{ collection: string; item_id?: string; error: string }>
  /** Writes that reverse this apply (updates with the prior values, deletes for creates). */
  undo: ProposalWrite[]
  action: string
}

/** Resolve a 'pick' proposal into concrete writes for the chosen id. */
export async function materializePick(
  collection: string,
  proposal: Proposal,
  choice: string
): Promise<Proposal | null> {
  if (proposal.kind !== 'pick' || !proposal.pick) return null
  const ok = (proposal.choices ?? []).find((c) => String(c.id) === String(choice))
  if (!ok) return null
  const t = proposal.pick
  const patch: Record<string, unknown> = { [t.field]: ok.id }
  if (t.rederive && t.collection !== collection) {
    // Chosen input → derive the rest of the line in the same write.
    const cfg = (await gridRuleConfigsFor(collection)).find(
      (c) => c.childCollection === t.collection
    )
    const line = (await db(t.collection).where({ id: t.item_id }).first()) as
      | Record<string, unknown>
      | undefined
    const parentId = line?.[cfg?.fkField ?? '']
    const parent =
      cfg && parentId != null
        ? ((await db(collection)
            .where({ id: String(parentId) })
            .first()) as Record<string, unknown> | undefined)
        : undefined
    if (cfg && line) {
      const plan = await planRowRuleChanges({
        collection: t.collection,
        rows: [{ ...line, ...patch }],
        parentContext: parentContextFrom(cfg, parent),
        rules: cfg.rowRules,
        mode: 'all'
      })
      Object.assign(patch, plan.changes[0]?.patch ?? {})
    }
  }
  const writes: ProposalWrite[] = [
    { op: 'update', collection: t.collection, item_id: t.item_id, data: patch }
  ]
  return {
    ...proposal,
    kind: 'set',
    label: `Set ${titleCase(t.field)} → ${ok.label}`,
    writes,
    id: proposalId('set', writes)
  }
}

export async function applyProposal(
  app: FastifyInstance,
  user: User,
  collection: string,
  itemId: string,
  proposal: Proposal,
  finding: FindingRef,
  req?: FastifyRequest
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, failed: [], undo: [], action: proposal.kind }
  if (proposal.kind === 'notify' && proposal.notify) {
    const title =
      `Data integrity: ${finding.message ?? `${finding.field} (${finding.rule})`}`.slice(0, 500)
    const [task] = (await db('nivaro_tasks')
      .insert({
        collection,
        item: String(itemId),
        title,
        description: `Raised from the record's integrity banner by ${[user.first_name, user.last_name].filter(Boolean).join(' ') || user.email}. Nothing on the record could derive a value — please resolve it.`,
        assignee: proposal.notify.user_id,
        created_by: user.id,
        status: 'open'
      })
      .returning('id')) as Array<{ id: number } | number>
    void task
    await notifyUser(app, proposal.notify.user_id, {
      subject: 'A data-integrity issue needs your input',
      category: 'system',
      message: title,
      collection,
      item: String(itemId),
      sender: user.id
    }).catch(() => {})
    result.applied = 1
    await logActivity({
      action: 'integrity-fix',
      user: user.id,
      collection,
      item: String(itemId),
      comment: `routed to ${proposal.notify.name}: ${finding.field}`,
      req
    })
    return result
  }
  for (const w of proposal.writes) {
    if (!IDENT.test(w.collection)) {
      result.failed.push({ collection: w.collection, error: 'invalid collection' })
      continue
    }
    try {
      if (w.op === 'update' && w.item_id && w.data) {
        const before = (await db(w.collection)
          .where({ id: w.item_id })
          .first(...Object.keys(w.data))) as Record<string, unknown> | undefined
        await updateOne(user, w.collection, w.item_id, { ...w.data }, req)
        result.undo.push({
          op: 'update',
          collection: w.collection,
          item_id: w.item_id,
          data: Object.fromEntries(Object.keys(w.data).map((k) => [k, before?.[k] ?? null]))
        })
        result.applied++
      } else if (w.op === 'create' && w.data) {
        const created = (await createOne(user, w.collection, { ...w.data }, req)) as
          | Record<string, unknown>
          | undefined
        if (created?.id != null)
          result.undo.push({ op: 'delete', collection: w.collection, item_id: String(created.id) })
        result.applied++
      } else if (w.op === 'delete' && w.item_id) {
        await deleteOne(user, w.collection, w.item_id, req)
        result.applied++
      }
    } catch (err) {
      const e = err as { message?: string; code?: string }
      result.failed.push({
        collection: w.collection,
        item_id: w.item_id,
        error: e.code ? `${e.code}: ${e.message ?? ''}` : (e.message ?? 'failed')
      })
    }
  }
  await logActivity({
    action: 'integrity-fix',
    user: user.id,
    collection,
    item: String(itemId),
    comment: `${proposal.kind}: ${proposal.label} (${result.applied} write(s)${result.failed.length ? `, ${result.failed.length} failed` : ''})`,
    req
  })
  return result
}

/** Undo = apply the reverse writes a previous apply returned. Each write
 *  still goes through the items service as the caller. */
export async function applyUndo(
  user: User,
  writes: ProposalWrite[],
  req?: FastifyRequest
): Promise<ApplyResult> {
  const p: Proposal = {
    id: 'undo',
    kind: 'set',
    label: 'Undo',
    basis: '',
    confidence: 'high',
    writes,
    preview: []
  }
  const collection = writes[0]?.collection ?? ''
  const itemId = writes[0]?.item_id ?? ''
  return applyProposal(
    undefined as unknown as FastifyInstance,
    user,
    collection,
    itemId,
    p,
    { field: '', rule: 'undo' },
    req
  )
}

/** The kinds a bulk "apply confident fixes" run may execute unattended. */
export const AUTO_APPLY_KINDS: ProposalKind[] = [
  'set',
  'replace',
  'derive',
  'rederive',
  'regenerate'
]

export type { GridRuleConfig }
