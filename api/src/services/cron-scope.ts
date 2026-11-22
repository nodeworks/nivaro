/**
 * Which scheduled jobs run once per app and which run once per process (Hub phase 5).
 *
 * On a Hub shared deployment (`perAppJobs()`), one process serves many apps, each with its own
 * database. A job that reads or writes an app's data runs once per active app, inside that app's
 * tenant context ('app'). A job that samples or serves the process itself (its traffic, sockets,
 * pool, hosts, drainers) runs once, with no tenant, exactly as it does today ('process').
 *
 * Self-hosted and Nivaro Cloud never read this: every job runs as it always has.
 *
 * Every core job id passed to `app.cron.schedule` is listed here; test/unit/cron-scope.guard.test.ts
 * fails on one that is missing. A key ending in `*` covers the ids a row schedule builds from that
 * prefix. Extension jobs are not listed: they default to 'app' unless they pass `scope`.
 *
 * Leaf module: no imports.
 */
export type CronScope = 'app' | 'process'

export const CORE_CRON_SCOPES: Record<string, CronScope> = {
  // ── process: samples or serves this process / deployment, not one app ──────────────────────
  // Traffic Map: the deployment's own request taps and the history they push.
  'traffic-map-snapshots': 'process',
  'traffic-minutes-write': 'process', // writes the minutes this process's taps pushed
  'traffic-minutes-prune': 'process', // prunes that same process-written history
  'traffic-baselines-rollup': 'process', // rolls up that history into baselines
  'concurrency-sample': 'process', // counts this process's sockets
  'pool-monitor': 'process', // this process's knex pool pressure
  'infra-drift-check': 'process', // Docker stack drift of the deployment's hosts
  'infra-health-sample': 'process', // Docker host health samples
  'restore-drill': 'process', // restores the server's backup into a scratch database (operator)
  'chaos-gamedays': 'process', // fault drills against this deployment
  'chaos-monkey': 'process', // random fault drills against this deployment
  'chaos-test-overlap': 'process', // the chaos lease-split drill's own sleeping job
  'staged-imports': 'process', // drains the process-wide import hand-off queue
  'huddle-turn-probe': 'process', // probes the deployment's TURN servers
  'huddle-sessions-sweep': 'process', // deployment-wide Redis huddle session keys (no tenant)
  'huddle-sessions-prune': 'process', // same store, pruned with no tenant

  // ── app: reads or writes one app's database, files or people ───────────────────────────────
  'access-requests-expire': 'app',
  'activity-seal': 'app',
  'activity-trail-verify': 'app',
  'agent-questions-expire': 'app',
  'agent-trigger-retries': 'app',
  'ai-knowledge-check': 'app',
  'ai-model-catalogue': 'app',
  'ai-plans-scheduled': 'app',
  'ai-spend-rollup': 'app',
  'ai-undo-prune': 'app',
  'ai-watch-checks': 'app',
  'alert-definitions-sweep': 'app',
  'anomaly-checks-daily': 'app',
  'anomaly-checks-weekly': 'app',
  'api-key-usage-statements': 'app',
  'blocking-sessions': 'app',
  'broadcast-ack-chasers': 'app',
  'cache-warm': 'app',
  'chat-archive-suggestions': 'app',
  'chat-dm-email-fallback': 'app',
  'chat-drafts-prune': 'app',
  'chat-polls-close': 'app',
  'chat-reminders': 'app',
  'chat-scheduled-send': 'app',
  'config-health-sweep': 'app',
  'config-review-monthly': 'app',
  'config-snapshot': 'app',
  'conformance-nightly': 'app',
  'cron-miss-detector': 'app',
  'cumulative-flow-rollup': 'app',
  'daily-action-digest': 'app',
  'dashboard-headline-snapshot': 'app',
  'db-tuning-observe': 'app',
  'db-tuning-watch': 'app',
  'dead-link-sweep': 'app',
  'deadlock-sweep': 'app',
  'device-grants-sweep': 'app',
  'directory-sync': 'app',
  'dq-nightly': 'app',
  'erp-auto-retry': 'app',
  'event-journal-prune': 'app',
  'extension-events-sweep': 'app',
  'external-api-contracts': 'app',
  'external-api-health-probes': 'app',
  'file-cleanup': 'app',
  'file-integrity-sweep': 'app',
  'fk-integrity-sweep': 'app',
  'help-video-next': 'app',
  'help-video-render-sweep': 'app',
  'help-video-stale-check': 'app',
  'help-video-storage-sweep': 'app',
  'huddle-schedules': 'app',
  'integration-reconcile': 'app',
  'integration-signals': 'app',
  'layout-review-reminders': 'app',
  'layout-schedules': 'app',
  'layout-usage-prune': 'app',
  'line-sla-sweep': 'app',
  'log-alert-requests': 'app',
  'mail-retry': 'app',
  'maintenance-windows': 'app',
  'mcp-idle-review': 'app',
  'metric-alerts-daily': 'app',
  'metric-alerts-digest-daily': 'app',
  'metric-alerts-digest-weekly': 'app',
  'metric-alerts-hourly': 'app',
  'metric-alerts-weekly': 'app',
  'notification-escalation': 'app',
  'ooo-schedule': 'app',
  'ops-daily-report': 'app',
  'ops-incident-updates': 'app',
  'ops-monitors': 'app',
  'outbox-worker': 'app',
  'outside-write-watch': 'app',
  'presence-janitor': 'app',
  'query-cache-warmers': 'app',
  'queue-cache-heal': 'app',
  'queue-entry-notify': 'app',
  'queue-stats-snapshot': 'app',
  'raw-write-announcements': 'app',
  'readiness-snapshot': 'app',
  'ready-to-send': 'app',
  'record-drafts-prune': 'app',
  'report-snapshots-monthly': 'app',
  'report-snapshots-weekly': 'app',
  'report-studio-alerts': 'app',
  'report-studio-daily': 'app',
  'report-studio-weekly': 'app',
  'rollup-drift-sweep': 'app',
  'scheduled-broadcasts': 'app',
  'scheduled-changes-apply': 'app',
  'session-frustration': 'app',
  'session-replay-heat': 'app',
  'session-replay-tiering': 'app',
  'sla-escalations': 'app',
  'sla-live-flips': 'app',
  'sql-checks': 'app',
  'staged-import-staging-purge': 'app',
  'storage-snapshot': 'app',
  'subscription-integrity': 'app',
  'task-done-when-sweep': 'app',
  'task-reminders': 'app',
  'team-alerts': 'app',
  'tracker-outbox': 'app',
  'tracker-prune': 'app',
  'tracker-reconcile': 'app',
  'tracker-sweep': 'app',
  'view-subscriptions-daily': 'app',
  'view-subscriptions-weekly': 'app',
  'watch-list-completed': 'app',
  'watch-list-digest': 'app',
  'watch-list-overdue': 'app',
  'workflow-auto-sweep': 'app',

  // ── row schedules (services/row-schedules.ts; off in every multi-tenant process today) ─────
  'retention-policy-*': 'app',
  'scheduled-report-*': 'app',
  'activity-view-*': 'app',
  'sync-job-*': 'app',
  'flow:*': 'app'
}

/** The scope one job runs in on a shared deployment: the core map, else the job's own
 *  `scope`, else 'app' (an extension job reads its app's data unless it says otherwise). */
export function cronScope(
  id: string,
  opts?: { scope?: CronScope; extensionId?: string }
): CronScope {
  const own = CORE_CRON_SCOPES[id]
  if (own) return own
  for (const [key, scope] of Object.entries(CORE_CRON_SCOPES)) {
    if (key.endsWith('*') && id.startsWith(key.slice(0, -1))) return scope
  }
  return opts?.scope ?? 'app'
}
