import type { DocSection } from '../types.js'

export const sdkExternalApis: DocSection = {
  id: 'sdk-external-apis',
  label: 'External APIs',
  content: [
    { type: 'h1', id: 'sdk-external-apis', text: 'SDK — External APIs' },
    {
      type: 'p',
      text: 'Call configured external APIs without exposing credentials. The SDK handles credential injection server-side. Use these commands to manage API configs, test connections, and call endpoints.'
    },
    { type: 'h3', text: 'Calling an external API' },
    {
      type: 'pre',
      code: `import { callExternalApi } from '@nivaro/sdk'

// Call any endpoint on a configured API
const { data: result } = await nivaro.request(
  callExternalApi('slack-api', {
    method: 'POST',
    path: '/chat.postMessage',
    body: { channel: 'C1234', text: 'Task completed' },
  })
)
// result.status → 200, 400, 500, etc.
// result.headers → response headers
// result.body → parsed JSON response (or text if not JSON)`
    },
    { type: 'h3', text: 'Admin: API config CRUD' },
    {
      type: 'pre',
      code: `import {
  readExternalApis, readExternalApi,
  createExternalApi, updateExternalApi, deleteExternalApi,
  testExternalApi,
} from '@nivaro/sdk'

// List all configured APIs
const { data: apis } = await nivaro.request(readExternalApis())

// Get one
const { data: api } = await nivaro.request(readExternalApi(apiId))

// Create an API config
const { data: slack } = await nivaro.request(
  createExternalApi({
    name: 'Slack API',
    base_url: 'https://slack.com/api',
    auth_type: 'bearer',  // bearer | api_key | basic | oauth2_cc
    auth_config: { token: 'xoxb-...' },
    enabled: true,
  })
)

// Update
await nivaro.request(updateExternalApi(slack.id, { enabled: false }))

// Test the connection
const { data: testResult } = await nivaro.request(testExternalApi(slack.id, {
  method: 'GET',
  path: '/auth.test',
}))
console.log(testResult.status, testResult.body)

// Delete
await nivaro.request(deleteExternalApi(slack.id))`
    },
    {
      type: 'table',
      head: ['Auth Type', 'Config Fields', 'Example'],
      rows: [
        ['bearer', 'token', '{ token: "sk_live_..." }'],
        ['api_key', 'header_name, value', '{ header_name: "X-API-Key", value: "key123" }'],
        ['basic', 'username, password', '{ username: "user", password: "pass" }'],
        ['oauth2_cc', 'client_id, client_secret, token_url', '{ client_id: "...", ... }']
      ]
    },
    { type: 'h3', text: 'Admin: Endpoint templates' },
    {
      type: 'p',
      text: 'Pre-define common endpoints for an API so users can call them by slug instead of writing full path/method each time.'
    },
    {
      type: 'pre',
      code: `import {
  readExternalApiEndpoints, createExternalApiEndpoint,
  updateExternalApiEndpoint, deleteExternalApiEndpoint,
} from '@nivaro/sdk'

// List templates for an API
const { data: endpoints } = await nivaro.request(readExternalApiEndpoints(apiId))

// Create a template
const { data: tpl } = await nivaro.request(
  createExternalApiEndpoint(apiId, {
    name: 'Post Message',
    slug: 'post-message',  // users call via this slug
    method: 'POST',
    path: '/chat.postMessage',
    default_body: { channel: 'general' },
  })
)

// Update
await nivaro.request(updateExternalApiEndpoint(tpl.id, {
  default_body: { channel: 'alerts' },
}))

// Delete
await nivaro.request(deleteExternalApiEndpoint(tpl.id))`
    },
    {
      type: 'note',
      text: 'Credentials (tokens, passwords) are never exposed in GET responses — sensitive fields return a masked value like `••••••`. When updating, re-submit the masked value to keep the existing credential; send a plaintext value to change it.'
    }
  ]
}

export const sdkComments: DocSection = {
  id: 'sdk-comments',
  label: 'Comments & Mentions',
  content: [
    { type: 'h1', id: 'sdk-comments', text: 'SDK — Comments & Mentions' },
    {
      type: 'p',
      text: 'Threaded comments on any record. Users can mention other users via @username syntax — mentioned users receive in-app notifications automatically.'
    },
    {
      type: 'pre',
      code: `import { readComments, createComment, updateComment, deleteComment } from '@nivaro/sdk'

// All comments on an item (oldest first)
const { data: comments } = await nivaro.request(
  readComments('projects', itemId)
)
// comments → Comment[] — { id, text, user_id, first_name, last_name, created_at, mentions: [{ user_id, first_name }] }

// Create a comment with @mentions
const { data: comment } = await nivaro.request(
  createComment({
    collection: 'projects',
    item: itemId,
    text: '@jane Please review when you get a chance. Thanks @bob!',
  })
)
// @mentions are parsed from text; mentioned users get notifications

// Update own comment
await nivaro.request(
  updateComment(comment.id, { text: 'Updated — needs urgent review' })
)

// Delete own comment (or admin delete any)
await nivaro.request(deleteComment(comment.id))`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['readComments(collection, item)', 'GET /comments', 'Authenticated'],
        ['createComment(body)', 'POST /comments', 'Authenticated'],
        ['updateComment(id, body)', 'PATCH /comments/:id', 'Authenticated (own)'],
        ['deleteComment(id)', 'DELETE /comments/:id', 'Authenticated (own or admin)']
      ]
    },
    {
      type: 'note',
      text: 'Mention syntax: `@firstname-lastname` (from the user directory). The server parses mentions from the text and sends notifications to all mentioned users. Mention list is also returned in the response for UI highlighting.'
    }
  ]
}

