import type { DocSection } from '../types.js'

export const userNotifications: DocSection = {
  id: 'notifications',
  label: 'Notifications',
  content: [
    { type: 'h1', id: 'notifications', text: 'In-App Notifications' },
    {
      type: 'p',
      text: 'Nivaro delivers real-time in-app notifications via Socket.io. The bell icon in the sidebar header shows an unread count badge and lists the last 10 notifications in a popover.'
    },
    { type: 'h3', text: 'Real-time delivery' },
    {
      type: 'p',
      text: "The admin UI connects to Socket.io on load and authenticates using the current user's static token. Incoming `notification:new` events immediately update the unread badge and show a toast. No page refresh needed."
    },
    { type: 'h3', text: 'Notification schema' },
    {
      type: 'table',
      head: ['Column', 'Description'],
      rows: [
        ['recipient', 'FK → nivaro_users.id — the target user.'],
        ['sender', 'FK → nivaro_users.id — who sent it (nullable).'],
        ['subject', 'Short title shown in the bell popover and toast.'],
        ['message', 'Full notification body (nullable).'],
        ['status', '"inbox" (unread) or "read".'],
        ['collection / item', 'Optional link to a specific record.'],
        ['timestamp', 'When the notification was created.']
      ]
    },
    { type: 'h3', text: 'REST endpoints' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/notifications',
          'List last 50 notifications for the current user. ?unread=true for inbox only.'
        ],
        ['GET', '/api/notifications/count', 'Returns { unread: N } — used to drive the badge.'],
        ['POST', '/api/notifications/:id/read', 'Mark a single notification as read.'],
        ['POST', '/api/notifications/read-all', 'Mark all inbox notifications as read.'],
        ['DELETE', '/api/notifications/:id', 'Delete a notification.']
      ]
    },
    { type: 'h3', text: 'Emitting from server code' },
    {
      type: 'pre',
      code: `import { emitNotification } from '../plugins/socketio.js';

// Inside a route or hook — app.io is the Socket.io server
emitNotification(app.io, targetUserId, {
  subject: 'Project approved',
  message: 'Your request was approved by Finance.',
  collection: 'projects',
  item: projectId,
});`
    },
    {
      type: 'note',
      text: "The Socket.io bell uses the user's static token for authentication. If a user has no static token, real-time delivery is unavailable but they can still poll the REST endpoints."
    }
  ]
}

export const userExternalApisGuide: DocSection = {
  id: 'external-apis-guide',
  label: 'External APIs',
  content: [
    { type: 'h1', id: 'external-apis-guide', text: 'External APIs' },
    {
      type: 'p',
      text: 'External APIs lets you configure connections to third-party services (Oracle EBS, MWF, MDSi, Azure, etc.) with stored authentication credentials. Configured APIs can be tested from the admin UI and called programmatically from extensions.'
    },
    { type: 'h3', text: 'Admin UI — /external-apis' },
    {
      type: 'p',
      text: 'Navigate to External APIs in the sidebar. Each entry shows the base URL, auth type, and enabled state. Click an entry to open the editor with three tabs: config, predefined endpoints, and the live test panel.'
    },
    { type: 'h3', text: 'Auth types' },
    {
      type: 'table',
      head: ['Type', 'How it works'],
      rows: [
        ['none', 'No auth headers added.'],
        ['bearer', 'Adds Authorization: Bearer <token> to every request.'],
        ['api_key', 'Injects a key/value pair as a header or query param (configurable).'],
        ['basic', 'Adds Authorization: Basic base64(username:password).'],
        [
          'oauth2_cc',
          'Fetches a client credentials token from token_url on each call, then injects as Bearer.'
        ]
      ]
    },
    { type: 'h3', text: 'Predefined endpoint templates' },
    {
      type: 'p',
      text: 'Each API can store a library of named endpoint templates — method, path, default body, default query params, default headers, and an optional description. Templates appear as color-coded pills in the test panel. Clicking a pill pre-fills all fields; you can then override any value before running the test.'
    },
    {
      type: 'p',
      text: 'Manage endpoints in the Endpoints card on the API edit page. Each row is expandable inline — add, edit, and delete without leaving the page. The body field includes a Format button that pretty-prints JSON.'
    },
    { type: 'h3', text: 'Test panel' },
    {
      type: 'p',
      text: 'The test panel supports full request composition: method selector, path, body textarea (shown for POST/PUT/PATCH), collapsible query params and request headers editors, and a response section that shows status, body, and toggleable response headers. Use the Custom pill for ad-hoc requests or select a predefined endpoint pill to start from its defaults.'
    },
    { type: 'h3', text: 'Security' },
    {
      type: 'p',
      text: 'Secrets (token, password, client_secret, api_key value) are masked in GET responses with `••••••`. Re-submitting the masked value on PATCH preserves the existing secret. Only admins can read or write API configs.'
    },
    {
      type: 'note',
      text: 'External APIs intentionally skip SSRF protection — they are admin-only and designed to reach internal corporate services (Oracle EBS, MWF, MDSi, etc.) that would otherwise be blocked. SSRF protection applies to webhooks, not external APIs.'
    }
  ]
}

