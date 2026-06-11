# @nivaro/sdk

TypeScript SDK for [Nivaro CMS](https://nivaro.dev) — typed REST client, GraphQL, realtime subscriptions, and presence.

## Installation

```bash
npm install @nivaro/sdk
# or
pnpm add @nivaro/sdk
```

All API calls use `nivaro.request(command)` where `command` is a typed descriptor built by one of the helper functions below.

---

## SDK — Setup

The `@nivaro/sdk` package is a typed client for the Nivaro API.

```typescript
# Install
pnpm add @nivaro/sdk

# TypeScript import
import { createNivaro, readItems, createItem, updateItem, deleteItem } from '@nivaro/sdk'
```

#### Create a client

```typescript
import { createNivaro } from '@nivaro/sdk'

// Pass the base URL of the Nivaro API server
const nivaro = createNivaro('https://nivaro.example.com')

// Optionally, seed an initial token
const nivaro = createNivaro('https://nivaro.example.com', { token: 'your-static-token' })
```

The `createNivaro` function returns a `NivaroClient` — a single object with `request()`, `graphql()`, `upload()`, `fileUrl()`, `setToken()`, and `getToken()`.

---

## SDK — Authentication

The SDK attaches the current token as an `Authorization: Bearer` header on every request. It also sets `credentials: 'include'` so browser session cookies are forwarded automatically.

#### Static token (scripts / server-side)

```typescript
// Set at creation time
const nivaro = createNivaro('https://nivaro.example.com', { token: 'abc123...' })

// Or set at runtime (e.g. after generating a token via the API)
nivaro.setToken('abc123...')

// Read the current token
const t = nivaro.getToken()  // string | undefined

// Remove the token (revert to session-cookie-only)
nivaro.setToken(null)
```

#### Session cookie (browser)

In a browser environment where the user has logged in via OIDC, the session cookie is sent automatically. You do not need to call `setToken()` unless you want to use a static token instead.

---

## SDK — REST Commands

All REST operations are performed via `nivaro.request(command)`. Command factories are pure functions — they return a descriptor that `request()` executes.

#### Items

```typescript
import { readItems, readItem, createItem, updateItem, deleteItem } from '@nivaro/sdk'

// List with filter + sort
const list = await nivaro.request(readItems('articles', {
  filter: { status: { _eq: 'active' } },
  sort: ['-created_at'],
  limit: 50,
}))
// list.data → T[], list.total, list.limit, list.offset

// Single item
const item = await nivaro.request(readItem('articles', '123'))
// item.data → T

// Create
const created = await nivaro.request(createItem('articles', { name: 'New', status: 'draft' }))

// Update (partial — only pass changed fields)
const updated = await nivaro.request(updateItem('articles', '123', { status: 'active' }))

// Delete
await nivaro.request(deleteItem('articles', '123'))
```

#### Singletons

```typescript
import { readSingleton, updateSingleton } from '@nivaro/sdk'

const settings = await nivaro.request(readSingleton('nivaro_settings'))
await nivaro.request(updateSingleton('nivaro_settings', { project_name: 'My Project' }))
```

#### Users & revisions

```typescript
import { readMe, updateMe, readUsers, readRevisions } from '@nivaro/sdk'

const me = await nivaro.request(readMe())
await nivaro.request(updateMe({ first_name: 'Rob' }))
const revs = await nivaro.request(readRevisions('articles', '123'))
```

---

## SDK — Workflow Commands

Workflow commands read and drive the state machine bound to any collection. All routes live under `/api/pipelines` (pipelines and workflows share the same engine).

```typescript
import {
  readWorkflowInstance, startWorkflow, transitionWorkflow, readWorkflowInstances
} from '@nivaro/sdk'

// Get current state, available transitions, and history for an item
const wf = await nivaro.request(readWorkflowInstance('inventory_requests', itemId))
// wf.data === null  → no workflow bound to this collection
// wf.data.instance  → { current_state, started_at, completed_at, ... }
// wf.data.states    → all states with id, key, label, color
// wf.data.available_transitions → transitions the caller's role can execute
// wf.data.history   → immutable log of every transition taken

// Find the current state label
const currentState = wf.data.states.find(s => s.id === wf.data.instance?.current_state)

// Start the workflow (creates instance in the initial state)
await nivaro.request(startWorkflow('inventory_requests', itemId))

// Execute a transition
await nivaro.request(
  transitionWorkflow('inventory_requests', itemId, transition.id, 'Approved — looks good')
)

// List all instances for a collection (summary rows, admin use)
const all = await nivaro.request(readWorkflowInstances('inventory_requests'))
```

| Function | Route | Auth |
| --- | --- | --- |
| readWorkflowInstance(col, item) | GET /pipelines/instance/:col/:item | Any authenticated user |
| startWorkflow(col, item) | POST /pipelines/instance/:col/:item/start | Any authenticated user |
| transitionWorkflow(col, item, txId, comment?) | POST /pipelines/instance/:col/:item/transition | Role-gated per transition |
| readWorkflowInstances(col) | GET /pipelines/instances/:col | Any authenticated user |
| readWorkflowBindings() | GET /pipelines/bindings | Admin |

---

## SDK — Pipeline & Owners

The Pipeline Owner Matrix resolves which users own each state of a workflow instance. Use these commands to read and manage ownership.

#### Reading owners

```typescript
import {
  readInstanceOwners, readStateOwners, readAllStateOwners
} from '@nivaro/sdk'

// Current state owners — the primary call for "who owns this right now?"
const { data: owners } = await nivaro.request(readInstanceOwners('inventory_requests', itemId))
// owners → ResolvedOwner[] — { id, email, first_name, last_name }

// Owners for a specific (non-current) state
const { data } = await nivaro.request(
  readStateOwners('inventory_requests', itemId, 'state-uuid-here')
)
// data.state   → { id, key, label, color, ... }
// data.owners  → ResolvedOwner[]

// All states at once — avoids N round-trips
const { data: allOwners } = await nivaro.request(
  readAllStateOwners('inventory_requests', itemId)
)
// allOwners → Record<stateId, { state, owners }> | null (null if no pipeline bound)
const reviewOwners = allOwners?.['review-state-uuid']?.owners
```

#### Managing instance owners

```typescript
import { addInstanceOwner, removeInstanceOwner } from '@nivaro/sdk'

// Assign a user as owner (optional: scope to a specific state)
const { data: owner } = await nivaro.request(
  addInstanceOwner('inventory_requests', itemId, 'user-uuid', 'state-uuid')
)

// Remove an owner assignment by its row ID
await nivaro.request(removeInstanceOwner(owner.id))
```

#### Template data (admin)

```typescript
import { readPipelineTemplates, readOwnerGroups, readStateOwnerGroups } from '@nivaro/sdk'

// List all pipeline templates
const { data: templates } = await nivaro.request(readPipelineTemplates())

// Owner groups for all states, keyed by state ID
const { data: groups } = await nivaro.request(readOwnerGroups(templateId))
// groups['state-uuid'] → PipelineOwnerGroup[] with .filters and .users
```

> **Note:** `readInstanceOwners` / `readStateOwners` apply the full matrix resolution — group filters evaluated against the actual record + instance owner overrides. `readOwnerGroups` returns the raw template configuration without applying any item-specific filter context.

---

## SDK — Notifications

```typescript
import {
  readNotifications, readNotificationCount,
  markNotificationRead, markAllNotificationsRead, deleteNotification
} from '@nivaro/sdk'

// List inbox notifications for the current user
const { data: notifs } = await nivaro.request(readNotifications())
// notifs → Notification[] — { id, subject, message, status, timestamp, collection, item }

// Unread count — lightweight poll for badge
const { data: { unread } } = await nivaro.request(readNotificationCount())

// Mark one as read
await nivaro.request(markNotificationRead(notif.id))

// Mark all read
await nivaro.request(markAllNotificationsRead())

// Delete one
await nivaro.request(deleteNotification(notif.id))
```

> **Note:** For real-time delivery use the Socket.io client — the server emits `notification:new` events to the room `user:<userId>` immediately when a notification is created. See the Realtime section.

---

## SDK — Activity & Revisions

#### Activity log

```typescript
import { readActivity } from '@nivaro/sdk'

// All activity, newest first
const { data: entries } = await nivaro.request(readActivity({ limit: 50 }))

// Filter by collection / action / user
const { data: creates } = await nivaro.request(readActivity({
  collection: 'inventory_requests',
  action: 'create',
  limit: 25,
}))
```

#### Revisions

```typescript
import { readRevisions, readRevision } from '@nivaro/sdk'

// All revisions for a specific item (newest first)
const { data: revs } = await nivaro.request(readRevisions('inventory_requests', itemId))
// Each revision: { action, data (full snapshot), delta (changed fields only), timestamp, user }

// Single revision with full snapshot + delta
const { data: rev } = await nivaro.request(readRevision(revisionId))
```

| Field | Description |
| --- | --- |
| action | "create" | "update" | "delete" |
| data | Full snapshot of the record at that point in time. |
| delta | For updates: only the changed fields. Null for create/delete. |
| timestamp | ISO 8601 datetime. |
| first_name / last_name / user_email | Joined from nivaro_users for display. |

---

## SDK — External APIs

Full CRUD for external API configs and their predefined endpoint templates, plus a test command that fires a live request through the server (credentials never leave the server).

#### API config commands

```typescript
import {
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
await nivaro.request(deleteExternalApi(apiId))
```

#### Test command

```typescript
// Fire a live request through the server (auth resolved server-side)
const { data: result } = await nivaro.request(
  testExternalApi(apiId, {
    method: 'POST',
    path: '/invoices',
    body: { po_number: 'PO-123' },
    query: { format: 'json' },
    headers: { 'X-Correlation-Id': 'abc' },
  })
)
// result: { status, headers, body }
```

#### Calling external APIs

```typescript
import { callExternalApi, callExternalApiEndpoint } from '@nivaro/sdk'

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
// Caller overrides merge on top of the template's saved defaults
```

#### Endpoint template commands

```typescript
import {
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
await nivaro.request(deleteExternalApiEndpoint(endpointId))
```

| Function | Route | Auth |
| --- | --- | --- |
| callExternalApi(apiId, opts?) | POST /external-apis/:id/call | Authenticated |
| callExternalApiEndpoint(slugOrId, opts?) | POST /external-apis/endpoints/:slugOrId/call | Authenticated |
| listExternalApis() | GET /external-apis | Admin |
| getExternalApi(id) | GET /external-apis/:id | Admin |
| createExternalApi(data) | POST /external-apis | Admin |
| updateExternalApi(id, data) | PATCH /external-apis/:id | Admin |
| deleteExternalApi(id) | DELETE /external-apis/:id | Admin |
| testExternalApi(id, opts?) | POST /external-apis/:id/test | Admin |
| listExternalApiEndpoints(apiId) | GET /external-apis/:id/endpoints | Admin |
| getExternalApiEndpoint(eid) | GET /external-apis/endpoints/:eid | Admin |
| createExternalApiEndpoint(apiId, data) | POST /external-apis/:id/endpoints | Admin |
| updateExternalApiEndpoint(eid, data) | PATCH /external-apis/endpoints/:eid | Admin |
| deleteExternalApiEndpoint(eid) | DELETE /external-apis/endpoints/:eid | Admin |

---

## SDK — GraphQL Transport

Use `nivaro.graphql()` to send typed GraphQL queries. The method throws on GraphQL errors — no need to check `response.errors` manually.

```typescript
interface ProjectsResult {
  articles: {
    data: Array<{ id: string; name: string; status: string }>
    total: number
  }
}

const result = await nivaro.graphql<ProjectsResult>(`
  query {
    articles(filter: { status: { _eq: "active" } }, limit: 10) {
      data { id name status }
      total
    }
  }
`)
const projects = result.articles.data
```

#### With variables

```typescript
const result = await nivaro.graphql<ProjectsResult>(
  `query GetProjects($filter: JSON, $limit: Int) {
    articles(filter: $filter, limit: $limit) {
      data { id name }
      total
    }
  }`,
  { filter: { status: { _eq: 'active' } }, limit: 25 },
  'GetProjects',  // optional operationName
)
```

> **Note:** `nivaro.graphql()` uses the same token / session cookie as `nivaro.request()`. Call `nivaro.setToken()` once and both transports are authenticated.

---

## SDK — Token Management

Generate and revoke static tokens via the SDK without leaving TypeScript.

```typescript
import { generateToken, revokeToken, generateUserToken, revokeUserToken } from '@nivaro/sdk'

// Generate a token for the currently-authenticated user
const { data } = await nivaro.request(generateToken())
nivaro.setToken(data.token)   // immediately use the new token
console.log(data.token)    // store it — not retrievable again

// Revoke your own token
await nivaro.request(revokeToken())
nivaro.setToken(null)

// Admin: generate/revoke for another user
const { data: adminData } = await nivaro.request(generateUserToken('user-uuid-here'))
await nivaro.request(revokeUserToken('user-uuid-here'))
```

> **Warning:** The token is only returned in the response body once. After `generateToken()` resolves, the value is not retrievable from the API. Save it to a secure store immediately.

---

## SDK — Files & Upload

```typescript
// Upload a File object (e.g. from <input type="file">)
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const result = await nivaro.upload(fileInput.files![0], {
  title: 'Q2 Report',
  folder: 'folder-uuid-here',   // optional
})
// result: FileUploadResult — id, filename_disk, type, filesize, width, height, etc.

// Generate a URL to serve a file
const url = nivaro.fileUrl(result.id)   // https://nivaro.example.com/api/files/<id>

// To serve the actual file content:
//   GET /api/files/:id/content  (sets correct Content-Type header)

```

#### FileUploadResult shape

| Field | Type | Description |
| --- | --- | --- |
| id | string | UUID primary key. |
| filename_disk | string | Name on disk (hashed for uniqueness). |
| filename_download | string | Original filename from the upload. |
| title | string | null | Optional display title. |
| type | string | MIME type, e.g. image/png. |
| filesize | number | Bytes. |
| width / height | number | null | Pixel dimensions (images only). |
| folder | string | null | Folder UUID, or null for root. |
| uploaded_on | string | ISO 8601 datetime. |

---

## SDK — Realtime

The SDK includes a Socket.io client wrapper for subscribing to live updates. Import `createRealtime` from `@nivaro/sdk`.

```typescript
import { createNivaro, createRealtime } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com', { token: '...' })

// Create a realtime connection
const rt = createRealtime()
rt.connect('https://nivaro.example.com')

// Subscribe to a room (e.g. 'articles:123')
const unsubscribe = rt.subscribe(
  'articles',
  { event: 'update' },
  (data) => {
    console.log('project updated', data)
  },
)

// Disconnect when done
rt.disconnect()
unsubscribe()
```

The Nivaro Socket.io server uses the Redis pub/sub adapter — events emitted on one replica are received by clients connected to any replica.

> **Note:** You do not need to run a separate Socket.io server. The Socket.io server runs inside the Fastify process. Connect directly to the Nivaro API URL.

---

## SDK — Filter Helpers

The SDK exports operator helper functions that make filters type-safe and readable.

```typescript
import {
  _eq, _neq, _gt, _gte, _lt, _lte,
  _in, _nin, _null, _nnull,
  _contains, _ncontains, _starts_with, _ends_with,
  _and, _or, _some, _none,
  asc, desc
} from '@nivaro/sdk'

// Scalar field conditions
const filter = {
  status: _in(['active', 'draft']),
  amount: _gt(1000),
  deleted_at: _null(),
  name: _contains('fiber'),
  email: _ends_with('@nivaro.dev'),
  title: _ncontains('archived'),
}

// Logical combinators
const combined = _and(
  { status: _eq('active') },
  _or({ region: _eq('East') }, { region: _eq('West') })
)

// Relation filters — O2M / M2M
const withTags = {
  tags: _some({ name: _eq('featured') }),   // at least one tag named "featured"
  approvals: _none({ status: _eq('rejected') }),  // no rejected approvals
}

// Sort helpers
const items = await nivaro.request(
  readItems('projects', {
    filter: combined,
    sort: [asc('region.short_name'), desc('created_at')],
  })
)
```

#### Scalar operators

| Helper | SQL | Notes |
| --- | --- | --- |
| _eq(v) | = v | Exact equality. |
| _neq(v) | != v | Not equal. |
| _gt(v) | > v |  |
| _gte(v) | >= v |  |
| _lt(v) | < v |  |
| _lte(v) | <= v |  |
| _in(arr) | IN (...) | Array of values. |
| _nin(arr) | NOT IN (...) |  |
| _null() | IS NULL |  |
| _nnull() | IS NOT NULL |  |
| _contains(s) | LIKE %s% | Substring match. |
| _ncontains(s) | NOT LIKE %s% | Substring exclusion. |
| _starts_with(s) | LIKE s% | Prefix match. |
| _ends_with(s) | LIKE %s | Suffix match. |

#### Logical & relation operators

| Helper | Type | Notes |
| --- | --- | --- |
| _and(...clauses) | Logical | All clauses must match. |
| _or(...clauses) | Logical | At least one clause must match. |
| _some(filter) | Relation | At least one related record matches filter. |
| _none(filter) | Relation | No related records match filter. |

#### Sort helpers

| Helper | Example | Notes |
| --- | --- | --- |
| asc(field) | asc('created_at') | Ascending. Dotted paths for M2O: asc('region.short_name'). |
| desc(field) | desc('amount') | Descending. |

---

## SDK — Comments

```typescript
import { listComments, createComment, updateComment, deleteComment } from '@nivaro/sdk'

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
await nivaro.request(deleteComment(comment.id))
```

| Function | Route | Auth |
| --- | --- | --- |
| listComments(collection, item) | GET /comments | Authenticated |
| createComment(body) | POST /comments | Authenticated |
| updateComment(id, body) | PATCH /comments/:id | Authenticated (own) |
| deleteComment(id) | DELETE /comments/:id | Authenticated (own or admin) |

---

## SDK — Webhooks

```typescript
import {
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

await nivaro.request(deleteWebhook(wh.id))
```

| Function | Route | Auth |
| --- | --- | --- |
| listWebhooks() | GET /webhooks | Admin |
| getWebhook(id) | GET /webhooks/:id | Admin |
| createWebhook(data) | POST /webhooks | Admin |
| updateWebhook(id, data) | PATCH /webhooks/:id | Admin |
| deleteWebhook(id) | DELETE /webhooks/:id | Admin |
| testWebhook(id) | POST /webhooks/:id/test | Admin |

---

## SDK — Rules

Rules run server-side on collection mutations (create/update/delete). Each rule has conditions and actions — `reject`, `set_field`, `send_notification`, or `trigger_webhook`.

```typescript
import { listRules, createRule, updateRule, deleteRule } from '@nivaro/sdk'

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
await nivaro.request(deleteRule(rule.id))
```

| Function | Route | Auth |
| --- | --- | --- |
| listRules(collection?) | GET /rules | Admin |
| createRule(data) | POST /rules | Admin |
| updateRule(id, data) | PATCH /rules/:id | Admin |
| deleteRule(id) | DELETE /rules/:id | Admin |

---

## SDK — Flow Runs

Read execution history for Inngest-backed flows. Flows are created and scheduled in the admin UI at `/flows`.

```typescript
import { listFlowRuns, getFlowRun } from '@nivaro/sdk'

// Execution history for a flow (newest first)
const { data: runs } = await nivaro.request(
  listFlowRuns('flow-uuid', { limit: 50, status: 'error' })
)
// run: { id, status ('running'|'success'|'error'), started_at, completed_at, duration_ms, output, error_message }

// Single run detail
const { data: run } = await nivaro.request(getFlowRun('run-uuid'))
```

| Function | Route | Auth |
| --- | --- | --- |
| listFlowRuns(flowId, opts?) | GET /flows/:id/runs | Admin |
| getFlowRun(runId) | GET /flows/runs/:id | Admin |

---

## SDK — Custom Queries

Custom queries are named, parameterized SQL endpoints defined in the admin UI at `/custom-queries`. Access is `admin` or `authenticated` per query.

```typescript
import { listCustomQueries, executeCustomQuery } from '@nivaro/sdk'

// List all queries visible to the current user
const { data: queries } = await nivaro.request(listCustomQueries())
// query: { id, name, slug, description, access, cache_ttl, enabled, params }

// Execute by slug — params are validated server-side against the param definitions
const { data, cached, executed_at } = await nivaro.request(
  executeCustomQuery('active-orders-by-region', { region: 'West', limit: 100 })
)
// data → unknown[] — raw rows from the SQL result
```

| Function | Route | Auth |
| --- | --- | --- |
| listCustomQueries() | GET /custom-queries | Authenticated |
| executeCustomQuery(slug, params?) | POST /custom-queries/:slug/execute | Per-query access setting |

---

## SDK — Collections

Returns the metadata registry — all collections visible to the current workspace and user. Useful for building dynamic UIs that adapt to the configured schema.

```typescript
import { readCollections } from '@nivaro/sdk'

const { data: collections } = await nivaro.request(readCollections())
// collection: { collection, label, singleton, sort_field, hidden, ... }
```

| Function | Route | Auth |
| --- | --- | --- |
| readCollections() | GET /collections | Authenticated |

---

## SDK — Blackout Dates

Blackout dates block scheduling on specific calendar days. Scoped per business unit or left global.

```typescript
import { listBlackoutDates, checkBlackoutDate, createBlackoutDate, deleteBlackoutDate } from '@nivaro/sdk'

// List all blackout dates (optional scope filter)
const { data: dates } = await nivaro.request(listBlackoutDates('us-holidays'))

// Check a single date
const { isBlackout, label } = await nivaro.request(checkBlackoutDate('2025-12-25', 'us-holidays'))

// Create
await nivaro.request(createBlackoutDate({ date: '2026-01-01', label: "New Year's Day", scope: 'us-holidays' }))

// Delete by ID
await nivaro.request(deleteBlackoutDate(dateId))
```

| Function | Route | Auth |
| --- | --- | --- |
| listBlackoutDates(scope?) | GET /blackout-dates | Authenticated |
| checkBlackoutDate(date, scope?) | GET /blackout-dates/check | Authenticated |
| createBlackoutDate(body) | POST /blackout-dates | Admin |
| deleteBlackoutDate(id) | DELETE /blackout-dates/:id | Admin |

---

## SDK — Schema Snapshot

Export a point-in-time snapshot of the full metadata registry and import it to another instance. Useful for promoting schema changes between environments.

```typescript
import { exportSchemaSnapshot, importSchemaSnapshot } from '@nivaro/sdk'

// Export — returns the full registry as a JSON object
const snapshot = await nivaro.request(exportSchemaSnapshot())

// Import — applies the snapshot to the target instance
const { imported } = await nivaro.request(importSchemaSnapshot(snapshot))
// imported: { collections: n, fields: n, relations: n }
```

| Function | Route | Auth |
| --- | --- | --- |
| exportSchemaSnapshot() | GET /schema-snapshot/export | Admin |
| importSchemaSnapshot(data) | POST /schema-snapshot/import | Admin |

---

## SDK — Alerts

Manage alert definitions (threshold and anomaly rules), per-user subscriptions, the alert log, and on-demand evaluation.

```typescript
import {
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
await nivaro.request(evaluateAlerts())
```

| Command | Method + path | Notes |
| --- | --- | --- |
| listAlertDefinitions(collection?) | GET /alerts/definitions | Admin |
| getAlertDefinition(id) | GET /alerts/definitions/:id | Admin |
| createAlertDefinition(body) | POST /alerts/definitions | Admin |
| updateAlertDefinition(id, body) | PATCH /alerts/definitions/:id | Admin |
| deleteAlertDefinition(id) | DELETE /alerts/definitions/:id | Admin |
| listAlertSubscriptions(definitionId?) | GET /alerts/subscriptions | Authenticated |
| createAlertSubscription(body) | POST /alerts/subscriptions | Authenticated |
| deleteAlertSubscription(id) | DELETE /alerts/subscriptions/:id | Authenticated |
| readAlertLog(definitionId?) | GET /alerts/log | Admin |
| evaluateAlerts() | POST /alerts/evaluate | Admin |

---

## SDK — Dynamic Attributes (EAV)

Dynamic attributes let admins attach ad-hoc key/value fields to any collection without schema migrations. Definitions are managed in Data Model; values are stored per item in `nivaro_attribute_values`.

```typescript
import {
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
}))
```

> **Note:** All attribute values are stored as strings regardless of the definition type. The admin UI parses them by type for rendering; SDK consumers should do the same.

---

## SDK — Notification Subscriptions

Users can subscribe to collection-level events (create/update/delete) with optional field-value filters, delivered as in-app notifications or digest emails.

```typescript
import {
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

await nivaro.request(deleteNotificationSubscription(sub.id))
```

---

## SDK — SLA Rules

SLA rules attach time-based targets to workflow states. The SDK covers rule CRUD (admin) and per-item or batch status reads (any authenticated user).

```typescript
import {
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
)
```

| Command | Method + path | Auth |
| --- | --- | --- |
| listSlaRules(workflowTemplateId?) | GET /sla/rules | Admin |
| getSlaRule(id) | GET /sla/rules/:id | Admin |
| createSlaRule(body) | POST /sla/rules | Admin |
| updateSlaRule(id, body) | PATCH /sla/rules/:id | Admin |
| deleteSlaRule(id) | DELETE /sla/rules/:id | Admin |
| getSlaStatus(collection, itemId) | GET /sla/status/:collection/:item | Authenticated |
| readSlaStatusBatch(collection, ids) | POST /sla/status/batch | Authenticated |

---

## SDK — Presence

Presence tracks which users are actively viewing or editing a record. Use it to show live collaborator avatars and avoid conflicting edits alongside item locking.

```typescript
import { getPresence, listActivePresence } from '@nivaro/sdk'

// Who is currently viewing/editing a specific item?
const { data: viewers } = await nivaro.request(
  getPresence('contracts', '99')
)
// → [{ user_id, first_name, last_name, last_seen }]

// All active presence sessions across the instance (admin)
const { data: sessions, total } = await nivaro.request(listActivePresence())
```

> **Note:** The admin UI emits Socket.io heartbeats automatically. SDK consumers managing custom UIs should emit the same `presence:heartbeat` event via the realtime client to stay visible.

---

## SDK — Tree & Hierarchy

The Nivaro SDK provides typed commands for both same-collection trees and multi-collection hierarchies.

#### Tree commands

```typescript
import { createNivaro, readTreeConfig, readTreeNodes, readTreeNested, readTreeAncestors, readTreeDescendants, readTreeChildren, moveTreeNode, reorderTreeSiblings, rebuildTreePaths } from '@nivaro/sdk'

const cms = createNivaro('https://cms.example.com', { token: 'my-token' })

// Check if a collection has a tree config
const config = await cms.request(readTreeConfig('org_units'))
// → { data: { id, collection, parent_field, label_field, order_field } | null }

// Flat node list (for custom rendering)
const nodes = await cms.request(readTreeNodes('org_units'))

// Fully nested tree (recursive children arrays)
const tree = await cms.request(readTreeNested('org_units'))

// Ancestors of a node (root-first breadcrumb)
const path = await cms.request(readTreeAncestors('org_units', 42))

// Direct children of a node
const kids = await cms.request(readTreeChildren('org_units', 42))

// All descendants (any depth)
const all = await cms.request(readTreeDescendants('org_units', 42))

// Move a node (null = make root)
await cms.request(moveTreeNode('org_units', 42, 7))

// Reorder siblings (requires order_field on the tree config)
await cms.request(reorderTreeSiblings('org_units', 42, [
  { id: 42, sort: 0 },
  { id: 43, sort: 1 },
]))

// Rebuild materialized path/depth columns (admin; maintain_path configs)
await cms.request(rebuildTreePaths(3))
```

#### Tree permission commands (admin)

```typescript
import { listTreePermissions, createTreePermission, updateTreePermission, deleteTreePermission } from '@nivaro/sdk'

// List rules (optionally for one collection)
const rules = await cms.request(listTreePermissions('org_units'))

// Deny the "Contractors" role updates inside node 42's subtree
await cms.request(createTreePermission({
  collection: 'org_units',
  node_id: 42,
  role: '0a1b2c3d-…',     // role UUID
  action: 'update',
  allow: false,
}))

await cms.request(updateTreePermission(7, { action: '*' }))
await cms.request(deleteTreePermission(7))
```

> **Note:** Item reads on tree collections may include an `_inherited` sidecar (`{ field: ancestorId }`) when inheritable fields resolved values from an ancestor — see Inherited Field Values.

#### Hierarchy commands

```typescript
import { createNivaro, listHierarchyConfigs, readHierarchyConfig, readHierarchyTree, readHierarchyNodes, readHierarchyNodeChildren, readHierarchyNodeAncestors, createHierarchyConfig, updateHierarchyConfig, deleteHierarchyConfig } from '@nivaro/sdk'

// List all hierarchy configs
const configs = await cms.request(listHierarchyConfigs())

// Full nested tree for hierarchy #1
const tree = await cms.request(readHierarchyTree(1))

// Flat nodes for hierarchy #1
const nodes = await cms.request(readHierarchyNodes(1))

// Children of a specific node
const children = await cms.request(readHierarchyNodeChildren(1, 'divisions', 5))

// Ancestors (breadcrumb) of a node
const ancestors = await cms.request(readHierarchyNodeAncestors(1, 'regions', 22))

// Create a new hierarchy config
await cms.request(createHierarchyConfig({
  name: 'Org Structure',
  levels: [
    { collection: 'divisions', label_field: 'name', parent_fk: null },
    { collection: 'regions', label_field: 'name', parent_fk: 'division_id' },
  ],
}))
```

---

## SDK — Privacy & Retention Policies

Retention policies identify inactive users and redact, delete, or suspend their accounts on a schedule. All endpoints are admin-only.

```typescript
import {
  listRetentionPolicies, getRetentionPolicy,
  createRetentionPolicy, updateRetentionPolicy, deleteRetentionPolicy,
  runRetentionPolicy, listRetentionRuns
} from '@nivaro/sdk'

// Create a policy: redact PII after 36 months of inactivity
const { data: policy } = await nivaro.request(createRetentionPolicy({
  name: '3-year inactivity redaction',
  inactivity_threshold_months: 36,
  action: 'redact',
  redact_fields: ['first_name', 'last_name', 'email', 'external_id', 'job_title'],
  redact_value_template: 'Redacted_{{id}}',
  exclusion_emails: ['admin@example.com', 'service@example.com'],
  exclusion_roles: [],
  cron_schedule: '0 2 1 * *',   // 1st of every month at 2am
  is_active: true,
  dry_run_mode: false
}))

// Dry run — preview without writing
const { data: preview } = await nivaro.request(runRetentionPolicy(policy.id, true))
console.log(`Would affect ${preview.affected_count} users`, preview.affected_ids)

// Execute for real
const { data: result } = await nivaro.request(runRetentionPolicy(policy.id))

// Run history
const { data: runs } = await nivaro.request(listRetentionRuns(policy.id))
```

| Command | Method + path | Access |
|---|---|---|
| listRetentionPolicies() | GET /retention | Admin |
| getRetentionPolicy(id) | GET /retention/:id | Admin |
| createRetentionPolicy(body) | POST /retention | Admin |
| updateRetentionPolicy(id, body) | PATCH /retention/:id | Admin |
| deleteRetentionPolicy(id) | DELETE /retention/:id | Admin |
| runRetentionPolicy(id, dryRun?) | POST /retention/:id/run | Admin |
| listRetentionRuns(policyId) | GET /retention/:id/runs | Admin |

Redacted users have `is_redacted: true` and are automatically excluded from all user list and picker endpoints — no changes needed in calling code.

---

## SDK Coverage: ~182 Typed Commands

The @nivaro/sdk command surface now covers every feature area — roughly 175 typed `Command<T>` factories spanning items, files, workflows, pipelines, flows, comments, webhooks, rules, custom queries, trees and hierarchies, submission forms, field watches, notification subscriptions, imports, SLA, alerts, AI endpoints (generate, summarize, validate, check-duplicates), translations, drafts, scheduled changes, record templates, saved views, API keys, widget feeds, sync jobs, ERP submissions, PDF templates, pages, and more. If a REST route exists, there is a typed command for it.

#### Discovering commands

- Everything is exported from the package root — editor autocomplete on `import { … } from "@nivaro/sdk"` is the fastest index.
- The SDK Playground at /sdk-playground runs snippets against the live instance with your session's permissions, with collection and field comboboxes to scaffold calls.
- All commands flow through `cms.request(command)`, so auth, workspace headers, and error handling are uniform.

```typescript
import { createNivaro, readItems, aiValidate, listWidgetFeeds } from '@nivaro/sdk';

const cms = createNivaro('https://cms.example.com').withToken('nvk_...');

const articles = await cms.request(readItems('articles', { limit: 5 }));
const check = await cms.request(aiValidate('articles', { title: 'Draft post' }));
const feeds = await cms.request(listWidgetFeeds());
```


---

## TypeScript

All commands are fully typed. Pass your collection interface as a generic to get typed responses:

```typescript
interface Project {
  id: string
  name: string
  status: 'active' | 'done' | 'archived'
  owner: string
  created_at: string
}

const list = await nivaro.request(readItems<Project>('projects', {
  filter: { status: _eq('active') },
  sort: [desc('created_at')],
}))
// list.data is Project[]

const { data: project } = await nivaro.request(readItem<Project>('projects', id))
// project is Project
```

---

## License

MIT — see [LICENSE](https://github.com/nodeworks/nivaro/blob/main/LICENSE).