export const sdkWebhooks: DocSection = {
  id: 'sdk-webhooks',
  label: 'Webhooks',
  content: [
    { type: 'h1', id: 'sdk-webhooks', text: 'SDK — Webhooks' },
    {
      type: 'p',
      text: 'HTTP webhooks fire when collection items are created, updated, or deleted. Payloads include the full item snapshot + delta for updates. Deliveries are retried automatically with exponential backoff.'
    },
    {
      type: 'pre',
      code: `import {
  readWebhooks, readWebhook,
  createWebhook, updateWebhook, deleteWebhook, testWebhook,
} from '@nivaro/sdk'

// List all webhooks
const { data: webhooks } = await nivaro.request(readWebhooks())

// Create a webhook
const { data: wh } = await nivaro.request(
  createWebhook({
    name: 'Slack notifications',
    url: 'https://hooks.slack.com/services/xxx/yyy/zzz',
    collection: 'projects',
    events: ['create', 'update'],  // or 'delete'
    headers: { 'X-Custom-Header': 'value' },
    enabled: true,
  })
)

// Update
await nivaro.request(updateWebhook(wh.id, { enabled: false }))

// Test delivery (fire one immediately to verify endpoint is working)
const { data: testResult } = await nivaro.request(testWebhook(wh.id))
console.log(testResult.status, testResult.response_time)

// Delete
await nivaro.request(deleteWebhook(wh.id))`
    },
    { type: 'h3', text: 'Payload shape' },
    {
      type: 'pre',
      code: `{
  "event": "item.create",
  "collection": "projects",
  "item": {
    "id": "123",
    "name": "New Project",
    "status": "draft",
    ...
  },
  "delta": {
    // For updates only — fields that changed
    "status": "draft"
  },
  "timestamp": "2024-06-14T10:30:00Z",
  "user_id": "user-uuid",
  "delivery_id": "delivery-uuid"
}`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['readWebhooks()', 'GET /webhooks', 'Admin'],
        ['readWebhook(id)', 'GET /webhooks/:id', 'Admin'],
        ['createWebhook(data)', 'POST /webhooks', 'Admin'],
        ['updateWebhook(id, data)', 'PATCH /webhooks/:id', 'Admin'],
        ['deleteWebhook(id)', 'DELETE /webhooks/:id', 'Admin'],
        ['testWebhook(id)', 'POST /webhooks/:id/test', 'Admin']
      ]
    },
    {
      type: 'note',
      text: 'Webhooks are fired asynchronously after the item is committed to the database. Failures are retried up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s). See the Webhooks admin page to view delivery history and retry failed deliveries.'
    }
  ]
}

export const sdkRules: DocSection = {
  id: 'sdk-rules',
  label: 'Rules & Automation',
  content: [
    { type: 'h1', id: 'sdk-rules', text: 'SDK — Rules & Automation' },
    {
      type: 'p',
      text: 'Automations (rules) run server-side on create/update/delete. Define conditions (field values that must match) and actions (notify, set field, reject, trigger external system). All actions run transactionally — if any action fails, the entire operation is rolled back.'
    },
    {
      type: 'pre',
      code: `import { readRules, createRule, updateRule, deleteRule } from '@nivaro/sdk'

// List rules for a collection
const { data: rules } = await nivaro.request(readRules('orders'))

// Create a rule
const { data: rule } = await nivaro.request(
  createRule({
    name: 'Auto-escalate urgent orders',
    collection: 'orders',
    trigger: 'create',  // or 'update' or 'delete'
    conditions: [
      { field: 'priority', operator: '_eq', value: 'urgent' }
    ],
    actions: [
      { type: 'notify', recipient_user_id: 'manager-uuid', subject: 'Urgent order' },
      { type: 'set_field', field: 'escalated', value: true },
    ],
    enabled: true,
  })
)

// Disable a rule temporarily
await nivaro.request(updateRule(rule.id, { enabled: false }))

// Delete
await nivaro.request(deleteRule(rule.id))`
    },
    { type: 'h3', text: 'Condition operators' },
    {
      type: 'table',
      head: ['Operator', 'Meaning', 'Example'],
      rows: [
        ['_eq', 'Equal', 'status _eq "urgent"'],
        ['_neq', 'Not equal', 'status _neq "draft"'],
        ['_gt', 'Greater than', 'amount _gt 1000'],
        ['_gte', 'Greater or equal', 'amount _gte 500'],
        ['_lt', 'Less than', 'age _lt 18'],
        ['_lte', 'Less or equal', 'age _lte 65'],
        ['_in', 'In set', 'status _in ["urgent", "high"]'],
        ['_empty', 'Is null/empty', 'description _empty null'],
        ['_contains', 'Substring', 'name _contains "test"'],
        ['_starts_with', 'Prefix', 'email _starts_with "admin"']
      ]
    },
    { type: 'h3', text: 'Action types' },
    {
      type: 'table',
      head: ['Action', 'Fields', 'Description'],
      rows: [
        ['notify', 'recipient_user_id, subject, body', 'Send in-app notification.'],
        ['set_field', 'field, value', 'Auto-set a field (no auth bypass — must be writable).'],
        ['reject', 'error_message', 'Block the save and return an error to the user.'],
        ['trigger_external', 'external_api_id, path, method, body', 'Call an external API (credentials stay server-side).']
      ]
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['readRules(collection?)', 'GET /rules', 'Admin'],
        ['createRule(data)', 'POST /rules', 'Admin'],
        ['updateRule(id, data)', 'PATCH /rules/:id', 'Admin'],
        ['deleteRule(id)', 'DELETE /rules/:id', 'Admin']
      ]
    },
    {
      type: 'note',
      text: 'All conditions in a rule must be true (AND logic) for actions to fire. Actions execute in order. If a "reject" action runs, no subsequent actions run and the item is not saved.'
    }
  ]
}

