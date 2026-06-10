import type { DocSection } from '../types.js'

export const sdkSetup: DocSection = {
  id: 'sdk-setup',
  label: 'Setup',
  content: [
    { type: 'h1', id: 'sdk-setup', text: 'SDK — Setup' },
    { type: 'p', text: 'The `@nivaro/sdk` package is a typed client for the Nivaro API.' },
    {
      type: 'pre',
      code: `# Install
pnpm add @nivaro/sdk

# TypeScript import
import { createNivaro, readItems, createItem, updateItem, deleteItem } from '@nivaro/sdk'`
    },
    { type: 'h3', text: 'Create a client' },
    {
      type: 'pre',
      code: `import { createNivaro } from '@nivaro/sdk'

// Pass the base URL of the Nivaro API server
const nivaro = createNivaro('https://nivaro.example.com')

// Optionally, seed an initial token
const nivaro = createNivaro('https://nivaro.example.com', { token: 'your-static-token' })`
    },
    {
      type: 'p',
      text: 'The `createNivaro` function returns a `NivaroClient` — a single object with `request()`, `graphql()`, `upload()`, `fileUrl()`, `setToken()`, and `getToken()`.'
    }
  ]
}

export const sdkAuth: DocSection = {
  id: 'sdk-auth',
  label: 'Authentication',
  content: [
    { type: 'h1', id: 'sdk-auth', text: 'SDK — Authentication' },
    {
      type: 'p',
      text: "The SDK attaches the current token as an `Authorization: Bearer` header on every request. It also sets `credentials: 'include'` so browser session cookies are forwarded automatically."
    },
    { type: 'h3', text: 'Static token (scripts / server-side)' },
    {
      type: 'pre',
      code: `// Set at creation time
const nivaro = createNivaro('https://nivaro.example.com', { token: 'abc123...' })

// Or set at runtime (e.g. after generating a token via the API)
nivaro.setToken('abc123...')

// Read the current token
const t = nivaro.getToken()  // string | undefined

// Remove the token (revert to session-cookie-only)
nivaro.setToken(null)`
    },
    { type: 'h3', text: 'Session cookie (browser)' },
    {
      type: 'p',
      text: 'In a browser environment where the user has logged in via OIDC, the session cookie is sent automatically. You do not need to call `setToken()` unless you want to use a static token instead.'
    }
  ]
}

export const sdkRest: DocSection = {
  id: 'sdk-rest',
  label: 'REST Commands',
  content: [
    { type: 'h1', id: 'sdk-rest', text: 'SDK — REST Commands' },
    {
      type: 'p',
      text: 'All REST operations are performed via `nivaro.request(command)`. Command factories are pure functions — they return a descriptor that `request()` executes.'
    },
    { type: 'h3', text: 'Items' },
    {
      type: 'pre',
      code: `import { readItems, readItem, createItem, updateItem, deleteItem } from '@nivaro/sdk'

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
await nivaro.request(deleteItem('articles', '123'))`
    },
    { type: 'h3', text: 'Singletons' },
    {
      type: 'pre',
      code: `import { readSingleton, updateSingleton } from '@nivaro/sdk'

const settings = await nivaro.request(readSingleton('nivaro_settings'))
await nivaro.request(updateSingleton('nivaro_settings', { project_name: 'My Project' }))`
    },
    { type: 'h3', text: 'Users & revisions' },
    {
      type: 'pre',
      code: `import { readMe, updateMe, readUsers, readRevisions } from '@nivaro/sdk'

const me = await nivaro.request(readMe())
await nivaro.request(updateMe({ first_name: 'Rob' }))
const revs = await nivaro.request(readRevisions('articles', '123'))`
    }
  ]
}

