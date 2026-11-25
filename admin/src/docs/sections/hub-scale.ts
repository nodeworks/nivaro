import type { DocSection } from '../types.js'

// Hub scaling (manual + automatic), checked against api/src/services/hub/scale/*,
// routes/hub-scale.ts, api/src/services/capacity/scale-figures.ts, packages/hub-agent/src/scale.ts
// and admin/src/pages/hub/scale.

export const hubScaleDocs: DocSection = {
  id: 'hub-scale',
  label: 'Scaling',
  content: [
    { type: 'h1', id: 'hub-scale', text: 'Scaling' },
    {
      type: 'p',
      text: 'The Scaling tab of the Apps hub (`/hub/scale`, Hub administrators) changes how many processes each role of a Docker stack runs, and their CPU and memory limits, on dedicated stacks and on shared deployments, by hand or by rules. Every change is a scale run with its reason and the figures behind it. It needs Hub agent 0.2.4 or later (`AGENT_TOO_OLD` otherwise).'
    },
    { type: 'h2', id: 'hub-scale-roles', text: 'Roles and what may change' },
    {
      type: 'table',
      head: ['Role', 'Replicas', 'Limits'],
      rows: [
        ['web', 'Any number from 1 (never below one).', 'CPU and memory per process.'],
        [
          'realtime',
          'From 1 while web runs `SOCKETS=off` (size large). A scale-in stops one process at a time, with a minute between steps, so the closed connections reconnect to the others.',
          'CPU and memory per process.'
        ],
        ['importer, exporter', 'From 1.', 'CPU and memory per process.'],
        [
          'worker',
          'Always 1: it ticks every scheduled job through one leader and fans out every app’s jobs.',
          'CPU and memory may change.'
        ],
        [
          'all (size small)',
          'Fixed: one process runs everything. Change the stack’s size to split it.',
          'CPU and memory may change.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'The numbers are kept per stack and role (`nivaro_hub_scale_roles`) on top of the size template, and both stack renderers lay them over it: a promotion, Apply now, a shared upgrade, a move or a restart renders the scaled stack, never the template’s numbers again. A role the template does not run (after a size change) keeps its numbers but they apply to nothing. The agent always rolls with start-first: a replica change starts or stops processes and restarts none; a limit change replaces that role’s processes one at a time, each new one started before the old one stops, and rolls back on failure.'
    },
    {
      type: 'warn',
      text: 'A SQLite app never runs past one process (SQLite allows one writer): its stack, or a shared deployment that serves one, refuses every change that adds a process (`SQLITE_ONE_PROCESS`).'
    },
    { type: 'h2', id: 'hub-scale-connections', text: 'Database connections' },
    {
      type: 'p',
      text: 'Every scale plan shows the connection math, and a scale past a database server’s limit is refused (`DB_CONNECTIONS`) unless it lowers the connections. Set each server’s max connections on the Scaling tab (Database server limits). Without a limit (or without a database record for the stack’s database) autoscaling never adds processes (`DB_LIMIT_UNKNOWN`), a change by hand warns and asks for the typed key, and scaling in always runs.'
    },
    {
      type: 'ul',
      items: [
        'Dedicated stack: processes × (DB_POOL_MAX + DB_POOL_BACKGROUND_MAX + 1), from the stack settings, else 60 + 10; the 1 is each process’s health probe connection.',
        'Shared deployment: processes × the sum of each app’s pool (`pool_max`, default 5). The pool budget caps that sum for one process; the plan shows both.',
        'Every other Hub stack whose database record lives on the same server is counted too (its processes × its pools), at the higher of its kept numbers and the target of a scale run still open on it. Plans on the same server are taken one at a time (a short lock per server), so two changes started together never both use the same headroom.',
        'Databases the Hub has no record of, a migration pool at boot and the server’s own reserved connections are not counted: leave room for them in the limit.'
      ]
    },
    {
      type: 'note',
      text: 'The limit is checked by scaling only. Placing an app on a shared deployment, creating an app, a size change by a promotion or Apply now, and a shared upgrade that adds roles are judged by their own plans, not against this limit.'
    },
    { type: 'h2', id: 'hub-scale-manual', text: 'Changing it by hand' },
    {
      type: 'p',
      text: 'Change… opens the numbers of every role; Plan the change shows what changes, the steps, the connections, and what stops it. Start is bound to that plan (`409 PLAN_CHANGED` when anything moved since) and, on a production environment or a shared deployment, asks for its key. Changes wait while a move into or out of the stack is open (`MOVE_OPEN`), while another action holds it (a promotion, Apply now, a restart, an upgrade, a placement) and while another scale of it runs. A release freeze or an open incident only warns a person: automatic scaling pauses, a change by hand still runs.'
    },
    { type: 'h2', id: 'hub-scale-auto', text: 'Autoscaling rules' },
    {
      type: 'p',
      text: 'Each scalable role may have one rule. The job `hub-scale-tick` runs every minute on the cron leader (Hub only): it reads the stack’s figures live over its link and judges each enabled rule of a role not pinned to manual.'
    },
    {
      type: 'table',
      head: ['Figure', 'Meaning'],
      rows: [
        ['CPU', 'Mean CPU of the role’s processes as a percent of its CPU limit.'],
        ['Memory', 'Mean memory of the role’s processes as a percent of its memory limit.'],
        ['Requests', 'Requests per minute per web replica.'],
        [
          'p95 answer time',
          'p95 of the role’s answer times over the last 5 minutes, every replica (bucketed: the bound of the bucket it falls in).'
        ],
        ['Heavy reads waiting', 'Heavy reads queued in the role’s read gates.'],
        ['Imports / exports waiting', 'Runs waiting in the hand-off queues (importer / exporter).']
      ]
    },
    {
      type: 'ul',
      items: [
        'Out: any figure above its out mark for `sustain` checks in a row (default 3) adds one step (`step`, 1–3; realtime always 1), up to `max`.',
        'In: every figure with a value below its in mark for `sustain_in` checks (default 10) removes one step, down to `min`. The in mark must be below the out mark.',
        'A change waits `cooldown_out_min` / `cooldown_in_min` after the last one and there is at most one step every `step_every_min` minutes.',
        'Schedules raise the floor inside a window on the calendar of its time zone (weekdays 07:00–19:00 America/New_York: at least 4). A window past midnight belongs to the day it starts.',
        'A figure the app does not answer (an app before 0.3.215, a read that failed) is never read as zero: it counts for neither direction.',
        'Pin manual leaves a role alone; its rule is kept.'
      ]
    },
    {
      type: 'p',
      text: 'Automatic scaling pauses during moves, shared upgrades, promotions, release freezes and open incidents (an incident for the app, or for this environment), and while anything else holds the stack; it reads no figures then. After a failed automatic change it waits 10 minutes, after a second 20; the third failure in a row pauses the stack’s rules, tells the app’s admins and owners once, and shows Resume rule on the Scaling tab. A decision that could not run is logged as a `skipped` row with the same reason and figures (at most one per stack and cause every 30 minutes). A rule that wants more than its max three times in 24 hours shows on the tab, warns in readiness (`hub-scale-max`) and tells the app’s admins and owners once a day; every automatic change, and every failed one, tells them too.'
    },
    { type: 'h2', id: 'hub-scale-runs', text: 'Runs, heartbeat and resume' },
    {
      type: 'p',
      text: 'A run holds the environment’s lock (or the shared deployment’s, holder `scale`), renews it with a heartbeat and checks it again right before every call to the agent and before it keeps new numbers: a run that lost it stops (`LOCK_LOST`) and sends nothing more. Each step renders the spec the stack runs now (the recorded image and pins, the saved settings and the numbers before the step) and asks the agent to change only that step’s numbers, then waits for swarm to settle. A run whose process stopped is resumed by the tick from its step: the agent answers `already` for a step it applied, so nothing is applied twice; one tick claims a stopped run, and an automatic run does not resume into a move, freeze or incident that began meanwhile. When the Hub cannot see how a step ended (a timeout, the agent unreachable, the lock lost) it reads the live stack and keeps what runs, so the next Apply now or promotion renders that and never scales back. When swarm rolls one role back, the run puts the other roles back to the numbers before the step. A later scale or restart refused `SPEC_MISMATCH` first adopts what runs, then tries once more. Stop after this step ends a realtime drain between steps; what ran keeps running.'
    },
    { type: 'h2', id: 'hub-scale-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'What it does'],
      rows: [
        ['GET /api/hub/scale', 'Every Docker stack the Hub scales, per role.'],
        [
          'GET /api/hub/scale/targets/:kind/:id',
          'One stack (`environment` or `shared`): running vs kept per role, rules, connections now, recent runs.'
        ],
        [
          'POST /api/hub/scale/targets/:kind/:id/plan',
          '`{roles: [{role, replicas?, cpus?, memory_mb?}]}` → the plan.'
        ],
        [
          'POST /api/hub/scale/targets/:kind/:id/runs',
          '`{roles, plan_hash, confirm?}` → 202 `{run_id}`.'
        ],
        [
          'PUT /api/hub/scale/targets/:kind/:id/roles/:role',
          '`{pinned?, auto?, resume?}` — pin to manual, set or clear (`null`) the rule, lift a pause the rule put itself in.'
        ],
        ['GET /api/hub/scale/runs, /runs/:id', 'Runs and skipped decisions.'],
        ['POST /api/hub/scale/runs/:id/cancel', 'Stops a run before its next step.'],
        [
          'GET / PUT /api/hub/scale/db-servers(/:id)',
          'Database servers and their `max_connections` (null = unknown).'
        ]
      ]
    },
    {
      type: 'note',
      text: 'App side, the capacity answer (`/api/hub-link/usage`, `/api/hub-deployment/usage`) carries `roles` (per-role p95 and heavy reads) and `queues` (imports and exports waiting) from 0.3.215; the agent side is `POST /v1/stacks/:name/scale` (deploy/hub-agent/README.md).'
    }
  ]
}
