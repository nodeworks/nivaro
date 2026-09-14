import type { DocSection } from '../types.js'

export const dbHealthDocs: DocSection = {
  id: 'db-health',
  label: 'DB & Runtime Health',
  content: [
    { type: 'h1', id: 'db-health', text: 'DB & Runtime Health' },
    {
      type: 'p',
      text: 'The DB & Runtime page at /db-health (Monitoring → DB & Runtime) is a read-mostly console over the database server, Redis, and the API process itself. Every endpoint behind it is admin-only. Panels that need database-server visibility degrade honestly: if the database login lacks the VIEW SERVER STATE permission, the panel shows an amber note saying exactly that instead of failing.'
    },
    { type: 'h3', text: 'What the panels show' },
    {
      type: 'table',
      head: ['Panel', 'What it tells you'],
      rows: [
        [
          'This process',
          'Uptime, memory, event-loop lag, and connection-pool usage for the replica that answered — per process, not fleet-wide.'
        ],
        [
          'Instance roster',
          'Every live API replica registered in Redis (empty when Redis is down).'
        ],
        [
          'Cache console',
          'In-process caches on this replica, each with a Bust button (and a bust-all). Every bust is audit-logged.'
        ],
        [
          'Degradation map',
          'What stops working when each dependency (database, Redis, Inngest, SMTP) goes down. Database and Redis are probed live.'
        ],
        [
          'Top expensive SQL',
          'The 15 statements costing the server the most CPU since its last restart. SELECT statements get an Explain button that opens the query plan.'
        ],
        [
          'Deadlocks',
          'Recent deadlock events mined from the server health session, with the statements involved.'
        ],
        [
          'Long transactions',
          'Sleeping sessions that have held an open transaction idle for 5+ minutes.'
        ],
        [
          'Unused indexes',
          'Nonclustered indexes with heavy writes and zero reads since the server last restarted.'
        ],
        ['Table heat', 'Read/write activity per table since the server last restarted.'],
        ['Redis', 'Memory, clients, keys, hit/miss counters, evictions.'],
        [
          'Storage runway',
          'Database size now, a daily growth rate from nightly snapshots, and the largest tables.'
        ],
        [
          'Held connections',
          'Checked-out pool connections attributed to the request holding them — the leak finder.'
        ],
        [
          'Data velocity',
          'Which collections are being created/updated the most, from the activity log.'
        ],
        ['Latency by hour', 'Slowest routes by hour of day (UTC) over the last 7 days.'],
        [
          'Dangling foreign keys',
          'Registered relations whose FK values point at rows that no longer exist, with guarded repair actions.'
        ],
        ['Inngest', 'Whether the job runner answers, and how many recent events it reports.']
      ]
    },
    { type: 'h3', text: 'The two write actions, and their guardrails' },
    {
      type: 'ul',
      items: [
        'Drop an unused index — only plain nonclustered indexes qualify: the server re-checks the index at drop time and refuses primary keys, unique indexes, and clustered indexes outright. Every drop is audit-logged with the index name. Remember the usage counters reset when SQL Server restarts, so "zero reads" on a recently restarted server is weak evidence — check the uptime first.',
        'Kill a long transaction — requires a typed reason (the KILL button stays disabled without one), only works on user sessions (session id above 50), and refuses to kill the console’s own connection. The reason lands in the audit log alongside the session id.',
        'Dangling-FK repair offers two actions only: null out the broken reference (refused on NOT NULL columns) or delete the orphaned rows through the normal delete path, so trash, deletion guards, and hooks all apply. Repointing to a different record is deliberately not offered.'
      ]
    },
    {
      type: 'note',
      text: 'Storage runway needs at least 7 nightly snapshots before it projects a growth rate — until then it reports how many snapshots it has collected. Snapshots are written by the storage-snapshot job at 03:45 daily.'
    }
  ]
}