export const sdkFlowRuns: DocSection = {
  id: 'sdk-flow-runs',
  label: 'Flow Runs',
  content: [
    { type: 'h1', id: 'sdk-flow-runs', text: 'SDK — Flow Runs' },
    {
      type: 'p',
      text: 'Flows are Inngest-backed automations (schedules, webhooks, manual triggers). View execution history, logs, and errors via the SDK.'
    },
    {
      type: 'pre',
      code: `import { readFlowRuns, readFlowRun, triggerFlowRun } from '@nivaro/sdk'

// List all runs for a flow (newest first)
const { data: runs } = await nivaro.request(
  readFlowRuns(flowId, { limit: 50, status: 'error' })
)
// runs → Run[] — { id, status, started_at, completed_at, duration_ms, output, error_message }

// Single run detail with step logs
const { data: run } = await nivaro.request(readFlowRun(runId))
console.log(run.status)  // 'running' | 'success' | 'error'
console.log(run.error_message)  // if status === 'error'

// Trigger a flow immediately (bypasses schedule)
const { data: run } = await nivaro.request(
  triggerFlowRun(flowId, { payload: { action: 'review', user_id: '123' } })
)`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['readFlowRuns(flowId, opts?)', 'GET /flows/:id/runs', 'Admin'],
        ['readFlowRun(runId)', 'GET /flows/runs/:id', 'Admin'],
        ['triggerFlowRun(flowId, payload?)', 'POST /flows/:id/trigger', 'Admin']
      ]
    },
    {
      type: 'note',
      text: 'Flows are created and configured in the admin UI at `/flows`. They support cron schedules, manual triggers, webhook triggers, and event-driven execution. Each flow run produces logs for every step — view them in the admin UI or via the GraphQL API.'
    }
  ]
}

export const sdkCustomQueries: DocSection = {
  id: 'sdk-custom-queries',
  label: 'Custom Queries',
  content: [
    { type: 'h1', id: 'sdk-custom-queries', text: 'SDK — Custom Queries' },
    {
      type: 'p',
      text: 'Custom queries are parameterized SQL endpoints defined by admins. Use them for complex analytics, cross-collection joins, and aggregations that the standard filter DSL cannot express.'
    },
    {
      type: 'pre',
      code: `import { readCustomQueries, executeCustomQuery } from '@nivaro/sdk'

// List all queries visible to the current user
const { data: queries } = await nivaro.request(readCustomQueries())
// queries → Query[] — { id, name, slug, description, access, cache_ttl, params }

// Execute a query by slug with parameters
const { data: rows, cached, executed_at } = await nivaro.request(
  executeCustomQuery('high-value-deals', { region: 'West', min_amount: 50000 })
)
// rows → Record[] — raw query results (any shape, depends on the query)`
    },
    { type: 'h3', text: 'Example: Defining a custom query' },
    {
      type: 'p',
      text: 'In the admin UI at `/custom-queries`, create a query:'
    },
    {
      type: 'pre',
      code: `-- Name: High-value deals
-- Access: authenticated

SELECT
  d.id,
  d.name,
  d.amount,
  d.region,
  u.first_name,
  u.last_name,
  COUNT(i.id) as item_count
FROM deals d
LEFT JOIN users u ON u.id = d.owner_id
LEFT JOIN items i ON i.deal_id = d.id
WHERE d.region = @region
  AND d.amount >= @min_amount
GROUP BY d.id, d.name, d.amount, d.region, u.first_name, u.last_name
ORDER BY d.amount DESC`
    },
    { type: 'h3', text: 'Parameters' },
    {
      type: 'table',
      head: ['Name', 'Type', 'Required', 'Default'],
      rows: [
        ['region', 'string', 'true', 'N/A'],
        ['min_amount', 'number', 'false', '0']
      ]
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['readCustomQueries()', 'GET /custom-queries', 'Authenticated'],
        [
          'executeCustomQuery(slug, params?)',
          'POST /custom-queries/:slug/execute',
          'Per-query setting'
        ]
      ]
    },
    {
      type: 'note',
      text: 'All parameters are bound safely via MSSQL parameterized queries (@name syntax). Never string-interpolate user input into custom queries. Results can be cached via the TTL setting.'
    }
  ]
}

export const sdkCollections: DocSection = {
  id: 'sdk-collections',
  label: 'Collections & Schema',
  content: [
    { type: 'h1', id: 'sdk-collections', text: 'SDK — Collections & Schema' },
    {
      type: 'p',
      text: 'Read collection metadata and field definitions from the registry. Useful for building dynamic UIs, form generators, and schema explorers.'
    },
    {
      type: 'pre',
      code: `import { readCollections, readCollection, readFields } from '@nivaro/sdk'

// List all collections visible to the current user
const { data: collections } = await nivaro.request(readCollections())
// collections → Collection[] — { id, collection, label, icon, sort_field, display_template }

// Single collection metadata
const { data: col } = await nivaro.request(readCollection('orders'))
// col → { id, collection: "orders", label: "Orders", primary_key_field: "id", ... }

// All fields in a collection
const { data: fields } = await nivaro.request(readFields('orders'))
// fields → Field[] — { key, type, interface, required, sort, hidden, ... }`
    },
    { type: 'h3', text: 'Collection metadata' },
    {
      type: 'table',
      head: ['Property', 'Type', 'Description'],
      rows: [
        ['id', 'string', 'UUID.'],
        ['collection', 'string', 'Slug used in API paths.'],
        ['label', 'string', 'Display name.'],
        ['icon', 'string', 'Icon class name.'],
        ['primary_key_field', 'string', 'Usually "id".'],
        ['sort_field', 'string | null', 'Default sort column.'],
        ['display_template', 'string | null', 'Handlebars for rendering rows (e.g., "{{ name }} ({{ status }})").']
      ]
    },
    { type: 'h3', text: 'Field metadata' },
    {
      type: 'table',
      head: ['Property', 'Type', 'Description'],
      rows: [
        ['key', 'string', 'Field name.'],
        ['label', 'string', 'Display label.'],
        ['type', 'string', 'text | number | boolean | date | select | etc.'],
        ['interface', 'string', 'UI hint: text-input | textarea | toggle | date-picker | etc.'],
        ['required', 'boolean', 'If true, must have a value.'],
        ['sort', 'number | null', 'Display order.'],
        ['hidden', 'boolean', 'If true, hidden from UI (but readable via API).'],
        ['computed_formula', 'string | null', 'If set, field is auto-calculated (read-only).']
      ]
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['readCollections()', 'GET /collections', 'Authenticated'],
        ['readCollection(collection)', 'GET /collections/:collection', 'Authenticated'],
        ['readFields(collection)', 'GET /fields/:collection', 'Authenticated']
      ]
    }
  ]
}