export const sdkWorkflow: DocSection = {
  id: 'sdk-workflow',
  label: 'Workflow Commands',
  content: [
    { type: 'h1', id: 'sdk-workflow', text: 'SDK — Workflow Commands' },
    {
      type: 'p',
      text: 'Workflow commands read and drive the state machine bound to any collection. All routes live under `/api/pipelines` (pipelines and workflows share the same engine).'
    },
    {
      type: 'pre',
      code: `import {
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
const all = await nivaro.request(readWorkflowInstances('inventory_requests'))`
    },
    {
      type: 'table',
      head: ['Function', 'Route', 'Auth'],
      rows: [
        [
          'readWorkflowInstance(col, item)',
          'GET /pipelines/instance/:col/:item',
          'Any authenticated user'
        ],
        [
          'startWorkflow(col, item)',
          'POST /pipelines/instance/:col/:item/start',
          'Any authenticated user'
        ],
        [
          'transitionWorkflow(col, item, txId, comment?)',
          'POST /pipelines/instance/:col/:item/transition',
          'Role-gated per transition'
        ],
        ['readWorkflowInstances(col)', 'GET /pipelines/instances/:col', 'Any authenticated user'],
        ['readWorkflowBindings()', 'GET /pipelines/bindings', 'Admin']
      ]
    }
  ]
}

export const sdkPipeline: DocSection = {
  id: 'sdk-pipeline',
  label: 'Pipeline & Owners',
  content: [
    { type: 'h1', id: 'sdk-pipeline', text: 'SDK — Pipeline & Owners' },
    {
      type: 'p',
      text: 'The Pipeline Owner Matrix resolves which users own each state of a workflow instance. Use these commands to read and manage ownership.'
    },
    { type: 'h3', text: 'Reading owners' },
    {
      type: 'pre',
      code: `import {
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
const reviewOwners = allOwners?.['review-state-uuid']?.owners`
    },
    { type: 'h3', text: 'Managing instance owners' },
    {
      type: 'pre',
      code: `import { addInstanceOwner, removeInstanceOwner } from '@nivaro/sdk'

// Assign a user as owner (optional: scope to a specific state)
const { data: owner } = await nivaro.request(
  addInstanceOwner('inventory_requests', itemId, 'user-uuid', 'state-uuid')
)

// Remove an owner assignment by its row ID
await nivaro.request(removeInstanceOwner(owner.id))`
    },
    { type: 'h3', text: 'Template data (admin)' },
    {
      type: 'pre',
      code: `import { readPipelineTemplates, readOwnerGroups, readStateOwnerGroups } from '@nivaro/sdk'

// List all pipeline templates
const { data: templates } = await nivaro.request(readPipelineTemplates())

// Owner groups for all states, keyed by state ID
const { data: groups } = await nivaro.request(readOwnerGroups(templateId))
// groups['state-uuid'] → PipelineOwnerGroup[] with .filters and .users`
    },
    {
      type: 'note',
      text: '`readInstanceOwners` / `readStateOwners` apply the full matrix resolution — group filters evaluated against the actual record + instance owner overrides. `readOwnerGroups` returns the raw template configuration without applying any item-specific filter context.'
    }
  ]
}

export const sdkNotifications: DocSection = {
  id: 'sdk-notifications',
  label: 'Notifications',
  content: [
    { type: 'h1', id: 'sdk-notifications', text: 'SDK — Notifications' },
    {
      type: 'pre',
      code: `import {
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
await nivaro.request(deleteNotification(notif.id))`
    },
    {
      type: 'note',
      text: 'For real-time delivery use the Socket.io client — the server emits `notification:new` events to the room `user:<userId>` immediately when a notification is created. See the Realtime section.'
    }
  ]
}

