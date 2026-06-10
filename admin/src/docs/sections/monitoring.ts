import type { DocSection } from '../types.js'

export const submissionFormsGuide: DocSection = {
  id: 'submission-forms-guide',
  label: 'Public Submission Forms',
  content: [
    { type: 'h1', id: 'submission-forms-guide', text: 'Public Submission Forms' },
    {
      type: 'p',
      text: 'Submission Forms let external users submit data into any registered collection without needing a Nivaro account. Each form has a unique token-based URL and can optionally require a password or enforce rate limits and expiry.'
    },
    { type: 'h3', text: 'Creating a form' },
    {
      type: 'p',
      text: 'Navigate to Monitoring → Submission Forms in the sidebar. Click New Form and configure:'
    },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['Name', 'Internal label for the form.'],
        ['Collection', 'Target collection where submissions are stored.'],
        ['Fields (JSON)', 'Array of allowed field names: ["name","email","message"]'],
        ['Password', 'Optional. Submitters must provide this to access the form.'],
        ['Expires At', 'Optional. Form stops accepting submissions after this datetime.'],
        ['Rate Limit / Hour', 'Max submissions per IP per hour. Default 60.'],
        ['Success Message', 'Message shown to the user on successful submission.']
      ]
    },
    { type: 'h3', text: 'Public URL' },
    {
      type: 'p',
      text: 'Each form gets a unique token. The public endpoint is `GET /api/submission-forms/public/:token` (returns form metadata) and `POST /api/submission-forms/public/:token` (submit data). No authentication required on these routes.'
    },
    { type: 'h3', text: 'Viewing submissions' },
    {
      type: 'p',
      text: 'From the form detail page, click Submissions to view all submitted records with timestamps and IP addresses. Individual submissions can be deleted by admins.'
    },
    {
      type: 'note',
      text: 'The `fields` array restricts which keys are accepted on submission — any fields not in the list are silently ignored. This prevents over-posting into sensitive columns.'
    }
  ]
}

export const fieldWatchesGuide: DocSection = {
  id: 'field-watches-guide',
  label: 'Field-Level Watches',
  content: [
    { type: 'h1', id: 'field-watches-guide', text: 'Field-Level Watches (Changelog)' },
    {
      type: 'p',
      text: 'Field Watches let users subscribe to changes on specific fields across a collection. When a watched field changes on any record, subscribed users receive an in-app notification with the old and new values.'
    },
    { type: 'h3', text: 'Creating a watch' },
    { type: 'p', text: 'Navigate to Monitoring → Field Watches. Click New Watch:' },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['Name', 'Label for this watch, e.g. "Status changes on Projects".'],
        ['Collection', 'The collection to watch.'],
        ['Field', 'The specific field to track changes on.']
      ]
    },
    { type: 'h3', text: 'Subscribing' },
    {
      type: 'p',
      text: 'Any authenticated user with read access to the collection can subscribe to a watch via `POST /api/field-watches/:id/subscribe`. Subscriptions are per-user and can be toggled active/inactive.'
    },
    { type: 'h3', text: 'How notifications work' },
    {
      type: 'p',
      text: 'On every item update, the `hooks/field-watches.ts` hook compares `previousData` against the updated result. If a watched field changed, all active subscribers receive a `nivaro_notifications` entry and a Socket.io push.'
    },
    {
      type: 'note',
      text: "Permission check on subscribe: users must have `read` access to the watch's collection. Admins can subscribe to any watch regardless."
    }
  ]
}

export const notificationSubscriptionsGuide: DocSection = {
  id: 'notification-subscriptions-guide',
  label: 'Notification Subscriptions',
  content: [
    { type: 'h1', id: 'notification-subscriptions-guide', text: 'Notification Subscriptions' },
    {
      type: 'p',
      text: 'Notification Subscriptions let users opt into notifications for collection-level events (create, update, delete) with optional field-value filters. Unlike Field Watches (which track specific field changes), subscriptions fire on any matching event.'
    },
    { type: 'h3', text: 'Creating a subscription' },
    {
      type: 'p',
      text: 'Navigate to Monitoring → Notification Subscriptions. Users manage their own subscriptions; admins can view all subscriptions.'
    },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['Collection', 'The collection to subscribe to.'],
        ['Event Type', 'One of: create, update, delete.'],
        ['Filter Field', 'Optional. Only notify if this field matches filter_value.'],
        ['Filter Value', 'Optional. The value to match against filter_field.'],
        ['Label', 'Optional display name for the subscription.']
      ]
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'p',
      text: 'The `hooks/notification-subscriptions.ts` hook fires on create/update/delete events, finds all matching active subscriptions, skips the actor (user who triggered the event), and delivers in-app notifications to all matching subscribers.'
    }
  ]
}