export const opsConsoleDocs: DocSection = {
  id: 'ops-console',
  label: 'Ops Console',
  content: [
    { type: 'h1', id: 'ops-console', text: 'Ops Console' },
    {
      type: 'p',
      text: 'The Ops Console at /ops-console (Monitoring → Ops Console) is the operational side of the API process: the live log, log-based alerting, environment inspection, maintenance windows, and controlled restart. Admin-only throughout.'
    },
    { type: 'h2', id: 'ops-console-crons', text: 'Scheduled jobs: pause, override, revert' },
    {
      type: 'p',
      text: 'Background Jobs (Monitoring nav) lists every cron the process registered — core schedules and extension-registered ones alike — with its effective schedule, last outcome and next run. Each row can be paused/resumed, run now, and have its schedule OVERRIDDEN from the admin: click the expression, type a new cron expression (the next fire times preview live; an invalid expression is refused with the parser message), Save. Revert puts the job back on the schedule its code registered.'
    },
    {
      type: 'ul',
      items: [
        'Overrides persist in settings.cron_overrides and are hydrated before extensions register, so an override binds to an extension job on every replica after a restart — no deploy needed.',
        'Pause keeps the job registered but its ticks return immediately (settings.paused_crons); Resume is instant.',
        'API: GET /api/cron (effective + default expression, override metadata), GET /api/cron/preview?expression=, PATCH /api/cron/:id {expression | null, note}, POST /api/cron/:id/revert, /pause, /resume, /run. Every change is activity-logged (cron-override, cron-revert, cron-pause, cron-resume, cron-run-now).',
        'Flows have the same enable/disable from the Flows list (the Power action on a row) — an inactive flow keeps its config and its version history; the editor’s Versions panel reverts config.'
      ]
    },
    { type: 'h2', id: 'ops-console-logs', text: 'Log tail and log alert rules' },
    {
      type: 'ul',
      items: [
        'Log tail — the last 2,000 log lines from this replica, held in memory (nothing is persisted), auto-refreshing every 10 seconds with level filters and a plain-text search. It captures structured logger output; anything printed with bare console.log goes to stdout only and will not appear here.',
        'Log alert rules — a rule is a name plus a regular expression (optionally with a minimum level). When a log line matches, an issue is raised in the Issue Log; a 5-minute per-rule cooldown keeps a noisy line from raising the same issue every second. Rules apply as lines arrive, on every replica.',
        'Keep patterns simple: patterns longer than 200 characters, or ones using nested quantifiers (the shapes that can hang a regex engine), are accepted but quietly never match — if a rule seems inert, shorten and simplify its pattern.',
        'Silent failures — a counter panel for deliberate catch-and-continue sites in the code, showing how often each has fired since this process started. A site firing 50 times in an hour raises an issue on its own.'
      ]
    },
    { type: 'h2', id: 'ops-console-incident', text: 'Incident timeline, clock audit, environment' },
    {
      type: 'ul',
      items: [
        'Incident timeline — pick a moment and build a merged timeline of everything within ±60 minutes: issues, failed or interrupted background jobs, and configuration changes. Made for "what changed around 14:00" questions.',
        'Clock & DST — measures the clock skew between the API and the database (flagged red past 5 seconds) and lists scheduled jobs whose hour falls in the 0–3 AM band that daylight-saving transitions can skip or repeat.',
        'Environment knobs — every configuration variable the process was started with, plus the documented raw-env switches. Values are masked two ways: any key whose name suggests a secret (secret, token, pass, key, credential, signing) shows as dots, and any value shaped like a credential-bearing URL has its password segment replaced — so connection strings are safe even under innocent key names.'
      ]
    },
    { type: 'h2', id: 'ops-console-maintenance', text: 'Maintenance windows' },
    {
      type: 'p',
      text: 'A maintenance window is a scheduled freeze with a lifecycle the platform runs for you. Create one with a title, start, end, and optional message; from there it is automatic:'
    },
    {
      type: 'ul',
      items: [
        'Pre-announce — once the start is under 24 hours away, a warning banner appears for everyone with a countdown and the local start–end times.',
        'Start — a per-minute sweep flips maintenance mode on at the boundary. Non-admin writes are refused while it is on, the banner switches to a non-dismissable notice, and the alert engines (ops monitors, alert definitions, report alerts) pause — their skipped evaluations are not queued up, they simply do not run.',
        'End — the sweep flips maintenance mode off and runs a smoke check (database, Redis, migrations, registered collections, and a self-request). Only when it passes is the "Maintenance complete" all-clear broadcast sent; a failed check raises a high-severity issue instead and holds the all-clear.',
        'Cancel — deleting an active window turns maintenance mode off immediately. The smoke check can also be run by hand at any time from the same card.'
      ]
    },
    { type: 'h2', id: 'ops-console-restart', text: 'Restart, follow-user, heap snapshot' },
    {
      type: 'ul',
      items: [
        'Restart — the Restart button requires a typed reason (audit-logged) and is refused while work is mid-run: running background jobs, staged imports, or processing collection imports each block it, and the refusal names what is running. The process exits cleanly and relies on the host’s restart policy to come back.',
        'Follow a user — pick a person and their next 50 requests are traced in full detail (per-phase waterfalls), regardless of how fast they are. Traces appear on the API Analytics page; a follow expires after an hour on its own.',
        'Heap snapshot — captures a V8 heap snapshot of this replica and downloads it for analysis in Chrome DevTools. The file lives in the process’s temp directory, so download it right away — a restart discards it.'
      ]
    }
  ]
}

