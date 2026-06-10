import type { DocSection } from '../types.js'

export const sdkExternalApis: DocSection = {
  id: 'sdk-external-apis',
  label: 'External APIs',
  content: [
    { type: 'h1', id: 'sdk-external-apis', text: 'SDK — External APIs' },
    {
      type: 'p',
      text: 'Full CRUD for external API configs and their predefined endpoint templates, plus a test command that fires a live request through the server (credentials never leave the server).'
    },
    { type: 'h3', text: 'API config commands' },
    {
      type: 'pre',
      code: `import {
  listExternalApis, getExternalApi,
  createExternalApi, updateExternalApi, deleteExternalApi,
  testExternalApi,
} from '@nivaro/sdk'

// List all configured APIs
const { data: apis } = await nivaro.request(listExternalApis())

// Get one
const { data: api } = await nivaro.request(getExternalApi(apiId))

// Create
const { data: created } = await nivaro.request(createExternalApi({
  name: 'Oracle EBS',
  base_url: 'https://ebs.internal/api',
  auth_type: 'oauth2_cc',
  auth_config: {
    client_id: 'my-client',
    client_secret: 'secret',
    token_url: 'https://ebs.internal/oauth/token',
  },
  enabled: true,
}))

// Update
await nivaro.request(updateExternalApi(apiId, { enabled: false }))

// Delete
await nivaro.request(deleteExternalApi(apiId))`
    },
    { type: 'h3', text: 'Test command' },
    {
      type: 'pre',
      code: `// Fire a live request through the server (auth resolved server-side)
const { data: result } = await nivaro.request(
  testExternalApi(apiId, {
    method: 'POST',
    path: '/invoices',
    body: { po_number: 'PO-123' },
    query: { format: 'json' },
    headers: { 'X-Correlation-Id': 'abc' },
  })
)
// result: { status, headers, body }`
    },
    { type: 'h3', text: 'Calling external APIs' },
    {
      type: 'pre',
      code: `import { callExternalApi, callExternalApiEndpoint } from '@nivaro/sdk'

// Call any arbitrary endpoint on a configured API (auth stays server-side)
const { data } = await nivaro.request(
  callExternalApi(apiId, {
    method: 'POST',
    path: '/invoices',
    body: { po_number: 'PO-123' },
    query: { format: 'json' },
  })
)
// data: { status, headers, body }

// Call a pre-defined endpoint by slug (or numeric id)
const { data } = await nivaro.request(
  callExternalApiEndpoint('get-invoice', { query: { id: '456' } })
)
// Caller overrides merge on top of the template's saved defaults`
    },
    { type: 'h3', text: 'Endpoint template commands' },
    {
      type: 'pre',
      code: `import {
  listExternalApiEndpoints, getExternalApiEndpoint,
  createExternalApiEndpoint, updateExternalApiEndpoint, deleteExternalApiEndpoint,
} from '@nivaro/sdk'

// List templates for an API
const { data: endpoints } = await nivaro.request(listExternalApiEndpoints(apiId))

// Create (slug is optional but recommended for SDK callers)
const { data: newEp } = await nivaro.request(createExternalApiEndpoint(apiId, {
  name: 'Get Invoice',
  slug: 'get-invoice',
  method: 'GET',
  path: '/invoices/:id',
  default_query: { format: 'json' },
}))

// Update
await nivaro.request(updateExternalApiEndpoint(endpointId, { default_body: { status: 'approved' } }))

// Delete
await nivaro.request(deleteExternalApiEndpoint(endpointId))`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['callExternalApi(apiId, opts?)', 'POST /external-apis/:id/call', 'Authenticated'],
        [
          'callExternalApiEndpoint(slugOrId, opts?)',
          'POST /external-apis/endpoints/:slugOrId/call',
          'Authenticated'
        ],
        ['listExternalApis()', 'GET /external-apis', 'Admin'],
        ['getExternalApi(id)', 'GET /external-apis/:id', 'Admin'],
        ['createExternalApi(data)', 'POST /external-apis', 'Admin'],
        ['updateExternalApi(id, data)', 'PATCH /external-apis/:id', 'Admin'],
        ['deleteExternalApi(id)', 'DELETE /external-apis/:id', 'Admin'],
        ['testExternalApi(id, opts?)', 'POST /external-apis/:id/test', 'Admin'],
        ['listExternalApiEndpoints(apiId)', 'GET /external-apis/:id/endpoints', 'Admin'],
        ['getExternalApiEndpoint(eid)', 'GET /external-apis/endpoints/:eid', 'Admin'],
        ['createExternalApiEndpoint(apiId, data)', 'POST /external-apis/:id/endpoints', 'Admin'],
        ['updateExternalApiEndpoint(eid, data)', 'PATCH /external-apis/endpoints/:eid', 'Admin'],
        ['deleteExternalApiEndpoint(eid)', 'DELETE /external-apis/endpoints/:eid', 'Admin']
      ]
    }
  ]
}