export const dataImportGuide: DocSection = {
  id: 'data-import-guide',
  label: 'Data Import Queue',
  content: [
    { type: 'h1', id: 'data-import-guide', text: 'Data Import Queue' },
    {
      type: 'p',
      text: 'The Data Import feature lets admins upload CSV data and map columns to collection fields. Imports are processed asynchronously in the background with real-time progress updates via Socket.io.'
    },
    { type: 'h3', text: 'Creating an import' },
    {
      type: 'p',
      text: 'Navigate to Monitoring → Imports. Click New Import and follow the 4-step wizard:'
    },
    {
      type: 'table',
      head: ['Step', 'Description'],
      rows: [
        ['1. Upload', 'Select collection and upload a CSV file (or paste CSV text).'],
        [
          '2. Map Columns',
          'Map each CSV column to a collection field. Unmapped columns are skipped.'
        ],
        [
          '3. Options',
          'Choose duplicate strategy: skip, update, or error. Optionally specify an ID field for upsert matching.'
        ],
        ['4. Review & Run', 'Preview row count and start the import.']
      ]
    },
    { type: 'h3', text: 'Progress tracking' },
    {
      type: 'p',
      text: 'The import page auto-refreshes for in-progress jobs. Socket.io emits `import:progress` events every 10 rows — the job detail page shows live counters for created, updated, skipped, and error rows.'
    },
    { type: 'h3', text: 'Duplicate strategies' },
    {
      type: 'table',
      head: ['Strategy', 'Behavior'],
      rows: [
        ['skip', 'If a row with the same ID field value exists, skip it.'],
        ['update', 'If a row with the same ID field value exists, update it (upsert).'],
        [
          'error',
          'If a row with the same ID field value exists, mark the row as an error and continue.'
        ]
      ]
    },
    {
      type: 'warn',
      text: 'Import is admin-only. `nivaro_*` system tables are blocked as import targets.'
    }
  ]
}

export const slaTrackingGuide: DocSection = {
  id: 'sla-tracking-guide',
  label: 'SLA Tracking',
  content: [
    { type: 'h1', id: 'sla-tracking-guide', text: 'SLA Tracking' },
    {
      type: 'p',
      text: 'SLA Rules define time limits for how long a workflow instance can remain in a given state. The system tracks warning thresholds (% of duration elapsed) and full breaches, with optional escalation user notifications.'
    },
    { type: 'h3', text: 'Creating an SLA rule' },
    { type: 'p', text: 'Navigate to Monitoring → SLA Rules. Click New Rule:' },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['Name', 'Display label for the rule.'],
        ['Workflow Template', 'The workflow this rule applies to.'],
        ['State Key', 'The specific workflow state to measure time in.'],
        ['Duration (hours)', 'Total allowed time in this state.'],
        [
          'Warning Threshold %',
          'Notification fires when this % of duration has elapsed. Default 80%.'
        ],
        ['Business Hours Only', 'When enabled, only counts Mon–Fri 9am–5pm towards elapsed time.'],
        ['Notify on Warning', 'Send in-app notification to escalation user at warning threshold.'],
        ['Notify on Breach', 'Send in-app notification to escalation user on full breach.'],
        ['Escalation User', 'Optional. User to notify on warning/breach.']
      ]
    },
    { type: 'h3', text: 'Checking SLA status' },
    {
      type: 'p',
      text: 'The `SlaBadge` component can be embedded on any item page. It queries `GET /api/sla/status/:collection/:item` and renders a colored badge:'
    },
    {
      type: 'table',
      head: ['Badge', 'Meaning'],
      rows: [
        ['On Track (green)', 'Below warning threshold.'],
        ['Warning (amber)', 'Past warning threshold but not yet breached.'],
        ['Breached (red)', 'Over the full allowed duration.'],
        ['No SLA (gray)', 'No active SLA rule for the current workflow state.']
      ]
    },
    {
      type: 'note',
      text: 'SLA elapsed time is computed on-demand from workflow history timestamps — no background job required. Business hours calculation uses Mon–Fri, 09:00–17:00 local server time.'
    }
  ]
}