export const sdkBlackoutDates: DocSection = {
  id: 'sdk-blackout-dates',
  label: 'Blackout Dates',
  content: [
    { type: 'h1', id: 'sdk-blackout-dates', text: 'SDK — Blackout Dates' },
    {
      type: 'p',
      text: 'Blackout date ranges (e.g., holidays, maintenance windows) pause scheduled flows, SLA timers, and other time-based automations. Mark days as blackout and time is not counted.'
    },
    {
      type: 'pre',
      code: `import {
  readBlackoutDates, checkBlackoutDate,
  createBlackoutDate, deleteBlackoutDate
} from '@nivaro/sdk'

// List all blackout dates
const { data: dates } = await nivaro.request(readBlackoutDates())
// dates → Blackout[] — { id, name, start_date, end_date, is_active }

// Check if a specific date is blacked out
const { isBlackout, reason } = await nivaro.request(
  checkBlackoutDate('2025-12-25')
)
console.log(isBlackout)  // true if in any active blackout range

// Create a blackout range
const { data: bd } = await nivaro.request(
  createBlackoutDate({
    name: 'Winter Shutdown',
    description: 'No deployments',
    start_date: '2024-12-20',
    end_date: '2025-01-02',
    is_active: true,
  })
)

// Delete
await nivaro.request(deleteBlackoutDate(bd.id))`
    },
    { type: 'h3', text: 'Usage in time-based systems' },
    {
      type: 'p',
      text: 'When SLA rules, scheduled flows, or other time-tracking systems are active:'
    },
    { type: 'ul', items: ['Time during blackout windows is not counted.', 'Timers pause on the first second of a blackout and resume on the first second after.', 'Business hours SLA settings (e.g., "Mon-Fri 09:00-17:00") are multiplied by the business hours factor within a blackout window.'] },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['readBlackoutDates()', 'GET /blackout-dates', 'Authenticated'],
        ['checkBlackoutDate(date)', 'GET /blackout-dates/check', 'Authenticated'],
        ['createBlackoutDate(body)', 'POST /blackout-dates', 'Admin'],
        ['deleteBlackoutDate(id)', 'DELETE /blackout-dates/:id', 'Admin']
      ]
    }
  ]
}

export const sdkSchemaSnapshot: DocSection = {
  id: 'sdk-schema-snapshot',
  label: 'Schema Snapshots',
  content: [
    { type: 'h1', id: 'sdk-schema-snapshot', text: 'SDK — Schema Snapshots' },
    {
      type: 'p',
      text: 'Capture point-in-time snapshots of your entire metadata registry (collections, fields, relations). Useful for version control, environment promotion, and disaster recovery.'
    },
    {
      type: 'pre',
      code: `import { readSchemaSnapshots, createSchemaSnapshot, restoreSchemaSnapshot } from '@nivaro/sdk'

// List all snapshots
const { data: snapshots } = await nivaro.request(readSchemaSnapshots())
// snapshots → Snapshot[] — { id, name, created_at, collection_count, field_count }

// Capture a snapshot
const { data: snap } = await nivaro.request(
  createSchemaSnapshot({
    name: 'Before v2.0 migration',
    description: 'Backup of schema before major refactoring',
  })
)

// Restore a snapshot (rolls back collections/fields to that point in time)
await nivaro.request(restoreSchemaSnapshot(snap.id))`
    },
    { type: 'h3', text: 'What gets snapshotted' },
    { type: 'ul', items: ['All collections (metadata, settings, display templates)', 'All fields (types, interfaces, validation rules, computed formulas)', 'All relations (M2O, O2M, M2M, M2A)', 'Field groups, layouts, and assignments', 'Collection-level settings (draft/publish, item locking, etc.)'] },
    { type: 'h3', text: 'What does NOT get snapshotted' },
    { type: 'ul', items: ['Item data (rows) — only schema', 'Workflows, pipelines, rules, or other business logic', 'User permissions or role assignments', 'Custom queries, external APIs, or webhooks'] },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['readSchemaSnapshots()', 'GET /schema-snapshot', 'Admin'],
        ['createSchemaSnapshot(body)', 'POST /schema-snapshot', 'Admin'],
        ['restoreSchemaSnapshot(id)', 'POST /schema-snapshot/:id/restore', 'Admin']
      ]
    },
    {
      type: 'warn',
      text: 'Restoring a snapshot overwrites the current schema. It does NOT roll back data. Always back up your database before restoring.'
    }
  ]
}