export const sdkComments: DocSection = {
  id: 'sdk-comments',
  label: 'Comments',
  content: [
    { type: 'h1', id: 'sdk-comments', text: 'SDK — Comments' },
    {
      type: 'pre',
      code: `import { listComments, createComment, updateComment, deleteComment } from '@nivaro/sdk'

// All comments for an item
const { data: comments } = await nivaro.request(listComments('projects', itemId))

// Create a comment (supports @mention in text)
const { data: comment } = await nivaro.request(
  createComment({ collection: 'projects', item: itemId, text: 'Approved @jane' })
)
// comment.mentions → [{ id, user }] — resolved from @username references

// Edit own comment
await nivaro.request(updateComment(comment.id, { text: 'Approved — updated note' }))

// Delete
await nivaro.request(deleteComment(comment.id))`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['listComments(collection, item)', 'GET /comments', 'Authenticated'],
        ['createComment(body)', 'POST /comments', 'Authenticated'],
        ['updateComment(id, body)', 'PATCH /comments/:id', 'Authenticated (own)'],
        ['deleteComment(id)', 'DELETE /comments/:id', 'Authenticated (own or admin)']
      ]
    }
  ]
}

export const sdkWebhooks: DocSection = {
  id: 'sdk-webhooks',
  label: 'Webhooks',
  content: [
    { type: 'h1', id: 'sdk-webhooks', text: 'SDK — Webhooks' },
    {
      type: 'pre',
      code: `import {
  listWebhooks, getWebhook,
  createWebhook, updateWebhook, deleteWebhook, testWebhook,
} from '@nivaro/sdk'

const { data: webhooks } = await nivaro.request(listWebhooks())

const { data: wh } = await nivaro.request(createWebhook({
  name: 'Deploy trigger',
  url: 'https://hooks.example.com/deploy',
  collection: 'articles',
  events: ['create', 'update'],
  method: 'POST',
  enabled: true,
}))

await nivaro.request(updateWebhook(wh.id, { enabled: false }))

// Fire a test ping (returns HTTP status + ok flag)
const { status, ok } = await nivaro.request(testWebhook(wh.id))

await nivaro.request(deleteWebhook(wh.id))`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['listWebhooks()', 'GET /webhooks', 'Admin'],
        ['getWebhook(id)', 'GET /webhooks/:id', 'Admin'],
        ['createWebhook(data)', 'POST /webhooks', 'Admin'],
        ['updateWebhook(id, data)', 'PATCH /webhooks/:id', 'Admin'],
        ['deleteWebhook(id)', 'DELETE /webhooks/:id', 'Admin'],
        ['testWebhook(id)', 'POST /webhooks/:id/test', 'Admin']
      ]
    }
  ]
}

