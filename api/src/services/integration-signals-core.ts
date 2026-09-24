/**
 * Core integration signals (spec §3.1 table). Generic — no deployment names.
 * Keys are entity identities so a problem keeps its first_seen across runs.
 */
import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { importCadence, isImportStale } from './integration-signal-settings.js'
import { registerIntegrationSignal, type SignalRow } from './integration-signals.js'

export function isAuthFailure(status: number | null, error: string | null): boolean {
  if (status === 401 || status === 403) return true
  return !!error && /token exchange failed|unauthori[sz]ed|forbidden/i.test(error)
}

export function failureStreak(
  calls: Array<{ ok: boolean; status: number | null; error: string | null }>
): { streak: number; auth: boolean } {
  let streak = 0
  let auth = false
  for (const c of calls) {
    if (c.ok) break
    streak++
    if (isAuthFailure(c.status, c.error)) auth = true
  }
  return { streak, auth }
}

const open = (collection: string, id: string, label?: string) => ({
  kind: 'open' as const,
  label: 'Open record',
  payload: { collection, id, label }
})

/**
 * Collapse rows sharing a `key` to the FIRST occurrence — a safety net on
 * top of the SQL windowing above, not a replacement for it: a row's own
 * `key` must be unique on the wire before it ever reaches the registry,
 * because `diffSnapshot` only dedupes by overwriting (last-write-wins),
 * which silently keeps whichever duplicate happens to sort last. Callers
 * order rows newest-first, so keeping the first occurrence keeps the
 * newest.
 */
export function uniqueByKey(rows: SignalRow[]): SignalRow[] {
  const seen = new Set<string>()
  const out: SignalRow[] = []
  for (const r of rows) {
    if (seen.has(r.key)) continue
    seen.add(r.key)
    out.push(r)
  }
  return out
}

/**
 * "User <uuid>" means nothing to an operator — name the person, or their
 * email when they have none. An API key keeps its numeric handle (that's
 * what the retry/snooze actions key on) and gains its label when it has one.
 */
export function formatInboundCaller(
  userId: string | null,
  apiKeyId: number | null,
  userNames: Map<string, string>,
  keyNames: Map<number, string>
): string {
  if (apiKeyId != null) {
    const name = keyNames.get(apiKeyId)
    return name ? `API key #${apiKeyId} (${name})` : `API key #${apiKeyId}`
  }
  if (userId) return userNames.get(userId) ?? `User ${userId}`
  return 'User unknown'
}