export const externalApisApiDoc: DocSection = {
  id: 'external-apis-api',
  label: 'External APIs API',
  content: [
    { type: 'h1', id: 'external-apis-api', text: 'External APIs API' },
    {
      type: 'p',
      text: 'All external API routes require admin access (`role.admin_access = true`). Secrets are masked on GET — re-submit the masked value to leave a secret unchanged.'
    },
    { type: 'h3', text: 'API config CRUD' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/external-apis', 'List all configs. Secrets masked.'],
        [
          'POST',
          '/api/external-apis',
          'Create config. Body: name, base_url, auth_type, auth_config, headers, enabled.'
        ],
        ['GET', '/api/external-apis/:id', 'Single config. Secrets masked.'],
        ['PATCH', '/api/external-apis/:id', 'Update config. Masked secret values preserved.'],
        ['DELETE', '/api/external-apis/:id', 'Delete config and all its endpoint templates.']
      ]
    },
    { type: 'h3', text: 'Auth config shape per auth_type' },
    {
      type: 'table',
      head: ['auth_type', 'auth_config fields'],
      rows: [
        ['none', '{}'],
        ['bearer', '{ token }'],
        ['api_key', '{ key, value, in: "header"|"query", param_name }'],
        ['basic', '{ username, password }'],
        ['oauth2_cc', '{ client_id, client_secret, token_url, scope? }']
      ]
    },
    { type: 'h3', text: 'Test endpoint' },
    {
      type: 'pre',
      code: `POST /api/external-apis/:id/test

// Body (all optional):
{
  "method": "POST",
  "path": "/invoices",
  "body": { "po_number": "PO-123" },
  "query": { "format": "json" },
  "headers": { "X-Correlation-Id": "abc" }
}

// Response:
{
  "status": 200,
  "headers": { "content-type": "application/json", ... },
  "body": { ... }
}`
    },
    { type: 'h3', text: 'Call routes' },
    {
      type: 'p',
      text: 'Both call routes require authentication but not admin access. Auth credentials stay server-side.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'POST',
          '/api/external-apis/:id/call',
          'Call any arbitrary endpoint on the API. Body: method?, path?, body?, query?, headers?.'
        ],
        [
          'POST',
          '/api/external-apis/endpoints/:slugOrId/call',
          'Call a pre-defined endpoint template by numeric id or slug. Caller overrides merge on top of saved defaults.'
        ]
      ]
    },
    { type: 'h3', text: 'Predefined endpoint templates' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/external-apis/:id/endpoints', 'List all endpoint templates for an API.'],
        [
          'POST',
          '/api/external-apis/:id/endpoints',
          'Create an endpoint template. Body: name, slug?, method, path, description?, default_body?, default_query?, default_headers?, sort?.'
        ],
        ['PATCH', '/api/external-apis/endpoints/:eid', 'Update an endpoint template.'],
        ['DELETE', '/api/external-apis/endpoints/:eid', 'Delete an endpoint template.'],
        ['PATCH', '/api/external-apis/:id/endpoints/reorder', 'Bulk reorder. Body: [{ id, sort }].']
      ]
    },
    { type: 'h3', text: 'Endpoint template shape' },
    {
      type: 'table',
      head: ['Field', 'Type', 'Description'],
      rows: [
        ['id', 'number', 'Auto-increment primary key.'],
        ['api_id', 'number', 'FK → nivaro_external_apis.id (CASCADE on delete).'],
        ['name', 'string', 'Human-readable name shown in the test panel.'],
        [
          'slug',
          'string | null',
          'Optional URL-safe identifier. Used with callExternalApiEndpoint() instead of the numeric id.'
        ],
        ['method', 'string', 'HTTP method: GET, POST, PUT, PATCH, DELETE, etc.'],
        ['path', 'string', 'Path appended to base_url, e.g. /invoices/:id.'],
        [
          'description',
          'string | null',
          'Optional human-readable description shown in the test panel.'
        ],
        ['default_body', 'object | null', 'Default request body (JSON). Caller can override.'],
        ['default_query', 'object | null', 'Default query params as key/value object.'],
        ['default_headers', 'object | null', 'Default request headers as key/value object.'],
        ['sort', 'number', 'Display order in the test panel pill list.']
      ]
    }
  ]
}

export const userComments: DocSection = {
  id: 'comments',
  label: 'Comments & Mentions',
  content: [
    { type: 'h1', id: 'comments', text: 'Comments & Mentions' },
    {
      type: 'p',
      text: 'Every item edit page includes a Comments panel. Users can post, edit, and delete comments on any record. Mentioning another user with `@handle` sends them an in-app notification and, if a Teams webhook is configured, a Microsoft Teams card.'
    },
    { type: 'h3', text: 'Posting a comment' },
    {
      type: 'p',
      text: 'Type in the comment input and submit. Use `@email-prefix` or `@first_name` to mention Nivaro users — the server resolves handles on submit, so no autocomplete is required.'
    },
    { type: 'h3', text: 'Mentions' },
    { type: 'p', text: 'When a user is mentioned they receive:' },
    {
      type: 'ul',
      items: [
        'An in-app notification in the bell popover (real-time via Socket.io).',
        'A Microsoft Teams MessageCard (requires `teams_webhook_url` in Settings).'
      ]
    },
    { type: 'h3', text: 'Editing and deleting' },
    {
      type: 'p',
      text: 'Authors can edit or delete their own comments. Admins can edit or delete any comment.'
    }
  ]
}

export const commentsApiDoc: DocSection = {
  id: 'comments-api',
  label: 'Comments API',
  content: [
    { type: 'h1', id: 'comments-api', text: 'Comments API' },
    {
      type: 'p',
      text: 'All endpoints are under `/api/comments` and require authentication. Permission checks are gated on read/create access to the parent collection.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth', 'Description'],
      rows: [
        [
          'GET',
          '/api/comments?collection=&item=',
          'read on collection',
          'List comments for a record, oldest first. Includes resolved mention users.'
        ],
        [
          'POST',
          '/api/comments',
          'create on collection',
          'Create comment. Body: { collection, item, text }. Mentions resolved + notifications sent.'
        ],
        [
          'PATCH',
          '/api/comments/:id',
          'Own comment or admin',
          'Update comment text. Body: { text }.'
        ],
        ['DELETE', '/api/comments/:id', 'Own comment or admin', 'Delete comment.']
      ]
    },
    { type: 'h3', text: 'Response shape' },
    {
      type: 'pre',
      code: `GET /api/comments?collection=projects&item=123
→ {
  "data": [
    {
      "id": "uuid",
      "collection": "projects",
      "item": "123",
      "user": { "id": "...", "first_name": "Rob", "last_name": "Lee", "email": "rob@..." },
      "text": "Looks good @finance_team",
      "created_at": "...",
      "updated_at": "...",
      "mentions": [
        { "id": "...", "first_name": "Jane", "last_name": "Smith", "email": "jane@..." }
      ]
    }
  ]
}`
    },
    { type: 'h3', text: 'Mention resolution' },
    {
      type: 'p',
      text: '`@handle` in the text is matched to Nivaro users by email prefix (`handle@*`) or first name (case-insensitive). All matched users receive in-app notifications and, if configured, Teams messages. Mentioning yourself is silently skipped.'
    }
  ]
}