export const customQueriesGuide: DocSection = {
  id: 'custom-queries-guide',
  label: 'Custom Queries — Deep Dive',
  content: [
    { type: 'h1', id: 'custom-queries-guide', text: 'Custom Queries — Deep Dive' },
    {
      type: 'p',
      text: 'Custom queries are admin-defined SQL SELECT statements exposed as parameterized REST endpoints. Use them for complex analytics, cross-collection joins, and aggregations that the standard filter DSL cannot express.'
    },
    { type: 'h3', text: 'Creating a custom query in the admin UI' },
    {
      type: 'p',
      text: 'Navigate to `/custom-queries` and click New Query. Fill in:'
    },
    {
      type: 'table',
      head: ['Field', 'Type', 'Notes'],
      rows: [
        ['Name', 'string', 'Display name (e.g., "High-value deals").'],
        ['Slug', 'string', 'URL identifier (auto-generated, editable). Used in API calls.'],
        ['SQL', 'string', 'Parameterized SELECT statement (@paramName syntax).'],
        ['Access', 'enum', '"authenticated" (any user) or "admin" (admin only).'],
        ['Cache TTL', 'number', 'Seconds to cache results. 0 disables caching.'],
        ['Description', 'string', 'Documentation for users.']
      ]
    },
    { type: 'h3', text: 'Defining parameters' },
    {
      type: 'p',
      text: 'For each @paramName in your SQL, define its type and whether it\'s required:'
    },
    {
      type: 'table',
      head: ['Type', 'MSSQL', 'JavaScript', 'Example'],
      rows: [
        ['string', 'nvarchar(max)', 'string', '"North America"'],
        ['number', 'int or decimal', 'number', '50000'],
        ['boolean', 'bit', 'boolean', 'true'],
        ['date', 'date or datetime', 'ISO 8601 string', '"2024-06-14"']
      ]
    },
    { type: 'h3', text: 'Example: High-value deals by region' },
    {
      type: 'pre',
      code: `SELECT
  d.id,
  d.name,
  d.amount,
  d.region,
  d.owner_id,
  u.first_name,
  u.last_name,
  COUNT(i.id) as item_count,
  SUM(i.value) as total_item_value
FROM deals d
LEFT JOIN users u ON u.id = d.owner_id
LEFT JOIN items i ON i.deal_id = d.id
WHERE d.region = @region
  AND d.amount >= @min_amount
  AND d.created_at >= @start_date
GROUP BY d.id, d.name, d.amount, d.region, d.owner_id, u.first_name, u.last_name
ORDER BY d.amount DESC`
    },
    { type: 'h3', text: 'Parameters for the above' },
    {
      type: 'table',
      head: ['Name', 'Type', 'Required', 'Default'],
      rows: [
        ['region', 'string', 'true', 'N/A'],
        ['min_amount', 'number', 'false', '0'],
        ['start_date', 'date', 'false', '2024-01-01']
      ]
    },
    { type: 'h3', text: 'Testing and executing' },
    {
      type: 'p',
      text: 'In the custom query editor, use the Test Execute panel to run the query with sample parameter values. Once saved, the query is available at:'
    },
    {
      type: 'pre',
      code: `POST /api/custom-queries/high-value-deals/execute
Content-Type: application/json

{
  "region": "North America",
  "min_amount": 50000,
  "start_date": "2024-01-01"
}`
    },
    { type: 'h3', text: 'SDK execution' },
    {
      type: 'pre',
      code: `import { executeCustomQuery } from '@nivaro/sdk'

const { data: deals } = await nivaro.request(
  executeCustomQuery('high-value-deals', {
    region: 'North America',
    min_amount: 50000,
    start_date: '2024-01-01',
  })
)

deals.forEach(deal => {
  console.log(\`\${deal.name}: $\${deal.amount} (\${deal.item_count} items)\`)
})`
    },
    {
      type: 'note',
      text: 'All parameters are bound safely via MSSQL parameterized queries (@name syntax). Never string-interpolate user input. The backend validates parameter names and types before execution.'
    }
  ]
}

export const sdkAlerts: DocSection = {
  id: 'sdk-alerts',
  label: 'Alerts & Monitoring',
  content: [
    { type: 'h1', id: 'sdk-alerts', text: 'SDK — Alerts & Monitoring' },
    {
      type: 'p',
      text: 'Define threshold-based or anomaly-detection alerts on collection fields. Monitor values in real-time and notify users when conditions are met. All users can subscribe to alerts relevant to their work.'
    },
    { type: 'h3', text: 'Admin: Create alert definitions' },
    {
      type: 'pre',
      code: `import { readAlertDefinitions, createAlertDefinition, updateAlertDefinition, deleteAlertDefinition } from '@nivaro/sdk'

// List all alert definitions
const { data: defs } = await nivaro.request(readAlertDefinitions())

// Create a threshold alert
const { data: alert } = await nivaro.request(
  createAlertDefinition({
    name: 'High-value order',
    category: 'threshold',  // or 'anomaly'
    collection: 'orders',
    field: 'total_amount',
    operator: 'gt',  // _eq, _neq, _gt, _gte, _lt, _lte, _in, _contains
    threshold: 100000,
    unit: 'USD',
    cooldown_minutes: 60,  // prevent alert spam
    is_active: true,
  })
)

// Update alert
await nivaro.request(updateAlertDefinition(alert.id, { is_active: false }))

// Delete
await nivaro.request(deleteAlertDefinition(alert.id))`
    },
    { type: 'h3', text: 'User: Subscribe to alerts' },
    {
      type: 'pre',
      code: `import { readAlertSubscriptions, createAlertSubscription, deleteAlertSubscription } from '@nivaro/sdk'

// List alerts you are subscribed to
const { data: subs } = await nivaro.request(readAlertSubscriptions())
// subs → Subscription[] — { id, alert_id, notify_inapp, notify_email }

// Subscribe to an alert
const { data: sub } = await nivaro.request(
  createAlertSubscription({
    alert_definition_id: alertId,
    notify_inapp: true,   // in-app bell notification
    notify_email: false,  // email digest
  })
)

// Unsubscribe
await nivaro.request(deleteAlertSubscription(sub.id))`
    },
    { type: 'h3', text: 'Admin: View alert log and manually evaluate' },
    {
      type: 'pre',
      code: `import { readAlertLog, evaluateAlerts } from '@nivaro/sdk'

// Last 100 alert firings for a definition
const { data: log } = await nivaro.request(readAlertLog(alertId))
// log → Firing[] — { id, triggered_at, collection, item_id, field_value }

// Trigger immediate evaluation (normally runs every 5 minutes)
await nivaro.request(evaluateAlerts())`
    },
    { type: 'h3', text: 'Alert operators' },
    {
      type: 'table',
      head: ['Operator', 'Meaning', 'Example'],
      rows: [
        ['_eq', 'Equal', 'status == "overdue"'],
        ['_neq', 'Not equal', 'status != "active"'],
        ['_gt', 'Greater than', 'amount > 100000'],
        ['_gte', 'Greater or equal', 'age >= 65'],
        ['_lt', 'Less than', 'days_remaining < 0'],
        ['_lte', 'Less or equal', 'days_remaining <= 7'],
        ['_in', 'In set', 'status in ("failed", "cancelled")'],
        ['_contains', 'Contains substring', 'email contains "@spam"']
      ]
    },
    {
      type: 'table',
      head: ['Command', 'Route', 'Auth'],
      rows: [
        ['readAlertDefinitions(collection?)', 'GET /alerts/definitions', 'Admin'],
        ['createAlertDefinition(body)', 'POST /alerts/definitions', 'Admin'],
        ['updateAlertDefinition(id, body)', 'PATCH /alerts/definitions/:id', 'Admin'],
        ['deleteAlertDefinition(id)', 'DELETE /alerts/definitions/:id', 'Admin'],
        ['readAlertSubscriptions()', 'GET /alerts/subscriptions', 'Authenticated'],
        ['createAlertSubscription(body)', 'POST /alerts/subscriptions', 'Authenticated'],
        ['deleteAlertSubscription(id)', 'DELETE /alerts/subscriptions/:id', 'Authenticated'],
        ['readAlertLog(alertId?)', 'GET /alerts/log', 'Admin'],
        ['evaluateAlerts()', 'POST /alerts/evaluate', 'Admin']
      ]
    },
    {
      type: 'note',
      text: 'Alerts are evaluated every 5 minutes by an Inngest cron job. Anomaly detection uses statistical analysis (standard deviation multipliers) to identify unusual values. Cooldown prevents the same alert from firing multiple times within a time window.'
    }
  ]
}

