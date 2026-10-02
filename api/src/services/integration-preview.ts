/**
 * What the record form says BEFORE anything is sent to a partner system.
 *
 *   #615 outboundPreview — per integration: what the next push would change
 *        compared with the payload the partner last received, and which
 *        transitions out of the current state would send it (and when:
 *        every time, or only when what it watches moved — push_when).
 *   #616 transitionPreflight — would pressing this transition go through,
 *        and would its pushes carry what the partner needs: requirement gaps
 *        per line ("2 lines missing Sales order"), a failing condition, a
 *        push guard that would skip, a template that cannot render, a
 *        contract path left empty.
 *
 * Read-only by construction: it reuses the gate/guard/render path of the
 * real run (workflow-actions previewErpActions) without the send, the
 * writebacks, the journal or the obligation ledger.
 */
import { db } from '../db/index.js'
import {
  describePushWhen,
  diffPayloads,
  humanizePayloadKey,
  type PayloadChange,
  summarizePayloadChanges
} from './erp-push-gate.js'
import { isSensitiveKey, MASK } from './secret-mask.js'
import {
  evaluateTransitionRequirements,
  type RequirementBlockResult,
  type TransitionRequirementBlock
} from './transition-requirements.js'
import { type ErpActionPreview, previewErpActions } from './workflow-actions.js'
import {
  evaluateConditionRules,
  fetchRecordForConditions,
  parseConditionRules
} from './workflow-conditions.js'

interface InstanceRow {
  id: string
  template: string
  current_state: string | null
  completed_at: Date | string | null
}
interface TransitionRow {
  id: string
  label: string
  from_state: string | null
  to_state: string
  actions: string | null
  auto_trigger: boolean | number | null
  condition_rules: string | null
  requirements: string | null
  sort: number | null
}
interface StateRow {
  id: string
  key: string
  label: string
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1'

async function loadInstance(collection: string, item: string) {
  const rows = (await db('nivaro_workflow_instances')
    .where({ collection, item: String(item) })
    .orderBy('started_at', 'desc')
    .select('id', 'template', 'current_state', 'completed_at')) as InstanceRow[]
  return rows.find((r) => !r.completed_at) ?? rows[0] ?? null
}

async function apiNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const want = [...new Set(ids.filter((n) => Number.isFinite(n)))]
  if (want.length === 0) return out
  try {
    const rows = (await db('nivaro_external_apis').whereIn('id', want).select('id', 'name')) as
      | Array<{ id: number; name: string }>
      | []
    for (const r of rows) out.set(Number(r.id), String(r.name))
  } catch {
    /* names are decoration */
  }
  return out
}

function hasPushes(actions: string | null): boolean {
  if (!actions) return false
  try {
    const parsed = JSON.parse(actions)
    return Array.isArray(parsed) && parsed.some((a) => a && a.type === 'erp_submit')
  } catch {
    return false
  }
}

// ─── #615 ───────────────────────────────────────────────────────────────────

export interface OutboundTrigger {
  transition_id: string
  transition_label: string
  to_state_label: string | null
  auto: boolean
  /** Its condition rules hold for the record today. */
  available: boolean
  /** "Sent every time this transition runs" / "Sent when what it would send has changed". */
  when: string
  status: ErpActionPreview['status']
  reason: string | null
  /** Top-level payload keys this trigger's push would change. */
  changes: string[]
}

export interface OutboundIntegration {
  api_id: number
  api_name: string
  endpoint_path: string
  method: string
  /** Nothing has ever landed at this endpoint for the record. */
  first_push: boolean
  last: { submission_id: number; status: string; at: string } | null
  /** Humanized top-level keys of the primary trigger's changes — "State, PO number". */
  summary: string[]
  changes: Array<PayloadChange & { label: string }>
  truncated: boolean
  triggers: OutboundTrigger[]
}

