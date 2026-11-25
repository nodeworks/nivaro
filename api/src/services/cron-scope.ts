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
  'app-concurrency-sample': 'app', // shared deployments only: the app's own sockets and people
  'app-pool-monitor': 'app', // shared deployments only: the app's own pool (app-pool-pressure.ts)
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
  'hub-capacity-sample': 'app', // Hub capacity: the Hub's own samples (HUB=on only, never shared)
  'hub-creation-waits': 'app', // Hub phase 3: the Hub's own creation rows (HUB=on only, never shared)
  'hub-rebalance-tick': 'app', // Hub rebalance runs (HUB=on only, never shared)
  'hub-release-ops': 'app', // Hub release operations: trains, schedules (HUB=on only, never shared)
  'hub-release-rollback': 'app', // Hub release operations: automatic rollback watches (HUB=on only),
  'hub-break-glass': 'app', // Hub security: the Hub's own break-glass rows (HUB=on only, never shared)
  'hub-break-glass-expire': 'app', // apps linked to a Hub: puts back an ended break-glass grant's role (per app)
  'hub-security-tick': 'app', // Hub security: access reviews + TLS watch (HUB=on only, never shared)
  'hub-vuln-scan': 'app', // Hub security: image scan (HUB=on only, never shared)
  'hub-data-tick': 'app', // Hub data care: the Hub's own backup policies and data runs (HUB=on only, never shared)
  'hub-signins-prune': 'app', // Hub phase 7: the Hub's own sign-in rows (HUB=on only, never shared)
  'hub-ops-collect': 'app', // Hub ops: the Hub's own issue/storage rows (HUB=on only, never shared)
  'hub-secrets': 'app', // Hub ops: the Hub's own secret rows (HUB=on only, never shared)
  'hub-fleet-probe': 'app', // Hub fleet: probes the Hub's environments (HUB=on only, never shared)
  'hub-fleet-rollup': 'app', // Hub fleet: hourly uptime rollups (HUB=on only, never shared)
  'hub-fleet-alerts': 'app', // Hub fleet: version drift alerts (HUB=on only, never shared)
  'hub-fleet-prune': 'app', // Hub fleet: uptime samples past 45 days (HUB=on only, never shared)
  'hub-slo-report': 'app', // Hub fleet: monthly SLO report (HUB=on only, never shared)
  'huddle-schedules': 'app',
  'integration-reconcile': 'app',
  'integration-signals': 'app',
  'job-runs-prune': 'app', // shared deployments only: the boot retention purge is self-hosted
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
  'retention-pass': 'app', // shared deployments only: self-hosted runs the pass from its boot chain
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
  // drains the app's own import queue and hand-off keys (services/import-handoff.ts); the kick
  // subscriber started at boot drains the app a kick names at once
  'staged-imports': 'app',
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

  // ── row schedules (services/row-schedules.ts) ──────────────────────────────────────────────
  // Never in Nivaro Cloud. On a shared deployment each one is bound to the app whose row it is
  // (scheduled inside that app: plugins/cron.ts boundCronKey) and runs in that app only, never
  // fanned out; 'app' below is the scope of its id, not a fan-out.
  'row-schedules-resync': 'app', // shared deployments only: re-reads each app's schedule rows
  'retention-policy-*': 'app',
  'scheduled-report-*': 'app',
  'activity-view-*': 'app',
  'sync-job-*': 'app',
  'flow:*': 'app'
}

/**
 * Core jobs a shared deployment never registers (Hub phase 5, ruling P5-9), with the reason.
 * Each one reaches something that is not one app's and has no per-app form yet: the host, the
 * process's own operator stores, or storage that is not keyed per app. Its own code already
 * refuses on a multi-tenant process, or running it once per app would be wrong. Self-hosted
 * and Nivaro Cloud register them exactly as before (cloud registers none of the server.ts jobs).
 * Every id here is also in CORE_CRON_SCOPES.
 */
