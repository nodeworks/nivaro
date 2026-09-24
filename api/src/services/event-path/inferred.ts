import { db } from '../../db/index.js'
import type { EventEntry } from '../integration-event-sources.js'
import { CALL_LOG_WINDOW_MS, gatherSubmissionFacts } from '../submission-detail.js'
import { iso } from './exact.js'
import { redactError, redactUrl } from './redact.js'
import type { PathStep } from './types.js'
import { inboundWindow, POLL_WINDOW_MS, PUSH_AFTER_MS } from './windows.js'

function ms(v: unknown): number {
  return Date.parse(iso(v))
}

/** "15 s" — reason text follows the window constant, never a literal. */
const PUSH_WINDOW_TEXT = `${Math.round(PUSH_AFTER_MS / 1000)} s`

function gap(a: unknown, b: unknown): string {
  const d = Math.abs(ms(a) - ms(b))
  return d < 1000 ? `${d} ms` : `${(d / 1000).toFixed(1)} s`
}

/**
 * Reconstruct a chain for an event from before migration 351 (no chain id) —
 * by the same windows the submission drill uses. Every step it matches by
 * clock is marked inferred and names why it was matched.
 */
export async function inferSteps(
  ev: EventEntry,
  opts: { withBodies: boolean } = { withBodies: false }
): Promise<{ rootStep: PathStep; steps: PathStep[]; warnings: string[] }> {
  const warnings: string[] = []
  const rootStep: PathStep = {
    key: `event:${ev.source}:${ev.id}`,
    parent: null,
    kind: ev.direction === 'in' ? 'request' : ev.direction === 'out' ? 'push' : 'feed',
    at: ev.created_at,
    who: ev.label,
    record:
      ev.collection && ev.item_id
        ? { collection: ev.collection, item: ev.item_id, label: ev.item_label ?? null }
        : null,
    summary: ev.text,
    failed: ev.status === 'error'
  }
  const steps: PathStep[] = []
  try {
    if (ev.source === 'core:inbound') {
      if (/^\d+$/.test(ev.id)) {
        const log = (await db('nivaro_api_logs')
          .where('id', ev.id)
          .first('user', 'created_at', 'latency_ms')) as Record<string, unknown> | undefined
        if (log?.user) {
          const w = inboundWindow(new Date(iso(log.created_at)), Number(log.latency_ms ?? 0))
          const acts = (await db('nivaro_activity')
            .where('user', String(log.user))
            .whereBetween('timestamp', [w.from, w.to])
            .whereIn('action', ['create', 'update', 'delete'])
            .select('id', 'action', 'collection', 'item', 'timestamp')
            .orderBy('id')
            .limit(500)) as Array<Record<string, unknown>>
          for (const a of acts) {
            steps.push(
              inferredWrite(a, `same account, ${gap(a.timestamp, log.created_at)} from the call`)
            )
          }
          await transitionsOn(steps, acts, w, log.created_at, warnings)
          await pushesAfter(steps, acts, warnings)
        }
      }
    } else if (ev.source === 'core:outbound') {
      if (/^\d+$/.test(ev.id)) await outboundSteps(Number(ev.id), rootStep, steps, warnings, opts)
    } else if (ev.collection && ev.item_id) {
      const t = Date.parse(ev.created_at)
      const acts = (await db('nivaro_activity')
        .where({ collection: ev.collection, item: ev.item_id })
        .whereIn('action', ['create', 'update', 'delete'])
        .whereBetween('timestamp', [new Date(t - POLL_WINDOW_MS), new Date(t + POLL_WINDOW_MS)])
        .select('id', 'action', 'collection', 'item', 'timestamp')
        .orderBy('id')
        .limit(200)) as Array<Record<string, unknown>>
      for (const a of acts) {
        steps.push(
          inferredWrite(a, `write on the record ${gap(a.timestamp, ev.created_at)} from the event`)
        )
      }
      await pushesAfter(steps, acts, warnings)
    }
  } catch (err) {
    warnings.push(`inference: ${String((err as Error)?.message ?? err).slice(0, 160)}`)
  }
  return { rootStep, steps, warnings }
}