export const sdkActivity: DocSection = {
  id: 'sdk-activity',
  label: 'Activity & Revisions',
  content: [
    { type: 'h1', id: 'sdk-activity', text: 'SDK — Activity & Revisions' },
    { type: 'h3', text: 'Activity log' },
    {
      type: 'pre',
      code: `import { readActivity } from '@nivaro/sdk'

// All activity, newest first
const { data: entries } = await nivaro.request(readActivity({ limit: 50 }))

// Filter by collection / action / user
const { data: creates } = await nivaro.request(readActivity({
  collection: 'inventory_requests',
  action: 'create',
  limit: 25,
}))`
    },
    { type: 'h3', text: 'Revisions' },
    {
      type: 'pre',
      code: `import { readRevisions, readRevision } from '@nivaro/sdk'

// All revisions for a specific item (newest first)
const { data: revs } = await nivaro.request(readRevisions('inventory_requests', itemId))
// Each revision: { action, data (full snapshot), delta (changed fields only), timestamp, user }

// Single revision with full snapshot + delta
const { data: rev } = await nivaro.request(readRevision(revisionId))`
    },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['action', '"create" | "update" | "delete"'],
        ['data', 'Full snapshot of the record at that point in time.'],
        ['delta', 'For updates: only the changed fields. Null for create/delete.'],
        ['timestamp', 'ISO 8601 datetime.'],
        ['first_name / last_name / user_email', 'Joined from nivaro_users for display.']
      ]
    }
  ]
}

export const sdkGraphql: DocSection = {
  id: 'sdk-graphql',
  label: 'GraphQL Transport',
  content: [
    { type: 'h1', id: 'sdk-graphql', text: 'SDK — GraphQL Transport' },
    {
      type: 'p',
      text: 'Use `nivaro.graphql()` to send typed GraphQL queries. The method throws on GraphQL errors — no need to check `response.errors` manually.'
    },
    {
      type: 'pre',
      code: `interface ProjectsResult {
  articles: {
    data: Array<{ id: string; name: string; status: string }>
    total: number
  }
}

const result = await nivaro.graphql<ProjectsResult>(\`
  query {
    articles(filter: { status: { _eq: "active" } }, limit: 10) {
      data { id name status }
      total
    }
  }
\`)
const projects = result.articles.data`
    },
    { type: 'h3', text: 'With variables' },
    {
      type: 'pre',
      code: `const result = await nivaro.graphql<ProjectsResult>(
  \`query GetProjects($filter: JSON, $limit: Int) {
    articles(filter: $filter, limit: $limit) {
      data { id name }
      total
    }
  }\`,
  { filter: { status: { _eq: 'active' } }, limit: 25 },
  'GetProjects',  // optional operationName
)`
    },
    {
      type: 'note',
      text: '`nivaro.graphql()` uses the same token / session cookie as `nivaro.request()`. Call `nivaro.setToken()` once and both transports are authenticated.'
    }
  ]
}

export const sdkTokens: DocSection = {
  id: 'sdk-tokens',
  label: 'Token Management',
  content: [
    { type: 'h1', id: 'sdk-tokens', text: 'SDK — Token Management' },
    {
      type: 'p',
      text: 'Generate and revoke static tokens via the SDK without leaving TypeScript.'
    },
    {
      type: 'pre',
      code: `import { generateToken, revokeToken, generateUserToken, revokeUserToken } from '@nivaro/sdk'

// Generate a token for the currently-authenticated user
const { data } = await nivaro.request(generateToken())
nivaro.setToken(data.token)   // immediately use the new token
console.log(data.token)    // store it — not retrievable again

// Revoke your own token
await nivaro.request(revokeToken())
nivaro.setToken(null)

// Admin: generate/revoke for another user
const { data: adminData } = await nivaro.request(generateUserToken('user-uuid-here'))
await nivaro.request(revokeUserToken('user-uuid-here'))`
    },
    {
      type: 'warn',
      text: 'The token is only returned in the response body once. After `generateToken()` resolves, the value is not retrievable from the API. Save it to a secure store immediately.'
    }
  ]
}

