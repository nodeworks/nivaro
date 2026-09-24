/**
 * Integrations console — admin HTTP surface over the signal registry
 * (spec 2026-09-23 §4). Reads the SNAPSHOT the `integration-signals` cron
 * writes; only /refresh evaluates on demand (used by "Refresh now" and
 * verification, never by the page's own load).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { chunkArray } from '../services/db-batch.js'
import {
  bustSignalSettings,
  isSnoozed,
  loadActiveSnoozes,
  resolveThresholds,
  rowOccurrence,
  splitSettingValues,
  stableRowHash,
  validateSettingPatch
} from '../services/integration-signal-settings.js'
import {
  getIntegrationSignal,
  getSignalAction,
  listIntegrationSignals,
  runSignalsCycle,
  type SignalAction,
  type SignalRow,
  signalOwner
} from '../services/integration-signals.js'
import { resolveFriendlyIds } from '../services/workflow-transitions.js'

const STALE_MS = 15 * 60_000
const LABEL_CACHE_MS = 60_000

/**
 * Every open/snoozed row across the whole snapshot may carry a `record` with
 * no `label` yet — the signal evaluators only know collection+id. One batched
 * lookup per collection (never per row), cached 60s keyed `collection:id` so
 * the page's own auto-refresh doesn't re-resolve the same friendly ids on
 * every poll. Mutates the rows in place; `openRows()` already builds a fresh
 * object per request, so there's no snapshot to corrupt.
 */
const recordLabelCache = new Map<string, { label: string; at: number }>()

export async function fillRecordLabels(
  signals: Array<{ rows: SignalRow[]; snoozed: SignalRow[] }>,
  resolve: (collection: string, ids: string[]) => Promise<Map<string, string>> = resolveFriendlyIds,
  now = Date.now()
): Promise<void> {
  const missing = new Map<string, Set<string>>()
  const records: Array<NonNullable<SignalRow['record']>> = []
  for (const s of signals) {
    for (const r of [...s.rows, ...s.snoozed]) {
      if (!r.record || r.record.label) continue
      records.push(r.record)
      const cached = recordLabelCache.get(`${r.record.collection}:${r.record.id}`)
      if (cached && now - cached.at < LABEL_CACHE_MS) continue
      if (!missing.has(r.record.collection)) missing.set(r.record.collection, new Set())
      missing.get(r.record.collection)?.add(r.record.id)
    }
  }
  for (const [collection, ids] of missing) {
    try {
      const resolved = await resolve(collection, [...ids])
      for (const [id, label] of resolved) {
        recordLabelCache.set(`${collection}:${id}`, { label, at: now })
      }
    } catch {
      // A broken collection lookup leaves those rows unlabeled this round —
      // the plain "open" action beside them still works either way.
    }
  }
  for (const rec of records) {
    const cached = recordLabelCache.get(`${rec.collection}:${rec.id}`)
    if (cached) rec.label = cached.label
  }
  // Bound the cache — after this round's rows are labeled, so a clear never
  // blanks what was just resolved. Nothing else ever shrinks it. Expired entries first;
  // if a run somehow still leaves it oversized (thousands of distinct
  // records within one 60s window), clear it outright rather than let it
  // grow without limit.
  if (recordLabelCache.size > 5000) {
    for (const [key, entry] of recordLabelCache) {
      if (now - entry.at >= LABEL_CACHE_MS) recordLabelCache.delete(key)
    }
    if (recordLabelCache.size > 5000) recordLabelCache.clear()
  }
}

export function planActionTargets(
  rows: SignalRow[],
  keys: string[],
  action: Pick<SignalAction, 'kind' | 'id' | 'label'>
): { targets: SignalRow[]; skipped: Array<{ key: string; ok: false; message: string }> } {
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const targets: SignalRow[] = []
  const skipped: Array<{ key: string; ok: false; message: string }> = []
  for (const k of keys) {
    const r = byKey.get(k)
    if (!r) {
      skipped.push({ key: k, ok: false, message: 'No longer open' })
      continue
    }
    const offers = r.actions.some(
      (a) => a.kind === action.kind && (action.kind !== 'extension' || a.id === action.id)
    )
    if (!offers) skipped.push({ key: k, ok: false, message: 'This row does not offer that action' })
    else targets.push(r)
  }
  return { targets, skipped }
}

