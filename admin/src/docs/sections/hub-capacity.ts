import type { DocSection } from '../types.js'

// Hub capacity (ideas 9, 13, 15, 16), checked against api/src/services/capacity/*,
// api/src/services/hub/capacity/*, routes/hub-capacity.ts, routes/hub-capacity-link.ts and
// admin/src/pages/hub/capacity.

export const hubCapacityDocs: DocSection = {
  id: 'hub-capacity',
  label: 'Capacity and limits',
  content: [
    { type: 'h1', id: 'hub-capacity', text: 'Capacity and limits' },
    {
      type: 'p',
      text: 'The Capacity tab of the Apps hub (`/hub/capacity`, Hub administrators) shows what each shared deployment and each dedicated stack uses, suggests moves, sets per-app limits on a shared deployment and rebalances shared deployments. Every figure is a count, a timing or a byte total: never a record, a name or a connection.'
    },
    { type: 'h2', id: 'hub-capacity-figures', text: 'What is measured' },
    {
      type: 'p',
      text: 'Every 15 minutes the job `hub-capacity-sample` reads each shared deployment over its deployment link (`GET /api/hub-deployment/usage`) and each hub-linked dedicated environment over its hub link (`GET /api/hub-link/usage`), with the same bearer as the link itself. It stores one row per deployment and per environment in `nivaro_hub_capacity_samples` and keeps 31 days. Sample now on the tab runs it at once.'
    },
    {
      type: 'table',
      head: ['Figure', 'Where it comes from'],
      rows: [
        [
          'CPU',
          'Percent of one core used by each process since its last snapshot, summed over the processes. Per app on a shared deployment it is an estimate: the deployment CPU split by the app’s share of answering time.'
        ],
        [
          'Memory',
          'Resident memory of each process, summed. Not split per app on a shared deployment.'
        ],
        [
          'Requests and answering time',
          'API requests per minute and milliseconds spent answering them per minute, mean over the last 15 complete minutes, per app. Health probes and the Hub’s own link calls are left out.'
        ],
        [
          'Database connections',
          'Connections in use in the app’s own pool against its pool size (on a shared deployment: against the deployment’s connection budget for the totals).'
        ],
        [
          'Background work',
          'Job runs running in the app (`nivaro_job_runs`) and job turns waiting for a slot under its jobs limit.'
        ],
        [
          'Files',
          'The size of every file the app stores (sum of `nivaro_files.filesize`), read at most once an hour.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Each process writes its snapshot to Redis every 30 seconds (`nvr:hubcap:<scope>:p:<process>`, two-minute expiry), so whichever replica answers the Hub sums every replica. Without Redis it answers for itself and the sample is marked partial. An app on a version before 0.3.215 has no usage route: its sample says so (`NO_USAGE_ROUTE`) and the trend shows a gap, never a zero.'
    },
    {
      type: 'p',
      text: 'An app whose share of its deployment’s requests, answering time or connections is half or more (`most_share`) is flagged "Uses most of the deployment", on a deployment serving two apps or more.'
    },
    { type: 'h2', id: 'hub-capacity-advisor', text: 'Move advisor' },
    {
      type: 'p',
      text: 'The advisor reads the last 7 days of samples (at least `min_samples`, default 96 = one day) and suggests:'
    },
    {
      type: 'ul',
      items: [
        '**Fits shared**: a dedicated environment whose 95th percentile of requests per minute, memory and connections in use, and whose file storage, are under the thresholds (30 requests/min, 768 MB, 3 connections, 20 GB by default), and whose shared-readiness report names no blocker. The target is the active shared deployment with the most connections left.',
        '**Outgrew shared**: an environment on a shared deployment whose share of the deployment (requests, answering time or connections) was 50% or more in at least 60% of the samples, or whose requests per minute passed 600 at the 95th percentile.'
      ]
    },
    {
      type: 'p',
      text: 'Each suggestion lists its reasons with the figures. Plan the move opens the app’s Move panel with the target picked (`/hub?app=<id>&move=<env>&to=shared:<id>`; for outgrew shared the person picks the dedicated stack). It is a plan only: the person reads the plan, ticks the checklist and types the confirmation there. Thresholds: `GET/PUT /api/hub/capacity/settings`.'
    },
    { type: 'h2', id: 'hub-capacity-limits', text: 'Per-app limits on a shared deployment' },
    {
      type: 'table',
      head: ['Limit', 'What the app gets past it'],
      rows: [
        [
          'Requests per minute (10–1,000,000)',
          '429 `APP_RATE_LIMITED` with `Retry-After` until the next minute. Counted in Redis across every web process (`nvr:applimit:rpm:<app>:<minute>`); when Redis does not answer within 250 ms each process counts alone. Probes, the Hub links and the file transfer of a move are never counted.'
        ],
        [
          'Background jobs at once (1–16)',
          'Each turn of a scheduled job for the app waits for one of its slots, first come first served, up to 5 minutes; then it is skipped (`app_limit` in the job run) and runs at its next time. Per process.'
        ],
        [
          'File storage (MB)',
          '413 `APP_STORAGE_FULL` on an upload that would pass it. Files already stored stay.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Set them in the Limits column of a deployment’s app table (`PUT /api/hub/capacity/limits/:envId`, empty = no limit; refused `MOVE_OPEN` while a move holds the environment). They are stored per environment (`nivaro_hub_app_limits`), listed with the app in the tenants answer (`limits`) and the deployment is asked to re-read its list at once, so they apply within a minute. A bad limit in the list is dropped alone; the app is still served. Apps need 0.3.215 or later on the deployment.'
    },
    { type: 'h2', id: 'hub-capacity-rebalance', text: 'Rebalance' },
    {
      type: 'p',
      text: 'Pick two or more active shared deployments and Plan the moves. The planner weighs each app by its mean answering time per minute over 7 days (else its requests) and moves, while it helps, the app from the busiest deployment to the quietest whose load is nearest half the gap, never past the target’s connection budget, never an app with an open move or not active, each app once, at most 5 moves. Each move is then planned by the move planner: a move with blockers, or whose names change by hand (manual routing), is left out and named.'
    },
    {
      type: 'ul',
      items: [
        'Tick each move’s required checklist items, choose the quiet window (start, end, time zone; a window past midnight wraps) and type `rebalance`.',
        'The job `hub-rebalance-tick` (every minute) starts the next move only inside the window, waits while it is open, moves on after a success and stops at the first move that ends any other way (failed, rolled back, cancelled) or cannot start (for example 409 `PLAN_CHANGED` when the plan changed since you checked it). Each move is a normal move: its locks, checks, rollback and history are the move engine’s own.',
        'Cancel stops before the next move. A move already running is never cancelled by the rebalance; cancel it on its own Move panel. One open rebalance per deployment.'
      ]
    }
  ]
}