export const sdkAttributes: DocSection = {
  id: 'sdk-attributes',
  label: 'Dynamic Attributes',
  content: [
    { type: 'h1', id: 'sdk-attributes', text: 'SDK — Dynamic Attributes' },
    {
      type: 'p',
      text: 'Dynamic attributes (EAV — Entity-Attribute-Value) let you attach arbitrary custom fields to any collection without modifying the database schema. Useful for extensibility, multi-tenant customization, and handling one-off custom fields.'
    },
    { type: 'h3', text: 'Admin: Define attribute types' },
    {
      type: 'pre',
      code: `import {
  readAttributeDefinitions, createAttributeDefinition,
  updateAttributeDefinition, deleteAttributeDefinition,
} from '@nivaro/sdk'

// List all attribute definitions for a collection
const { data: defs } = await nivaro.request(readAttributeDefinitions('projects'))

// Create a new attribute type
const { data: def } = await nivaro.request(
  createAttributeDefinition('projects', {
    key: 'risk_level',  // slug used in API calls
    label: 'Risk Level',  // display name
    type: 'select',  // text | number | boolean | date | select
    options: ['low', 'medium', 'high'],  // required for type='select'
    required: false,
    sort: 1,
  })
)

// Update definition
await nivaro.request(updateAttributeDefinition(def.id, { required: true }))

// Delete (also cleans up orphaned values)
await nivaro.request(deleteAttributeDefinition(def.id))`
    },
    { type: 'h3', text: 'User: Read and write values' },
    {
      type: 'pre',
      code: `import { readAttributes, updateAttributes } from '@nivaro/sdk'

// Read all attribute values for an item
const { data: attrs } = await nivaro.request(readAttributes('projects', '42'))
// attrs → { risk_level: 'medium', budget_code: 'IT-2024-003' }

// Update attribute values (partial patch)
await nivaro.request(
  updateAttributes('projects', '42', {
    risk_level: 'high',
    budget_code: 'IT-2024-099',
  })
)
// Omitted keys are left unchanged`
    },
    { type: 'h3', text: 'Attribute types' },
    {
      type: 'table',
      head: ['Type', 'Stored As', 'Parsed As', 'Example'],
      rows: [
        ['text', 'string', 'string', '"extended warranty"'],
        ['number', 'string', 'number', '"42"'],
        ['boolean', 'string', 'boolean', '"true" or "false"'],
        ['date', 'string', 'ISO 8601 date', '"2024-12-31"'],
        ['select', 'string', 'option key', '"gold"']
      ]
    },
    { type: 'h3', text: 'Admin UI' },
    {
      type: 'p',
      text: 'Attribute definitions are managed in `/data-model` → Table Editor → Attributes tab (admin only). Once definitions exist for a collection, an Attributes card appears on the item editor for users to fill in values.'
    },
    {
      type: 'table',
      head: ['Command', 'Route', 'Auth'],
      rows: [
        ['readAttributeDefinitions(collection)', 'GET /attributes/definitions/:collection', 'Authenticated'],
        ['createAttributeDefinition(collection, body)', 'POST /attributes/definitions/:collection', 'Admin'],
        ['updateAttributeDefinition(id, body)', 'PATCH /attributes/definitions/:id', 'Admin'],
        ['deleteAttributeDefinition(id)', 'DELETE /attributes/definitions/:id', 'Admin'],
        ['readAttributes(collection, itemId)', 'GET /attributes/:collection/:itemId', 'Authenticated'],
        ['updateAttributes(collection, itemId, body)', 'PATCH /attributes/:collection/:itemId', 'Authenticated']
      ]
    },
    {
      type: 'note',
      text: 'All attribute values are stored as strings in `nivaro_attribute_values` regardless of the definition type. SDKs and the admin UI handle type conversion on read/write. Deleting a definition cleans up its orphaned values.'
    }
  ]
}

