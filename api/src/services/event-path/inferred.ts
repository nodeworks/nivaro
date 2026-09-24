import { db } from '../../db/index.js'
import type { EventEntry } from '../integration-event-sources.js'
import { gatherSubmissionFacts } from '../submission-detail.js'
import { iso } from './exact.js'
import type { PathStep } from './types.js'
import { inboundWindow, POLL_WINDOW_MS, PUSH_AFTER_MS } from './windows.js'

function ms(v: unknown): number {
  return Date.parse(iso(v))
}

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
  ev: EventEntry
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
          await pushesAfter(steps, acts, warnings)
        }
      }
    } else if (ev.source === 'core:outbound') {
      if (/^\d+$/.test(ev.id)) await outboundSteps(Number(ev.id), rootStep, steps, warnings)
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
  warnings: string[]
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
      reason: 'nearest transition on the record within 15 s'
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
      reason: (a.error as string | null) ?? null
    })
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
        reason: 'push for a record this event changed, within 15 s'
      })
    }
  } catch (err) {
    warnings.push(`inferred pushes: ${String((err as Error)?.message ?? err).slice(0, 160)}`)
  }
}