export const userComputedFields: DocSection = {
  id: 'computed-fields',
  label: 'Computed Fields',
  content: [
    { type: 'h1', id: 'computed-fields', text: 'Computed Fields' },
    {
      type: 'p',
      text: 'Fields can have a formula that is evaluated automatically. Formulas use `expr-eval` — a safe, sandboxed arithmetic/logical expression evaluator. No arbitrary code execution.'
    },
    { type: 'h3', text: 'Compute types' },
    {
      type: 'table',
      head: ['Type', 'When evaluated', 'Stored in DB?', 'Use case'],
      rows: [
        [
          'read',
          'On every GET request',
          'No — virtual key added to response',
          'Derived display values (full name, total price)'
        ],
        [
          'write (not stored)',
          'Before INSERT / UPDATE',
          'No',
          'Transformations that should not persist'
        ],
        [
          'write + store',
          'Before INSERT / UPDATE',
          'Yes — written to the DB column',
          'Searchable / sortable derived columns'
        ],
        [
          'rollup',
          'On every GET request',
          'No — virtual key added to response',
          'Aggregates of related items (sum of line totals, child count)'
        ]
      ]
    },
    { type: 'h3', id: 'computed-rollup', text: 'Rollup fields' },
    {
      type: 'p',
      text: 'A rollup field returns an aggregate (sum / count / avg / min / max) of related items in another collection. Instead of an expression, the formula is a JSON config object describing what to aggregate. Like read-time fields, rollups are virtual — computed fresh on every read, never stored.'
    },
    {
      type: 'pre',
      code: `{
  "related_collection": "line_items",  // table to aggregate from
  "fk_field": "workflow_id",            // column on related_collection → this item's id
  "aggregate": "sum",                   // sum | count | avg | min | max
  "value_field": "amount",              // column to aggregate (ignored for count)
  "recursive": false                    // optional — see below
}`
    },
    {
      type: 'p',
      text: 'Example: on a workflow record, a rollup with `related_collection: "line_items"`, `fk_field: "workflow_id"`, `aggregate: "sum"`, `value_field: "amount"` returns the total of all line item amounts pointing at that workflow.'
    },
    { type: 'h3', text: 'Recursive (tree) rollups' },
    {
      type: 'p',
      text: 'Set `recursive: true` when `related_collection` is the SAME collection as the field\'s own collection and that collection forms a self-referential tree (the `fk_field` points at a parent row\'s id). The rollup then aggregates every descendant at any depth — children, grandchildren, and beyond — using a recursive SQL CTE (capped at 100 levels). Use this for "sum of all costs under this node" style totals across an org/category tree.'
    },
    {
      type: 'note',
      text: 'The Recursive checkbox in the UI only appears when the related collection equals the collection being edited. When the related collection differs, recursive is ignored and a plain single-level aggregate runs.'
    },
    {
      type: 'p',
      text: 'Configure rollups in Data Model → table → expand a field → Computed Formula → enable → choose Rollup (aggregate). Pick the related collection, FK field, aggregate function, and value field from the comboboxes. The value field is disabled for count.'
    },
    { type: 'h3', text: 'Configuring in the UI' },
    {
      type: 'p',
      text: 'Go to Data Model in the sidebar → click a table → expand any field row → scroll to the Computed Formula section:'
    },
    {
      type: 'p',
      text: '1. Check Enable to activate the formula editor. 2. Choose Read (virtual) or Write (before save). 3. Enter a formula using `item.fieldName` syntax. 4. For write-type, optionally check Store result in database column. 5. Click Save on the field row.'
    },
    { type: 'h3', text: 'Formula syntax' },
    { type: 'p', text: 'The formula context provides the full record as `item`:' },
    {
      type: 'pre',
      code: `// Numeric
item.quantity * item.unit_price
item.discount > 0 ? item.amount * (1 - item.discount / 100) : item.amount

// String — use || for concatenation (+ is numeric only)
item.first_name || " " || item.last_name

// String helpers
concat(item.first_name, " ", item.last_name)   // nulls skipped
join(", ", item.city, item.state, item.zip)     // empty values skipped
upper(item.code)
lower(item.email)
trim(item.notes)
substr(item.sku, 0, 3)
replace(item.slug, "-", "_")
coalesce(item.nickname, item.first_name)        // first non-null/empty wins

// Conditional
item.status == "active" ? 1 : 0`
    },
    {
      type: 'note',
      text: 'String concatenation: use `||` or the `concat()` helper — not `+`. The `+` operator is numeric; using it on strings produces `NaN`. The `concat()` and `join()` helpers automatically skip null/undefined values.'
    },
    { type: 'h3', text: 'In the item editor' },
    {
      type: 'p',
      text: 'Computed fields are excluded from the editable Fields section. They appear in a separate Computed Values card (with a function icon in the header) showing the current server-evaluated value, a `read-time` or `write-time` badge, and the formula displayed beneath each value. The card is read-only — computed values cannot be manually edited.'
    },
    { type: 'h3', text: 'In the collection browser' },
    {
      type: 'p',
      text: 'Computed columns are marked with a small violet ⊡ icon in the column header. Hovering shows the formula. Read-time values are fresh on every page load; write-time stored values reflect the last save.'
    },
    { type: 'h3', text: 'Configuring via API' },
    {
      type: 'pre',
      code: `POST /api/collections/:collection/fields
{
  "field": "total_price",
  "computed_formula": "item.quantity * item.unit_price",
  "computed_type": "read",    // "read" | "write" | "rollup"
  "computed_store": false     // true = persist result to DB column (write-type only)
}

// Rollup — computed_formula is a JSON string config:
{
  "field": "line_total",
  "computed_type": "rollup",
  "computed_formula": "{\\"related_collection\\":\\"line_items\\",\\"fk_field\\":\\"workflow_id\\",\\"aggregate\\":\\"sum\\",\\"value_field\\":\\"amount\\"}",
  "computed_store": false
}`
    },
    {
      type: 'note',
      text: 'Write-time + stored computed fields require the target column to already exist in the database schema. Read-time fields add a virtual key to API responses without touching the schema.'
    },
    { type: 'h3', text: 'GraphQL' },
    {
      type: 'p',
      text: 'Computed fields appear in the auto-generated GraphQL schema exactly like regular scalar fields — no special handling required. Read-time virtual fields are populated by the query resolver (which calls `readItems` server-side). Write-time fields reflect the stored or last-evaluated value.'
    },
    {
      type: 'pre',
      code: `query {
  articles_by_id(id: "123") {
    id
    title
    full_name        # read-time computed — evaluated fresh on every query
    total_price      # write+store computed — stored in DB, returned as-is
  }
}`
    },
    { type: 'h3', text: 'SDK' },
    {
      type: 'p',
      text: 'Computed field values are included transparently in all item responses. No special SDK commands are needed — `readItems` and `readItem` return them alongside regular fields.'
    },
    {
      type: 'pre',
      code: `import { readItem } from '@nivaro/sdk'

const article = await nivaro.request(readItem('articles', '123'))
// article.data.full_name   → computed read-time value (evaluated server-side)
// article.data.total_price → computed write+store value`
    }
  ]
}