/** An outbound push: the transition / edit that set it off, then its attempts. */
async function outboundSteps(
  id: number,
  rootStep: PathStep,
  steps: PathStep[],
  warnings: string[],
  opts: { withBodies: boolean }
): Promise<void> {
  const facts = await gatherSubmissionFacts(id)
  if (!facts) return
  const record = { collection: String(facts.row.collection), item: String(facts.row.item) }
  if (facts.history) {
    // FactHistory carries no row id — key the step by its moment.
    const t = facts.history.transition
    steps.push({
      key: `history:inferred:${ms(facts.history.timestamp)}`,
      parent: null,
      kind: 'transition',
      at: iso(facts.history.timestamp),
      record,
      summary: t?.label
        ? `${t.label} — the transition that set off this push`
        : 'Transition that set off this push',
      inferred: true,
      reason: `nearest transition on the record within ${PUSH_WINDOW_TEXT}`
    })
  }
  if (facts.record_edit) {
    const a = facts.record_edit
    steps.push({
      key: `activity:inferred:${ms(a.timestamp)}`,
      parent: null,
      kind: 'write',
      at: iso(a.timestamp),
      record,
      summary: a.action === 'create' ? 'created' : 'updated',
      inferred: true,
      reason: 'edit on the record just before the push'
    })
  }
  // FactAttempt carries no status — read the attempts themselves.
  const atts = (await db('nivaro_erp_submission_attempts')
    .where('submission_id', id)
    .orderBy('attempt', 'asc')
    .select('id', 'attempt', 'status', 'http_status', 'error', 'recorded_at')
    .catch((err: Error) => {
      warnings.push(`attempts: ${String(err?.message ?? err).slice(0, 160)}`)
      return []
    })) as Array<Record<string, unknown>>
  for (const a of atts) {
    steps.push({
      key: `attempt:${a.id}`,
      parent: rootStep.key,
      kind: 'attempt',
      at: iso(a.recorded_at),
      summary: `Attempt ${a.attempt} · ${a.status}${a.http_status ? ` · HTTP ${a.http_status}` : ''}`,
      failed: a.status === 'failed',
      reason: redactError(a.error, opts.withBodies)
    })
  }
  // The push's own partner calls — the submission drill's matching (a body
  // match is proof; otherwise the same endpoint within 10 s of an attempt).
  const apiId = facts.row.external_api != null ? Number(facts.row.external_api) : null
  for (const c of facts.call_logs) {
    const status = c.response_status != null ? Number(c.response_status) : null
    steps.push({
      key: `call:${c.id}`,
      parent: rootStep.key,
      kind: 'partner_call',
      at: iso(c.created_at),
      summary: `${facts.api?.name ?? 'Partner'} answered ${status ?? 'no response'}`,
      failed: status == null || status >= 400 || Boolean(c.error),
      api_id: apiId,
      inferred: true,
      reason: c.body_match
        ? 'request body matches the stored push'
        : `same partner endpoint within ${Math.round(CALL_LOG_WINDOW_MS / 1000)} s of an attempt`,
      detail: {
        type: 'call',
        method: String(c.method ?? ''),
        url: redactUrl(c.url, opts.withBodies),
        status,
        duration_ms: c.duration_ms != null ? Number(c.duration_ms) : null,
        error: redactError(c.error, opts.withBodies)
      }
    })
  }
}

