/**
 * Core integration signals (spec §3.1 table). Generic — no deployment names.
 * Keys are entity identities so a problem keeps its first_seen across runs.
 */
import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
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
        .select('api_id', 'api_name', 'ok', 'status', 'error', 'created_at')) as Array<{
        api_id: number
        api_name: string | null
        ok: boolean | number
        status: number | null
        error: string | null
        created_at: Date
      }>
      const byApi = new Map<number, typeof calls>()
      for (const c of calls) byApi.set(c.api_id, [...(byApi.get(c.api_id) ?? []), c])
      const rows: SignalRow[] = []
      for (const [apiId, list] of byApi) {
        const { streak, auth } = failureStreak(
          list.map((c) => ({ ok: !!c.ok, status: c.status, error: c.error }))
        )
        if (streak === 0 || (!auth && streak < thresholds.streak)) continue
        const newest = list[0]
        const firstFail = list[streak - 1]
        const name = newest.api_name ?? `API #${apiId}`
        rows.push({
          key: `api:${apiId}`,
          title: auth
            ? `${name}: authentication failing`
            : `${name}: ${streak} failed calls in a row`,
          detail: newest.error ?? (newest.status != null ? `HTTP ${newest.status}` : 'No response'),
          since: new Date(firstFail.created_at).toISOString(),
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
          api: r.api_name,
          record: { collection: r.collection, id: r.item },
          actions: [
            { kind: 'retry_submission', label: 'Retry', id: String(r.id) },
            open(r.collection, r.item)
          ]
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
        out.push({
          key: r.api_key_id ? `key:${r.api_key_id}` : `user:${r.user_id ?? 'none'}`,
          title: `${who}: ${Math.round((errors / calls) * 100)}% of calls failing`,
          detail: `${errors} of ${calls} calls in the last hour`,
          since: r.last_error_at ? new Date(r.last_error_at).toISOString() : undefined,
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
        `SELECT q.import_key, d.label, q.id, q.finished_at, LEFT(CAST(q.logs AS nvarchar(max)), 300) AS logs
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
      }>
      const out: SignalRow[] = rows.map((r) => ({
        key: `import:${r.import_key}`,
        title: `${r.label}: last run failed`,
        detail: r.logs ?? undefined,
        since: r.finished_at ? new Date(r.finished_at).toISOString() : undefined,
        actions: [{ kind: 'explain', label: 'Open run', payload: { import_run: r.id } }]
      }))
      return { count: out.length, rows: out }
    }
  })

  registerIntegrationSignal({
    id: 'core:import-stale',
    label: 'Import stale',
    description:
      'A staged import whose newest successful run is older than its expected cadence (default 48 h; per-import override "cadence_hours:<key>").',
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
      }
    ],
    evaluate: async ({ thresholds }) => {
      const rows = (await db.raw(
        `SELECT d.[key] AS import_key, d.label, MAX(q.finished_at) AS last_ok
           FROM nivaro_import_definitions d
           LEFT JOIN nivaro_import_queue q ON q.definition = d.id AND q.status = 'completed'
          WHERE d.is_active = 1
          GROUP BY d.[key], d.label
          ORDER BY d.[key]`
      )) as Array<{ import_key: string; label: string; last_ok: Date | null }>
      const out: SignalRow[] = []
      for (const r of rows) {
        // Only imports that have ever run are expected to keep running.
        if (!r.last_ok) continue
        const hours = thresholds[`cadence_hours:${r.import_key}`] ?? thresholds.default_hours
        const age = (Date.now() - new Date(r.last_ok).getTime()) / 3600_000
        if (age < hours) continue
        out.push({
          key: `import:${r.import_key}`,
          title: `${r.label}: no successful run in ${Math.floor(age)} h`,
          detail: `Expected every ${hours} h`,
          since: new Date(new Date(r.last_ok).getTime() + hours * 3600_000).toISOString(),
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
        `SELECT f.id, f.name, r.error_message, r.started_at,
                (SELECT COUNT(*) FROM nivaro_flow_runs e WHERE e.flow = f.id AND e.status = 'error' AND e.started_at >= ?) AS errors
           FROM nivaro_flows f
           JOIN nivaro_flow_runs r ON r.id = (SELECT TOP 1 id FROM nivaro_flow_runs x WHERE x.flow = f.id ORDER BY x.started_at DESC, x.id DESC)
          WHERE r.status = 'error' AND r.started_at >= ?
          ORDER BY r.started_at DESC, f.id`,
        [since, since]
      )) as Array<{
        id: string
        name: string
        error_message: string | null
        started_at: Date
        errors: number
      }>
      const out: SignalRow[] = rows.map((r) => ({
        key: `flow:${r.id}`,
        title: `${r.name}: failing`,
        detail: `${r.error_message ?? 'error'} · ${r.errors} failed run${Number(r.errors) === 1 ? '' : 's'} in ${thresholds.window_hours} h`,
        since: new Date(r.started_at).toISOString(),
        actions: [{ kind: 'explain', label: 'Open flow', payload: { flow: r.id } }]
      }))
      return { count: out.length, rows: out }
    }
  })
}