export const userDashboardsGuide: DocSection = {
  id: 'dashboards-guide',
  label: 'Dashboards',
  content: [
    { type: 'h1', id: 'dashboards-guide', text: 'Dashboards' },
    {
      type: 'p',
      text: 'The Dashboards page lets you build KPI dashboards composed of metric widgets. Dashboards are personal by default; admins can mark them shared so all users see them.'
    },
    { type: 'h3', text: 'Widget types' },
    {
      type: 'table',
      head: ['Type', 'Description'],
      rows: [
        ['count', 'Total row count for a collection.'],
        ['sum', 'Sum of a numeric field across all rows.'],
        ['avg', 'Average of a numeric field.'],
        ['latest', 'Table of the 10 most recently created records.'],
        ['bar_chart', 'Bar chart of record creation counts over the last 30 days.'],
        ['line_chart', 'Line chart of creation counts over the last 30 days.']
      ]
    },
    { type: 'h3', text: 'Creating a dashboard' },
    {
      type: 'p',
      text: 'Click + New Dashboard, give it a name, and optionally check Shared. Add widgets using + Add Widget in the toolbar.'
    },
    { type: 'h3', text: 'Shared dashboards' },
    {
      type: 'p',
      text: "Shared dashboards appear in every user's list but can only be edited by the owner or an admin."
    }
  ]
}

export const dashboardsApiDoc: DocSection = {
  id: 'dashboards-api',
  label: 'Dashboards API',
  content: [
    { type: 'h1', id: 'dashboards-api', text: 'Dashboards API' },
    {
      type: 'p',
      text: 'All endpoints are under `/api/dashboards` and require authentication. Users can only access their own dashboards and shared dashboards.'
    },
    { type: 'h3', text: 'Dashboards' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/dashboards', 'List own + shared dashboards with widgets.'],
        ['POST', '/api/dashboards', 'Create. Body: { name, is_shared? }.'],
        ['GET', '/api/dashboards/:id', 'Single dashboard with widgets.'],
        ['PATCH', '/api/dashboards/:id', 'Update name or is_shared. Owner or admin.'],
        ['DELETE', '/api/dashboards/:id', 'Delete dashboard and widgets. Owner or admin.']
      ]
    },
    { type: 'h3', text: 'Widgets' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'POST',
          '/api/dashboards/:id/widgets',
          'Add widget. Body: { type, title, collection?, field?, col, row, width, height }.'
        ],
        ['PATCH', '/api/dashboards/widgets/:widgetId', 'Update widget. Owner or admin.'],
        ['DELETE', '/api/dashboards/widgets/:widgetId', 'Remove widget.'],
        ['GET', '/api/dashboards/widgets/:widgetId/data', 'Fetch live data for a widget.']
      ]
    },
    { type: 'h3', text: 'Widget types and required fields' },
    {
      type: 'table',
      head: ['type', 'collection', 'field', 'data shape'],
      rows: [
        ['count', 'required', '—', '{ value: N }'],
        ['sum', 'required', 'required', '{ value: N }'],
        ['avg', 'required', 'required', '{ value: N }'],
        ['latest', 'required', '—', '{ rows: [...] }'],
        ['bar_chart', 'required', '—', '{ rows: [{ date, count }] }'],
        ['line_chart', 'required', '—', '{ rows: [{ date, count }] }']
      ]
    }
  ]
}