export const alertEngineGuide: DocSection = {
  id: 'alert-engine-guide',
  label: 'Alert & Threshold Engine',
  content: [
    { type: 'h1', id: 'alert-engine-guide', text: 'Alert & Threshold Engine' },
    {
      type: 'p',
      text: 'Alert Definitions watch collection fields for threshold conditions and notify subscribed users when conditions are met. Alerts fire on item create/update hooks and can also be triggered manually.'
    },
    { type: 'h3', text: 'Creating an alert definition' },
    { type: 'p', text: 'Navigate to Monitoring → Alerts. Click New Alert (admin only):' },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['Name', 'Display label.'],
        ['Category', 'Grouping tag, e.g. "compliance", "performance", "general".'],
        ['Collection', 'The collection to watch.'],
        ['Field', 'The field whose value is compared.'],
        ['Operator', 'Comparison: gt, gte, lt, lte, eq, neq.'],
        ['Threshold', 'Numeric value to compare against.'],
        ['Unit', 'Display-only label for the threshold, e.g. "count", "$", "days".'],
        ['Cooldown (minutes)', 'Min time between repeat alerts for the same item. Default 60.'],
        [
          'Filters (JSON)',
          'Optional additional conditions to scope which records trigger the alert.'
        ]
      ]
    },
    { type: 'h3', text: 'Subscribing to alerts' },
    {
      type: 'p',
      text: "Any authenticated user with read access to the alert's collection can subscribe via `POST /api/alerts/subscriptions`. Each subscription controls whether to receive email and/or in-app notifications."
    },
    { type: 'h3', text: 'How evaluation works' },
    {
      type: 'p',
      text: 'On every item create/update, `hooks/alerts.ts` fires a fire-and-forget evaluation for that collection. For each active matching alert definition, the field value is compared against the threshold. If the condition is met and the cooldown has passed, all subscribers are notified.'
    },
    {
      type: 'p',
      text: 'Admins can also trigger a full scan via `POST /api/alerts/evaluate` — this evaluates all active alerts against all records in their target collections.'
    },
    {
      type: 'table',
      head: ['Operator', 'Fires when field value is...'],
      rows: [
        ['gt', 'Greater than threshold'],
        ['gte', 'Greater than or equal to threshold'],
        ['lt', 'Less than threshold'],
        ['lte', 'Less than or equal to threshold'],
        ['eq', 'Equal to threshold'],
        ['neq', 'Not equal to threshold']
      ]
    },
    {
      type: 'note',
      text: 'Alert log entries are written to `nivaro_alert_log` on each trigger. The alert list page shows subscriber count and last triggered time per definition.'
    }
  ]
}

export const submissionFormsApiDoc: DocSection = {
  id: 'submission-forms-api',
  label: 'Submission Forms API',
  content: [
    { type: 'h1', id: 'submission-forms-api', text: 'Submission Forms API' },
    {
      type: 'p',
      text: 'Admin endpoints require admin access. Public endpoints require no authentication.'
    },
    { type: 'h3', text: 'Admin — Form management' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/submission-forms', 'List all forms with submission counts.'],
        ['GET', '/api/submission-forms/:id', 'Single form detail.'],
        [
          'POST',
          '/api/submission-forms',
          'Create a form. Body: { name, collection, fields, password?, expires_at?, rate_limit_per_hour?, success_message? }'
        ],
        ['PATCH', '/api/submission-forms/:id', 'Update form.'],
        ['DELETE', '/api/submission-forms/:id', 'Delete form and all submissions.'],
        [
          'GET',
          '/api/submission-forms/:id/submissions',
          'List submissions for a form (paginated).'
        ],
        ['DELETE', '/api/submission-forms/:id/submissions/:subId', 'Delete a specific submission.']
      ]
    },
    { type: 'h3', text: 'Public — Unauthenticated' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/submission-forms/public/:token',
          'Get form metadata (name, fields, success_message). 404 if inactive/expired.'
        ],
        [
          'POST',
          '/api/submission-forms/public/:token',
          'Submit data. Body: { data: {}, password? }. Rate-limited per IP.'
        ]
      ]
    },
    {
      type: 'pre',
      code: `// POST /api/submission-forms/public/:token
{ "data": { "name": "Jane Doe", "email": "jane@example.com", "message": "Hello" } }

// Password-protected form
{ "data": { ... }, "password": "secret123" }

// Response on success
{ "data": { "id": "uuid", "message": "Thank you for your submission." } }`
    }
  ]
}