export const sdkRules: DocSection = {
  id: 'sdk-rules',
  label: 'Rules',
  content: [
    { type: 'h1', id: 'sdk-rules', text: 'SDK — Rules' },
    {
      type: 'p',
      text: 'Rules run server-side on collection mutations (create/update/delete). Each rule has conditions and actions — `reject`, `set_field`, `send_notification`, or `trigger_webhook`.'
    },
    {
      type: 'pre',
      code: `import { listRules, createRule, updateRule, deleteRule } from '@nivaro/sdk'

// List rules for a collection (or all if no collection passed)
const { data: rules } = await nivaro.request(listRules('articles'))

const { data: rule } = await nivaro.request(createRule({
  name: 'Require title on publish',
  collection: 'articles',
  trigger: 'update',
  conditions: [
    { field: 'status', op: '_eq', value: 'published' },
    { field: 'title', op: '_empty', value: null },
  ],
  actions: [{ type: 'reject', error_message: 'Title is required before publishing.' }],
  enabled: true,
}))

await nivaro.request(updateRule(rule.id, { enabled: false }))
await nivaro.request(deleteRule(rule.id))`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['listRules(collection?)', 'GET /rules', 'Admin'],
        ['createRule(data)', 'POST /rules', 'Admin'],
        ['updateRule(id, data)', 'PATCH /rules/:id', 'Admin'],
        ['deleteRule(id)', 'DELETE /rules/:id', 'Admin']
      ]
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
      text: 'Read execution history for Inngest-backed flows. Flows are created and scheduled in the admin UI at `/flows`.'
    },
    {
      type: 'pre',
      code: `import { listFlowRuns, getFlowRun } from '@nivaro/sdk'

// Execution history for a flow (newest first)
const { data: runs } = await nivaro.request(
  listFlowRuns('flow-uuid', { limit: 50, status: 'error' })
)
// run: { id, status ('running'|'success'|'error'), started_at, completed_at, duration_ms, output, error_message }

// Single run detail
const { data: run } = await nivaro.request(getFlowRun('run-uuid'))`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['listFlowRuns(flowId, opts?)', 'GET /flows/:id/runs', 'Admin'],
        ['getFlowRun(runId)', 'GET /flows/runs/:id', 'Admin']
      ]
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
      text: 'Custom queries are named, parameterized SQL endpoints defined in the admin UI at `/custom-queries`. Access is `admin` or `authenticated` per query.'
    },
    {
      type: 'pre',
      code: `import { listCustomQueries, executeCustomQuery } from '@nivaro/sdk'

// List all queries visible to the current user
const { data: queries } = await nivaro.request(listCustomQueries())
// query: { id, name, slug, description, access, cache_ttl, enabled, params }

// Execute by slug — params are validated server-side against the param definitions
const { data, cached, executed_at } = await nivaro.request(
  executeCustomQuery('active-orders-by-region', { region: 'West', limit: 100 })
)
// data → unknown[] — raw rows from the SQL result`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['listCustomQueries()', 'GET /custom-queries', 'Authenticated'],
        [
          'executeCustomQuery(slug, params?)',
          'POST /custom-queries/:slug/execute',
          'Per-query access setting'
        ]
      ]
    }
  ]
}

export const sdkCollections: DocSection = {
  id: 'sdk-collections',
  label: 'Collections',
  content: [
    { type: 'h1', id: 'sdk-collections', text: 'SDK — Collections' },
    {
      type: 'p',
      text: 'Returns the metadata registry — all collections visible to the current workspace and user. Useful for building dynamic UIs that adapt to the configured schema.'
    },
    {
      type: 'pre',
      code: `import { readCollections } from '@nivaro/sdk'

const { data: collections } = await nivaro.request(readCollections())
// collection: { collection, label, singleton, sort_field, hidden, ... }`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [['readCollections()', 'GET /collections', 'Authenticated']]
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
      text: 'Blackout dates block scheduling on specific calendar days. Scoped per business unit or left global.'
    },
    {
      type: 'pre',
      code: `import { listBlackoutDates, checkBlackoutDate, createBlackoutDate, deleteBlackoutDate } from '@nivaro/sdk'

// List all blackout dates (optional scope filter)
const { data: dates } = await nivaro.request(listBlackoutDates('us-holidays'))

// Check a single date
const { isBlackout, label } = await nivaro.request(checkBlackoutDate('2025-12-25', 'us-holidays'))

// Create
await nivaro.request(createBlackoutDate({ date: '2026-01-01', label: "New Year's Day", scope: 'us-holidays' }))

// Delete by ID
await nivaro.request(deleteBlackoutDate(dateId))`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['listBlackoutDates(scope?)', 'GET /blackout-dates', 'Authenticated'],
        ['checkBlackoutDate(date, scope?)', 'GET /blackout-dates/check', 'Authenticated'],
        ['createBlackoutDate(body)', 'POST /blackout-dates', 'Admin'],
        ['deleteBlackoutDate(id)', 'DELETE /blackout-dates/:id', 'Admin']
      ]
    }
  ]
}