export async function outboundPreview(
  collection: string,
  item: string,
  userId: string | null
): Promise<{ state: { key: string; label: string } | null; integrations: OutboundIntegration[] }> {
  const instance = await loadInstance(collection, item)
  if (!instance) return { state: null, integrations: [] }
  const [states, transitions] = await Promise.all([
    db('nivaro_workflow_states')
      .where({ template: instance.template })
      .select('id', 'key', 'label') as Promise<StateRow[]>,
    db('nivaro_workflow_transitions')
      .where({ template: instance.template })
      .orderBy('sort')
      .select(
        'id',
        'label',
        'from_state',
        'to_state',
        'actions',
        'auto_trigger',
        'condition_rules',
        'requirements',
        'sort'
      ) as Promise<TransitionRow[]>
  ])
  const stateById = new Map(states.map((s) => [String(s.id).toUpperCase(), s]))
  const current = instance.current_state
    ? (stateById.get(String(instance.current_state).toUpperCase()) ?? null)
    : null
  const cur = String(instance.current_state ?? '').toUpperCase()
  const outgoing = transitions.filter(
    (t) =>
      hasPushes(t.actions) &&
      (t.from_state === null || String(t.from_state).toUpperCase() === cur) &&
      (!instance.completed_at || String(t.from_state ?? '').toUpperCase() === cur)
  )
  if (outgoing.length === 0)
    return { state: current ? { key: current.key, label: current.label } : null, integrations: [] }

  const conditionRecord = await fetchRecordForConditions(
    collection,
    item,
    outgoing.map((t) => t.condition_rules)
  ).catch(() => ({}))

  interface Group {
    api_id: number
    endpoint_path: string
    method: string
    primary: ErpActionPreview | null
    primaryRank: number
    triggers: OutboundTrigger[]
    last: ErpActionPreview['last']
  }
  const groups = new Map<string, Group>()
  const cache = new Map<string, Promise<unknown>>()
  for (const t of outgoing) {
    const to = stateById.get(String(t.to_state).toUpperCase()) ?? null
    const previews = await previewErpActions({
      transition: { id: t.id, label: t.label, actions: t.actions },
      instance: { collection, item: String(item) },
      newStateObj: to ? { key: to.key, label: to.label } : null,
      userId,
      cache
    })
    const available = evaluateConditionRules(t.condition_rules, conditionRecord)
    for (const p of previews) {
      if (p.api_id == null || !p.endpoint_path) continue
      // Not this record's partner: the push would never apply here.
      if (p.status === 'not_applicable') continue
      const key = `${p.api_id}|${p.endpoint_path}`
      let g = groups.get(key)
      if (!g) {
        g = {
          api_id: p.api_id,
          endpoint_path: p.endpoint_path,
          method: p.method,
          primary: null,
          primaryRank: 99,
          triggers: [],
          last: p.last
        }
        groups.set(key, g)
      }
      const changes = p.body ? diffPayloads(p.last?.body ?? null, p.body) : []
      g.triggers.push({
        transition_id: t.id,
        transition_label: t.label,
        to_state_label: to?.label ?? null,
        auto: truthy(t.auto_trigger),
        available,
        when: describePushWhen(p.push_when),
        status: p.status,
        reason: p.reason,
        changes: summarizePayloadChanges(changes)
      })
      // The diff shown is the one the most likely next push would carry: a
      // person's available transition that would send, then an automatic
      // one, then anything that at least renders.
      const rank =
        p.body && available && p.status === 'would_push'
          ? truthy(t.auto_trigger)
            ? 1
            : 0
          : p.body
            ? 2
            : 3
      if (rank < g.primaryRank) {
        g.primary = p
        g.primaryRank = rank
      }
    }
  }
  const names = await apiNames([...groups.values()].map((g) => g.api_id))
  const integrations: OutboundIntegration[] = [...groups.values()].map((g) => {
    const all = g.primary?.body ? diffPayloads(g.last?.body ?? null, g.primary.body, 61) : []
    // A credential rendered into the payload (a partner token) is named as
    // changed, never shown.
    const changes = all.slice(0, 60).map((c) => {
      const secret = c.path
        .split(/[.[\]]/)
        .filter(Boolean)
        .some((seg) => isSensitiveKey(seg))
      return {
        ...c,
        from: secret && c.from != null ? MASK : c.from,
        to: secret && c.to != null ? MASK : c.to,
        label: humanizePayloadKey(c.top)
      }
    })
    return {
      api_id: g.api_id,
      api_name: names.get(g.api_id) ?? `API #${g.api_id}`,
      endpoint_path: g.endpoint_path,
      method: g.method,
      first_push: !g.last,
      last: g.last
        ? { submission_id: g.last.submission_id, status: g.last.status, at: g.last.at }
        : null,
      summary: summarizePayloadChanges(changes),
      changes,
      truncated: all.length > 60,
      triggers: g.triggers
    }
  })
  integrations.sort((a, b) => a.api_name.localeCompare(b.api_name))
  return { state: current ? { key: current.key, label: current.label } : null, integrations }
}