export const fieldWatchesApiDoc: DocSection = {
  id: 'field-watches-api',
  label: 'Field Watches API',
  content: [
    { type: 'h1', id: 'field-watches-api', text: 'Field Watches API' },
    {
      type: 'p',
      text: 'All endpoints require authentication. Create/delete watches requires admin access.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth', 'Description'],
      rows: [
        ['GET', '/api/field-watches', 'Any user', 'List all watches with subscriber count.'],
        ['GET', '/api/field-watches/:id', 'Any user', 'Single watch detail with subscriber list.'],
        ['POST', '/api/field-watches', 'Admin', 'Create watch. Body: { name, collection, field }.'],
        ['PATCH', '/api/field-watches/:id', 'Admin', 'Update watch.'],
        ['DELETE', '/api/field-watches/:id', 'Admin', 'Delete watch and all subscriptions.'],
        [
          'POST',
          '/api/field-watches/:id/subscribe',
          'Any user (read access)',
          'Subscribe current user to watch.'
        ],
        ['DELETE', '/api/field-watches/:id/unsubscribe', 'Any user', 'Unsubscribe current user.'],
        [
          'GET',
          '/api/field-watches/my-subscriptions',
          'Any user',
          'List watches the current user is subscribed to.'
        ]
      ]
    }
  ]
}

export const notificationSubscriptionsApiDoc: DocSection = {
  id: 'notification-subscriptions-api',
  label: 'Notification Subscriptions API',
  content: [
    { type: 'h1', id: 'notification-subscriptions-api', text: 'Notification Subscriptions API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth', 'Description'],
      rows: [
        [
          'GET',
          '/api/notification-subscriptions',
          'Any user',
          "List current user's subscriptions."
        ],
        [
          'POST',
          '/api/notification-subscriptions',
          'Any user',
          'Create subscription. Body: { collection, event_type, filter_field?, filter_value?, label? }.'
        ],
        ['PATCH', '/api/notification-subscriptions/:id', 'Owner / Admin', 'Update subscription.'],
        ['DELETE', '/api/notification-subscriptions/:id', 'Owner / Admin', 'Delete subscription.'],
        [
          'GET',
          '/api/notification-subscriptions/admin/all',
          'Admin',
          'All subscriptions across all users.'
        ],
        [
          'GET',
          '/api/notification-subscriptions/admin/stats',
          'Admin',
          'Subscription counts grouped by collection + event_type.'
        ]
      ]
    },
    {
      type: 'pre',
      code: `// POST /api/notification-subscriptions
{
  "collection": "projects",
  "event_type": "create",
  "filter_field": "status",
  "filter_value": "approved",
  "label": "New approved projects"
}`
    }
  ]
}

export const importsApiDoc: DocSection = {
  id: 'imports-api',
  label: 'Data Import API',
  content: [
    { type: 'h1', id: 'imports-api', text: 'Data Import API' },
    { type: 'p', text: 'All endpoints require admin access.' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/imports', 'List all import jobs (newest first).'],
        ['GET', '/api/imports/:id', 'Single job with full error list.'],
        ['POST', '/api/imports', 'Create and start an import job.'],
        ['DELETE', '/api/imports/:id', 'Delete a job record (completed/failed only).']
      ]
    },
    { type: 'h3', text: 'Creating an import' },
    {
      type: 'pre',
      code: `POST /api/imports
{
  "collection": "projects",
  "file_name": "projects_q1.csv",
  "csv_data": "id,name,status\\n1,Alpha,active\\n2,Beta,draft",
  "column_map": { "id": "id", "name": "name", "status": "status" },
  "duplicate_strategy": "skip",   // "skip" | "update" | "error"
  "id_field": "id"                // field used for duplicate detection
}

→ 202 { "data": { "id": "uuid", "status": "pending", ... } }`
    },
    { type: 'h3', text: 'Job status fields' },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['status', 'pending → processing → completed / failed'],
        ['total_rows', 'Total CSV rows parsed.'],
        ['processed_rows', 'Rows attempted so far.'],
        ['created_rows', 'New records inserted.'],
        ['updated_rows', 'Existing records updated.'],
        ['skipped_rows', 'Rows skipped by duplicate strategy.'],
        ['error_rows', 'Rows that failed (see errors JSON array).']
      ]
    },
    {
      type: 'note',
      text: "Socket.io emits `import:progress` events to the creating user's room every 10 rows: `{ jobId, processed, total, created, updated, skipped, errors }`"
    }
  ]
}

