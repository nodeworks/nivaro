import { db } from '../../db/index.js'
import { hasChainColumns } from '../chain-columns.js'
import { type LabelMetaCache, labelledChanges } from '../mail-types.js'
import { maskBodySecrets } from '../secret-mask.js'
import { redactError, redactUrl } from './redact.js'
import { FOLD_THRESHOLD } from './tree.js'
import type { PathStep } from './types.js'

/**
 * Exact mode: every row stamped with the chain id (migration 351), nested by
 * its chain_parent. Each table is read on its own and best-effort — one
 * unreadable table becomes a warning, never a failed path.
 */

/** Activity rows read per chain (one over STEP_CAP so truncation still shows). */
const ACTIVITY_LIMIT = 2100
/** Revisions whose previous snapshot is looked up (bound-parameter headroom). */
const PREV_LOOKUP_CAP = 500
/** labelledChanges calls in flight at once. */
const LABEL_CONCURRENCY = 8
const BODY_CAP = 20_000

async function safe<T>(label: string, warnings: string[], fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn()
  } catch (err) {
    warnings.push(`${label}: ${String((err as Error)?.message ?? err).slice(0, 160)}`)
    return []
  }
}

/** A DB datetime as ISO, keeping milliseconds (String(Date) drops them). */
export function iso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString()
}