export const sdkSchemaSnapshot: DocSection = {
  id: 'sdk-schema-snapshot',
  label: 'Schema Snapshot',
  content: [
    { type: 'h1', id: 'sdk-schema-snapshot', text: 'SDK — Schema Snapshot' },
    {
      type: 'p',
      text: 'Export a point-in-time snapshot of the full metadata registry and import it to another instance. Useful for promoting schema changes between environments.'
    },
    {
      type: 'pre',
      code: `import { exportSchemaSnapshot, importSchemaSnapshot } from '@nivaro/sdk'

// Export — returns the full registry as a JSON object
const snapshot = await nivaro.request(exportSchemaSnapshot())

// Import — applies the snapshot to the target instance
const { imported } = await nivaro.request(importSchemaSnapshot(snapshot))
// imported: { collections: n, fields: n, relations: n }`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        ['exportSchemaSnapshot()', 'GET /schema-snapshot/export', 'Admin'],
        ['importSchemaSnapshot(data)', 'POST /schema-snapshot/import', 'Admin']
      ]
    }
  ]
}

export const customQueriesGuide: DocSection = {
  id: 'custom-queries-guide',
  label: 'Custom Queries',
  content: [
    { type: 'h1', id: 'custom-queries-guide', text: 'Custom Queries' },
    {
      type: 'p',
      text: 'Custom queries let admins expose parameterized SQL as named REST endpoints. They appear under `/custom-queries` in the sidebar.'
    },
    { type: 'h3', text: 'Creating a query' },
    { type: 'p', text: 'Go to Custom Queries → New Query. Fill in:' },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['Name', 'Human-readable label.'],
        [
          'Slug',
          'URL identifier — auto-derived from the name, editable. Used as the endpoint slug.'
        ],
        ['SQL', 'Raw SQL. Use :paramName placeholders for dynamic values.'],
        ['Access', '"authenticated" (any logged-in user) or "admin" (admin only).'],
        ['Cache TTL', 'Seconds to cache results. 0 disables caching.'],
        [
          'Parameters',
          'Define name, type (string/number/boolean), default value, and required flag.'
        ]
      ]
    },
    { type: 'h3', text: 'Executing' },
    {
      type: 'p',
      text: 'Once saved, the query is available at `POST /api/custom-queries/:slug/execute` with a JSON body `{ "params": { "region": "West" } }`. Use the Test Execute panel in the editor to run it live with sample values.'
    },
    { type: 'h3', text: 'SDK' },
    {
      type: 'pre',
      code: `import { listCustomQueries, executeCustomQuery } from '@nivaro/sdk'

const { data } = await nivaro.request(
  executeCustomQuery('active-orders-by-region', { region: 'West' })
)`
    }
  ]
}