// ─── #616 ───────────────────────────────────────────────────────────────────

export interface PreflightIssue {
  /** 'block' stops the transition; 'warn' lets it through but a push will
   *  skip, fail or leave the partner without something; 'ask' is a value the
   *  step's own requirements dialog asks for when the button is pressed (REQ
   *  IDs on Fusion Submitted) — expected to be empty beforehand, never a
   *  problem. */
  severity: 'block' | 'warn' | 'ask'
  message: string
  /** Record field to bring into view. */
  field?: string
  /** Child rows to bring into view: the grid's collection + FK to the record. */
  collection?: string
  fk_field?: string
  rows?: Array<{ id: string; label: string }>
}

export interface PreflightResult {
  ready: boolean
  issues: PreflightIssue[]
  pushes: Array<{ api_name: string; status: ErpActionPreview['status']; reason: string | null }>
}

function isEmpty(v: unknown): boolean {
  return v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '')
}

/** Group a child_fields block's incomplete rows by the field they lack. These
 *  are what the transition's requirements dialog collects when the button is
 *  pressed, so they read as 'ask', never as something standing in the way. */
export function requirementIssues(blocks: TransitionRequirementBlock[]): PreflightIssue[] {
  const issues: PreflightIssue[] = []
  for (const b of blocks) {
    if (b.type === 'record_fields') {
      if (b.optional) continue
      for (const f of b.fields) {
        if (!isEmpty(b.values?.[f.field])) continue
        issues.push({ severity: 'ask', message: `Asks for ${f.label}`, field: f.field })
      }
      continue
    }
    const block = b as RequirementBlockResult
    const byField = new Map<string, Array<{ id: string; label: string }>>()
    for (const row of block.rows) {
      if (row.complete) continue
      for (const f of block.fields) {
        if (!isEmpty(row.values?.[f.field])) continue
        const rule = f.optional_when
        if (rule) {
          const ctl = row.values?.[rule.field] ?? row.display?.[rule.field]
          const vals = Array.isArray(ctl) ? ctl : [ctl]
          if (vals.some((v) => v != null && rule.in.map(String).includes(String(v)))) continue
        }
        const list = byField.get(f.field) ?? []
        list.push({ id: String(row.id), label: row.label })
        byField.set(f.field, list)
      }
    }
    for (const f of block.fields) {
      const rows = byField.get(f.field)
      if (!rows?.length) continue
      issues.push({
        severity: 'ask',
        message: `Asks for ${f.label} on ${rows.length} line${rows.length === 1 ? '' : 's'}`,
        collection: block.collection,
        fk_field: block.fk_field,
        rows
      })
    }
  }
  return issues
}

const OP_WORDS: Record<string, string> = {
  eq: 'must be',
  neq: 'must not be',
  in: 'must be one of',
  notin: 'must not be one of',
  gt: 'must be over',
  gte: 'must be at least',
  lt: 'must be under',
  lte: 'must be at most',
  contains: 'must contain'
}

/** A condition rule as a sentence: "Needs at least one workflow line item". */
export function describeCondition(rule: { field: string; op: string; value: unknown }): string {
  const op = String(rule.op ?? 'eq').toLowerCase()
  if (op === 'related_some' || op === 'related_none') {
    const child = humanizePayloadKey(rule.field.split(':')[0] ?? rule.field).toLowerCase()
    return op === 'related_some'
      ? `Needs at least one row in ${child}${rule.value ? ' that matches' : ''}`
      : `${child.charAt(0).toUpperCase()}${child.slice(1)} must have no ${rule.value ? 'matching ' : ''}rows`
  }
  const field = humanizePayloadKey(rule.field.replace(/\./g, ' '))
  if (op === 'nnull' || op === 'not_null') return `${field} must be filled in`
  if (op === 'null') return `${field} must be empty`
  if (op === 'within_days') return `${field} must be within ${rule.value} days`
  if (op === 'beyond_days') return `${field} must be more than ${rule.value} days out`
  return `${field} ${OP_WORDS[op] ?? op} ${rule.value ?? ''}`.trim()
}