export const instanceOverridesDocs: DocSection = {
  id: 'instance-overrides',
  label: 'Per-Instance Settings',
  content: [
    { type: 'h1', id: 'instance-overrides', text: 'Per-Instance Settings Overrides' },
    {
      type: 'p',
      text: 'When several environments share one database — a local machine and a staging server pointed at the same instance, for example — they also share the one settings row, which makes "use a local mail server in dev but keep the real relay on staging" impossible. Settings → This Instance solves that: each environment can overlay its own values on top of the shared settings, visible only to itself.'
    },
    { type: 'h3', text: 'How an instance is identified' },
    {
      type: 'p',
      text: 'Each API process resolves its instance key from the NIVARO_INSTANCE environment variable, falling back to NODE_ENV. That fallback means a local dev process ("development") and a deployed container ("production") already read different override sets with zero setup — set NIVARO_INSTANCE explicitly only when you run two environments that would otherwise share a NODE_ENV.'
    },
    { type: 'h3', text: 'What overrides apply to' },
    {
      type: 'ul',
      items: [
        'Overrides are read exactly where mail and SMS configuration is resolved — SMTP host/port/credentials/from, mail test mode and its allowlist, the environment label, and the SMS provider settings. Every other setting reads the shared row and is unaffected.',
        'The This Instance tab offers exactly those keys. Set a value to override it for this instance; leave a value blank to clear the shared value and fall back to this instance’s environment variables.',
        'A second layer exists for containers: the NIVARO_SETTINGS_OVERRIDES environment variable can hold a JSON object of the same keys, and it wins over anything set in the tab. It is read once at startup, so changing it requires a restart.',
        'Saving replaces this instance’s whole override set — the tab always shows and submits the complete list.'
      ]
    },
    {
      type: 'warn',
      text: 'The other Settings tabs (Email, SMS) keep showing and editing the shared row — deliberately, since that row serves every environment. So the Email tab can display SMTP values this particular instance is not actually using; check This Instance to see what is overlaid here.'
    },
    {
      type: 'note',
      text: 'Both the read (GET /api/settings/instance-overrides) and the save (PUT) are admin-only, and every save is audit-logged with the instance key and the keys it set.'
    }
  ]
}

