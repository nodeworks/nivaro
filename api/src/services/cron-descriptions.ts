/**
 * Plain-language purpose of every core cron job — what it does, what it
 * touches, who it tells. Surfaced on the Background Jobs page so an operator
 * reading "rollup-drift-sweep" doesn't have to open the source to learn what
 * running it now would do. Extensions describe their own jobs through the
 * `description` option on ctx.cron.schedule(); anything missing here reads
 * as an undescribed job on the page, which is the cue to add it.
 */
export const CRON_DESCRIPTIONS: Record<string, string> = {
  // ── Delivery & notifications ──
  'daily-action-digest':
    'Hourly at :45 — sends the "daily action summary" email to users whose delivery hour matches: deferred emails, records waiting on them, invoices to review. Flushes nivaro_deferred_emails.',
  'digest-daily':
    'Daily notification digest email — every unread notification since the last digest, for users on the daily cadence. Advances last_digest_at.',
  'digest-weekly':
    'Weekly notification digest email (Monday) — same as the daily digest for users on the weekly cadence.',
  'view-subscriptions-daily':
    'Re-runs every subscribed saved view as its subscriber and emails the records that entered it since yesterday.',
  'view-subscriptions-weekly': 'Weekly (Monday) version of the saved-view digest.',
  'report-studio-daily':
    'Renders each subscribed Report Studio report as the subscriber and delivers the daily digest (email, in-app, Teams, PDF per subscription).',
  'report-studio-weekly': 'Weekly (Monday) Report Studio digest delivery.',
  'report-studio-alerts':
    'Evaluates every active Report Studio alert against its widget data; opens a firing row and notifies subscribers, resolves when back in range.',
  'report-snapshots-weekly':
    'Captures a point-in-time metric snapshot for reports scheduled weekly (used by vs-then comparisons).',
  'report-snapshots-monthly': 'Monthly (1st) report metric snapshot capture.',
  'metric-alerts-hourly':
    'Checks every metric alert rule on the hourly cadence (custom-query or collection-count metrics) and fires or resolves them.',
  'metric-alerts-daily': 'Daily metric alert rule checks.',
  'metric-alerts-weekly': 'Weekly (Monday) metric alert rule checks.',
  'metric-alerts-digest-daily':
    'Emails subscribers on the daily digest cadence a summary of their currently firing metric alerts.',
  'metric-alerts-digest-weekly': 'Weekly (Monday) metric alert digest.',
  'anomaly-checks-daily':
    'Runs daily anomaly rules (amount outliers, period spikes, duplicate patterns) over their source queries; logs detections and notifies the rule creator.',
  'anomaly-checks-weekly': 'Weekly (Monday) anomaly rule checks.',
  'alert-definitions-sweep':
    'Hourly re-evaluation of per-record alert definitions (thresholds and anomalies on nivaro_alert_definitions) so time-based conditions fire without a write.',
  'sla-escalations':
    'Every 30 minutes — finds breached SLA records whose escalation ladder has a tier due and notifies the tier target (owner, manager, named user) once per episode.',
  'line-sla-sweep':
    'Daily — records with grid lines still missing a required id past their line-SLA window; notifies current owners once per day and feeds the digest.',
  'queue-entry-notify':
    'Every 5 minutes — tells queue subscribers about items that newly entered their queue.',
  'scheduled-broadcasts':
    'Every minute — delivers announcements whose scheduled send time has arrived (banner, inbox, email, SMS per channel config).',
  'broadcast-ack-chasers':
    'Hourly — reminds users who have not acknowledged a must-acknowledge broadcast, and tells its author how many are outstanding.',
  'chat-reminders':
    'Every 5 minutes — delivers reminders the chat bot set ("remind me Friday 9am") as in-app notifications.',
  'outbox-worker':
    'Every minute — retries notification and email deliveries that failed and were parked in the outbox.',
  'extension-events-sweep':
    'Every minute — delivers pending extension outbox events to their handlers with exponential backoff; dead after 8 attempts.',

  // ── Workflow & data upkeep ──
  'workflow-auto-sweep':
    'Hourly — re-evaluates automatic (condition-driven) pipeline transitions on open instances so date conditions that flipped by time alone still move records.',
  'ooo-schedule':
    'Every 15 minutes — flips users into/out of out-of-office on their scheduled window and reassigns their open tasks to the delegate.',
  'access-requests-expire':
    'Daily — closes access requests nobody acted on within 14 days and tells the requester.',
  'staged-imports':
    'Every 10 seconds — starts the next queued staged import (file → staging table → stored procedure) when nothing else is running.',
  'erp-auto-retry':
    'Every 10 minutes — retries failed ERP submissions (MDSi, MWF, Fusion, Nuvolo pushes) that are eligible for automatic retry.',
  'maintenance-windows':
    'Every minute — turns maintenance mode on/off at scheduled window boundaries, pre-announces upcoming windows, sends the all-clear after a passing smoke check.',
  'presence-janitor':
    'Every 5 minutes — clears is_online on presence rows whose last heartbeat is stale (survives API restarts that strand the flag).',
  'file-cleanup': 'Hourly — deletes files whose expires_at has passed.',

  // ── Integrity sweeps ──
  'rollup-drift-sweep':
    'Nightly — samples stored rollup fields against a fresh computation and raises one issue per drifting field with the worst offenders. Detects only; never rewrites values.',
  'fk-integrity-sweep':
    'Nightly — counts dangling foreign keys per registered relation and raises an issue naming the offenders.',
  'file-integrity-sweep':
    'Nightly — checks nivaro_files rows against storage (missing or orphaned objects) and raises an issue.',
  'dead-link-sweep':
    'Nightly — finds references to deleted records and files across config surfaces and raises an issue.',
  'dq-nightly':
    'Nightly — runs every active data-quality rule (not_null, regex, range, unique, formula) and records pass/fail counts with failing rows.',
  'conformance-nightly':
    'Nightly — re-runs Data Integrity sweeps for collections with a schedule and notifies whoever scheduled it when violations grow.',
  'config-health-sweep':
    'Nightly — usage hygiene + schema lint findings (unopened queues, orphan relations, missing display templates…) into the Config Health page.',
  'subscription-integrity':
    'Weekly (Sunday) — deactivates notification subscriptions whose collection, field, or queue no longer exists.',

  // ── Ops telemetry ──
  'ops-monitors':
    'Every 5 minutes — evaluates freshness, deploy-regression, and synthetic monitors; raises an issue and notifies subscribers when one flips to failing.',
  'deadlock-sweep':
    'Hourly — reads SQL Server deadlock events from the DMVs into the DB Health console.',
  'blocking-sessions':
    'Every 5 minutes — raises one deduped issue when a blocking chain has held for over 15 seconds, naming the head blocker.',
  'pool-monitor':
    'Every 5 minutes — samples DB connection pool usage and leak attribution for the DB Health console.',
  'concurrency-sample':
    'Every 5 minutes — records connected socket / active user counts for the concurrency chart on the Realtime console.',
  'storage-snapshot': 'Nightly — records storage usage so DB Health can project the runway.',
  'readiness-snapshot':
    'Daily — scores the go-live readiness checks and stores the result for the trend line.',
  'queue-stats-snapshot':
    'Nightly at 02:00 — per-queue and per-owner stat snapshots (totals, unowned, SLA, at-risk) that power the queue trend sparklines.'
}