function describeGuard(g: NonNullable<ErpActionPreview['guard_failed']>): string {
  const field = humanizePayloadKey(g.field)
  const op = g.op.toLowerCase()
  if (op === 'nnull' || op === 'not_null' || op === 'nempty') return `${field} is empty`
  if (op === 'null' || op === 'empty') return `${field} is already set`
  return `${field} is ${g.actual == null || g.actual === '' ? 'empty' : JSON.stringify(g.actual)} (needs ${op} ${JSON.stringify(g.value)})`
}

export async function transitionPreflight(
  collection: string,
  item: string,
  transitionId: string,
  userId: string | null
): Promise<PreflightResult | null> {
  const instance = await loadInstance(collection, item)
  if (!instance) return null
  const t = (await db('nivaro_workflow_transitions')
    .where({ id: transitionId, template: instance.template })
    .first(
      'id',
      'label',
      'from_state',
      'to_state',
      'actions',
      'auto_trigger',
      'condition_rules',
      'requirements',
      'sort'
    )) as TransitionRow | undefined
  if (!t) return null
  const issues: PreflightIssue[] = []
  // Record fields the requirements dialog collects on press: a push guard
  // waiting on one of them is satisfied by the dialog, not a blocker.
  const asked = new Set<string>()

  if (t.requirements) {
    const blocks = await evaluateTransitionRequirements(
      db,
      t.requirements,
      String(item),
      undefined,
      collection
    ).catch(() => null)
    if (blocks) {
      issues.push(...requirementIssues(blocks))
      for (const b of blocks) {
        if (b.type === 'record_fields') for (const f of b.fields) asked.add(f.field)
      }
    }
  }

  if (t.condition_rules) {
    const rules = parseConditionRules(t.condition_rules) ?? []
    const rec = await fetchRecordForConditions(collection, String(item), [t.condition_rules]).catch(
      () => ({}) as Record<string, unknown>
    )
    if (!evaluateConditionRules(t.condition_rules, rec)) {
      const unmet = rules.filter(
        (r) => r && typeof r.field === 'string' && !evaluateConditionRules(JSON.stringify([r]), rec)
      )
      issues.push({
        severity: 'block',
        message:
          unmet.length > 0
            ? unmet.map(describeCondition).join('; ')
            : 'The transition’s conditions are not met',
        field: unmet[0] && !unmet[0].field.includes(':') ? unmet[0].field.split('.')[0] : undefined
      })
    }
  }

  const to = t.to_state
    ? ((await db('nivaro_workflow_states').where({ id: t.to_state }).first('key', 'label')) as
        | { key: string; label: string }
        | undefined)
    : undefined
  const previews = await previewErpActions({
    transition: { id: t.id, label: t.label, actions: t.actions },
    instance: { collection, item: String(item) },
    newStateObj: to ?? null,
    userId
  })
  const names = await apiNames(previews.map((p) => p.api_id ?? Number.NaN))
  const pushes: PreflightResult['pushes'] = []
  for (const p of previews) {
    const name = p.api_id != null ? (names.get(p.api_id) ?? `API #${p.api_id}`) : 'A partner'
    pushes.push({ api_name: name, status: p.status, reason: p.reason })
    const later = p.after_earlier_writeback ? ' (an earlier push on this step may fill it)' : ''
    if (p.status === 'guard' && p.guard_failed && asked.has(p.guard_failed.field)) {
      issues.push({
        severity: 'ask',
        message: `${name} goes once ${humanizePayloadKey(p.guard_failed.field)} is entered in the dialog`,
        field: p.guard_failed.field
      })
    } else if (p.status === 'guard' && p.guard_failed) {
      issues.push({
        severity: p.blocking ? 'block' : 'warn',
        message: `${name} will not be sent: ${describeGuard(p.guard_failed)}${later}`,
        field: p.guard_failed.field.includes('.') ? undefined : p.guard_failed.field
      })
    } else if (p.status === 'template_error' || p.status === 'not_configured') {
      issues.push({
        severity: p.blocking ? 'block' : 'warn',
        message: `${name} cannot be built: ${p.reason ?? 'the push is misconfigured'}`
      })
    }
    if (p.contract_missing.length > 0) {
      issues.push({
        severity: 'warn',
        message: `${name} would receive no ${p.contract_missing.map(humanizePayloadKey).join(', ')}${later}`
      })
    }
  }
  return { ready: !issues.some((i) => i.severity === 'block'), issues, pushes }
}