/** Transitions on the records these writes touched, inside the call's window. */
async function transitionsOn(
  steps: PathStep[],
  acts: Array<Record<string, unknown>>,
  w: { from: Date; to: Date },
  callAt: unknown,
  warnings: string[]
): Promise<void> {
  const pairs = new Set(acts.map((a) => `${a.collection}\u0000${a.item}`))
  if (pairs.size === 0) return
  const collections = [...new Set(acts.map((a) => String(a.collection)))].slice(0, 100)
  const items = [...new Set(acts.map((a) => String(a.item)))].slice(0, 500)
  try {
    const hist = (await db('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
      .leftJoin('nivaro_workflow_states as fs', 'fs.id', 'h.from_state')
      .leftJoin('nivaro_workflow_states as ts', 'ts.id', 'h.to_state')
      .leftJoin('nivaro_workflow_transitions as t', 't.id', 'h.transition')
      .whereIn('i.collection', collections)
      .whereIn('i.item', items)
      .whereBetween('h.timestamp', [w.from, w.to])
      .select(
        'h.id',
        'h.timestamp',
        'h.comment',
        'i.collection',
        'i.item',
        'fs.label as from_label',
        'ts.label as to_label',
        't.label as transition_label'
      )
      .orderBy('h.id')
      .limit(200)) as Array<Record<string, unknown>>
    for (const h of hist) {
      if (!pairs.has(`${h.collection}\u0000${h.item}`)) continue
      steps.push({
        key: `history:${h.id}`,
        parent: null,
        kind: 'transition',
        at: iso(h.timestamp),
        record: { collection: String(h.collection), item: String(h.item) },
        summary: `${h.transition_label ?? 'Moved'} → ${h.to_label ?? '?'}`,
        inferred: true,
        reason: `transition on a record this call wrote, ${gap(h.timestamp, callAt)} from the call`,
        detail: {
          type: 'transition',
          from: (h.from_label as string | null) ?? null,
          to: (h.to_label as string | null) ?? null,
          comment: (h.comment as string | null) ?? null
        }
      })
    }
  } catch (err) {
    warnings.push(`inferred transitions: ${String((err as Error)?.message ?? err).slice(0, 160)}`)
  }
}

function inferredWrite(a: Record<string, unknown>, reason: string): PathStep {
  const action = String(a.action)
  return {
    key: `activity:${a.id}`,
    parent: null,
    kind: 'write',
    at: iso(a.timestamp),
    record: a.collection ? { collection: String(a.collection), item: String(a.item ?? '') } : null,
    summary: action === 'create' ? 'created' : action === 'delete' ? 'deleted' : 'updated',
    inferred: true,
    reason
  }
}

/** Pushes for the records these writes touched, within the drill's push window. */
async function pushesAfter(
  steps: PathStep[],
  acts: Array<Record<string, unknown>>,
  warnings: string[]
): Promise<void> {
  const keys = new Set(acts.map((a) => `${a.collection}\u0000${a.item}`))
  if (keys.size === 0) return
  const times = acts.map((a) => ms(a.timestamp))
  const earliest = Math.min(...times)
  const latest = Math.max(...times)
  try {
    const subs = (await db('nivaro_erp_submissions as s')
      .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
      .whereBetween('s.created_at', [new Date(earliest), new Date(latest + PUSH_AFTER_MS)])
      .select(
        's.id',
        's.collection',
        's.item',
        's.status',
        's.created_at',
        's.external_api',
        'a.name as api_name'
      )
      .orderBy('s.id')
      .limit(200)) as Array<Record<string, unknown>>
    for (const s of subs) {
      if (!keys.has(`${s.collection}\u0000${s.item}`)) continue
      const failed = s.status === 'failed' || s.status === 'rejected'
      steps.push({
        key: `submission:${s.id}`,
        parent: null,
        kind: 'push',
        at: iso(s.created_at),
        record: { collection: String(s.collection), item: String(s.item) },
        summary: `Push to ${s.api_name ?? 'partner'} · ${s.status}`,
        failed,
        api_id: s.external_api != null ? Number(s.external_api) : null,
        inferred: true,
        reason: `push for a record this event changed, within ${PUSH_WINDOW_TEXT}`
      })
    }
  } catch (err) {
    warnings.push(`inferred pushes: ${String((err as Error)?.message ?? err).slice(0, 160)}`)
  }
}