export const sdkAlerts: DocSection = {
  id: 'sdk-alerts',
  label: 'Alerts',
  content: [
    { type: 'h1', id: 'sdk-alerts', text: 'SDK — Alerts' },
    {
      type: 'p',
      text: 'Manage alert definitions (threshold and anomaly rules), per-user subscriptions, the alert log, and on-demand evaluation.'
    },
    {
      type: 'pre',
      code: `import {
  listAlertDefinitions, getAlertDefinition,
  createAlertDefinition, updateAlertDefinition, deleteAlertDefinition,
  listAlertSubscriptions, createAlertSubscription, deleteAlertSubscription,
  readAlertLog, evaluateAlerts,
} from '@nivaro/sdk'

// List all alert definitions (optionally filter by collection)
const { data: defs } = await nivaro.request(listAlertDefinitions('orders'))

// Create a threshold alert
const { data: def } = await nivaro.request(createAlertDefinition({
  name: 'High value order',
  category: 'threshold',
  collection: 'orders',
  field: 'total',
  operator: 'gt',
  threshold: 10000,
  cooldown_minutes: 60,
  is_active: true,
}))

// Subscribe the current user (in-app notification)
await nivaro.request(createAlertSubscription({
  alert_definition_id: def.id,
  notify_inapp: true,
  notify_email: false,
}))

// Read the log (last 100 firings for a definition)
const { data: log } = await nivaro.request(readAlertLog(def.id))

// Trigger an immediate evaluation pass across all active rules
await nivaro.request(evaluateAlerts())`
    },
    {
      type: 'table',
      head: ['Command', 'Method + path', 'Notes'],
      rows: [
        ['listAlertDefinitions(collection?)', 'GET /alerts/definitions', 'Admin'],
        ['getAlertDefinition(id)', 'GET /alerts/definitions/:id', 'Admin'],
        ['createAlertDefinition(body)', 'POST /alerts/definitions', 'Admin'],
        ['updateAlertDefinition(id, body)', 'PATCH /alerts/definitions/:id', 'Admin'],
        ['deleteAlertDefinition(id)', 'DELETE /alerts/definitions/:id', 'Admin'],
        ['listAlertSubscriptions(definitionId?)', 'GET /alerts/subscriptions', 'Authenticated'],
        ['createAlertSubscription(body)', 'POST /alerts/subscriptions', 'Authenticated'],
        ['deleteAlertSubscription(id)', 'DELETE /alerts/subscriptions/:id', 'Authenticated'],
        ['readAlertLog(definitionId?)', 'GET /alerts/log', 'Admin'],
        ['evaluateAlerts()', 'POST /alerts/evaluate', 'Admin']
      ]
    }
  ]
}