export const sdkNotificationSubscriptions: DocSection = {
  id: 'sdk-notification-subscriptions',
  label: 'Notification Subscriptions',
  content: [
    { type: 'h1', id: 'sdk-notification-subscriptions', text: 'SDK — Notification Subscriptions' },
    {
      type: 'p',
      text: 'Users subscribe to collection events (create/update/delete) with optional field filters. Notifications are delivered instantly or as daily/weekly digests. Self-serve — no admin permission needed.'
    },
    {
      type: 'pre',
      code: `import {
  readNotificationSubscriptions,
  createNotificationSubscription,
  updateNotificationSubscription,
  deleteNotificationSubscription,
} from '@nivaro/sdk'

// List my subscriptions
const { data: subs } = await nivaro.request(readNotificationSubscriptions())
// subs → Subscription[] — { id, collection, event_type, filter_field, filter_value, label, digest_frequency, is_active }

// Subscribe to all new "urgent" orders
const { data: sub } = await nivaro.request(
  createNotificationSubscription({
    collection: 'orders',
    event_type: 'create',  // 'create' | 'update' | 'delete'
    filter_field: 'priority',  // optional: filter by field value
    filter_value: 'urgent',  // only notify if priority == 'urgent'
    label: 'Urgent orders',  // custom label
    is_active: true,
  })
)

// Switch to daily digest instead of instant notifications
await nivaro.request(
  updateNotificationSubscription(sub.id, {
    digest_frequency: 'instant',  // or 'daily' or 'weekly'
  })
)

// Unsubscribe
await nivaro.request(deleteNotificationSubscription(sub.id))`
    },
    { type: 'h3', text: 'Subscription types' },
    {
      type: 'table',
      head: ['Event Type', 'Triggers', 'Example'],
      rows: [
        ['create', 'New item is added to the collection', 'Notify on new leads'],
        ['update', 'An existing item is modified', 'Notify when status changes'],
        ['delete', 'An item is removed from the collection', 'Notify on deleted orders']
      ]
    },
    { type: 'h3', text: 'Filters (optional)' },
    {
      type: 'p',
      text: 'If you only care about certain items (e.g., high-priority orders), specify a filter_field and filter_value. Notifications only fire when the field matches the value.'
    },
    {
      type: 'table',
      head: ['No Filter', 'With Filter', 'Result'],
      rows: [
        ['collection: "orders"', 'filter_field: "priority", filter_value: "urgent"', 'Only notify on urgent orders'],
        ['collection: "deals"', 'filter_field: "amount", filter_value: "100000"', 'Only notify on deals >= 100k'],
        ['collection: "projects"', '(no filter)', 'Notify on ALL project changes']
      ]
    },
    { type: 'h3', text: 'Digest modes' },
    {
      type: 'table',
      head: ['Mode', 'Delivery', 'Best For'],
      rows: [
        ['instant', 'Real-time in-app bell notification', 'Critical events that need immediate action'],
        ['daily', 'Email digest at 08:00 daily', 'Summary of events from the last 24 hours'],
        ['weekly', 'Email digest on Monday 08:00', 'Lower-priority notifications, trending events']
      ]
    },
    {
      type: 'table',
      head: ['Command', 'Route', 'Auth'],
      rows: [
        ['readNotificationSubscriptions()', 'GET /notification-subscriptions', 'Authenticated'],
        ['createNotificationSubscription(body)', 'POST /notification-subscriptions', 'Authenticated'],
        ['updateNotificationSubscription(id, body)', 'PATCH /notification-subscriptions/:id', 'Authenticated'],
        ['deleteNotificationSubscription(id)', 'DELETE /notification-subscriptions/:id', 'Authenticated']
      ]
    },
    {
      type: 'note',
      text: 'Digest emails are sent daily at 08:00 and weekly on Monday at 08:00 (UTC). Each user has a single watermark (`last_digest_at`) shared across both daily and weekly digests — whichever sends first advances the watermark, so events are never delivered twice.'
    }
  ]
}