/**
 * A row_keys body from the browser can carry the same key twice (a
 * double-click, a stale client re-post) — deduping BEFORE planActionTargets
 * (and before the 200-row cap) is what stops that from retrying the same
 * submission, or firing the same extension action, twice.
 */
export function dedupeRowKeys(rowKeys: unknown[]): string[] {
  return [...new Set(rowKeys.filter((k): k is string => typeof k === 'string'))]
}

/**
 * "Until it changes" hashes ONE row's stable payload — applied at group or
 * whole-signal scope, the snooze route would hash whichever open row happens
 * to come back first and then compare EVERY other row in that scope against
 * that one row's hash, silently hiding only the rows that happen to be
 * identical to it. Refuse the combination instead of guessing. Dismiss
 * ("until_occurrence") is per-row by definition for the same reason, and for
 * the notification-style meaning itself: "I've seen THIS one" only means
 * something about a single problem instance.
 */
export function validateSnoozeScope(b: {
  until_change?: boolean
  until_occurrence?: boolean
  row_key?: string | null
}): { ok: true } | { ok: false; error: string } {
  if (b.until_change && !b.row_key) {
    return {
      ok: false,
      error:
        '"Until it changes" applies to a single row — pick a date for a group or the whole signal'
    }
  }
  if (b.until_occurrence && !b.row_key) {
    return {
      ok: false,
      error: 'Dismiss applies to a single row — pick a date for a group or the whole signal'
    }
  }
  return { ok: true }
}

/** POST /integration-signals/subscriptions body check — `*critical` is the
 *  "every critical problem" subscription; anything else must be a signal
 *  this instance actually registers. */
export function validateSubscription(
  b: { signal?: unknown; mode?: unknown },
  signalExists: (id: string) => boolean
): { ok: true; signal: string; mode: 'realtime' | 'digest' } | { ok: false; error: string } {
  const signal = typeof b?.signal === 'string' ? b.signal : ''
  if (!signal) return { ok: false, error: 'signal is required' }
  if (signal !== '*critical' && !signalExists(signal)) return { ok: false, error: 'Unknown signal' }
  if (b.mode !== 'realtime' && b.mode !== 'digest')
    return { ok: false, error: 'mode must be realtime or digest' }
  return { ok: true, signal, mode: b.mode }
}

/**
 * Two concurrent POSTs for the same (user, signal, mode) both pass the
 * pre-check "no existing row" and race to insert — one lands, the other hits
 * `UNIQUE(user, signal, mode)` (MSSQL 2627 "Violation of UNIQUE KEY
 * constraint" / 2601 "Cannot insert duplicate key row"). That is not a
 * failure from the caller's point of view: the row it wanted now exists.
 * knex/mssql sometimes wraps the driver error in an AggregateError whose own
 * `.number` is unset and the real one sits on `.errors[]` — check both.
 */
export function isUniqueConstraintViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const isCode = (n: unknown): boolean => n === 2627 || n === 2601
  const top = err as { number?: unknown; errors?: unknown }
  if (isCode(top.number)) return true
  if (Array.isArray(top.errors)) {
    return top.errors.some((e) => isCode((e as { number?: unknown })?.number))
  }
  return false
}

const PREVIEW_BUDGET_MS = 10_000

function authHeaders(req: FastifyRequest): Record<string, string> {
  const h: Record<string, string> = {}
  if (req.headers.authorization) h.authorization = String(req.headers.authorization)
  if (req.headers.cookie) h.cookie = String(req.headers.cookie)
  return h
}

async function openRows(signal: string): Promise<Array<SignalRow & { first_seen: string }>> {
  const rows = (await db('nivaro_integration_signal_rows')
    .where({ signal })
    .whereNull('cleared_at')
    .orderBy('first_seen', 'asc')
    .select('payload', 'first_seen')) as Array<{ payload: string; first_seen: Date }>
  return rows.map((r) => ({
    ...(JSON.parse(r.payload) as SignalRow),
    first_seen: new Date(r.first_seen).toISOString()
  }))
}