export const sdkAttributes: DocSection = {
  id: 'sdk-attributes',
  label: 'Dynamic Attributes',
  content: [
    { type: 'h1', id: 'sdk-attributes', text: 'SDK — Dynamic Attributes (EAV)' },
    {
      type: 'p',
      text: 'Dynamic attributes let admins attach ad-hoc key/value fields to any collection without schema migrations. Definitions are managed in Data Model; values are stored per item in `nivaro_attribute_values`.'
    },
    {
      type: 'pre',
      code: `import {
  listAttributeDefinitions,
  createAttributeDefinition, updateAttributeDefinition, deleteAttributeDefinition,
  getAttributeValues, updateAttributeValues,
} from '@nivaro/sdk'

// List all attribute definitions for a collection
const { data: defs } = await nivaro.request(listAttributeDefinitions('projects'))
// → [{ id, collection, key, label, type, options, required, sort, is_active }]

// Create a new attribute definition (admin)
await nivaro.request(createAttributeDefinition({
  collection: 'projects',
  key: 'risk_rating',
  label: 'Risk Rating',
  type: 'select',
  options: ['low', 'medium', 'high'],
  required: false,
}))

// Read an item's attribute values
const { data: values } = await nivaro.request(getAttributeValues('projects', '42'))
// → { risk_rating: 'medium', budget_code: 'IT-2024-003' }

// Update attribute values (partial patch — omit keys to leave them unchanged)
await nivaro.request(updateAttributeValues('projects', '42', {
  risk_rating: 'high',
  budget_code: 'IT-2024-099',
}))`
    },
    {
      type: 'note',
      text: 'All attribute values are stored as strings regardless of the definition type. The admin UI parses them by type for rendering; SDK consumers should do the same.'
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
      text: 'Users can subscribe to collection-level events (create/update/delete) with optional field-value filters, delivered as in-app notifications or digest emails.'
    },
    {
      type: 'pre',
      code: `import {
  listNotificationSubscriptions,
  createNotificationSubscription,
  updateNotificationSubscription,
  deleteNotificationSubscription,
} from '@nivaro/sdk'

// List current user's subscriptions
const { data: subs } = await nivaro.request(listNotificationSubscriptions())

// Subscribe to all new "urgent" orders
const { data: sub } = await nivaro.request(createNotificationSubscription({
  collection: 'orders',
  event_type: 'create',
  filter_field: 'priority',
  filter_value: 'urgent',
  label: 'Urgent orders',
  is_active: true,
}))

// Switch to digest (daily batch) instead of instant
await nivaro.request(updateNotificationSubscription(sub.id, {
  digest_frequency: 'daily',
}))

await nivaro.request(deleteNotificationSubscription(sub.id))`
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
      text: 'SLA rules attach time-based targets to workflow states. The SDK covers rule CRUD (admin) and per-item or batch status reads (any authenticated user).'
    },
    {
      type: 'pre',
      code: `import {
  listSlaRules, getSlaRule,
  createSlaRule, updateSlaRule, deleteSlaRule,
  getSlaStatus, readSlaStatusBatch,
} from '@nivaro/sdk'

// List rules for a workflow template
const { data: rules } = await nivaro.request(listSlaRules('wf-template-uuid'))

// Create a rule: 48 business hours in "Under Review" state
await nivaro.request(createSlaRule({
  workflow_template_id: 'wf-template-uuid',
  state_key: 'under_review',
  name: '48h review SLA',
  duration_hours: 48,
  warning_threshold_pct: 75,
  business_hours_only: true,
  notify_on_breach: true,
  is_active: true,
}))

// Single-item SLA status
const { data: status } = await nivaro.request(getSlaStatus('orders', '42'))
// → [{ rule_id, state_key, elapsed_hours, is_warning, is_breached, breached_at }]

// Batch status for a list of items
const { data: batch } = await nivaro.request(
  readSlaStatusBatch('orders', ['42', '43', '44'])
)`
    },
    {
      type: 'table',
      head: ['Command', 'Method + path', 'Auth'],
      rows: [
        ['listSlaRules(workflowTemplateId?)', 'GET /sla/rules', 'Admin'],
        ['getSlaRule(id)', 'GET /sla/rules/:id', 'Admin'],
        ['createSlaRule(body)', 'POST /sla/rules', 'Admin'],
        ['updateSlaRule(id, body)', 'PATCH /sla/rules/:id', 'Admin'],
        ['deleteSlaRule(id)', 'DELETE /sla/rules/:id', 'Admin'],
        ['getSlaStatus(collection, itemId)', 'GET /sla/status/:collection/:item', 'Authenticated'],
        ['readSlaStatusBatch(collection, ids)', 'POST /sla/status/batch', 'Authenticated']
      ]
    }
  ]
}

export const sdkPresence: DocSection = {
  id: 'sdk-presence',
  label: 'Presence',
  content: [
    { type: 'h1', id: 'sdk-presence', text: 'SDK — Presence' },
    {
      type: 'p',
      text: 'Presence tracks which users are actively viewing or editing a record. Use it to show live collaborator avatars and avoid conflicting edits alongside item locking.'
    },
    {
      type: 'pre',
      code: `import { getPresence, listActivePresence } from '@nivaro/sdk'

// Who is currently viewing/editing a specific item?
const { data: viewers } = await nivaro.request(
  getPresence('contracts', '99')
)
// → [{ user_id, first_name, last_name, last_seen }]

// All active presence sessions across the instance (admin)
const { data: sessions, total } = await nivaro.request(listActivePresence())`
    },
    {
      type: 'note',
      text: 'The admin UI emits Socket.io heartbeats automatically. SDK consumers managing custom UIs should emit the same `presence:heartbeat` event via the realtime client to stay visible.'
    }
  ]
}