export const slaApiDoc: DocSection = {
  id: 'sla-api',
  label: 'SLA API',
  content: [
    { type: 'h1', id: 'sla-api', text: 'SLA API' },
    {
      type: 'p',
      text: 'Rule management requires admin access. Status endpoints require authentication.'
    },
    { type: 'h3', text: 'Rules (admin)' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/sla/rules', 'List all SLA rules with workflow template name.'],
        ['GET', '/api/sla/rules/:id', 'Single rule.'],
        [
          'POST',
          '/api/sla/rules',
          'Create rule. Body: { name, workflow_template, state_key, duration_hours, warning_threshold_pct?, business_hours_only?, notify_on_warning?, notify_on_breach?, escalation_user?, is_active? }.'
        ],
        ['PATCH', '/api/sla/rules/:id', 'Update rule.'],
        ['DELETE', '/api/sla/rules/:id', 'Delete rule.']
      ]
    },
    { type: 'h3', text: 'Status (authenticated)' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/sla/status/:collection/:item', 'SLA status for one record.'],
        [
          'GET',
          '/api/sla/status?collection=x&items=id1,id2',
          'Batch SLA status for multiple records.'
        ]
      ]
    },
    {
      type: 'pre',
      code: `// GET /api/sla/status/:collection/:item
{
  "data": {
    "rule": { "id": 1, "name": "Approval SLA", "duration_hours": 48, ... },
    "state_key": "pending_approval",
    "entered_at": "2026-06-01T09:00:00.000Z",
    "elapsed_hours": 36.5,
    "elapsed_pct": 76,
    "status": "on_track",   // "on_track" | "warning" | "breached" | "no_sla"
    "remaining_hours": 11.5
  }
}`
    }
  ]
}

export const alertsApiDoc: DocSection = {
  id: 'alerts-api',
  label: 'Alerts API',
  content: [
    { type: 'h1', id: 'alerts-api', text: 'Alerts API' },
    { type: 'h3', text: 'Definitions (admin)' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/alerts/definitions',
          'List all definitions with subscriber_count and last_triggered.'
        ],
        ['GET', '/api/alerts/definitions/:id', 'Single definition with subscriber list.'],
        ['POST', '/api/alerts/definitions', 'Create definition.'],
        ['PATCH', '/api/alerts/definitions/:id', 'Update definition.'],
        [
          'DELETE',
          '/api/alerts/definitions/:id',
          'Delete definition and its subscriptions + log entries.'
        ],
        [
          'POST',
          '/api/alerts/evaluate',
          'Manual full scan — evaluate all active alerts against all records.'
        ]
      ]
    },
    { type: 'h3', text: 'Subscriptions (authenticated)' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/alerts/subscriptions', "List current user's alert subscriptions."],
        [
          'POST',
          '/api/alerts/subscriptions',
          'Subscribe. Body: { alert_definition, notify_email?, notify_inapp? }. Upserts.'
        ],
        ['DELETE', '/api/alerts/subscriptions/:id', 'Unsubscribe (own or admin).']
      ]
    },
    { type: 'h3', text: 'Log (admin)' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/alerts/log', 'Last 100 alert trigger log entries. Filter: ?definition=:id']
      ]
    },
    {
      type: 'pre',
      code: `// POST /api/alerts/definitions
{
  "name": "High value pending",
  "category": "compliance",
  "collection": "projects",
  "field": "amount",
  "operator": "gt",
  "threshold": 1000000,
  "unit": "$",
  "cooldown_minutes": 120
}`
    },
    {
      type: 'note',
      text: "Subscription permission check: users must have `read` access to the alert's collection. Admins bypass this check."
    }
  ]
}