function whoOf(r: Record<string, unknown>): string | null {
  return [r.first_name, r.last_name].filter(Boolean).join(' ') || null
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export function maskedJson(raw: unknown): string | null {
  if (raw == null) return null
  const masked = maskBodySecrets(String(raw))
  if (masked == null) return null
  try {
    return JSON.stringify(JSON.parse(masked), null, 2).slice(0, BODY_CAP)
  } catch {
    return masked.slice(0, BODY_CAP)
  }
}

/** Chain ids are compared as text in step keys; the DB may hand them back upper-case. */
function lowerId(v: unknown): string | null {
  return v == null ? null : String(v).toLowerCase()
}

/** A chain_parent naming a chain (`request:<uuid>`) matches its root key only in one case. */
function parentKey(v: unknown): string | null {
  if (v == null) return null
  const p = String(v)
  return p.startsWith('request:') ? p.toLowerCase() : p
}

/**
 * Writes that will fold into a group (more than FOLD_THRESHOLD to one
 * collection under one parent, none with steps of its own): their per-row
 * change detail is never shown, so it is never looked up.
 */
function foldingWrites(
  acts: Array<Record<string, unknown>>,
  parentsInUse: Set<string>
): Set<unknown> {
  const buckets = new Map<string, Array<Record<string, unknown>>>()
  for (const a of acts) {
    if (!a.collection || parentsInUse.has(`activity:${a.id}`)) continue
    const k = `${parentKey(a.chain_parent) ?? ''}|${a.collection}`
    const list = buckets.get(k) ?? []
    list.push(a)
    buckets.set(k, list)
  }
  const out = new Set<unknown>()
  for (const list of buckets.values()) {
    if (list.length > FOLD_THRESHOLD) for (const a of list) out.add(a.id)
  }
  return out
}

export async function loadChainSteps(
  rawChainId: string,
  opts: { withBodies: boolean }
): Promise<{ steps: PathStep[]; rootStep: PathStep | null; warnings: string[] }> {
  // Step keys carry the id lower-case (the chain plugin mints it that way).
  const chainId = rawChainId.toLowerCase()
  const warnings: string[] = []
  const steps: PathStep[] = []
  let rootStep: PathStep | null = null

  // Root: the chain's own inbound request. A request that adopted this chain
  // (an in-process app.inject) carries a chain_parent — it is neither the
  // root nor a step: the writes it made are already steps of their own.
  if (await hasChainColumns('nivaro_api_logs')) {
    const [log] = await safe('api log', warnings, () =>
      db('nivaro_api_logs as l')
        .leftJoin('nivaro_users as u', 'u.id', 'l.user')
        .where('l.chain_id', chainId)
        .whereNull('l.chain_parent')
        .select(
          'l.id',
          'l.method',
          'l.path',
          'l.status',
          'l.created_at',
          'l.latency_ms',
          'u.first_name',
          'u.last_name'
        )
        .orderBy('l.id')
        .limit(1)
    )
    if (log) {
      const r = log as Record<string, unknown>
      rootStep = {
        key: `request:${chainId}`,
        parent: null,
        kind: 'request',
        at: new Date(Date.parse(iso(r.created_at)) - Number(r.latency_ms ?? 0)).toISOString(),
        who: whoOf(r),
        summary: `${r.method} ${r.path} · ${r.status}`,
        failed: Number(r.status) >= 400
      }
    }
  }

  // Activity rows; their steps are built last (see buildActivitySteps) —
  // which writes fold is only known once every other step is loaded.
  let activityRows: Array<Record<string, unknown>> = []
  if (await hasChainColumns('nivaro_activity')) {
    activityRows = (await safe('activity', warnings, () =>
      db('nivaro_activity as a')
        .leftJoin('nivaro_users as u', 'u.id', 'a.user')
        .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
        .where('a.chain_id', chainId)
        .whereIn('a.action', ['create', 'update', 'delete'])
        .select(
          'a.id',
          'a.action',
          'a.collection',
          'a.item',
          'a.timestamp',
          'a.chain_parent',
          'r.id as revision_id',
          'r.delta',
          'u.first_name',
          'u.last_name'
        )
        .orderBy('a.id')
        .limit(ACTIVITY_LIMIT)
    )) as Array<Record<string, unknown>>
  }

  // Workflow history.
  if (await hasChainColumns('nivaro_workflow_history')) {
    const hist = (await safe('workflow history', warnings, () =>
      db('nivaro_workflow_history as h')
        .leftJoin('nivaro_workflow_instances as i', 'i.id', 'h.instance')
        .leftJoin('nivaro_workflow_states as fs', 'fs.id', 'h.from_state')
        .leftJoin('nivaro_workflow_states as ts', 'ts.id', 'h.to_state')
        .leftJoin('nivaro_workflow_transitions as t', 't.id', 'h.transition')
        .leftJoin('nivaro_users as u', 'u.id', 'h.user')
        .where('h.chain_id', chainId)
        .select(
          'h.id',
          'h.timestamp',
          'h.comment',
          'h.chain_parent',
          'i.collection',
          'i.item',
          'fs.label as from_label',
          'ts.label as to_label',
          't.label as transition_label',
          'u.first_name',
          'u.last_name'
        )
        .orderBy('h.id')
        .limit(ACTIVITY_LIMIT)
    )) as Array<Record<string, unknown>>
    for (const h of hist) {
      steps.push({
        key: `history:${h.id}`,
        parent: parentKey(h.chain_parent),
        kind: 'transition',
        at: iso(h.timestamp),
        who: whoOf(h),
        record: h.collection ? { collection: String(h.collection), item: String(h.item) } : null,
        summary: `${h.transition_label ?? 'Moved'} → ${h.to_label ?? '?'}`,
        detail: {
          type: 'transition',
          from: (h.from_label as string | null) ?? null,
          to: (h.to_label as string | null) ?? null,
          comment: (h.comment as string | null) ?? null
        }
      })
    }
  }

  // Flow runs.
  if (await hasChainColumns('nivaro_flow_runs')) {
    const runs = (await safe('flow runs', warnings, () =>
      db('nivaro_flow_runs as r')
        .leftJoin('nivaro_flows as f', 'f.id', 'r.flow')
        .where('r.chain_id', chainId)
        .select(
          'r.id',
          'r.status',
          'r.started_at',
          'r.error_message',
          'r.halted_at',
          'r.chain_parent',
          'f.name as flow_name'
        )
        .orderBy('r.started_at')
        .limit(ACTIVITY_LIMIT)
    )) as Array<Record<string, unknown>>
    for (const r of runs) {
      steps.push({
        key: `flow_run:${r.id}`,
        parent: parentKey(r.chain_parent),
        kind: 'flow',
        at: iso(r.started_at),
        summary: `Flow "${r.flow_name ?? 'flow'}" · ${r.status}`,
        failed: r.status === 'error',
        reason: redactError(r.error_message, opts.withBodies),
        detail: {
          type: 'flow',
          status: String(r.status),
          halted_at: (r.halted_at as string | null) ?? null,
          error: redactError(r.error_message, opts.withBodies)
        }
      })
    }
  }

  // Pushes + attempts.
  const subIds: number[] = []
  if (await hasChainColumns('nivaro_erp_submissions')) {
    const subs = (await safe('submissions', warnings, () =>
      db('nivaro_erp_submissions as s')
        .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
        .where('s.chain_id', chainId)
        .select(
          's.id',
          's.collection',
          's.item',
          's.status',
          's.attempts',
          's.last_error',
          's.created_at',
          's.chain_parent',
          's.external_api',
          'a.name as api_name',
          ...(opts.withBodies ? ['s.payload', 's.response'] : [])
        )
        .orderBy('s.id')
        .limit(ACTIVITY_LIMIT)
    )) as Array<Record<string, unknown>>
    for (const s of subs) {
      subIds.push(Number(s.id))
      const failed = s.status === 'failed' || s.status === 'rejected'
      steps.push({
        key: `submission:${s.id}`,
        parent: parentKey(s.chain_parent),
        kind: 'push',
        at: iso(s.created_at),
        record: s.collection ? { collection: String(s.collection), item: String(s.item) } : null,
        summary: `Push to ${s.api_name ?? 'partner'} · ${s.status}`,
        failed,
        reason: failed ? redactError(s.last_error, opts.withBodies) : null,
        api_id: s.external_api != null ? Number(s.external_api) : null,
        detail: {
          type: 'push',
          status: String(s.status),
          attempts: Number(s.attempts ?? 1),
          error: redactError(s.last_error, opts.withBodies),
          submission_id: Number(s.id),
          request: opts.withBodies ? maskedJson(s.payload) : null,
          response: opts.withBodies ? maskedJson(s.response) : null
        }
      })
    }
  }
  // A retry runs on its OWN chain (the retry cron / the Retry click), so a
  // push's attempts are read by submission too, and the calls each retry
  // made while that push was open by the retry chains.
  const retryChains = new Set<string>()
  if (await hasChainColumns('nivaro_erp_submission_attempts')) {
    const cols = [
      'id',
      'submission_id',
      'attempt',
      'status',
      'http_status',
      'error',
      'recorded_at',
      'chain_id',
      'chain_parent'
    ]
    const own = (await safe('attempts', warnings, () =>
      db('nivaro_erp_submission_attempts')
        .where('chain_id', chainId)
        .select(...cols)
        .orderBy('id')
        .limit(ACTIVITY_LIMIT)
    )) as Array<Record<string, unknown>>
    const bySubmission = subIds.length
      ? ((await safe('push attempts', warnings, () =>
          db('nivaro_erp_submission_attempts')
            .whereIn('submission_id', subIds)
            .select(...cols)
            .orderBy('id')
            .limit(ACTIVITY_LIMIT)
        )) as Array<Record<string, unknown>>)
      : []
    const subSet = new Set(subIds)
    const seen = new Set<string>()
    for (const a of [...own, ...bySubmission]) {
      const id = String(a.id)
      if (seen.has(id)) continue
      seen.add(id)
      const ofPush = subSet.has(Number(a.submission_id))
      const chain = lowerId(a.chain_id)
      if (ofPush && chain && chain !== chainId) retryChains.add(chain)
      steps.push({
        key: `attempt:${a.id}`,
        // An attempt of a push on this path hangs under that push, whatever
        // chain the retry ran on.
        parent: ofPush
          ? `submission:${a.submission_id}`
          : (parentKey(a.chain_parent) ?? `submission:${a.submission_id}`),
        kind: 'attempt',
        at: iso(a.recorded_at),
        summary: `Attempt ${a.attempt} · ${a.status}${a.http_status ? ` · HTTP ${a.http_status}` : ''}`,
        failed: a.status === 'failed' || a.status === 'rejected',
        reason: redactError(a.error, opts.withBodies)
      })
    }
  }

  // Partner calls.
  if (await hasChainColumns('nivaro_external_api_logs')) {
    const callQuery = () =>
      db('nivaro_external_api_logs as c')
        .leftJoin('nivaro_external_apis as a', 'a.id', 'c.api_id')
        .select(
          'c.id',
          'c.api_id',
          'c.method',
          'c.url',
          'c.response_status',
          'c.duration_ms',
          'c.error',
          'c.created_at',
          'c.chain_parent',
          'a.name as api_name'
        )
        .orderBy('c.id')
        .limit(ACTIVITY_LIMIT)
    const own = (await safe('call logs', warnings, () =>
      callQuery().where('c.chain_id', chainId)
    )) as Array<Record<string, unknown>>
    const retries =
      retryChains.size && subIds.length
        ? ((await safe('retry call logs', warnings, () =>
            callQuery()
              .whereIn('c.chain_id', [...retryChains])
              .whereIn(
                'c.chain_parent',
                subIds.map((id) => `submission:${id}`)
              )
          )) as Array<Record<string, unknown>>)
        : []
    const seen = new Set<string>()
    for (const c of [...own, ...retries]) {
      if (seen.has(String(c.id))) continue
      seen.add(String(c.id))
      const status = c.response_status != null ? Number(c.response_status) : null
      steps.push({
        key: `call:${c.id}`,
        parent: parentKey(c.chain_parent),
        kind: 'partner_call',
        at: iso(c.created_at),
        summary: `${c.api_name ?? 'Partner'} answered ${status ?? 'no response'}`,
        failed: status == null || status >= 400 || Boolean(c.error),
        reason: redactError(c.error, opts.withBodies),
        api_id: c.api_id != null ? Number(c.api_id) : null,
        detail: {
          type: 'call',
          method: String(c.method),
          url: redactUrl(c.url, opts.withBodies),
          status,
          duration_ms: c.duration_ms != null ? Number(c.duration_ms) : null,
          error: redactError(c.error, opts.withBodies)
        }
      })
    }
  }

  steps.unshift(...(await buildActivitySteps(activityRows, steps, warnings)))
  return { steps, rootStep, warnings }
}

/**
 * Activity rows → write steps (+ revision delta and the previous snapshot for
 * old values). Writes that will fold carry no per-row change detail — the
 * group shows the count — so their labels and old values are never looked
 * up; field labels are read once per collection for the whole path.
 */
async function buildActivitySteps(
  acts: Array<Record<string, unknown>>,
  others: PathStep[],
  warnings: string[]
): Promise<PathStep[]> {
  if (acts.length === 0) return []
  const parentsInUse = new Set<string>()
  for (const s of others) if (s.parent) parentsInUse.add(s.parent)
  for (const a of acts) {
    const p = parentKey(a.chain_parent)
    if (p) parentsInUse.add(p)
  }
  const folding = foldingWrites(acts, parentsInUse)
  const detailed = (a: Record<string, unknown>) => a.action === 'update' && !folding.has(a.id)

  const revIds = [
    ...new Set(
      acts.filter((a) => detailed(a) && a.revision_id != null).map((a) => Number(a.revision_id))
    )
  ].slice(0, PREV_LOOKUP_CAP)
  const prevData = new Map<number, Record<string, unknown>>()
  if (revIds.length) {
    const prev = (await safe('previous revisions', warnings, async () => {
      const res = await db.raw(
        `SELECT r.id, p.data AS prev_data FROM nivaro_revisions r
         OUTER APPLY (SELECT TOP 1 x.data FROM nivaro_revisions x
                      WHERE x.collection = r.collection AND x.item = r.item AND x.id < r.id
                      ORDER BY x.id DESC) p
         WHERE r.id IN (${revIds.map(() => '?').join(',')})`,
        revIds
      )
      return res as unknown as Array<{ id: number; prev_data: string | null }>
    })) as Array<{ id: number; prev_data: string | null }>
    for (const p of prev) {
      try {
        prevData.set(Number(p.id), p.prev_data ? JSON.parse(p.prev_data) : {})
      } catch {
        // an unparseable snapshot = old values unknown
      }
    }
  }

  const metaCache: LabelMetaCache = new Map()
  return pool(acts, LABEL_CONCURRENCY, async (a): Promise<PathStep> => {
    const action = String(a.action)
    let changes: Array<{ field: string; label: string; old: string; new: string }> = []
    if (detailed(a) && a.collection && a.delta) {
      let delta: Record<string, unknown> | null = null
      try {
        delta = JSON.parse(String(a.delta))
      } catch {
        // an unparseable delta = no field detail
      }
      if (delta) {
        try {
          changes = await labelledChanges(
            String(a.collection),
            delta,
            prevData.get(Number(a.revision_id)) ?? null,
            40,
            metaCache
          )
        } catch {
          changes = []
        }
      }
    }
    const names = changes.slice(0, 3).map((c) => c.label)
    const more = changes.length > 3 ? ` +${changes.length - 3}` : ''
    return {
      key: `activity:${a.id}`,
      parent: parentKey(a.chain_parent),
      kind: 'write',
      at: iso(a.timestamp),
      who: whoOf(a),
      record: a.collection
        ? { collection: String(a.collection), item: String(a.item ?? '') }
        : null,
      summary:
        action === 'create'
          ? 'created'
          : action === 'delete'
            ? 'deleted'
            : changes.length
              ? `updated ${names.join(', ')}${more}`
              : 'updated',
      detail: changes.length ? { type: 'changes', changes } : null
    }
  })
}