export function registerCoreIntegrationSignals(): void {
  registerIntegrationSignal({
    id: 'core:partner-failing',
    label: 'Partner failing',
    description:
      'Consecutive failed calls to an external API, or any authentication failure, in the recent window.',
    tab: 'partners',
    severity: 'critical',
    thresholds: [
      { key: 'streak', label: 'Consecutive failures', default: 3, unit: 'calls', min: 1, max: 50 },
      {
        key: 'window_minutes',
        label: 'Look-back window',
        default: 60,
        unit: 'minutes',
        min: 5,
        max: 1440
      }
    ],
    evaluate: async ({ thresholds }) => {
      const since = new Date(Date.now() - thresholds.window_minutes * 60_000)
      const calls = (await db('nivaro_outbound_log')
        .where('created_at', '>=', since)
        .orderBy('id', 'desc')
        .limit(5000)
        .select('id', 'api_id', 'api_name', 'ok', 'status', 'error', 'created_at')) as Array<{
        id: number
        api_id: number
        api_name: string | null
        ok: boolean | number
        status: number | null
        error: string | null
        created_at: Date
      }>
      const byApi = new Map<number, typeof calls>()
      for (const c of calls) byApi.set(c.api_id, [...(byApi.get(c.api_id) ?? []), c])
      const flagged: Array<{ apiId: number; list: typeof calls; streak: number; auth: boolean }> =
        []
      for (const [apiId, list] of byApi) {
        const { streak, auth } = failureStreak(
          list.map((c) => ({ ok: !!c.ok, status: c.status, error: c.error }))
        )
        if (streak === 0 || (!auth && streak < thresholds.streak)) continue
        flagged.push({ apiId, list, streak, auth })
      }
      // A streak that fills the whole window began before it — the oldest
      // call the window still holds is NOT the start, and would slide forward
      // every cycle. Ask the log for the first call after the last success.
      const starts = new Map<number, { id: number; at: Date }>()
      const unbounded = flagged.filter((f) => f.streak === f.list.length).map((f) => f.apiId)
      if (unbounded.length > 0) {
        const found = (await selectInChunks(unbounded, 1000, (chunk) =>
          db.raw(
            `SELECT l.api_id, MIN(l.id) AS first_id, MIN(l.created_at) AS first_at
               FROM nivaro_outbound_log l
              WHERE l.api_id IN (${chunk.map(() => '?').join(',')})
                AND l.id > ISNULL((SELECT MAX(s.id) FROM nivaro_outbound_log s
                                    WHERE s.api_id = l.api_id AND s.ok = 1), 0)
              GROUP BY l.api_id`,
            chunk
          )
        )) as Array<{ api_id: number; first_id: number | null; first_at: Date | null }>
        for (const f of found) {
          if (f.first_id != null && f.first_at != null) {
            starts.set(Number(f.api_id), { id: Number(f.first_id), at: new Date(f.first_at) })
          }
        }
      }
      const rows: SignalRow[] = []
      for (const { apiId, list, streak, auth } of flagged) {
        const newest = list[0]
        const firstFail = list[streak - 1]
        const start = starts.get(apiId) ?? {
          id: firstFail.id,
          at: new Date(firstFail.created_at)
        }
        const name = newest.api_name ?? `API #${apiId}`
        rows.push({
          key: `api:${apiId}`,
          title: auth
            ? `${name}: authentication failing`
            : `${name}: ${streak} failed calls in a row`,
          detail: newest.error ?? (newest.status != null ? `HTTP ${newest.status}` : 'No response'),
          since: start.at.toISOString(),
          // The FIRST failing call of this streak (the first failure after the
          // last success) — unchanged for as long as the outage lasts, so a
          // steady outage never reads as "it happened again". A success ends
          // the streak (the row clears); the next failure starts a new one.
          occurrence: `call:${start.id}`,
          api: name,
          actions: [{ kind: 'explain', label: 'Partner detail', payload: { api_id: apiId } }]
        })
      }
      return { count: rows.length, rows }
    }
  })

  registerIntegrationSignal({
    id: 'core:push-failed',
    label: 'Failed pushes',
    description:
      'Pushes whose latest attempt failed and that no later push to the same record and endpoint has replaced.',
    tab: 'pushes',
    severity: 'warn',
    thresholds: [
      {
        key: 'min_age_minutes',
        label: 'Older than',
        default: 0,
        unit: 'minutes',
        min: 0,
        max: 1440
      }
    ],
    evaluate: async ({ thresholds }) => {
      const cutoff = new Date(Date.now() - thresholds.min_age_minutes * 60_000)
      // recordSubmission() inserts one row per attempt — several still-failing
      // attempts can share one (collection, item, external_api, endpoint)
      // tuple with nothing accepted/pending in between. Window to the newest
      // failed attempt per tuple so the signal's row key is unique BY
      // CONSTRUCTION (never just by the registry's last-write-wins dedupe).
      const rows = (await db.raw(
        `SELECT id, collection, item, last_error, updated_at, attempts, api_name, endpoint
           FROM (
             SELECT s.id, s.collection, s.item, s.last_error, s.updated_at, s.attempts, a.name AS api_name,
                    JSON_VALUE(s.payload, '$.endpoint_path') AS endpoint,
                    ROW_NUMBER() OVER (
                      PARTITION BY s.collection, s.item, s.external_api,
                                   ISNULL(JSON_VALUE(s.payload, '$.endpoint_path'), '')
                      ORDER BY s.id DESC
                    ) AS rn
               FROM nivaro_erp_submissions s
               JOIN nivaro_external_apis a ON a.id = s.external_api
              WHERE s.status IN ('failed', 'rejected') AND s.updated_at <= ?
                AND NOT EXISTS (
                  SELECT 1 FROM nivaro_erp_submissions n
                   WHERE n.collection = s.collection AND n.item = s.item AND n.external_api = s.external_api
                     AND ISNULL(JSON_VALUE(n.payload, '$.endpoint_path'), '') = ISNULL(JSON_VALUE(s.payload, '$.endpoint_path'), '')
                     AND n.id > s.id AND n.status IN ('accepted', 'pending'))
           ) x
          WHERE rn = 1
          ORDER BY updated_at DESC, id DESC`,
        [cutoff]
      )) as Array<{
        id: number
        collection: string
        item: string
        last_error: string | null
        updated_at: Date
        attempts: number
        api_name: string
        endpoint: string | null
      }>
      const out: SignalRow[] = uniqueByKey(
        rows.map((r) => ({
          key: `${r.collection}:${r.item}:${r.api_name}:${r.endpoint ?? ''}`,
          group: r.api_name,
          group_label: r.api_name,
          title: `${r.api_name} ${r.endpoint ?? ''}`.trim(),
          detail: `${r.last_error ?? 'failed'} · ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}`,
          since: new Date(r.updated_at).toISOString(),
          // Attempts increments per retry — a new retry IS a new occurrence,
          // same as dismissing one failed send but wanting to hear about the
          // next one.
          occurrence: `sub:${r.id}:${r.attempts}`,
          api: r.api_name,
          record: { collection: r.collection, id: r.item },
          actions: [
            { kind: 'retry_submission', label: 'Retry', id: String(r.id) },
            open(r.collection, r.item)
          ],
          drill: { kind: 'submission', id: String(r.id) }
        }))
      )
      return { count: out.length, rows: out }
    }
  })

  for (const outcome of ['missing', 'overdue'] as const) {
    registerIntegrationSignal({
      id: `core:obligation-${outcome}`,
      label: outcome === 'missing' ? 'Never sent' : 'Overdue acknowledgements',
      description:
        outcome === 'missing'
          ? 'The data says a partner should have been told something and no send was ever attempted.'
          : 'A send is unacknowledged or skipped past its grace period while the partner still lacks it.',
      tab: 'pushes',
      severity: outcome === 'missing' ? 'critical' : 'warn',
      thresholds: [],
      evaluate: async () => {
        // A crash between opening and resolving an obligation, or any path
        // that opens more than one row for the same item, can leave several
        // unresolved rows sharing one (collection, item, kind) — the
        // reconcile sweep's own supersede pass only reaches items it is
        // currently looking at, so this is not guaranteed clean between
        // sweeps. Window to the newest row per key so the signal's row key
        // is unique BY CONSTRUCTION.
        const rows = (await db.raw(
          `SELECT id, api, kind, collection, item, reason, due_at, created_at FROM (
             SELECT id, api, kind, collection, item, reason, due_at, created_at,
                    ROW_NUMBER() OVER (PARTITION BY collection, item, kind ORDER BY id DESC) AS rn
               FROM nivaro_integration_obligations
              WHERE outcome = ? AND resolved_at IS NULL
           ) x
          WHERE rn = 1
          ORDER BY due_at ASC, id ASC
          OFFSET 0 ROWS FETCH NEXT 2000 ROWS ONLY`,
          [outcome]
        )) as Array<{
          id: number
          api: string
          kind: string
          collection: string
          item: string
          reason: string | null
          due_at: Date | null
          created_at: Date
        }>
        const out: SignalRow[] = uniqueByKey(
          rows.map((r) => ({
            key: `${r.collection}:${r.item}:${r.kind}`,
            group: `${r.api}:${r.kind}`,
            group_label: `${r.api} · ${r.kind}`,
            title: `${r.api}: ${r.kind}`,
            detail: r.reason ?? undefined,
            since: new Date(r.due_at ?? r.created_at).toISOString(),
            occurrence: `obl:${r.id}`,
            api: r.api,
            record: { collection: r.collection, id: r.item },
            actions: [open(r.collection, r.item)]
          }))
        )
        return { count: out.length, rows: out }
      }
    })
  }

  registerIntegrationSignal({
    id: 'core:inbound-errors',
    label: 'Inbound error spike',
    description:
      'A caller using a token or API key whose requests fail at or above the error rate in the last hour.',
    tab: 'inbound',
    severity: 'warn',
    thresholds: [
      { key: 'error_pct', label: 'Error rate', default: 20, unit: '%', min: 1, max: 100 },
      { key: 'min_calls', label: 'Minimum calls', default: 10, unit: 'calls', min: 1, max: 10000 }
    ],
    evaluate: async ({ thresholds }) => {
      const since = new Date(Date.now() - 3600_000)
      const rows = (await db.raw(
        `SELECT l.[user] AS user_id, l.api_key_id, COUNT(*) AS calls,
                SUM(CASE WHEN l.status >= 400 THEN 1 ELSE 0 END) AS errors,
                MAX(CASE WHEN l.status >= 400 THEN l.created_at END) AS last_error_at
           FROM nivaro_api_logs l
          WHERE l.created_at >= ? AND l.auth IN ('token', 'api_key')
          GROUP BY l.[user], l.api_key_id
          ORDER BY l.[user], l.api_key_id`,
        [since]
      )) as Array<{
        user_id: string | null
        api_key_id: number | null
        calls: number
        errors: number
        last_error_at: Date | null
      }>
      const flagged = rows.filter((r) => {
        const calls = Number(r.calls)
        const errors = Number(r.errors)
        return calls >= thresholds.min_calls && (errors / calls) * 100 >= thresholds.error_pct
      })
      // When did each flagged caller's CURRENT bout of errors begin: the
      // first error after a quiet spell longer than the window (an hour with
      // no error at all). A caller erroring steadily keeps that start, so a
      // continuing spike never reads as "it happened again"; a fresh spike
      // after a quiet hour is a new one. Bounded to the log's own retention.
      const episodeStarts = new Map<string, Date>()
      const callerKey = (u: string | null, k: number | null) =>
        k != null ? `key:${k}` : `user:${String(u ?? 'none').toUpperCase()}`
      if (flagged.length > 0) {
        const episodeUsers = [
          ...new Set(flagged.filter((r) => r.api_key_id == null && r.user_id).map((r) => r.user_id))
        ] as string[]
        const episodeKeys = [
          ...new Set(flagged.map((r) => r.api_key_id).filter((v): v is number => v != null))
        ]
        const clauses: string[] = []
        const bindings: Array<Date | string | number> = [new Date(Date.now() - 14 * 86_400_000)]
        if (episodeUsers.length > 0) {
          clauses.push(
            `(l.api_key_id IS NULL AND l.[user] IN (${episodeUsers.map(() => '?').join(',')}))`
          )
          bindings.push(...episodeUsers)
        }
        if (episodeKeys.length > 0) {
          clauses.push(`l.api_key_id IN (${episodeKeys.map(() => '?').join(',')})`)
          bindings.push(...episodeKeys)
        }
        if (clauses.length > 0) {
          const starts = (await db.raw(
            `SELECT user_id, api_key_id, MAX(created_at) AS episode_start FROM (
               SELECT l.[user] AS user_id, l.api_key_id, l.created_at,
                      LAG(l.created_at) OVER (PARTITION BY l.[user], l.api_key_id
                                              ORDER BY l.created_at, l.id) AS prev_at
                 FROM nivaro_api_logs l
                WHERE l.created_at >= ? AND l.auth IN ('token', 'api_key') AND l.status >= 400
                  AND (${clauses.join(' OR ')})
             ) x
            WHERE prev_at IS NULL OR DATEDIFF(second, prev_at, created_at) > 3600
            GROUP BY user_id, api_key_id`,
            bindings
          )) as Array<{
            user_id: string | null
            api_key_id: number | null
            episode_start: Date | null
          }>
          for (const e of starts) {
            if (e.episode_start) {
              episodeStarts.set(
                callerKey(e.user_id, e.api_key_id != null ? Number(e.api_key_id) : null),
                new Date(e.episode_start)
              )
            }
          }
        }
      }
      // Two lookups total, however many distinct callers are flagged — never
      // one query per row.
      const userIds = [...new Set(flagged.map((r) => r.user_id).filter((v): v is string => !!v))]
      const keyIds = [
        ...new Set(flagged.map((r) => r.api_key_id).filter((v): v is number => v != null))
      ]
      const userNames = new Map<string, string>()
      if (userIds.length > 0) {
        const users = (await selectInChunks(userIds, 1000, (chunk) =>
          db('nivaro_users').whereIn('id', chunk).select('id', 'first_name', 'last_name', 'email')
        )) as Array<{
          id: string
          first_name: string | null
          last_name: string | null
          email: string | null
        }>
        for (const u of users) {
          const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
          const label = name || u.email
          if (label) userNames.set(String(u.id), label)
        }
      }
      const keyNames = new Map<number, string>()
      if (keyIds.length > 0) {
        const keys = (await selectInChunks(keyIds, 1000, (chunk) =>
          db('nivaro_api_keys').whereIn('id', chunk).select('id', 'name')
        )) as Array<{
          id: number
          name: string | null
        }>
        for (const k of keys) if (k.name) keyNames.set(Number(k.id), k.name)
      }
      const out: SignalRow[] = []
      for (const r of flagged) {
        const calls = Number(r.calls)
        const errors = Number(r.errors)
        const who = formatInboundCaller(r.user_id, r.api_key_id, userNames, keyNames)
        const episode = episodeStarts.get(
          callerKey(r.user_id, r.api_key_id != null ? Number(r.api_key_id) : null)
        )
        const since = episode
          ? episode.toISOString()
          : r.last_error_at
            ? new Date(r.last_error_at).toISOString()
            : undefined
        out.push({
          key: r.api_key_id ? `key:${r.api_key_id}` : `user:${r.user_id ?? 'none'}`,
          title: `${who}: ${Math.round((errors / calls) * 100)}% of calls failing`,
          detail: `${errors} of ${calls} calls in the last hour`,
          since,
          // The start of this bout of errors (see episodeStarts above) — the
          // same for as long as the caller keeps erroring; a fresh bout after
          // a quiet hour moves it, which is exactly "it happened again".
          occurrence: since,
          actions: [
            {
              kind: 'explain',
              label: 'Request log',
              payload: { user: r.user_id, api_key_id: r.api_key_id }
            }
          ]
        })
      }
      return { count: out.length, rows: out }
    }
  })

  registerIntegrationSignal({
    id: 'core:import-failed',
    label: 'Import failed',
    description: 'A staged import whose newest run errored.',
    tab: 'inbound',
    severity: 'warn',
    thresholds: [],
    evaluate: async () => {
      const rows = (await db.raw(
        `SELECT q.import_key, d.label, q.id, q.finished_at, LEFT(CAST(q.logs AS nvarchar(max)), 300) AS logs,
                (SELECT MIN(e.id) FROM nivaro_import_queue e
                  WHERE e.import_key = q.import_key AND e.status = 'error'
                    AND e.id > ISNULL((SELECT MAX(c.id) FROM nivaro_import_queue c
                                        WHERE c.import_key = q.import_key AND c.status = 'completed'), 0)
                ) AS first_fail_run_id
           FROM nivaro_import_queue q
           JOIN nivaro_import_definitions d ON d.id = q.definition
          WHERE q.id IN (SELECT MAX(id) FROM nivaro_import_queue WHERE status IN ('completed','error') GROUP BY import_key)
            AND q.status = 'error'
          ORDER BY q.finished_at DESC, q.id DESC`
      )) as Array<{
        import_key: string
        label: string
        id: number
        finished_at: Date | null
        logs: string | null
        first_fail_run_id: number | null
      }>
      const out: SignalRow[] = rows.map((r) => ({
        key: `import:${r.import_key}`,
        title: `${r.label}: last run failed`,
        detail: r.logs ?? undefined,
        since: r.finished_at ? new Date(r.finished_at).toISOString() : undefined,
        // The FIRST failed run since the import last completed — an import
        // that keeps failing run after run is one problem, not a new one per
        // run. A completed run ends it; the next failure starts a new one.
        // The drill still opens the NEWEST failed run (its log is current).
        occurrence: `run:${r.first_fail_run_id ?? r.id}`,
        actions: [{ kind: 'explain', label: 'Open run', payload: { import_run: r.id } }],
        drill: { kind: 'import_run', id: String(r.id) }
      }))
      return { count: out.length, rows: out }
    }
  })

  registerIntegrationSignal({
    id: 'core:import-stale',
    label: 'Import stale',
    description:
      'A staged import whose newest successful run is older than its expected cadence (default 48 h; per-import override "cadence_hours:<key>", 0 = not monitored). An import with no run attempt at all in a long while is dormant instead — not raised here.',
    tab: 'inbound',
    severity: 'warn',
    thresholds: [
      {
        key: 'default_hours',
        label: 'Default cadence',
        default: 48,
        unit: 'hours',
        min: 1,
        max: 2160
      },
      {
        key: 'dormant_days',
        label: 'Treat as dormant after',
        default: 90,
        unit: 'days',
        min: 7,
        max: 3650
      }
    ],
    evaluate: async ({ thresholds }) => {
      const rows = (await db.raw(
        `SELECT d.[key] AS import_key, d.label, MAX(q.finished_at) AS last_ok,
                (SELECT MAX(COALESCE(q2.finished_at, q2.started_at, q2.created_at))
                   FROM nivaro_import_queue q2 WHERE q2.definition = d.id) AS last_attempt
           FROM nivaro_import_definitions d
           LEFT JOIN nivaro_import_queue q ON q.definition = d.id AND q.status = 'completed'
          WHERE d.is_active = 1
          GROUP BY d.id, d.[key], d.label
          ORDER BY d.[key]`
      )) as Array<{
        import_key: string
        label: string
        last_ok: Date | null
        last_attempt: Date | null
      }>
      const out: SignalRow[] = []
      for (const r of rows) {
        // Only imports that have ever run are expected to keep running.
        if (!r.last_ok) continue
        const cadence = importCadence(r.import_key, thresholds, r.last_attempt)
        // Excluded (cadence 0) and dormant imports are never stale.
        if (!isImportStale(r.last_ok, cadence)) continue
        const hours = cadence.hours
        const age = (Date.now() - new Date(r.last_ok).getTime()) / 3600_000
        out.push({
          key: `import:${r.import_key}`,
          title: `${r.label}: no successful run in ${Math.floor(age)} h`,
          detail: `Expected every ${hours} h`,
          since: new Date(new Date(r.last_ok).getTime() + hours * 3600_000).toISOString(),
          // The last SUCCESSFUL run this staleness is measured from. Once a
          // fresh success lands and it later goes stale again, that is a
          // genuinely new instance of "stale" worth raising again.
          occurrence: new Date(r.last_ok).toISOString(),
          actions: []
        })
      }
      return { count: out.length, rows: out }
    }
  })

  registerIntegrationSignal({
    id: 'core:flow-failed',
    label: 'Flow runs failing',
    description: 'Flows whose most recent run ended in error within the window.',
    tab: 'pushes',
    severity: 'warn',
    thresholds: [
      { key: 'window_hours', label: 'Window', default: 24, unit: 'hours', min: 1, max: 168 }
    ],
    evaluate: async ({ thresholds }) => {
      const since = new Date(Date.now() - thresholds.window_hours * 3600_000)
      const rows = (await db.raw(
        `SELECT f.id, f.name, r.id AS run_id, r.error_message, r.started_at,
                (SELECT COUNT(*) FROM nivaro_flow_runs e WHERE e.flow = f.id AND e.status = 'error' AND e.started_at >= ?) AS errors,
                ff.id AS first_fail_run_id, ff.started_at AS first_fail_at
           FROM nivaro_flows f
           OUTER APPLY (
             SELECT MAX(s.started_at) AS last_ok FROM nivaro_flow_runs s
              WHERE s.flow = f.id AND s.status = 'success'
           ) ls
           OUTER APPLY (
             SELECT TOP 1 e.id, e.started_at FROM nivaro_flow_runs e
              WHERE e.flow = f.id AND e.status = 'error'
                -- nivaro_flow_runs.id is a uuid, so "after the last success"
                -- is judged by time, never by id.
                AND (ls.last_ok IS NULL OR e.started_at > ls.last_ok)
              ORDER BY e.started_at ASC, e.id ASC
           ) ff
           JOIN nivaro_flow_runs r ON r.id = (SELECT TOP 1 id FROM nivaro_flow_runs x WHERE x.flow = f.id ORDER BY x.started_at DESC, x.id DESC)
          WHERE r.status = 'error' AND r.started_at >= ?
          ORDER BY r.started_at DESC, f.id`,
        [since, since]
      )) as Array<{
        id: string
        name: string
        run_id: string
        error_message: string | null
        started_at: Date
        errors: number
        first_fail_run_id: string | null
        first_fail_at: Date | null
      }>
      const out: SignalRow[] = rows.map((r) => ({
        key: `flow:${r.id}`,
        title: `${r.name}: failing`,
        detail: `${r.error_message ?? 'error'} · ${r.errors} failed run${Number(r.errors) === 1 ? '' : 's'} in ${thresholds.window_hours} h`,
        since: new Date(r.first_fail_at ?? r.started_at).toISOString(),
        // The FIRST failing run since the flow's last successful one — the
        // same for as long as it keeps failing; a success ends the streak and
        // the next failure starts a new one ("it happened again").
        occurrence: `run:${r.first_fail_run_id ?? r.run_id}`,
        actions: [{ kind: 'explain', label: 'Open flow', payload: { flow: r.id } }]
      }))
      return { count: out.length, rows: out }
    }
  })
}