export const userReportsGuide: DocSection = {
  id: 'reports-guide',
  label: 'Compliance Reports',
  content: [
    { type: 'h1', id: 'reports-guide', text: 'Audit & Compliance Reports' },
    {
      type: 'p',
      text: 'The Reports page (admin-only) provides filtered views of the audit log with CSV export for compliance workflows.'
    },
    { type: 'h3', text: 'Activity report' },
    {
      type: 'p',
      text: 'Filter by collection, user, action (create/update/delete), and date range. Results are paginated in the UI. Click Export CSV to download the full filtered dataset with no row limit.'
    },
    { type: 'h3', text: 'Summary report' },
    {
      type: 'p',
      text: 'Aggregated counts for the selected date range: breakdown by action type, top collections by mutation volume, and top users by activity count.'
    },
    {
      type: 'note',
      text: 'Reports require admin access. Non-admin users cannot access this page or its API.'
    }
  ]
}

export const reportsApiDoc: DocSection = {
  id: 'reports-api',
  label: 'Reports API',
  content: [
    { type: 'h1', id: 'reports-api', text: 'Reports API' },
    { type: 'p', text: 'All report endpoints require admin access.' },
    { type: 'h3', text: 'Activity report' },
    {
      type: 'pre',
      code: `GET /api/reports/activity
Authorization: Bearer <admin-token>

// Query parameters (all optional):
?collection=projects
?user=uuid
?action=update          // create | update | delete
?from=2025-01-01        // ISO 8601 date
?to=2025-12-31
?page=1&limit=50        // pagination; max limit 500
?format=csv             // download full result set as CSV (no pagination)

// JSON response:
{
  "data": [
    { "id", "action", "collection", "item", "timestamp",
      "user_id", "first_name", "last_name", "user_email" }
  ],
  "total": 1234,
  "page": 1,
  "limit": 50
}`
    },
    { type: 'h3', text: 'Summary report' },
    {
      type: 'pre',
      code: `GET /api/reports/summary
Authorization: Bearer <admin-token>
?from=2025-01-01&to=2025-12-31

→ {
  "by_action":     [{ "action": "create", "count": 450 }],
  "by_collection": [{ "collection": "projects", "count": 300 }],
  "by_user":       [{ "user_id", "first_name", "last_name", "email", "count" }],
  "total_events":  1234,
  "date_range":    { "from": "...", "to": "..." }
}`
    }
  ]
}

export const userMicrosoftGuide: DocSection = {
  id: 'microsoft-guide',
  label: 'Microsoft Integration',
  content: [
    { type: 'h1', id: 'microsoft-guide', text: 'Microsoft Integration' },
    {
      type: 'p',
      text: 'Nivaro ships with built-in Microsoft 365 integrations. Configure them in Settings.'
    },
    { type: 'h3', text: 'Teams notifications' },
    {
      type: 'p',
      text: 'Set `teams_webhook_url` in Settings to an incoming Teams webhook URL. When a user is mentioned in a comment, a Teams MessageCard is automatically posted to that webhook.'
    },
    { type: 'h3', text: 'Azure AD group → role mapping' },
    {
      type: 'p',
      text: "Set `ad_group_role_map` in Settings to a JSON object mapping AD group names to Nivaro role IDs. On OIDC login, the server resolves the user's AD groups and auto-assigns the first matching role."
    },
    {
      type: 'pre',
      code: `// ad_group_role_map example (JSON stored in Settings):
{
  "Admins":   "admin-role-uuid",
  "Finance":  "finance-role-uuid",
  "ReadOnly": "viewer-role-uuid"
}`
    },
    { type: 'h3', text: 'OIDC authentication' },
    {
      type: 'p',
      text: 'All auth flows through Microsoft OIDC (PKCE). First name, last name, and email are synced from the OIDC token on every login. No separate user creation required.'
    }
  ]
}

export const userWorkspacesGuide: DocSection = {
  id: 'workspaces-guide',
  label: 'Workspaces',
  content: [
    { type: 'h1', id: 'workspaces-guide', text: 'Workspaces' },
    {
      type: 'p',
      text: 'Workspaces provide logical separation within a single Nivaro instance. Collections and roles are scoped to a workspace. Users can switch workspaces without logging out.'
    },
    { type: 'h3', text: 'Switching workspaces' },
    {
      type: 'p',
      text: 'Click the workspace name at the bottom of the sidebar to open the switcher popover. Select a workspace to switch — the page reloads with the new context applied.'
    },
    { type: 'h3', text: 'Workspace isolation' },
    {
      type: 'p',
      text: "Every API request includes an `x-workspace` header (sent automatically by the admin UI). The server uses this to scope collections and roles. If omitted, the server falls back to the user's saved preference, then the default workspace."
    },
    {
      type: 'note',
      text: 'Workspace isolation applies to collections and roles — which collections appear in the sidebar and which roles exist for assignment. Data rows (items) are not filtered by workspace; all records in a table are visible regardless of active workspace. Full row-level isolation would require a `workspace_id` FK column per business table and can be added in a future migration.'
    },
    { type: 'h3', text: 'Managing workspaces' },
    {
      type: 'p',
      text: 'Admins can create, edit, and delete workspaces via the Workspaces page in the sidebar. Each workspace needs a unique slug. The default workspace cannot be deleted.'
    }
  ]
}