export const sdkSlaRules: DocSection = {
  id: 'sdk-sla-rules',
  label: 'SLA Rules',
  content: [
    { type: 'h1', id: 'sdk-sla-rules', text: 'SDK — SLA Rules' },
    {
      type: 'p',
      text: 'Attach time-based SLA targets (e.g., "resolve within 24 hours") to workflow states. Track elapsed time, warn on approaching breach, and escalate to managers when targets are missed.'
    },
    { type: 'h3', text: 'Admin: Define SLA rules' },
    {
      type: 'pre',
      code: `import {
  readSlaRules, readSlaRule,
  createSlaRule, updateSlaRule, deleteSlaRule,
} from '@nivaro/sdk'

// List all SLA rules for a workflow template
const { data: rules } = await nivaro.request(readSlaRules(workflowTemplateId))

// Create an SLA rule
const { data: rule } = await nivaro.request(
  createSlaRule({
    name: 'Critical bug resolution',
    workflow_template_id: 'wf-uuid',
    state_key: 'in_progress',  // applies to this workflow state
    duration_hours: 8,  // must resolve within 8 hours
    warning_threshold_pct: 75,  // warn at 75% (6 hours)
    business_hours_only: true,  // count only Mon-Fri 09:00-17:00
    notify_on_warning: true,  // notify owner at 75%
    notify_on_breach: true,  // notify owner at 100%
    escalation_user_id: 'manager-uuid',  // escalate to manager on breach
    is_active: true,
  })
)

// Update
await nivaro.request(updateSlaRule(rule.id, { duration_hours: 16 }))

// Delete
await nivaro.request(deleteSlaRule(rule.id))`
    },
    { type: 'h3', text: 'User: Check SLA status' },
    {
      type: 'pre',
      code: `import { readSlaStatus, readSlaStatusBatch } from '@nivaro/sdk'

// Check SLA for a single item
const { data: status } = await nivaro.request(readSlaStatus('orders', '42'))
// status → SlaStatus[] — one entry per active SLA rule for the workflow state
// {
//   rule_id,
//   rule_name,
//   state_key,
//   elapsed_hours: 4.5,
//   remaining_hours: 3.5,
//   warning_threshold_pct: 75,
//   is_warning: false,  // 75% reached?
//   is_breached: false,  // 100% exceeded?
//   breached_at: null,
// }

// Batch check multiple items
const { data: batch } = await nivaro.request(
  readSlaStatusBatch('orders', ['42', '43', '44'])
)
// batch → { [itemId]: SlaStatus[] }`
    },
    { type: 'h3', text: 'Business hours calculation' },
    {
      type: 'p',
      text: 'When `business_hours_only: true`, only Mon-Fri 09:00-17:00 is counted. Blackout dates (holidays, maintenance windows) pause the timer entirely.'
    },
    {
      type: 'table',
      head: ['Scenario', 'Time Counting', 'Example'],
      rows: [
        ['Mon 10:00 - Mon 18:00', '8 business hours counted', '8h of an 8h SLA'],
        ['Fri 16:00 - Fri 17:00 + Mon 09:00 - 10:00', '2 business hours counted', '1h Friday + 1h Monday'],
        ['During blackout date', 'Timer paused', 'Winter shutdown 12/20-1/2 → no time counted'],
        ['24/7 mode (business_hours_only: false)', 'All hours counted', 'Calendar hours only']
      ]
    },
    {
      type: 'table',
      head: ['Command', 'Route', 'Auth'],
      rows: [
        ['readSlaRules(workflowTemplateId?)', 'GET /sla/rules', 'Admin'],
        ['readSlaRule(id)', 'GET /sla/rules/:id', 'Admin'],
        ['createSlaRule(body)', 'POST /sla/rules', 'Admin'],
        ['updateSlaRule(id, body)', 'PATCH /sla/rules/:id', 'Admin'],
        ['deleteSlaRule(id)', 'DELETE /sla/rules/:id', 'Admin'],
        ['readSlaStatus(collection, itemId)', 'GET /sla/status/:collection/:item', 'Authenticated'],
        ['readSlaStatusBatch(collection, ids)', 'POST /sla/status/batch', 'Authenticated']
      ]
    },
    {
      type: 'note',
      text: 'SLA times are calculated from workflow history: elapsed time is how long the item has been in the current state. Transitions reset the clock for the new state (which may have its own SLA rule).'
    }
  ]
}

export const sdkPresence: DocSection = {
  id: 'sdk-presence',
  label: 'Presence & Awareness',
  content: [
    { type: 'h1', id: 'sdk-presence', text: 'SDK — Presence & Awareness' },
    {
      type: 'p',
      text: 'Real-time presence tracking via Socket.io. See who is currently viewing/editing an item and take coordination actions (lock, merge, notify).'
    },
    { type: 'h3', text: 'REST: Query presence' },
    {
      type: 'pre',
      code: `import { readPresence, readAllPresence } from '@nivaro/sdk'

// Who is currently viewing/editing a specific item?
const { data: viewers } = await nivaro.request(readPresence('contracts', '99'))
// viewers → Presence[] — { user_id, first_name, last_name, email, is_editing, last_heartbeat }

// All active sessions across the instance (admin)
const { data: sessions, total } = await nivaro.request(readAllPresence())
// sessions → Presence[] (paginated; default 100 per page)`
    },
    { type: 'h3', text: 'Socket.io: Real-time subscription' },
    {
      type: 'pre',
      code: `import { createRealtime } from '@nivaro/sdk'

const rt = createRealtime(token)
await rt.connect('https://nivaro.example.com')

// Subscribe to presence updates for an item
rt.presence.subscribe('contracts:99', (users) => {
  console.log(\`\${users.length} users viewing\`)
  users.forEach(u => {
    if (u.is_editing) console.log(\`\${u.first_name} is editing\`)
  })
})

// Announce that you are editing
rt.presence.setEditing('contracts:99', true)

// Stop editing
rt.presence.setEditing('contracts:99', false)

// Leave the presence room
rt.presence.leave('contracts:99')`
    },
    { type: 'h3', text: 'Soft edit locks (item locking)' },
    {
      type: 'p',
      text: 'Pair presence with item locking to prevent conflicting edits:'
    },
    {
      type: 'pre',
      code: `// Admin UI example
const canEdit = async (collection, itemId, userId) => {
  // Check if item is locked by another user
  const { data: locked } = await nivaro.request(
    isItemLocked(collection, itemId, userId)
  )

  if (locked && locked.lock.user_id !== userId) {
    // Item is locked by someone else
    return false
  }

  // Item is free to edit — acquire a lock
  const { data: lock } = await nivaro.request(
    acquireItemLock(collection, itemId)
  )
  return true
}

// Release lock when done editing
await nivaro.request(releaseItemLock(collection, itemId))`
    },
    { type: 'h3', text: 'Presence events via Socket.io' },
    {
      type: 'table',
      head: ['Event', 'When Fired', 'Data'],
      rows: [
        ['presence:join', 'User enters a room', '{ user_id, first_name, last_name }'],
        ['presence:leave', 'User leaves a room', '{ user_id }'],
        ['presence:editing', 'User starts/stops editing', '{ user_id, is_editing }'],
        ['presence:heartbeat', 'Periodic keep-alive (30s)', '{ user_id, last_seen }']
      ]
    },
    {
      type: 'table',
      head: ['Command', 'Route', 'Auth'],
      rows: [
        ['readPresence(collection, itemId)', 'GET /presence/:collection/:itemId', 'Authenticated'],
        ['readAllPresence(limit?, offset?)', 'GET /presence', 'Admin']
      ]
    },
    {
      type: 'note',
      text: 'Presence data is ephemeral — it lives only in Redis and is lost on server restart. Perfect for collaboration cues but not for audit/compliance tracking. The admin UI emits heartbeats automatically; custom clients should emit `presence:heartbeat` every 30 seconds to stay visible.'
    }
  ]
}