export const presenceApiDoc: DocSection = {
  id: 'presence-api',
  label: 'Presence API',
  content: [
    { type: 'h1', id: 'presence-api', text: 'Presence API' },
    { type: 'h3', text: 'Public — no auth required' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/presence.js',
          'Serve the embeddable tracker script. Ping interval is injected from settings. Cache-Control: no-cache.'
        ],
        [
          'POST',
          '/api/presence/ping',
          'Upsert a session in Redis with SESSION_TTL. Body: { sessionId, pageUrl, userId?, userEmail?, userName?, deviceType?, ... }'
        ],
        ['POST', '/api/presence/disconnect', 'Delete a session immediately. Body: { sessionId }.']
      ]
    },
    { type: 'h3', text: 'Admin — requireAdmin' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/presence/sessions',
          'List all active sessions. Returns { data: PresenceSession[], total }.'
        ],
        ['DELETE', '/api/presence/sessions/:sessionId', 'Force-expire a specific session.']
      ]
    },
    { type: 'h3', text: 'Socket.io — real-time updates' },
    {
      type: 'p',
      text: 'Join room `presence:admin` to receive live updates. The server emits `presence:update` with `{ sessions }` on every ping, disconnect, and on a configurable sweep interval (default 8s) to flush expired sessions.'
    },
    {
      type: 'pre',
      code: `socket.emit('join', 'presence:admin');
socket.on('presence:update', ({ sessions }) => {
  console.log('Active sessions:', sessions.length);
});`
    },
    { type: 'h3', text: 'PresenceSession shape' },
    {
      type: 'table',
      head: ['Field', 'Type', 'Description'],
      rows: [
        ['sessionId', 'string', 'UUID stored in client localStorage.'],
        ['pageUrl', 'string', 'Current page URL.'],
        ['pageTitle', 'string|null', 'Current page title.'],
        ['userId / userEmail / userName', 'string|null', 'Client-asserted identity.'],
        ['deviceType', 'string|null', 'desktop, tablet, or mobile.'],
        ['ip', 'string|null', 'Server-side request IP.'],
        ['firstSeen / lastSeen', 'ISO string', 'First ping and most recent ping timestamps.']
      ]
    }
  ]
}

export const analyticsApiDoc: DocSection = {
  id: 'analytics-api',
  label: 'Analytics API',
  content: [
    { type: 'h1', id: 'analytics-api', text: 'Analytics API' },
    { type: 'h3', text: 'Public — no auth required' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'POST',
          '/api/analytics/pageview',
          'Record a page view. Returns { id }. Body: { sessionId, pageUrl, pageTitle?, referrer?, deviceType?, userId?, userEmail?, userName?, previousViewId?, previousDuration? }'
        ],
        [
          'PATCH',
          '/api/analytics/pageview/:id',
          'Update duration for a view. Body: { duration (seconds), sessionId }. sessionId must match the stored row (IDOR guard). Only updates if duration_seconds is currently NULL.'
        ]
      ]
    },
    { type: 'h3', text: 'Authenticated' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/analytics/pageviews/stats',
          'Aggregated stats. Query: ?period=1d|7d|30d. Returns { total_views, unique_sessions, unique_pages, top_pages[] }.'
        ],
        [
          'GET',
          '/api/analytics/pageviews',
          'Paginated view list. Query: ?period=&page=&limit=&search=&session_id=. Returns { data, total, page, limit }.'
        ]
      ]
    },
    { type: 'h3', text: 'Stats response shape' },
    {
      type: 'pre',
      code: `{
  "total_views": 1240,
  "unique_sessions": 312,
  "unique_pages": 87,
  "top_pages": [
    { "page_url": "/products", "views": 310, "unique_sessions": 98 }
  ]
}`
    },
    {
      type: 'note',
      text: "The PATCH endpoint requires `sessionId` in the body to prevent IDOR — a caller who knows a view ID cannot update another session's duration without the originating session ID."
    }
  ]
}