export const workspacesApiDoc: DocSection = {
  id: 'workspaces-api',
  label: 'Workspaces API',
  content: [
    { type: 'h1', id: 'workspaces-api', text: 'Workspaces API' },
    {
      type: 'p',
      text: 'Management endpoints require admin access. The switch endpoint is available to any authenticated user.'
    },
    { type: 'h3', text: 'Workspace header' },
    {
      type: 'p',
      text: 'Include `x-workspace: <workspaceId>` on every API request to target a specific workspace. The admin UI sends this automatically based on the active workspace.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth', 'Description'],
      rows: [
        ['GET', '/api/workspaces', 'Admin', 'List all workspaces.'],
        [
          'POST',
          '/api/workspaces',
          'Admin',
          'Create workspace. Body: { name, slug, icon?, color? }.'
        ],
        ['GET', '/api/workspaces/:id', 'Admin', 'Single workspace.'],
        ['PATCH', '/api/workspaces/:id', 'Admin', 'Update workspace.'],
        ['DELETE', '/api/workspaces/:id', 'Admin', 'Delete (blocked if last workspace).'],
        [
          'POST',
          '/api/workspaces/:id/switch',
          'Any user',
          "Set as user's current_workspace preference."
        ]
      ]
    },
    { type: 'h3', text: 'Workspace object' },
    {
      type: 'pre',
      code: `{
  "id":         "uuid",
  "name":       "Production",
  "slug":       "prod",
  "icon":       "building",     // optional
  "color":      "#00ceff",      // optional hex
  "created_at": "...",
  "updated_at": "..."
}`
    }
  ]
}