export const sdkFiles: DocSection = {
  id: 'sdk-files',
  label: 'Files & Upload',
  content: [
    { type: 'h1', id: 'sdk-files', text: 'SDK — Files & Upload' },
    {
      type: 'pre',
      code: `// Upload a File object (e.g. from <input type="file">)
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
`
    },
    { type: 'h3', text: 'FileUploadResult shape' },
    {
      type: 'table',
      head: ['Field', 'Type', 'Description'],
      rows: [
        ['id', 'string', 'UUID primary key.'],
        ['filename_disk', 'string', 'Name on disk (hashed for uniqueness).'],
        ['filename_download', 'string', 'Original filename from the upload.'],
        ['title', 'string | null', 'Optional display title.'],
        ['type', 'string', 'MIME type, e.g. image/png.'],
        ['filesize', 'number', 'Bytes.'],
        ['width / height', 'number | null', 'Pixel dimensions (images only).'],
        ['folder', 'string | null', 'Folder UUID, or null for root.'],
        ['uploaded_on', 'string', 'ISO 8601 datetime.']
      ]
    }
  ]
}

export const sdkRealtime: DocSection = {
  id: 'sdk-realtime',
  label: 'Realtime',
  content: [
    { type: 'h1', id: 'sdk-realtime', text: 'SDK — Realtime' },
    {
      type: 'p',
      text: 'The SDK includes a Socket.io client wrapper for subscribing to live updates. Import `createRealtime` from `@nivaro/sdk`.'
    },
    {
      type: 'pre',
      code: `import { createNivaro, createRealtime } from '@nivaro/sdk'

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
unsubscribe()`
    },
    {
      type: 'p',
      text: 'The Nivaro Socket.io server uses the Redis pub/sub adapter — events emitted on one replica are received by clients connected to any replica.'
    },
    {
      type: 'note',
      text: 'You do not need to run a separate Socket.io server. The Socket.io server runs inside the Fastify process. Connect directly to the Nivaro API URL.'
    }
  ]
}

export const sdkFilters: DocSection = {
  id: 'sdk-filters',
  label: 'Filter Helpers',
  content: [
    { type: 'h1', id: 'sdk-filters', text: 'SDK — Filter Helpers' },
    {
      type: 'p',
      text: 'The SDK exports operator helper functions that make filters type-safe and readable.'
    },
    {
      type: 'pre',
      code: `import {
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
)`
    },
    { type: 'h3', text: 'Scalar operators' },
    {
      type: 'table',
      head: ['Helper', 'SQL', 'Notes'],
      rows: [
        ['_eq(v)', '= v', 'Exact equality.'],
        ['_neq(v)', '!= v', 'Not equal.'],
        ['_gt(v)', '> v', ''],
        ['_gte(v)', '>= v', ''],
        ['_lt(v)', '< v', ''],
        ['_lte(v)', '<= v', ''],
        ['_in(arr)', 'IN (...)', 'Array of values.'],
        ['_nin(arr)', 'NOT IN (...)', ''],
        ['_null()', 'IS NULL', ''],
        ['_nnull()', 'IS NOT NULL', ''],
        ['_contains(s)', 'LIKE %s%', 'Substring match.'],
        ['_ncontains(s)', 'NOT LIKE %s%', 'Substring exclusion.'],
        ['_starts_with(s)', 'LIKE s%', 'Prefix match.'],
        ['_ends_with(s)', 'LIKE %s', 'Suffix match.']
      ]
    },
    { type: 'h3', text: 'Logical & relation operators' },
    {
      type: 'table',
      head: ['Helper', 'Type', 'Notes'],
      rows: [
        ['_and(...clauses)', 'Logical', 'All clauses must match.'],
        ['_or(...clauses)', 'Logical', 'At least one clause must match.'],
        ['_some(filter)', 'Relation', 'At least one related record matches filter.'],
        ['_none(filter)', 'Relation', 'No related records match filter.']
      ]
    },
    { type: 'h3', text: 'Sort helpers' },
    {
      type: 'table',
      head: ['Helper', 'Example', 'Notes'],
      rows: [
        [
          'asc(field)',
          "asc('created_at')",
          "Ascending. Dotted paths for M2O: asc('region.short_name')."
        ],
        ['desc(field)', "desc('amount')", 'Descending.']
      ]
    }
  ]
}