export const atRiskFlagging: DocSection = {
  id: 'at-risk-flagging',
  label: 'At-Risk Flagging',
  content: [
    { type: 'h1', id: 'at-risk-flagging', text: 'At-Risk Flagging' },
    {
      type: 'p',
      text: 'At-risk rules highlight rows in the collection browser that meet risk conditions — overdue items, budget overruns, missing data. Flagged rows get a red or amber tint plus a flag icon, and an "At risk (N)" chip above the table filters the view down to flagged rows only.'
    },
    { type: 'h3', text: 'Managing rules' },
    {
      type: 'p',
      text: 'In the collection browser, admins see a "Manage rules" button next to the At-risk chip. The inline panel lists the collection\'s rules and lets you create, edit, activate/deactivate, and delete them. Each rule has:'
    },
    {
      type: 'table',
      head: ['Setting', 'Description'],
      rows: [
        ['Name', 'Shown in the flag tooltip when the rule matches a row.'],
        [
          'Conditions',
          'One or more field / operator / value rows. ALL must match (AND) for the rule to flag a row.'
        ],
        [
          'Highlight',
          '`red` (default) or `amber` — controls the row tint. The first matching rule decides the colour.'
        ],
        ['Active', 'Inactive rules are kept but not evaluated.']
      ]
    },
    { type: 'h3', text: 'Operators and cross-field references' },
    {
      type: 'ul',
      items: [
        'Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `null`, `nnull`.',
        "A condition value can reference another field on the same row: `{{budget}}` compares against the row's budget value.",
        'A field reference can carry a scale or offset: `{{budget}} * 0.9` or `{{baseline}} + 10` — e.g. flag rows where `spend gte {{budget}} * 0.9` (spend has reached 90% of budget).',
        'Numbers, booleans, and dates are coerced for comparison; `contains` is case-insensitive.'
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth', 'Description'],
      rows: [
        ['GET', '/api/at-risk/rules?collection=', 'Admin', 'List rules.'],
        [
          'POST',
          '/api/at-risk/rules',
          'Admin',
          'Create. Body: `{ collection, name, conditions[], highlight_color?, is_active? }`.'
        ],
        ['PATCH', '/api/at-risk/rules/:id', 'Admin', 'Update any rule field.'],
        ['DELETE', '/api/at-risk/rules/:id', 'Admin', 'Delete. → 204'],
        [
          'GET',
          '/api/at-risk/rules/active?collection=',
          'Authenticated',
          'Active rules for a collection — requires read permission on the collection.'
        ],
        [
          'POST',
          '/api/at-risk/evaluate',
          'Authenticated',
          '`{ collection, ids[] }` (max 500) → `{ data: { [id]: { at_risk, rule, color } } }`. Only flagged ids are returned.'
        ],
        [
          'GET',
          '/api/at-risk/summary',
          'Authenticated',
          'Per-collection at-risk counts across all active rules the caller can read (scans up to 1000 rows per collection).'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Rules live in `nivaro_at_risk_rules`; system (`nivaro_*`) collections cannot have rules. SDK: `listAtRiskRules`, `listActiveAtRiskRules`, `createAtRiskRule`, `updateAtRiskRule`, `deleteAtRiskRule`, `evaluateAtRisk(collection, ids)`, `readAtRiskSummary()`.'
    }
  ]
}

export const queueSlaTimers: DocSection = {
  id: 'queue-sla-timers',
  label: 'Queue SLA Timers',
  content: [
    { type: 'h1', id: 'queue-sla-timers', text: 'Queue SLA Timers' },
    {
      type: 'p',
      text: 'The collection browser shows a live SLA column for workflow-bound collections that have active SLA rules — turning any filtered list into a work queue with countdown timers. No configuration beyond existing SLA rules is needed.'
    },
    { type: 'h3', text: 'What you see' },
    {
      type: 'table',
      head: ['Badge', 'Meaning'],
      rows: [
        ['Green — "Xh left"', 'Within the SLA duration and below the warning threshold.'],
        ['Amber — "Xh left"', "Past the rule's warning threshold percentage but not yet breached."],
        ['Red — "overdue Xh"', 'The SLA duration has elapsed; shows how far overdue the item is.'],
        ['—', "No workflow instance, or no active SLA rule for the item's current state."]
      ]
    },
    {
      type: 'p',
      text: 'The column appears automatically when any visible row has SLA data, and the timers refresh every 60 seconds while the page is open.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `// POST /api/sla/status/batch
{ "collection": "tickets", "ids": [101, 102, 103] }

// → map keyed by item id; items without an active SLA are omitted
{
  "data": {
    "101": {
      "state_key": "in_progress",
      "elapsed_hours": 5.2,
      "duration_hours": 8,
      "status": "warning",          // ok | warning | breached
      "remaining_hours": 2.8
    }
  }
}`
    },
    {
      type: 'note',
      text: 'Requires read permission on the collection. Elapsed time is computed on demand from `nivaro_workflow_history` (business-hours aware when the rule says so) — the batch endpoint is just a multi-item version of `GET /api/sla/status/:collection/:item`. SDK: `readSlaStatusBatch(collection, ids)`.'
    }
  ]
}