export const mailHarnessDocs: DocSection = {
  id: 'mail-harness',
  label: 'Mail Templates & Test Harness',
  content: [
    { type: 'h1', id: 'mail-harness', text: 'Mail Templates & Test Harness' },
    {
      type: 'p',
      text: 'Every email the instance sends is registered as a mail TYPE (Mail Templates → "Send a real one"): what it is, which Liquid template renders it, and how to build it from a real sample — a workflow transition, a changed record, a user, a recent inbox row. Pick a type, pick a sample, and you see the exact email production would send, its subject, and the people it would go to with the reason each is on the list. Send it to yourself, to any address, or (admin, logged, confirmed) to the real recipients. Mail test mode still applies to every send.'
    },
    { type: 'h2', id: 'mail-harness-types', text: 'Registered types' },
    {
      type: 'table',
      head: ['Type', 'Template', 'Sample'],
      rows: [
        [
          'Workflow state change',
          'workflow_transition',
          'a workflow-history row — rendered THROUGH the delivering flow ("Workflows — notify owners" / "IR Approval — notify owners"), so subject and recipients are the flow\'s'
        ],
        ['Workflow canceled', 'workflow_canceled', 'a history row into a canceled state'],
        [
          'Record you watch changed',
          'record_watch',
          'a recent activity row (record card + labelled old → new table)'
        ],
        ['Collection subscription', 'subscription', 'a recent activity row'],
        [
          'Daily action summary',
          '(built in code)',
          'a user — the digest is built for them without flushing their deferred rows'
        ],
        [
          'Alert / Anomaly / SLA / Mention / Report / System / Workflow (generic)',
          'notification',
          'a recent inbox row of that category'
        ],
        [
          'Extension types (e.g. EFP invoices on hold)',
          'invoice_on_hold',
          'registered by the extension through ctx.mail.registerType'
        ]
      ]
    },
    { type: 'h2', id: 'mail-harness-blocks', text: 'What the detailed templates carry' },
    {
      type: 'ul',
      items: [
        "Record card — the record's title (display template), a link, and the fields the collection's ACTIVE grouped layout pins in its item-header strip. The card follows the layout, not a per-collection field list in code.",
        'Approval path — every state in order: done (who, when), current (waiting on whom), upcoming (next owners). Cancel/reject branches only show once the record lands there.',
        'What changed — labelled old → new pairs since the record entered the state it just left (transition mails) or in this write (watch mails); FK ids resolve to display labels.',
        "The person's comment, only when a human wrote it — machine stamps (state merges, legacy syncs, imports) are never quoted back."
      ]
    },
    {
      type: 'note',
      text: "Flows keep owning WHEN an email goes out and to whom; a mail op's `template` option names the Liquid file that renders the body, with the full trigger payload (record_card, approval_chain, brief, actor_name…) as its context. Templates live in api/templates/mail (core) or <extension>/templates/mail; partials under partials/ are shared building blocks ({% render 'partials/record-card', card: record_card %}). The Templates tab edits any of them as a database override."
    },
    { type: 'h2', id: 'mail-harness-why', text: 'The "why me" footer' },
    {
      type: 'p',
      text: 'Every email ends with "You\'re getting this because …" and a link to the recipient\'s notification rules (in the app they use). The reason is per recipient: builders name it (assigned a task, approver for a step, watching a record, subscribed to a queue, delegate while someone is out), workflow transition mails read it off the trigger payload (owner of the new state, creator, additional contact), and anything without a stated reason falls back to the honest default — "your notification rules for <category> send you email".'
    },
    {
      type: 'ul',
      items: [
        "Flow mail ops: 'One email per recipient' (option `split`) sends each address its own copy — the footer and every link resolve for that person; 'Why-me line' (option `why`, templated) pins a shared reason for ops that mail one person per run.",
        "Programmatic senders pass `why` to notifyUser / sendMail / sendRawMail, or put `why` in the template's data.",
        'The rules link is the profile page — portal route key `profile` (Settings → Project → Frontend app), admin fallback /profile.'
      ]
    },
    { type: 'h2', id: 'notification-bench', text: 'Notification test bench' },
    {
      type: 'p',
      text: 'Data Tools → Notification Bench (admin). "Send me a sample of every category" delivers one real notification per category to you — through your own rules, so a category you switched off will not arrive, which is the point. The simulator takes a person + an event (category, subject, optional record, requested channels, "as of" time) and renders the exact delivery decision notifyUser would make: in-app, push, email (sent now / daily summary / off), SMS, with the reason for every kept or dropped channel (suspended, muted, matrix row, presence, quiet hours, digest mode, critical bypass, sender cadence), plus where the click lands in the portal and the admin and which inline action the row offers. Nothing is sent from the simulator.'
    },
    { type: 'h2', id: 'notification-targets', text: 'What a notification click does' },
    {
      type: 'p',
      text: "Every notification carries a structured target (record, task, approval, access request, SLA, chat room, queue, report, alerts, issue, import, dashboard, My Work) plus the action a click should offer. Each app maps the target onto ITS routes — the admin opens /collections/:c/:id or /tasks, the portal opens /records/:c/:id or My Work — and when a host has no page for the kind, it falls back to the server-resolved URL for the recipient's preferred app (same origin = in-app, foreign = new tab). Rows can carry an inline action the server declares safe to fire from a click: Mark task done, Acknowledge SLA. Rows written before targets existed are derived from collection + item + subject."
    },
    { type: 'h2', id: 'mail-delivery-board', text: 'Delivery board' },
    {
      type: 'p',
      text: 'Mail Log → Delivery rolls the outbound log up over the last 7 / 14 / 30 days: sent / failed / dropped / deferred with the success rate (sent ÷ attempted), a per-day stacked chart, a per-template table (labelled with the mail type when one template maps to exactly one type; a row opens the log filtered to it), the busiest recipients, "Not reaching" (addresses whose LATEST attempt failed), and failure reasons grouped by the stable head of the SMTP error (addresses, ids and session tokens collapsed). Raw sends log a template name too (flow ops as flow:<op key>, the digest as daily_digest); rows older than that land in "Untemplated sends".'
    },
    { type: 'h2', id: 'mail-harness-links', text: 'Where links land' },
    {
      type: 'p',
      text: 'Links in emails resolve per recipient. Settings → Project → "Frontend app (portal)" names the headless app and its routes (record, queue, report, alerts, chat, tasks, approvals, my_work, home; a `record:<collection>` key gives one collection its own page). A recipient\'s profile choice ("Email links open in": Automatic / Portal / Admin) wins; otherwise admins get the admin console and everyone else the portal. A destination the portal has no route for falls back to the admin. Emails sent to a list in one go (the workflow transition flows) link the portal when one is configured. Extensions can register the portal through ctx.links.register; the Settings value wins when both exist. The harness shows the app each recipient would land in.'
    },
    { type: 'h2', id: 'mail-harness-api', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/mail-types                      # every registered type
GET  /api/mail-types/:key/samples?q=      # real samples to pick from
POST /api/mail-types/:key/preview         # { sample_id } → { subject, html, recipients[] }
POST /api/mail-types/:key/send            # { sample_id, mode: 'self' | 'address' | 'recipients', to? }`
    }
  ]
}