export const aiOverview: DocSection = {
  id: 'ai-overview',
  label: 'Overview',
  content: [
    { type: 'h1', id: 'ai-overview', text: 'AI Features' },
    {
      type: 'p',
      text: 'Nivaro includes Claude-powered AI features for content generation and record summarization. AI features are admin-only and require an Anthropic API key. The key can be configured in two ways: set the `ANTHROPIC_API_KEY` environment variable on the server, or enter it in Settings → AI Features → Anthropic API Key. The settings value takes precedence when the env var is absent. When no key is found, all AI endpoints return `503 Service Unavailable`.'
    },
    {
      type: 'table',
      head: ['Feature', 'Where', 'Description'],
      rows: [
        [
          'Generate with AI',
          'Item editor — field label',
          "Generates a value for a text/string field using the record's existing data as context."
        ],
        [
          'Summarize',
          'Item editor — page header',
          'Produces a 2-3 sentence plain-English summary of the full record for a business user.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'AI features are available to admin users only. The "AI" button on fields and the "Summarize" button in the header are hidden for non-admin users.'
    }
  ]
}

export const aiGenerate: DocSection = {
  id: 'ai-generate',
  label: 'Generate with AI',
  content: [
    { type: 'h1', id: 'ai-generate', text: 'Generate with AI' },
    {
      type: 'p',
      text: 'On the item edit page, text and string fields show a small `✦ AI` button next to the field label. Clicking it calls `POST /api/ai/generate` with the current collection, item ID, and field name. Claude reads the full record and writes a suggested value directly into the field — you can edit or discard it before saving.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `POST /api/ai/generate
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "collection": "articles",
  "item_id": "123",
  "field": "summary",
  "context": "Optional extra instructions for the AI"
}

→ 200 { "data": { "value": "Generated field content..." } }
→ 400 { "error": "collection, item_id, and field are required" }
→ 404 { "error": "Item not found" }
→ 503 { "error": "AI features require ANTHROPIC_API_KEY to be configured" }`
    },
    { type: 'h3', text: 'Model' },
    {
      type: 'p',
      text: 'Uses `claude-haiku-4-5` with `max_tokens: 500`. The prompt includes the full record JSON, field metadata (note/description if present), and any additional context you provide.'
    }
  ]
}

export const aiSummarize: DocSection = {
  id: 'ai-summarize',
  label: 'Summarize',
  content: [
    { type: 'h1', id: 'ai-summarize', text: 'Summarize' },
    {
      type: 'p',
      text: 'The `Summarize` button in the item editor header calls `POST /api/ai/summarize`. The result appears in a dismissible amber info box below the header — it is not saved to the record.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `POST /api/ai/summarize
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "collection": "inventory_requests",
  "item_id": "456"
}

→ 200 { "data": { "summary": "This inventory request..." } }
→ 400 { "error": "collection and item_id are required" }
→ 404 { "error": "Item not found" }
→ 503 { "error": "AI features require ANTHROPIC_API_KEY to be configured" }`
    },
    { type: 'h3', text: 'Model' },
    {
      type: 'p',
      text: 'Uses `claude-haiku-4-5` with `max_tokens: 200`. The prompt instructs the model to produce a 2-3 sentence plain-English summary for a business user.'
    },
    { type: 'h3', text: 'Server configuration' },
    {
      type: 'pre',
      code: `# .env
ANTHROPIC_API_KEY=sk-ant-...`
    },
    {
      type: 'warn',
      text: 'The server starts normally without `ANTHROPIC_API_KEY` — the field is optional. AI endpoints return 503 until the key is provided.'
    }
  ]
}

export const columnPresets: DocSection = {
  id: 'column-presets',
  label: 'Column Presets',
  content: [
    { type: 'h1', id: 'column-presets', text: 'Column Presets' },
    {
      type: 'p',
      text: 'The collection browser lets you choose which columns to display and in what order. Your selection is saved as a preset so it persists across sessions. Admins can also set a system default that applies to all users who have not chosen their own preset.'
    },
    { type: 'h3', text: 'Opening the column picker' },
    {
      type: 'p',
      text: 'Click the Columns button in the top-right toolbar of any collection browser. A popover opens with:'
    },
    {
      type: 'ul',
      items: [
        'Visible columns — drag handles let you reorder. Click the × to hide a column.',
        'Add column — a searchable list of all available fields not already visible.',
        'Your presets — saved column configurations. Click one to activate it. The active preset name is shown as a badge on the Columns button.',
        'Save as preset — saves the current column/order selection under a name of your choice.',
        'Set as system default (admin only) — saves the current selection as the default for all users who have not set their own preset.'
      ]
    },
    { type: 'h3', text: 'Preset resolution order' },
    {
      type: 'p',
      text: 'When loading a collection browser, columns are resolved in this priority:'
    },
    {
      type: 'ul',
      items: [
        'Your active preset (if you have activated one for this collection).',
        'The system default (if an admin has set one for this collection).',
        "The first 7 fields from the collection's field list (built-in fallback)."
      ]
    },
    { type: 'h3', text: 'Deleting or renaming a preset' },
    {
      type: 'p',
      text: 'In the column picker popover, hover over a saved preset and click the trash icon to delete it. To rename, delete and re-save with the new name.'
    },
    {
      type: 'note',
      text: 'Presets are stored per collection per user in `nivaro_collection_presets`. The system default has `user_id = NULL`. Each user can have multiple named presets but only one active at a time (tracked server-side).'
    }
  ]
}

export const userProfile: DocSection = {
  id: 'profile',
  label: 'My Profile',
  content: [
    { type: 'h1', id: 'profile', text: 'My Profile' },
    {
      type: 'p',
      text: 'The Profile page lets any authenticated user manage their own account. Access it by clicking your name or avatar in the sidebar footer.'
    },
    { type: 'h3', text: 'What you can change' },
    {
      type: 'ul',
      items: [
        'First name / Last name — editable. Changes take effect immediately in the sidebar and across the UI.',
        'Email — read-only. Managed via Microsoft OIDC; cannot be changed here.'
      ]
    },
    { type: 'h3', text: 'Read-only account details' },
    {
      type: 'p',
      text: 'Role name, account status, User ID, member since date, and last access time are displayed but not editable by a regular user. Admins can change role and status via the Users page.'
    },
    { type: 'h3', text: 'API token management' },
    {
      type: 'p',
      text: 'The API Token section lets you manage your static token for programmatic API access:'
    },
    {
      type: 'ul',
      items: [
        'Generate — creates a new token. The value is shown once — copy it immediately.',
        'Reveal / Hide — toggles visibility of the token value.',
        'Copy — copies the token to the clipboard (only available while revealed).',
        'Regenerate — replaces the existing token with a new one. The old token stops working immediately.',
        'Revoke — deletes the token entirely. Bearer-token API access is disabled until a new token is generated.'
      ]
    },
    { type: 'h3', text: 'Revision history' },
    {
      type: 'p',
      text: 'A History button in the page header opens the revision panel showing every change made to your user record (name changes, role assignments, status changes).'
    },
    {
      type: 'warn',
      text: 'Tokens are shown only on generation. If you close the page without copying, the token value cannot be retrieved — regenerate to get a new one.'
    }
  ]
}

export const userDelegation: DocSection = {
  id: 'delegation',
  label: 'Delegation & Substitution',
  content: [
    { type: 'h1', id: 'delegation', text: 'Delegation & Substitution' },
    {
      type: 'p',
      text: 'Delegation lets a user temporarily hand off their pipeline owner responsibilities to another user. When a user is marked out of office and has an active delegate, the pipeline engine substitutes the delegate wherever the user would otherwise be resolved as an owner.'
    },
    { type: 'h3', text: 'Setting your own delegation' },
    {
      type: 'p',
      text: 'On your Profile page the Delegation card lets you configure substitution without admin access:'
    },
    {
      type: 'ul',
      items: [
        'Out of office — toggle on to activate delegation. While off, you remain the owner regardless of the delegate setting.',
        'Delegate to — pick the user who should receive your ownership. The picker is a searchable combobox of all users.',
        'Delegation expires — optional date/time. Leave blank for an indefinite delegation; once the expiry passes, ownership reverts to you automatically.',
        'Manager — read-only on your own profile; set by an administrator.'
      ]
    },
    {
      type: 'note',
      text: 'Delegation only takes effect when all three conditions hold: out of office is on, a delegate is selected, and the expiry (if set) is in the future.'
    },
    { type: 'h3', text: 'Admin management' },
    {
      type: 'p',
      text: 'On the Users → user edit page, administrators see the same Delegation card plus an editable Manager field. Admins can set delegation and the manager relationship for any user.'
    },
    { type: 'h3', text: 'How substitution works' },
    {
      type: 'p',
      text: 'When the pipeline engine resolves owners for a state, it applies delegation as the final step. Each resolved owner who is out of office with an active, non-expired delegate is replaced by the delegate. The result is de-duplicated, so two owners delegating to the same person collapse to a single entry.'
    }
  ]
}

export const presetsApiDoc: DocSection = {
  id: 'presets-api',
  label: 'Column Presets API',
  content: [
    { type: 'h1', id: 'presets-api', text: 'Column Presets API' },
    {
      type: 'p',
      text: 'Column presets store per-user (or system-wide) column selections for collection browsers. All endpoints are under `/api/presets` and require authentication.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth', 'Description'],
      rows: [
        [
          'GET',
          '/api/presets?collection=:col',
          'Any user',
          'Returns systemDefault, presets[], and activePresetId for the given collection.'
        ],
        [
          'POST',
          '/api/presets',
          'Any user',
          'Create a named preset. Body: { collection, name, columns: string[] }.'
        ],
        [
          'PUT',
          '/api/presets/system-default',
          'Admin',
          'Set or replace the system default for a collection. Body: { collection, columns: string[] }.'
        ],
        [
          'DELETE',
          '/api/presets/active?collection=:col',
          'Any user',
          'Clear the active preset for the given collection (revert to system default / fallback).'
        ],
        [
          'POST',
          '/api/presets/:id/activate',
          'Any user (own preset)',
          'Set a preset as active for its collection.'
        ],
        [
          'PATCH',
          '/api/presets/:id',
          'Any user (own preset)',
          'Rename a preset or update its columns. Body: { name?, columns? }.'
        ],
        ['DELETE', '/api/presets/:id', 'Any user (own preset) / Admin', 'Delete a preset.']
      ]
    },
    { type: 'h3', text: 'GET /api/presets response' },
    {
      type: 'pre',
      code: `{
  "data": {
    "systemDefault": {
      "id": "uuid", "collection": "projects",
      "name": "System Default", "user_id": null,
      "columns": ["id", "name", "status", "created_at"],
      "is_default": true, "created_at": "..."
    },
    "presets": [
      {
        "id": "uuid", "collection": "projects",
        "name": "My View", "user_id": "user-uuid",
        "columns": ["id", "name", "region", "amount"],
        "is_default": false, "created_at": "..."
      }
    ],
    "activePresetId": "uuid"   // null if no active preset
  }
}`
    },
    { type: 'h3', text: 'Creating a preset' },
    {
      type: 'pre',
      code: `POST /api/presets
{ "collection": "projects", "name": "My View", "columns": ["id", "name", "region", "amount"] }

→ 201 { "data": { "id": "uuid", ... } }`
    },
    {
      type: 'note',
      text: 'The system default (`PUT /api/presets/system-default`) has `user_id = NULL` and is visible to all users as the fallback when no personal preset is active.'
    }
  ]
}

export const presenceGuide: DocSection = {
  id: 'presence-guide',
  label: 'Presence Tracking',
  content: [
    { type: 'h1', id: 'presence-guide', text: 'Presence Tracking' },
    {
      type: 'p',
      text: 'Presence lets you see which external users are active on your site right now. The embedded tracker script pings the API on a configurable interval; sessions expire automatically from Redis when pings stop. The admin Presence page updates in near real-time via Socket.io.'
    },
    { type: 'h3', text: 'Embedding the tracker' },
    {
      type: 'p',
      text: 'Serve the script from your Nivaro API and add it to any page you want to track:'
    },
    {
      type: 'pre',
      code: `<script
  src="https://your-api.example.com/api/presence.js"
  data-api-url="https://your-api.example.com"
  data-user-id="user-123"
  data-user-email="jane@example.com"
  data-user-name="Jane Smith"
></script>`
    },
    {
      type: 'p',
      text: 'All `data-*` attributes are optional. Alternatively, set a `window.NivaroPresence` config object before the script tag:'
    },
    {
      type: 'pre',
      code: `window.NivaroPresence = {
  apiUrl: 'https://your-api.example.com',
  userId: currentUser.id,
  userEmail: currentUser.email,
  userName: currentUser.name,
};`
    },
    { type: 'h3', text: 'Runtime API' },
    { type: 'p', text: 'After the script loads, `window.NivaroPresenceClient` is available:' },
    {
      type: 'table',
      head: ['Method', 'Description'],
      rows: [
        ['ping()', 'Send an immediate ping (called automatically on interval).'],
        ['disconnect()', 'Remove this session from Redis immediately.'],
        [
          'setUser(id, email, name)',
          'Update the identity for the current session — use in SPAs after login.'
        ],
        ['trackView(prevDur)', 'Manually record a page view (called automatically on navigation).'],
        ['sessionId', 'The current session UUID (read-only).']
      ]
    },
    { type: 'h3', text: 'Timing configuration' },
    {
      type: 'p',
      text: 'Ping interval, server sweep interval, and session TTL are all configurable in Settings → Presence. The session TTL must be longer than the ping interval or sessions will expire between pings. Ping interval changes take effect when the script is next loaded (no server restart required).'
    },
    {
      type: 'note',
      text: 'User identity fields (userId, userEmail, userName) are client-asserted and cannot be verified for public tracker requests. Display them as "self-reported" rather than treating them as authoritative.'
    }
  ]
}

export const analyticsGuide: DocSection = {
  id: 'analytics-guide',
  label: 'Frontend Analytics',
  content: [
    { type: 'h1', id: 'analytics-guide', text: 'Frontend Analytics' },
    {
      type: 'p',
      text: 'The same tracker script that powers Presence also records page views into `nivaro_page_views`. No extra configuration is needed — page view tracking is active as soon as the script is embedded.'
    },
    { type: 'h3', text: 'What is tracked' },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['pageUrl', 'Full URL of the page viewed.'],
        ['pageTitle', 'document.title at view time.'],
        ['referrer', 'document.referrer (empty on direct navigation).'],
        ['deviceType', 'desktop, tablet, or mobile (UA-sniffed).'],
        [
          'duration_seconds',
          'Time spent on the page. Recorded when the user navigates away or closes the tab.'
        ],
        ['session_id', 'Persistent session UUID stored in localStorage.'],
        [
          'user_email / user_name',
          'Client-asserted identity from the tracker config (self-reported).'
        ]
      ]
    },
    { type: 'h3', text: 'SPA navigation' },
    {
      type: 'p',
      text: 'The script hooks `history.pushState` and the `popstate` event so single-page app route changes are tracked automatically. Each navigation closes the previous view (recording its duration) and opens a new one.'
    },
    { type: 'h3', text: 'Analytics page' },
    { type: 'p', text: 'Navigate to Monitoring → Analytics. The page shows:' },
    {
      type: 'table',
      head: ['Panel', 'Description'],
      rows: [
        ['Stat cards', 'Total views, unique sessions, and unique pages for the selected period.'],
        [
          'Views table',
          'Paginated list of individual page views with URL, identity, device, and duration.'
        ],
        ['Top pages', 'Bar chart of the most-visited URLs by view count for the selected period.']
      ]
    },
    { type: 'p', text: 'Period options: Today (1d), 7 Days, 30 Days.' },
    {
      type: 'note',
      text: 'Page view durations are written on navigation or tab close via `fetch + keepalive`. If the browser is force-killed the final duration may not be recorded.'
    }
  ]
}