export const SELF_HOSTED_ONLY_CRONS: Record<string, string> = {
  'restore-drill': 'restores the server backup into a scratch database; refused on multi-tenant',
  'chaos-gamedays': 'fault drills: the chaos gate refuses every multi-tenant process',
  'chaos-monkey': 'fault drills: the chaos gate refuses every multi-tenant process',
  'chaos-test-overlap': 'the chaos lease-split drill job; the chaos gate refuses multi-tenant',
  'infra-drift-check': 'Docker stack drift of the host; operator infrastructure',
  'infra-health-sample': 'Docker host health samples; operator infrastructure',
  'traffic-map-snapshots': 'Traffic Map store is the process’s own; refused on multi-tenant',
  'traffic-minutes-write': 'Traffic Map minute history: no deployment store yet',
  'traffic-minutes-prune': 'Traffic Map minute history: no deployment store yet',
  'traffic-baselines-rollup': 'Traffic Map baselines: no deployment store yet',
  'huddle-turn-probe': 'huddle crons are off on multi-tenant (operator TURN hosts)',
  'huddle-sessions-sweep': 'huddle crons are off on multi-tenant',
  'huddle-sessions-prune': 'huddle crons are off on multi-tenant',
  // file-cleanup and session-replay-tiering run per app since Hub phase 6: every storage call
  // they make goes through getStorage() / the app's own settings driver, which a shared
  // deployment scopes to apps/<tenantId>/ (services/storage/app-scope.ts).
  'storage-snapshot':
    "walks the upload folder on disk directly (UPLOAD_DIR), outside the per-app storage scope: it would record the whole deployment's files as one app's",
  'help-video-render-sweep':
    'the render pump state is process-wide; a per-app render queue is phase 6 (a publish still renders its own video in the request)'
}

/**
 * Deployment-wide ('process') core jobs whose only output is the static database: on a shared
 * deployment they would sample and write nothing anywhere, so server.ts registers them self-hosted
 * only (P5-10). There the figure that is per app runs as an app job of its own (app-pool-monitor,
 * app-concurrency-sample: each app's pool and sockets, stored in that app), and the process's own
 * figures are on the deployment link status (routes/hub-deployment-link.ts). They stay 'process'
 * here, so a manager can still run them.
 */
export const NO_DEPLOYMENT_STORE_CRONS: Record<string, string> = {
  'pool-monitor':
    "reads the process's static pool and raises an issue in the static database; on a shared deployment each app's own pool is judged by app-pool-monitor, and the process figures are on the deployment link status",
  'concurrency-sample':
    "writes socket counts to the static database; on a shared deployment each app's own sockets are sampled by app-concurrency-sample, and the process's total is on the deployment link status"
}

/** Whether a shared deployment leaves this core job out (SELF_HOSTED_ONLY_CRONS). */
export function selfHostedOnlyCron(id: string): boolean {
  return Object.hasOwn(SELF_HOSTED_ONLY_CRONS, id)
}

/** The scope a job declares: the core map (exact id, then a `*` prefix), else its own `scope`,
 *  else 'app' for an extension job (Decision 10: an extension job reads its app's data unless
 *  it says otherwise), else null: a job that says nothing. */
export function explicitCronScope(
  id: string,
  opts?: { scope?: CronScope; extensionId?: string }
): CronScope | null {
  const own = CORE_CRON_SCOPES[id]
  if (own) return own
  for (const [key, scope] of Object.entries(CORE_CRON_SCOPES)) {
    if (key.endsWith('*') && id.startsWith(key.slice(0, -1))) return scope
  }
  if (opts?.scope) return opts.scope
  return opts?.extensionId ? 'app' : null
}

/** The scope one job runs in on a shared deployment: the core map, else the job's own
 *  `scope`, else 'app' (an extension job reads its app's data unless it says otherwise). */
export function cronScope(
  id: string,
  opts?: { scope?: CronScope; extensionId?: string }
): CronScope {
  return explicitCronScope(id, opts) ?? 'app'
}