export async function integrationSignalsRoutes(app: FastifyInstance) {
  const { registerReadinessCheck } = await import('../services/readiness.js')
  registerReadinessCheck({
    id: 'integration-signals-fresh',
    label: 'Integration signals are being checked',
    group: 'Integrations',
    run: async () => {
      const r = (await db('nivaro_integration_signal_runs').max('ran_at as m').first()) as
        | { m: Date | null }
        | undefined
      if (!r?.m) return { status: 'warn', detail: 'No evaluation has run yet' }
      const age = Date.now() - new Date(r.m).getTime()
      return age > STALE_MS
        ? {
            status: 'fail',
            detail: `Last evaluation ${Math.round(age / 60000)} min ago — the integration-signals job may be stopped`
          }
        : { status: 'pass', detail: `Last evaluation ${Math.round(age / 60000)} min ago` }
    }
  })

  app.get('/integration-signals', { preHandler: requireAdmin }, async (req) => {
    const tab = (req.query as { tab?: string }).tab
    const snoozes = await loadActiveSnoozes()
    const now = new Date()
    const lastRuns = (await db.raw(
      `SELECT r.signal, r.ran_at, r.count, r.error FROM nivaro_integration_signal_runs r
        WHERE r.id IN (SELECT MAX(id) FROM nivaro_integration_signal_runs GROUP BY signal)`
    )) as Array<{ signal: string; ran_at: Date; count: number; error: string | null }>
    const runBy = new Map(lastRuns.map((r) => [r.signal, r]))
    const signals = []
    for (const s of listIntegrationSignals().filter((x) => !tab || x.tab === tab)) {
      const settings = await resolveThresholds(s)
      if (!settings.enabled) continue
      const run = runBy.get(s.id)
      const all = await openRows(s.id)
      const rows = []
      const snoozed = []
      for (const r of all) {
        const sn = isSnoozed(r, s.id, snoozes, now)
        if (sn) {
          snoozed.push({
            ...r,
            snooze: {
              id: sn.id,
              until: sn.until ? new Date(sn.until).toISOString() : null,
              until_change: !!sn.until_change_hash,
              until_occurrence: sn.until_occurrence != null,
              note: sn.note ?? null
            }
          })
        } else rows.push(r)
      }
      signals.push({
        id: s.id,
        label: s.label,
        description: s.description,
        tab: s.tab,
        severity: settings.severity,
        count: run ? Math.max(Number(run.count) - snoozed.length, rows.length) : rows.length,
        error: run?.error ?? null,
        last_run: run ? new Date(run.ran_at).toISOString() : null,
        thresholds: s.thresholds,
        settings,
        rows,
        snoozed,
        shown: rows.length
      })
    }
    const checked = lastRuns.reduce<Date | null>(
      (m, r) => (!m || new Date(r.ran_at) > m ? new Date(r.ran_at) : m),
      null
    )
    await fillRecordLabels(signals)
    return {
      data: {
        checked_at: checked?.toISOString() ?? null,
        stale: !checked || now.getTime() - checked.getTime() > STALE_MS,
        signals
      }
    }
  })

  app.post('/integration-signals/refresh', { preHandler: requireAdmin }, async () => ({
    data: await runSignalsCycle()
  }))

  app.post('/integration-signals/snoozes', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body as {
      signal?: string
      row_key?: string | null
      group_key?: string | null
      until?: string | null
      until_change?: boolean
      until_occurrence?: boolean
      note?: string | null
    }
    if (!b?.signal || !getIntegrationSignal(b.signal))
      return reply.code(400).send({ error: 'Unknown signal' })
    if (!b.until && !b.until_change && !b.until_occurrence)
      return reply.code(400).send({ error: 'until, until_change or until_occurrence is required' })
    const scoped = validateSnoozeScope(b)
    if (!scoped.ok) return reply.code(400).send({ error: scoped.error })
    let hash: string | null = null
    let occurrence: string | null = null
    if (b.until_change || b.until_occurrence) {
      // scoped above guarantees row_key is set here for either of these —
      // never a group/signal scope, so this can only ever match the ONE row
      // being snoozed/dismissed.
      const target = (await openRows(b.signal)).find((r) => r.key === b.row_key)
      if (!target) return reply.code(404).send({ error: 'Nothing open to snooze' })
      if (b.until_change) hash = stableRowHash(target)
      if (b.until_occurrence) occurrence = rowOccurrence(target)
    }
    const [ins] = await db('nivaro_integration_signal_snoozes')
      .insert({
        signal: b.signal,
        row_key: b.row_key ?? null,
        group_key: b.group_key ?? null,
        until: b.until ? new Date(b.until) : null,
        until_change_hash: hash,
        until_occurrence: occurrence,
        note: b.note?.slice(0, 500) ?? null,
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
      .returning('id')
    const id = typeof ins === 'object' ? (ins as { id: number }).id : ins
    await logActivity({
      action: b.until_occurrence ? 'integration-signal-dismiss' : 'integration-signal-snooze',
      collection: 'nivaro_integration_signal_snoozes',
      item: String(id),
      user: req.user?.id,
      req,
      comment: `${b.signal} ${b.row_key ?? b.group_key ?? '(whole signal)'} ${
        b.until_occurrence
          ? 'dismissed until this occurrence changes'
          : b.until
            ? `until ${b.until}`
            : 'until it changes'
      }${b.note ? ` — ${b.note}` : ''}`
    })
    return { data: { id } }
  })

  /**
   * "Dismiss selected" in the bulk bar — one dismissal per selected row (each
   * row keeps its OWN occurrence identity; there is no group/signal-scoped
   * Dismiss). Rows already gone by the time this lands are reported, not
   * treated as an error — the point of dismissing was to stop seeing them.
   */
  app.post('/integration-signals/dismiss', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body as { signal?: string; row_keys?: string[] }
    if (!b?.signal || !getIntegrationSignal(b.signal))
      return reply.code(400).send({ error: 'Unknown signal' })
    const keys = dedupeRowKeys(b.row_keys ?? [])
    if (keys.length === 0) return reply.code(400).send({ error: 'row_keys is required' })
    if (keys.length > 200) return reply.code(400).send({ error: 'At most 200 rows at once' })
    const open = await openRows(b.signal)
    const byKey = new Map(open.map((r) => [r.key, r]))
    const now = new Date()
    const toInsert: Array<Record<string, unknown>> = []
    const skipped: string[] = []
    for (const k of keys) {
      const target = byKey.get(k)
      if (!target) {
        skipped.push(k)
        continue
      }
      toInsert.push({
        signal: b.signal,
        row_key: k,
        group_key: null,
        until: null,
        until_change_hash: null,
        until_occurrence: rowOccurrence(target),
        note: null,
        created_by: req.user?.id ?? null,
        created_at: now
      })
    }
    for (const chunk of chunkArray(toInsert, 50)) {
      if (chunk.length) await db('nivaro_integration_signal_snoozes').insert(chunk)
    }
    await logActivity({
      action: 'integration-signal-dismiss',
      collection: 'nivaro_integration_signal_rows',
      item: b.signal,
      user: req.user?.id,
      req,
      comment: `Dismissed ${toInsert.length} row(s)${skipped.length ? `, ${skipped.length} no longer open` : ''}`
    })
    return { data: { dismissed: toInsert.length, skipped } }
  })

  app.delete('/integration-signals/snoozes/:id', { preHandler: requireAdmin }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    await db('nivaro_integration_signal_snoozes').where({ id }).del()
    await logActivity({
      action: 'integration-signal-unsnooze',
      collection: 'nivaro_integration_signal_snoozes',
      item: String(id),
      user: req.user?.id,
      req
    })
    return { data: { id } }
  })

  app.get('/integration-signals/settings', { preHandler: requireAdmin }, async () => ({
    data: await Promise.all(
      listIntegrationSignals().map(async (s) => ({
        id: s.id,
        label: s.label,
        description: s.description,
        tab: s.tab,
        thresholds: s.thresholds,
        settings: await resolveThresholds(s)
      }))
    )
  }))

  app.patch(
    '/integration-signals/settings/:signal',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = (req.params as { signal: string }).signal
      const s = getIntegrationSignal(id)
      if (!s) return reply.code(404).send({ error: 'Unknown signal' })
      const v = validateSettingPatch(s, (req.body ?? {}) as Record<string, unknown>)
      if (!v.ok) return reply.code(400).send({ error: v.error })
      const { upserts, deletes } = splitSettingValues(v.values)
      for (const [key, value] of upserts) {
        const hit = await db('nivaro_integration_signal_settings')
          .where({ signal: id, key })
          .first('id')
        const row = { value, updated_by: req.user?.id ?? null, updated_at: new Date() }
        if (hit) await db('nivaro_integration_signal_settings').where({ id: hit.id }).update(row)
        else await db('nivaro_integration_signal_settings').insert({ signal: id, key, ...row })
      }
      // null = back to the default: drop the stored row.
      if (deletes.length)
        await db('nivaro_integration_signal_settings')
          .where({ signal: id })
          .whereIn('key', deletes)
          .del()
      bustSignalSettings()
      await logActivity({
        action: 'integration-signal-settings',
        collection: 'nivaro_integration_signal_settings',
        item: id,
        user: req.user?.id,
        req,
        comment: Object.entries(v.values)
          .map(([k, x]) => (x === null ? `${k} cleared` : `${k}=${x}`))
          .join(', ')
      })
      return { data: await resolveThresholds(s) }
    }
  )

  app.get(
    '/integration-signals/settings/:signal/preview',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = (req.params as { signal: string }).signal
      const s = getIntegrationSignal(id)
      if (!s) return reply.code(404).send({ error: 'Unknown signal' })
      const v = validateSettingPatch(s, (req.query ?? {}) as Record<string, unknown>)
      if (!v.ok) return reply.code(400).send({ error: v.error })
      const base = await resolveThresholds(s)
      const thresholds = { ...base.thresholds }
      for (const [k, x] of Object.entries(v.values)) {
        if (k === 'severity' || k === 'enabled') continue
        if (x === null) {
          const declared = s.thresholds.find((t) => t.key === k)
          if (declared) thresholds[k] = declared.default
          else delete thresholds[k]
        } else thresholds[k] = Number(x)
      }
      try {
        const { businessDaysAgoForPreview } = await import('../services/integration-signals.js')
        let timer: NodeJS.Timeout | undefined
        const out = await Promise.race([
          s.evaluate({ thresholds, businessDaysAgo: businessDaysAgoForPreview }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Preview took longer than ${PREVIEW_BUDGET_MS / 1000} s`)),
              PREVIEW_BUDGET_MS
            )
          })
        ]).finally(() => clearTimeout(timer))
        return { data: { count: out.count, error: null } }
      } catch (err) {
        return { data: { count: null, error: err instanceof Error ? err.message : String(err) } }
      }
    }
  )

  // ── opt-in alert subscriptions (own rows only) ─────────────────────────
  app.get('/integration-signals/subscriptions', { preHandler: requireAuth }, async (req) => ({
    data: (await db('nivaro_integration_signal_subscriptions')
      .where({ user: req.user!.id })
      .orderBy('id', 'asc')
      .select('id', 'signal', 'mode', 'last_notified_at')) as Array<{
      id: number
      signal: string
      mode: string
      last_notified_at: Date | null
    }>
  }))

  app.post(
    '/integration-signals/subscriptions',
    { preHandler: requireAuth },
    async (req, reply) => {
      // Alerts describe the admin-only console and link into it — a person
      // who cannot open it has nothing to subscribe to.
      if (!req.isAdmin) {
        return reply.code(403).send({ error: 'Integration alerts are for administrators' })
      }
      const v = validateSubscription(
        (req.body ?? {}) as { signal?: unknown; mode?: unknown },
        (id) => !!getIntegrationSignal(id)
      )
      if (!v.ok) return reply.code(400).send({ error: v.error })
      const userId = req.user!.id
      const existing = (await db('nivaro_integration_signal_subscriptions')
        .where({ user: userId, signal: v.signal, mode: v.mode })
        .first('id')) as { id: number } | undefined
      if (existing) return { data: { id: existing.id, signal: v.signal, mode: v.mode } }
      let id: number
      try {
        const [ins] = await db('nivaro_integration_signal_subscriptions')
          .insert({ user: userId, signal: v.signal, mode: v.mode, created_at: new Date() })
          .returning('id')
        id = typeof ins === 'object' ? (ins as { id: number }).id : ins
      } catch (err) {
        if (!isUniqueConstraintViolation(err)) throw err
        // A concurrent POST for the same (user, signal, mode) won the race —
        // that row is exactly what this request wanted, so hand it back as
        // if this request had made it, rather than 500 on a non-error.
        const raced = (await db('nivaro_integration_signal_subscriptions')
          .where({ user: userId, signal: v.signal, mode: v.mode })
          .first('id')) as { id: number } | undefined
        if (!raced) throw err
        return { data: { id: raced.id, signal: v.signal, mode: v.mode } }
      }
      await logActivity({
        action: 'integration-signal-subscribe',
        collection: 'nivaro_integration_signal_subscriptions',
        item: String(id),
        user: userId,
        req,
        comment: `${v.signal} · ${v.mode}`
      })
      return { data: { id, signal: v.signal, mode: v.mode } }
    }
  )

  app.delete(
    '/integration-signals/subscriptions/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id)
      if (!Number.isInteger(id)) return reply.code(404).send({ error: 'Not found' })
      const row = (await db('nivaro_integration_signal_subscriptions')
        .where({ id, user: req.user!.id })
        .first('id', 'signal', 'mode')) as { id: number; signal: string; mode: string } | undefined
      if (!row) return reply.code(404).send({ error: 'Not found' })
      await db('nivaro_integration_signal_subscriptions').where({ id }).del()
      await logActivity({
        action: 'integration-signal-unsubscribe',
        collection: 'nivaro_integration_signal_subscriptions',
        item: String(id),
        user: req.user!.id,
        req,
        comment: `${row.signal} · ${row.mode}`
      })
      return { data: { id } }
    }
  )

  app.post('/integration-signals/actions', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body as { signal?: string; row_keys?: string[]; action?: SignalAction }
    if (!b?.signal || !Array.isArray(b.row_keys) || !b.action) {
      return reply.code(400).send({ error: 'signal, row_keys and action are required' })
    }
    const keys = dedupeRowKeys(b.row_keys)
    if (keys.length > 200) return reply.code(400).send({ error: 'At most 200 rows per action' })
    const { targets, skipped } = planActionTargets(await openRows(b.signal), keys, b.action)
    const results: Array<{ key: string; ok: boolean; message: string }> = [...skipped]
    if (b.action.kind === 'retry_submission') {
      for (const r of targets) {
        const a = r.actions.find((x) => x.kind === 'retry_submission')
        const res = await app.inject({
          method: 'POST',
          url: `/api/erp-submissions/${a?.id}/retry`,
          headers: authHeaders(req)
        })
        const status = (
          JSON.parse(res.body || '{}') as { data?: { status?: string; last_error?: string } }
        ).data
        const ok = res.statusCode < 300 && status?.status !== 'failed'
        results.push({
          key: r.key,
          ok,
          message: ok
            ? `Retried — ${status?.status}`
            : (status?.last_error ?? `HTTP ${res.statusCode}`)
        })
      }
    } else if (b.action.kind === 'extension') {
      const handler = b.action.id ? getSignalAction(b.action.id) : undefined
      if (!handler || handler.owner !== signalOwner(b.signal)) {
        return reply.code(400).send({ error: 'That action does not belong to this signal' })
      }
      results.push(
        ...(await handler.def.run({
          rows: targets,
          userId: req.user?.id ?? null,
          authHeaders: authHeaders(req)
        }))
      )
    } else {
      return reply.code(400).send({ error: 'Open and explain run in the browser' })
    }
    await logActivity({
      action: 'integration-signal-action',
      collection: 'nivaro_integration_signal_rows',
      item: b.signal,
      user: req.user?.id,
      req,
      comment: `${b.action.kind}${b.action.id ? `:${b.action.id}` : ''} on ${targets.length} row(s) · ${results.filter((r) => r.ok).length} ok`
    })
    return { data: results }
  })
}
