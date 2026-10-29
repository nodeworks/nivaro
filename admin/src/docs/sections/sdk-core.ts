import type { DocSection } from '../types.js'

export const sdkSetup: DocSection = {
  id: 'sdk-setup',
  label: 'Setup',
  content: [
    { type: 'h1', id: 'sdk-setup', text: 'SDK — Setup' },
    {
      type: 'p',
      text: 'The `@nivaro/sdk` package is a fully-typed TypeScript client for the Nivaro REST, GraphQL, and realtime APIs. Works in Node.js, browsers, and edge runtimes.'
    },
    { type: 'h3', text: 'Installation' },
    {
      type: 'pre',
      code: `pnpm add @nivaro/sdk`
    },
    { type: 'h3', text: 'MCP server (Claude Code, Claude Desktop, Cursor)' },
    {
      type: 'p',
      text: "The companion package `@nivaro/mcp` wraps the SDK as a Model Context Protocol server, so an AI coding assistant can read and write an instance directly: collection schemas, record reads and aggregates, rehearsed creates, updates, deletes with an explicit confirm, pipeline state and transitions, and the instance's own ask-your-data assistant. It authenticates with an `nvk_` API key, so role permissions, row-level security and user scopes apply unchanged; a sandbox key is read-only by construction. Install and client config snippets live in the package README (`packages/mcp/README.md`)."
    },
    {
      type: 'pre',
      code: `claude mcp add nivaro -e NIVARO_URL=https://nivaro.example.com -e NIVARO_TOKEN=nvk_... -- npx -y @nivaro/mcp`
    },
    { type: 'h3', text: 'Create a client' },
    {
      type: 'pre',
      code: `import { createNivaro } from '@nivaro/sdk'

// Minimal — use session cookie (browser) or set token later
const nivaro = createNivaro('https://nivaro.example.com')

// With static token
const nivaro = createNivaro('https://nivaro.example.com', {
  token: 'nvk_abc123...',  // Bearer token
})

// Full options
const nivaro = createNivaro('https://nivaro.example.com', {
  token: 'nvk_abc123...',
  headers: { 'x-workspace': 'workspace-uuid', 'x-nivaro-app': 'my-app' },  // extra headers (or a function)
  timeoutMs: 90_000,  // abandon a GET read that has not answered (off by default)
  retry: 2,           // retry GETs on 408/429/502/503/504 + network errors, honouring Retry-After (off by default)
  debug: true,        // one console.debug line per request: method, path, status, ms, request id
  onRequest: (req) => { req.headers['traceparent'] = currentTrace() },
  onResponse: (res) => metrics.observe(res.path, res.status, res.durationMs, res.requestId),
  onError: (err, where) => logger.warn({ where, err }),
})`
    },
    { type: 'h3', text: 'Errors' },
    {
      type: 'p',
      text: 'Every non-2xx answer throws a `NivaroError` (an `Error`): `status`, the API machine `code` (e.g. `QUOTA_EXCEEDED`, `SERVER_BUSY`), `requestId` (the `x-nivaro-request-id` the server stamped — quote it when reporting a problem), the parsed body on `response`, `method`, `path` and `retryAfterMs`. A GET past `timeoutMs` throws a `TimeoutError`; a caller abort (`withSignal`) throws the platform `AbortError`.'
    },
    {
      type: 'pre',
      code: `import { isNivaroError, readItem } from '@nivaro/sdk'

try {
  await nivaro.request(readItem('orders', 42))
} catch (err) {
  if (isNivaroError(err) && err.status === 404) return null
  if (isNivaroError(err)) console.error(err.code, err.message, 'request', err.requestId)
  throw err
}`
    },
    { type: 'h3', text: 'Client methods' },
    {
      type: 'table',
      head: ['Method', 'Purpose', 'Example'],
      rows: [
        ['request(command)', 'REST operations', 'await nivaro.request(readItems("articles"))'],
        [
          'graphql(query, vars?)',
          'GraphQL queries + mutations',
          'await nivaro.graphql(query, variables)'
        ],
        ['upload(file)', 'File upload', 'await nivaro.upload(file)'],
        ['fileUrl(fileId)', 'Get download URL', 'nivaro.fileUrl("file-uuid")'],
        ['setToken(token)', 'Set/clear auth token', 'nivaro.setToken("nvk_...")'],
        ['getToken()', 'Read current token', 'const t = nivaro.getToken()']
      ]
    },
    { type: 'h3', text: 'TypeScript setup' },
    {
      type: 'p',
      text: 'All SDK functions are fully typed. For collection-specific item operations, define your data shape and pass it as a generic:'
    },
    {
      type: 'pre',
      code: `import { readItems, createItem } from '@nivaro/sdk'

interface Article {
  id: string
  name: string
  status: 'draft' | 'published'
  author_id: string
}

const items = await nivaro.request(
  readItems<Article>('articles', { filter: { status: { _eq: 'published' } } })
)
// items.data → Article[]`
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
      text: 'The SDK sends whatever `token` you give it as `Authorization: Bearer`; without one it rides the browser session cookie.'
    },
    {
      type: 'table',
      head: ['Credential', 'Where it comes from', 'Notes'],
      rows: [
        [
          'Named API key `nvk_…`',
          'API Keys page / createApiKey()',
          'Scopes, expiry, IP allowlist, rate limit; sandbox keys never write. Sockets: use a ws-token.'
        ],
        [
          'Static user token',
          'generateToken() / generateUserToken()',
          'Acts as that user; also signs a socket in directly.'
        ],
        [
          'Session cookie',
          'OIDC / SAML / password sign-in in the browser',
          'No token; `credentials: include`. Sockets: use a ws-token.'
        ],
        [
          'View-as token `nvm_…`',
          'An admin’s View-as',
          'Acts as the viewed person; ends with the View-as.'
        ],
        [
          'OAuth access token `nvo_…`',
          'Remote MCP clients (OAuth 2.1)',
          'Accepted on /api/mcp and its tool calls only — never on other routes.'
        ]
      ]
    },
    { type: 'h3', text: 'Static tokens (server-side / CLI)' },
    {
      type: 'p',
      text: 'Use a static API token for automated scripts, cron jobs, and server-to-server communication:'
    },
    {
      type: 'pre',
      code: `import { createNivaro, readItems } from '@nivaro/sdk'

// Set token at creation
const nivaro = createNivaro('https://nivaro.example.com', {
  token: process.env.NIVARO_TOKEN,  // nvk_...
})

// Or set at runtime
nivaro.setToken(process.env.NIVARO_TOKEN)

// Check current token
const hasToken = nivaro.getToken() !== undefined

// Clear token (revert to unauth or session-cookie mode)
nivaro.setToken(null)

// Use the client
const { data: items } = await nivaro.request(readItems('articles'))`
    },
    { type: 'h3', text: 'Session cookies (browser SPA)' },
    {
      type: 'p',
      text: 'In a browser, after a user logs in via the OIDC flow (`/login`), the session cookie is set automatically. The SDK will send it with every request:'
    },
    {
      type: 'pre',
      code: `import { createNivaro } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com')
// No token needed — session cookie is sent automatically

// After login, you can also set a static token if desired
nivaro.setToken(localStorage.getItem('api_token'))`
    },
    { type: 'h3', text: 'Token priority' },
    {
      type: 'ul',
      items: [
        'If a static token is set, it takes priority (Authorization: Bearer header).',
        'Otherwise, the session cookie is sent if available.',
        'If neither exists, requests are made as unauthenticated (limits depend on public routes).'
      ]
    },
    { type: 'h3', text: 'Generate tokens via the API' },
    {
      type: 'pre',
      code: `import { generateToken } from '@nivaro/sdk'

// Generate a new token for yourself
const { data: result } = await nivaro.request(generateToken())
console.log(result.token)  // Show once — never retrievable again

// Store in env var or secure storage
process.env.NIVARO_TOKEN = result.token
nivaro.setToken(result.token)

// Admin: generate token for another user
const { data: other } = await nivaro.request(generateUserToken('user-uuid'))

// Revoke your own token
await nivaro.request(revokeToken())
nivaro.setToken(null)

// Admin: revoke another user's token
await nivaro.request(revokeUserToken('user-uuid'))`
    },
    { type: 'h3', text: 'Session helpers' },
    {
      type: 'pre',
      code: `import { readMe, logout, logoutAll, readWsToken, readAuthProviders } from '@nivaro/sdk'

const { data: me } = await nivaro.request(readMe())
const { data: providers } = await nivaro.request(readAuthProviders())  // public: which sign-ins exist
const { token } = await nivaro.request(readWsToken())   // one-time socket token (2 min)
await nivaro.request(logout())      // end this session (cookie sign-in)
await nivaro.request(logoutAll())   // end every session of mine`
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
      text: 'All REST operations use `await nivaro.request(command)`. Command functions are factories that return a descriptor — no network call happens until `request()` executes it.'
    },
    { type: 'h3', text: 'Read items' },
    {
      type: 'pre',
      code: `import { readItems, readItem } from '@nivaro/sdk'

// List with filtering, sorting, and pagination
const { data, total, limit, offset } = await nivaro.request(
  readItems('articles', {
    filter: {
      status: { _eq: 'published' },
      created_at: { _gte: '2024-01-01' },
    },
    sort: ['-created_at', 'title'],  // descending created_at, then ascending title
    limit: 25,
    offset: 0,
  })
)
// data → T[]

// Search a few fields by relevance, a cached total, relation labels flattened in
const found = await nivaro.request(
  readItems('articles', {
    search: 'pump',
    search_fields: ['title', 'code'],
    search_rank: true,
    count: 'approx',  // or false to skip the count (total → null)
    labels: true,
  })
)

// Keyset paging for walking a large collection
let res = await nivaro.request(readItems('articles', { after: 'start', limit: 500 }))
while (res.next_cursor) res = await nivaro.request(readItems('articles', { after: res.next_cursor, limit: 500 }))

// Single item (optionally projected)
const { data: article } = await nivaro.request(readItem('articles', '123', { fields: ['id', 'title'] }))
// data → T`
    },
    { type: 'h3', text: 'Create items' },
    {
      type: 'pre',
      code: `import { createItem } from '@nivaro/sdk'

const { data: created } = await nivaro.request(
  createItem('articles', {
    title: 'New Article',
    body: 'Lorem ipsum...',
    status: 'draft',
    author_id: 'user-uuid',
  })
)
// data → T (with id, timestamps, and default values filled in)`
    },
    { type: 'h3', text: 'Update items' },
    {
      type: 'pre',
      code: `import { updateItem } from '@nivaro/sdk'

// Partial update — only changed fields
const { data: updated } = await nivaro.request(
  updateItem('articles', '123', {
    status: 'published',
    published_at: new Date().toISOString(),
  })
)
// data → T (full record with updates applied)`
    },
    { type: 'h3', text: 'Delete items' },
    {
      type: 'pre',
      code: `import { deleteItem } from '@nivaro/sdk'

await nivaro.request(deleteItem('articles', '123'))`
    },
    { type: 'h3', text: 'Bulk, batch and rehearsed writes' },
    {
      type: 'p',
      text: 'Every row goes through the items service as the caller — permissions, row filters, User Scopes, validation, hooks and revisions apply row by row; one refused row never fails the others unless you ask for all-or-nothing.'
    },
    {
      type: 'pre',
      code: `import {
  bulkWriteItems, queueBulkWriteItems, readBulkRun, batchItems,
  bulkUpdateItems, bulkDeleteItems, bulkTransitionItems,
  rehearseCreateItem, rehearseUpdateItem, checkItemFilter
} from '@nivaro/sdk'

// Up to 500 rows: a row with an id is an update, without one a create (207, per-row status)
const { data: out } = await nivaro.request(
  bulkWriteItems('articles', [{ title: 'A' }, { id: '124', status: 'published' }])
)
// out.results[i] → { index, op, status, id?, error?, code? }; atomic: true = creates, all or nothing

// Bigger runs in the background, results kept 24 h
const { data: queued } = await nivaro.request(queueBulkWriteItems('articles', rows))
const { data: results } = await nivaro.request(readBulkRun('articles', queued.run_id))

// Up to 100 creates + updates, one result per row
await nivaro.request(batchItems('articles', { create: [{ title: 'B' }], update: [{ id: '9', title: 'C' }] }))

// The same values on several records; a transition on several records; delete several
await nivaro.request(bulkUpdateItems('articles', ['123', '124'], { status: 'published' }))
await nivaro.request(bulkTransitionItems('articles', ['123'], 'transition-uuid', 'Approved'))
await nivaro.request(bulkDeleteItems('articles', ['123', '124']))

// Rehearse: everything runs, nothing is saved
const plan = await nivaro.request(rehearseUpdateItem('articles', '123', { status: 'published' }))
// plan.changes → [{ field, from, to }]; plan.ok / plan.error / plan.code when it would be refused
const check = await nivaro.request(checkItemFilter('articles', { status: { _eq: 'live' } }))`
    },
    { type: 'h3', text: 'Lookups, trash and history' },
    {
      type: 'pre',
      code: `import {
  readItem, readItemBySlug, readItemDistinct, listTrash, restoreTrashItem,
  readOwnerHistory, readCommentCounts
} from '@nivaro/sdk'

const { data: a } = await nivaro.request(readItem('articles', '123', { fields: ['id', 'author.email'] }))
const { data: page } = await nivaro.request(readItemBySlug('pages', 'about-us'))
const { data: statuses } = await nivaro.request(readItemDistinct('articles', 'status'))

// Deleted records (admins: all; everyone else: their own deletions)
const { data: trash } = await nivaro.request(listTrash({ collection: 'articles', days: 30 }))
await nivaro.request(restoreTrashItem(trash[0].id))

const { data: owners } = await nivaro.request(readOwnerHistory('articles', '123'))  // per pipeline state
const { data: counts } = await nivaro.request(readCommentCounts('articles', ['123', '124']))`
    },
    { type: 'h3', text: 'Singletons' },
    {
      type: 'p',
      text: 'For single-record collections (e.g., site settings), use singleton commands:'
    },
    {
      type: 'pre',
      code: `import { readSingleton, updateSingleton } from '@nivaro/sdk'

// Read the singleton record
const { data: settings } = await nivaro.request(readSingleton('site_settings'))

// Update it
const { data: updated } = await nivaro.request(
  updateSingleton('site_settings', { site_name: 'My App', theme: 'dark' })
)`
    },
    { type: 'h3', text: 'Current user' },
    {
      type: 'pre',
      code: `import { readMe, updateMe } from '@nivaro/sdk'

// Get your own profile
const { data: me } = await nivaro.request(readMe())
// me → { id, email, first_name, last_name, role, current_workspace, ... }

// Update your profile
const { data: updated } = await nivaro.request(
  updateMe({ first_name: 'Jane', last_name: 'Doe' })
)`
    },
    { type: 'h3', text: 'Revisions (audit trail)' },
    {
      type: 'pre',
      code: `import { readRevisions, readRevision } from '@nivaro/sdk'

// All changes to an item (newest first, up to 100; no paging)
const { data: revisions } = await nivaro.request(readRevisions('articles', '123'))
// Each revision: { id, action, data, delta, timestamp, user_id, first_name, last_name, comment, event? }

// Single revision detail
const { data: rev } = await nivaro.request(readRevision(revisions[0].id!))
// rev.data → full snapshot at that point in time
// rev.delta → only the fields that changed (for updates)`
    }
  ]
}

export const sdkWorkflow: DocSection = {
  id: 'sdk-workflow',
  label: 'Workflow State Machine',
  content: [
    { type: 'h1', id: 'sdk-workflow', text: 'SDK — Workflow State Machine' },
    {
      type: 'p',
      text: 'Workflows are state machines that control the lifecycle of items. Each transition can be conditional, role-gated, and can trigger automations. Use these commands to read and drive workflow states.'
    },
    { type: 'h3', text: 'Read workflow state' },
    {
      type: 'pre',
      code: `import { readWorkflowInstance, readWorkflowInstances } from '@nivaro/sdk'

// Get full workflow context for an item
const { data: wf } = await nivaro.request(
  readWorkflowInstance('inventory_requests', itemId)
)
// wf === null → no workflow bound to this collection

// If bound:
// wf.instance → { current_state, started_at, completed_at, transitioned_at }
// wf.states → all states with { id, key, label, color, is_initial, is_terminal, lock_record }
// wf.available_transitions → transitions the user's role can execute from current state
// wf.history → immutable log: [{ transitioned_at, from_state, to_state, comment, user }]

// Find current state label
const currentState = wf.states.find(s => s.id === wf.instance.current_state)
console.log(currentState.label)  // e.g., "In Progress"

// List all workflow instances for a collection (admin)
const { data: instances } = await nivaro.request(
  readWorkflowInstances('inventory_requests', { limit: 100 })
)`
    },
    { type: 'h3', text: 'Start and transition workflows' },
    {
      type: 'pre',
      code: `import { startWorkflow, transitionWorkflow } from '@nivaro/sdk'

// Start a workflow on an item (moves to initial state)
await nivaro.request(startWorkflow('inventory_requests', itemId))

// Execute a transition with optional comment
const { data: updated } = await nivaro.request(
  transitionWorkflow('inventory_requests', itemId, transitionId, {
    comment: 'Approved — ready to ship',
  })
)
// updated → full item with updated workflow state

// Check available transitions before showing UI
const { data: wf } = await nivaro.request(
  readWorkflowInstance('inventory_requests', itemId)
)
wf.available_transitions.forEach(tx => {
  // Render a button per transition
  console.log(tx.label, tx.id)
})`
    },
    { type: 'h3', text: 'Conditional transitions' },
    {
      type: 'p',
      text: 'Some transitions have conditions (field values that must match) before they can execute:'
    },
    {
      type: 'pre',
      code: `// Before transitioning, check if conditions are met
const { data: wf } = await nivaro.request(
  readWorkflowInstance('orders', orderId)
)

const transition = wf.available_transitions.find(t => t.id === selectedTxId)

// Attempt transition — if conditions not met, API returns 409
try {
  await nivaro.request(
    transitionWorkflow('orders', orderId, transition.id, { comment: 'Approved' })
  )
} catch (err) {
  if (err.status === 409) {
    console.error('Transition conditions no longer met:', err.message)
  }
}`
    },
    {
      type: 'table',
      head: ['Function', 'Purpose', 'Auth'],
      rows: [
        [
          'readWorkflowInstance(collection, itemId)',
          'Get current state + available transitions',
          'Authenticated'
        ],
        ['startWorkflow(collection, itemId)', 'Initialize workflow on an item', 'Authenticated'],
        [
          'transitionWorkflow(col, itemId, txId, opts?)',
          'Execute a state transition',
          'Role-gated per transition'
        ],
        ['readWorkflowInstances(collection)', 'List all workflow instances', 'Authenticated']
      ]
    }
  ]
}

export const sdkPipeline: DocSection = {
  id: 'sdk-pipeline',
  label: 'Pipeline & Ownership Matrix',
  content: [
    { type: 'h1', id: 'sdk-pipeline', text: 'SDK — Pipeline & Ownership Matrix' },
    {
      type: 'p',
      text: 'The Pipeline Owner Matrix extends workflows with multi-dimensional ownership. It resolves which users own each workflow state based on dimensional rules (e.g., "If region=North and status=urgent, then assign to @jane").'
    },
    { type: 'h3', text: 'Read ownership' },
    {
      type: 'pre',
      code: `import {
  readInstanceOwners, readStateOwners, readAllStateOwners
} from '@nivaro/sdk'

// Get owners for the CURRENT state (primary API)
const { data: owners } = await nivaro.request(
  readInstanceOwners('inventory_requests', itemId)
)
// owners → User[] — { id, email, first_name, last_name, is_inherited }

// Get owners for a SPECIFIC state (non-current)
const { data: result } = await nivaro.request(
  readStateOwners('inventory_requests', itemId, stateId)
)
// result.state → { id, key, label, color }
// result.owners → User[] (resolved via matrix rules)

// Get owners for ALL states at once (no N+1)
const { data: allOwners } = await nivaro.request(
  readAllStateOwners('inventory_requests', itemId)
)
// allOwners → { [stateId]: { state, owners } } | null

// Null means no pipeline bound to collection
if (allOwners) {
  Object.entries(allOwners).forEach(([stateId, { state, owners }]) => {
    console.log(\`\${state.label}: \${owners.map(o => o.first_name).join(', ')}\`)
  })
}`
    },
    { type: 'h3', text: 'Manual ownership overrides' },
    {
      type: 'pre',
      code: `import { addInstanceOwner, removeInstanceOwner } from '@nivaro/sdk'

// Assign a user as an override owner for this item
const { data: owner } = await nivaro.request(
  addInstanceOwner('inventory_requests', itemId, 'user-uuid', {
    state_id: stateId,  // optional: scope to a specific state
  })
)

// Remove an override
await nivaro.request(removeInstanceOwner(owner.id))`
    },
    { type: 'h3', text: 'Admin: Pipeline template configuration' },
    {
      type: 'pre',
      code: `import {
  readPipelineTemplates, readPipelineTemplate,
  readOwnerGroups, readDimensions
} from '@nivaro/sdk'

// List all pipeline templates
const { data: templates } = await nivaro.request(readPipelineTemplates())

// Get one template
const { data: template } = await nivaro.request(readPipelineTemplate(templateId))
// template → { id, name, states: [], binding: { collection }, ... }

// Owner groups per state (configured in admin UI)
const { data: groups } = await nivaro.request(readOwnerGroups(templateId))
// groups[stateId] → OwnerGroup[] with { filters: JSON, priority, users: [] }

// Dimensions for the matrix (region, product, etc.)
const { data: dimensions } = await nivaro.request(readDimensions(templateId))
// dimensions → Dimension[] — { field, label, is_row_axis, sort }`
    },
    { type: 'h3', text: 'How ownership resolution works' },
    {
      type: 'ul',
      items: [
        'Owner Groups are evaluated in priority order (lower = higher priority).',
        'Each group has filter rules (e.g., "region == North AND status == urgent").',
        'First group where ALL filters match assigns its users.',
        'If no rules match, the item has no owner.',
        'Manual Instance Owner overrides always apply (bypass rules).',
        'Delegation via user.delegate_id also applies (temporary out-of-office reassignments).'
      ]
    },
    {
      type: 'table',
      head: ['Function', 'Purpose', 'Auth'],
      rows: [
        ['readInstanceOwners(col, itemId)', 'Owners for current state', 'Authenticated'],
        ['readStateOwners(col, itemId, stateId)', 'Owners for a specific state', 'Authenticated'],
        ['readAllStateOwners(col, itemId)', 'Owners for all states (no N+1)', 'Authenticated'],
        ['addInstanceOwner(col, itemId, userId, opts?)', 'Add manual override', 'Authenticated'],
        ['removeInstanceOwner(ownerId)', 'Remove override', 'Authenticated'],
        ['readPipelineTemplates()', 'List pipeline templates', 'Admin'],
        ['readPipelineTemplate(id)', 'Get one template', 'Admin'],
        ['readOwnerGroups(templateId)', 'Owner groups by state', 'Admin'],
        ['readDimensions(templateId)', 'Matrix dimensions', 'Admin']
      ]
    }
  ]
}

export const sdkForms: DocSection = {
  id: 'sdk-forms',
  label: 'Form Schema',
  content: [
    { type: 'h1', id: 'sdk-forms', text: 'SDK — Form Schema' },
    {
      type: 'p',
      text: 'The Form Schema API aggregates collection metadata, fields, groups, layouts, and relations into one normalized response. Use it to power dynamic UIs, form generators, and headless form runtimes.'
    },
    { type: 'h3', text: 'Load form schema' },
    {
      type: 'pre',
      code: `import { fetchFormSchema } from '@nivaro/sdk'

const { data: schema } = await nivaro.request(fetchFormSchema('inventory_requests'))
// schema → {
//   collection: { id, name, icon, ... },
//   fields: FormField[],
//   groups: FieldGroup[],  // section/tab definitions, sorted
//   relations: RelationMeta[],  // m2o/o2m/m2m/m2a
//   layout: { id, name, tab_mode, ... },
//   ungroupedSort: 5,  // position of Ungrouped zone
// }

// Iterate fields by group
schema.groups.forEach(group => {
  const fieldsInGroup = schema.fields.filter(f => f.group_key === group.key)
  console.log(group.label, fieldsInGroup.map(f => f.label))
})`
    },
    { type: 'h3', text: 'Evaluate field rules in real-time' },
    {
      type: 'pre',
      code: `import { evaluateFieldRules } from '@nivaro/sdk'

// As the user types, evaluate inline field rules (no save)
const values = { category: 'hardware', vendor: null }
const { data: result } = await nivaro.request(
  evaluateFieldRules('inventory_requests', values)
)
// result.updates → { priority: 'high' }  (only changed fields)

// Apply rule updates to form state
setValues({ ...values, ...result.updates })`
    },
    { type: 'h3', text: 'Load relation options (picker)' },
    {
      type: 'pre',
      code: `import { readRelationOptions } from '@nivaro/sdk'

// Load options for an M2O or M2M field picker
const { data: options } = await nivaro.request(
  readRelationOptions('inventory_requests', 'assigned_to', {
    search: 'jane',  // filter by search term
    limit: 25,
  })
)
// options → { value, label }[]  (label from display template)

// Render picker
options.forEach(opt => console.log(\`\${opt.label} (\${opt.value})\`))`
    },
    { type: 'h3', text: 'Submit form item' },
    {
      type: 'pre',
      code: `import { submitFormItem } from '@nivaro/sdk'

// Create new item
const { data: created } = await nivaro.request(
  submitFormItem('inventory_requests', {
    mode: 'create',
    values: {
      title: 'New Request',
      category: 'hardware',
      priority: 'high',
    },
  })
)

// Update existing
const { data: updated } = await nivaro.request(
  submitFormItem('inventory_requests', {
    mode: 'edit',
    itemId: '123',
    values: { status: 'approved' },  // partial update
  })
)`
    },
    { type: 'h3', text: 'Form field shape' },
    {
      type: 'table',
      head: ['Property', 'Type', 'Description'],
      rows: [
        ['key', 'string', 'Field name (used in values/updates).'],
        ['label', 'string', 'Display name.'],
        ['type', 'string', 'text | number | boolean | date | select | etc.'],
        ['interface', 'string', 'UI hint: text-input | textarea | toggle | date-picker.'],
        ['required', 'boolean', 'If true, value must be provided.'],
        ['sort', 'number | null', 'Display order within group.'],
        ['hidden', 'boolean', 'If true, hidden from UI but readable via API.'],
        ['validation_rules', 'Rule[]', 'Constraints: min_length, pattern, unique, etc.'],
        ['visibility_rules', 'Rule[]', 'Show/hide based on other field values.'],
        ['lock_condition', 'Rule[]', 'Make read-only based on field values.'],
        ['computed_formula', 'string | null', 'If set, field is auto-calculated (read-only).']
      ]
    },
    {
      type: 'table',
      head: ['Command', 'Purpose'],
      rows: [
        ['fetchFormSchema(collection)', 'Load full schema + layout + relations'],
        [
          'evaluateFieldRules(collection, values)',
          'Server-evaluate rules against values (no save)'
        ],
        [
          'readRelationOptions(collection, field, opts?)',
          'Get picker options for a relation field'
        ],
        ['submitFormItem(collection, { mode, itemId?, values })', 'Create or update via form']
      ]
    },
    {
      type: 'note',
      text: 'Form Schema uses **snake_case** (`validation_rules`, `visibility_rules`, `computed_formula`). The `@nivaro/react` package wraps these in **camelCase** (`validationRules`) for React — do not mix the two APIs.'
    }
  ]
}

export const sdkReact: DocSection = {
  id: 'sdk-react',
  label: 'React (@nivaro/react)',
  content: [
    { type: 'h1', id: 'sdk-react', text: 'SDK — React (@nivaro/react)' },
    {
      type: 'p',
      text: '`@nivaro/react` is a form runtime built on `@nivaro/sdk`. One hook (`useNivaroForm`) handles schema loading, field rules, visibility/lock evaluation, relation options, validation, and submit. Pair it with your own inputs (headless) or use `<NivaroForm>` for auto-rendering fields.'
    },
    { type: 'h3', text: 'Installation' },
    {
      type: 'pre',
      code: `pnpm add @nivaro/react @nivaro/sdk react react-dom @tanstack/react-query sonner`
    },
    { type: 'h3', text: 'Styling' },
    {
      type: 'p',
      text: 'The styled components (`ItemEditForm`, `QueueWorklist`, panels, sheets) are built with Tailwind. Two ways to get their styles — pick one:'
    },
    {
      type: 'p',
      text: '**Option A — precompiled CSS (simplest, no Tailwind required).** One import, works in any app:'
    },
    {
      type: 'pre',
      code: `// app entry
import '@nivaro/react/full.css'`
    },
    {
      type: 'p',
      text: '**Option B — Tailwind v3 preset.** If your app already runs Tailwind 3 and you want one utility pipeline (no duplicated classes):'
    },
    {
      type: 'pre',
      code: `// tailwind.config.js
module.exports = {
  presets: [require('@nivaro/react/tailwind-preset')],
  content: [
    './src/**/*.{ts,tsx}',
    './node_modules/@nivaro/react/dist/**/*.js'
  ]
}

// app entry
import '@nivaro/react/styles.css'`
    },
    {
      type: 'p',
      text: 'The preset supplies the theme tokens (`nvr-cyan`, semantic color vars, radius, type scale) and the animate plugin; `styles.css` supplies the CSS variables plus class-based dark-mode overrides. Tailwind v4 configs ignore `tailwind.config.js` presets — use Option A there. Dark mode in both options: `dark` class on `<html>`. The headless `useNivaroForm` API needs neither.'
    },
    { type: 'h3', text: 'Setup' },
    {
      type: 'p',
      text: 'Wrap your app in `<NivaroProvider>` with a configured SDK client. It provides a TanStack Query `QueryClient` automatically when your app does not already run a `QueryClientProvider` — if you do, yours wins.'
    },
    { type: 'h3', text: 'Item links in embedded apps' },
    {
      type: 'p',
      text: 'Components like `QueueWorklist` open records at the admin route shape (`/collections/:collection/:id`) by default. When embedding in your own app, override link handling on `NavigationContext`:'
    },
    {
      type: 'pre',
      code: `import { NavigationContext } from '@nivaro/react'

<NavigationContext.Provider
  value={{
    navigate: (to) => router.push(to),
    // Map record links onto YOUR routes (row clicks, Open buttons, Work Next):
    itemUrl: ({ collection, itemId, layoutSlug }) =>
      \`/records/\${collection}/\${itemId}\${layoutSlug ? \`?layout=\${layoutSlug}\` : ''}\`,
    // Or intercept opening entirely (return true = handled — e.g. open your own drawer):
    openItem: ({ collection, itemId }) => {
      openMyDetailDrawer(collection, itemId)
      return true
    }
  }}
>`
    },
    {
      type: 'p',
      text: '`openItem` is checked first; returning `true` skips navigation. Otherwise the component navigates to `itemUrl(target)`, falling back to the admin shape when neither is provided.'
    },
    { type: 'h3', text: 'Page renderer' },
    {
      type: 'p',
      text: '`<PageRenderer slug="…" />` renders a page-builder page (widget grid) in your own app — the same surface as the admin\'s `/p/:slug` viewer: table, KPI, markdown, iframe, recent-activity, query tables (param filters, progress columns, row-click picker/drill/matrix sheets), matrix editors (inline or drawer-button), and record grids (`record-grid` — flat rows, or `browse: true` for header key pickers with roll-up totals until every key is chosen). Widget data resolves through the client identity, so permissions apply server-side. Requires `NivaroProvider` + a TanStack Query `QueryClientProvider`; supply `NavigationContext` to control where record links go, and an outer `DrilldownContext` if you host your own record sheet (PageRenderer hosts one otherwise).'
    },
    {
      type: 'pre',
      code: `import { NivaroProvider, PageRenderer } from '@nivaro/react'

<NivaroProvider client={nivaro}>
  <PageRenderer slug="budget-allocation" />
</NivaroProvider>

// Props: slug (required), hideHeader (skip the page-name row), className`
    },
    { type: 'h3', text: 'Report Studio viewer' },
    {
      type: 'p',
      text: '`<ReportView reportId="…" />` renders a fully-styled, interactive Report Studio report in your own app — same as `QueueWorklist` / `ItemEditForm`: bring the styles via `@nivaro/react/full.css` (or the Tailwind preset). It fetches the definition and resolves every widget (KPIs, KPI groups, bar/line/donut charts via recharts, tables) as the client identity — collection read permissions apply server-side. Interactive: a global filter bar (date-range switcher + live entity-filter chips) and per-widget refresh. Read-only (no drag/resize edit surface).'
    },
    {
      type: 'pre',
      code: `import { NivaroProvider, ReportView } from '@nivaro/react'

<ReportView
  reportId="…"
  refetchInterval={60_000}          // live-refresh; omit for one-shot
  showFilterBar                              // date range + entity chips (default true)
  dateRange={{ preset: 'last_3_months' }}    // override the saved range (optional)
  initialEntityFilters={[{ field: 'division', values: [1, 2] }]}
/>`
    },
    {
      type: 'p',
      text: 'For custom rendering, skip the component and drive the data commands directly: `readReport`, `readReportWidgetData` / `previewReportWidget`, plus the full CRUD, subscription (`setReportSubscription`), alert (`createReportAlert`), and AI (`aiBuildReport`, `aiReportFilters`) surface from `@nivaro/sdk`.'
    },
    {
      type: 'pre',
      code: `import { createNivaro } from '@nivaro/sdk'
import { NivaroProvider } from '@nivaro/react'

const nivaro = createNivaro('https://nivaro.example.com', { token: '...' })

export function App() {
  return (
    <NivaroProvider client={nivaro}>
      <Routes>
        <Route path="/requests/new" element={<CreateRequestForm />} />
        <Route path="/requests/:id/edit" element={<EditRequestForm />} />
      </Routes>
    </NivaroProvider>
  )
}`
    },
    { type: 'h3', text: 'useNivaroForm hook' },
    {
      type: 'pre',
      code: `import { useNivaroForm } from '@nivaro/react'

function CreateRequestForm() {
  const form = useNivaroForm('inventory_requests', {
    mode: 'create',
    defaultValues: { priority: 'medium', status: 'draft' },
    onSuccess: (item) => navigate(\`/requests/\${item.id}\`),
    onError: (err) => toast.error(err.message),
  })

  return (
    <form onSubmit={form.handleSubmit}>
      <input
        type="text"
        value={form.values.title}
        onChange={(e) => form.setValue('title', e.target.value)}
      />
      {form.errors.title && <p>{form.errors.title}</p>}

      <select
        value={form.values.priority}
        onChange={(e) => form.setValue('priority', e.target.value)}
        disabled={form.isLocked('priority')}
      >
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>

      <button type="submit" disabled={!form.isValid || form.isSubmitting}>
        {form.isSubmitting ? 'Saving...' : 'Create'}
      </button>
    </form>
  )
}`
    },
    { type: 'h3', text: 'Hook return shape' },
    {
      type: 'table',
      head: ['Property', 'Type', 'Description'],
      rows: [
        ['values', 'Record<string, unknown>', 'Current form values.'],
        ['errors', 'Record<string, string>', 'Validation errors (empty when valid).'],
        ['isValid', 'boolean', 'Whether all fields pass validation.'],
        ['isDirty', 'boolean', 'Whether any field differs from initial values.'],
        ['isLoading', 'boolean', 'Schema loading in progress.'],
        ['isSubmitting', 'boolean', 'Form submission in progress.'],
        ['setValue(field, value)', 'void', 'Update one field; re-runs rules/visibility.'],
        ['handleSubmit(e?)', 'void', 'Validate + submit; fires onSuccess/onError.'],
        ['reset(values?)', 'void', 'Reset to initial or new values.'],
        ['isVisible(field)', 'boolean', 'Whether field passes visibility rules.'],
        ['isLocked(field)', 'boolean', 'Whether field is read-only.'],
        ['schema', 'FormSchema', 'Full schema (camelCase: fieldType, validationRules).'],
        ['fieldsByGroup', 'Record<string, Field[]>', 'Fields bucketed by group key.'],
        ['visibleGroups', 'Group[]', 'Groups with at least one visible field.']
      ]
    },
    { type: 'h3', text: 'Auto-render form' },
    {
      type: 'pre',
      code: `import { NivaroForm } from '@nivaro/react'

function AutoForm() {
  return (
    <NivaroForm
      collection="inventory_requests"
      mode="create"
      onSuccess={(item) => navigate(\`/requests/\${item.id}\`)}
    />
  )
}
// <NivaroForm> auto-renders all fields, groups, and validation.`
    },
    {
      type: 'note',
      text: '`@nivaro/react` uses **camelCase** (`fieldType`, `validationRules`, `visibilityRules`) — different from the SDK Form Schema snake_case. This is intentional for React conventions. Do not mix the two APIs.'
    }
  ]
}

export const sdkReactLayout: DocSection = {
  id: 'sdk-react-layout',
  label: 'React — Layout Hooks',
  content: [
    { type: 'h1', id: 'sdk-react-layout', text: 'SDK — React Layout Hooks (@nivaro/react)' },
    {
      type: 'p',
      text: 'These hooks work alongside `useNivaroForm` and require a form returned by that hook. They expose the active collection layout (tabs, sections, col_span grid, ungrouped zone position) plus field-level state, dirty tracking, and repeater management. Import all hooks from `@nivaro/react`.'
    },
    {
      type: 'note',
      text: '`FormSchema` now includes `ungroupedSort: number | null` — the configured position of the Ungrouped zone relative to named groups. `fetchFormSchema` and `useFormSchema` fetch this automatically from the active layout endpoint; no extra call is needed.'
    },
    {
      type: 'table',
      head: ['Export', 'Kind', 'Purpose'],
      rows: [
        [
          'LayoutForm',
          'Component',
          'Full layout-aware auto-renderer (tabs, sections, col_span grid, ungrouped zone).'
        ],
        [
          'useOrderedLayout(form)',
          'Hook',
          'Ordered list of groups + `__ungrouped__` sentinel, reflecting `ungroupedSort`.'
        ],
        [
          'useTabState(form)',
          'Hook',
          'Active tab + setter + tabs list; `hasTabs` false when layout has no tab groups.'
        ],
        [
          'useSectionState(form, defaultCollapsed?)',
          'Hook',
          'Per-section collapse state; `toggle`, `collapseAll`, `expandAll`.'
        ],
        [
          'useFieldState(form, field)',
          'Hook',
          'value, error, visible, locked, required, colSpan, descriptor, onChange for one field.'
        ],
        [
          'useWatchFields(form, fields[])',
          'Hook',
          'Reactive Record<string, unknown> slice — re-renders only when watched values change.'
        ],
        [
          'useFormDirty(form, initialValues?)',
          'Hook',
          'isDirty, dirtyFields[], isFieldDirty(field) — compares against initial or mounted values.'
        ],
        [
          'useFormStatus(form)',
          'Hook',
          'isDirty, isValid, isSubmitting, isLoading, canSubmit — one-stop status object.'
        ],
        [
          'useFieldArray(form, field)',
          'Hook',
          'append, remove, move, update, replace for ordered repeater rows.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'All layout hooks read the same `form` object returned by `useNivaroForm`. They do not create extra network requests — schema and layout data are fetched once by the hook and shared.'
    }
  ]
}

export const sdkReactLive: DocSection = {
  id: 'sdk-react-live',
  label: 'React — Live Data',
  content: [
    { type: 'h1', id: 'sdk-react-live', text: 'SDK — React Live Data (@nivaro/react)' },
    {
      type: 'p',
      text: "`useLiveRecord` and `useLiveList` are react-query reads that stay current. When the host mounts a realtime adapter, other people's writes are patched into the cached data in place; without one (or while the socket reconnects) the read polls instead. Nothing to wire by hand: no socket events, no invalidation."
    },
    { type: 'h2', id: 'sdk-react-live-adapter', text: 'Connect the socket once' },
    {
      type: 'p',
      text: '`createSocketRealtime` turns the Socket.io connection your app already holds into the adapter every live surface reads (`RealtimeContext`). Your app keeps owning the socket: it connects, sends `auth {token}` and its `client:hello`. The adapter joins and leaves collection rooms, admin watch rooms and live operations topics (reference counted), joins them again after every reconnect, replays missed events, and raises the same window events the admin app does (`nvr:catchup-full`, `nvr:access-changed`, `nvr:config-update`, `nvr:force-refresh`).'
    },
    {
      type: 'pre',
      code: `import { io } from 'socket.io-client'
import { createSocketRealtime, RealtimeContext } from '@nivaro/react'

const socket = io(API_URL, { transports: ['websocket', 'polling'], withCredentials: true })
socket.on('connect', async () => socket.emit('auth', { token: await wsToken() }))

// Once, at module level — the adapter is shared by every component.
const realtime = createSocketRealtime({ socket })

<NivaroProvider client={client}>
  <RealtimeContext.Provider value={realtime}>
    <App />
  </RealtimeContext.Provider>
</NivaroProvider>`
    },
    {
      type: 'note',
      text: 'Shared components (My Work, Notes, tasks, record pages, collection lists, queues) read the same context, so mounting the adapter makes them live too. Set `windowEvents: { forceRefresh: false }` (or another key) when your app already raises that window event itself.'
    },
    { type: 'h2', id: 'sdk-react-live-record', text: 'useLiveRecord' },
    {
      type: 'pre',
      code: `const { data: order, deleted, live, isLoading } = useLiveRecord('orders', id, {
  fields: ['title', 'status', 'customer.name']
})
if (deleted) return <p>This order was deleted.</p>`
    },
    {
      type: 'p',
      text: 'With an explicit `fields` list a change re-reads only the requested fields it touched (`customer` changed → `customer.name` is read again) and merges them into the cached record; a change to a field you did not ask for costs no request. Without `fields` the whole record is re-read, because a virtual computed field may depend on any column. `data` is null when the record does not exist or the viewer cannot read it.'
    },
    { type: 'h2', id: 'sdk-react-live-list', text: 'useLiveList' },
    {
      type: 'pre',
      code: `const { data: page, live } = useLiveList('orders', {
  filter: { status: { _eq: 'open' } },
  sort: ['-created_at'],
  fields: ['title', 'status'],
  limit: 25
})`
    },
    {
      type: 'table',
      head: ['Someone else…', 'What the list does'],
      rows: [
        [
          'changes a row on the page',
          "Re-reads that row as the viewer under the list's own filter and search, and patches it in place."
        ],
        [
          'changes a row so it no longer matches',
          'The re-read returns nothing, so the row leaves (a paged list refetches to fill the gap).'
        ],
        [
          'creates or changes a record so it now matches',
          "Refetches the page quietly; where it belongs in the sort order is the server's to decide."
        ],
        [
          'changes a sort field of a row on the page',
          'Refetches the page (the order may have moved).'
        ],
        ['deletes a row on the page', 'Drops it from the cached page.'],
        ['runs a bulk or raw write', 'Refetches the page quietly.'],
        [
          'changes a record the filter cannot see',
          'Nothing: an update that touches no field the filter reads cannot bring a record in.'
        ]
      ]
    },
    {
      type: 'table',
      head: ['Option', 'Default', 'Meaning'],
      rows: [
        ['enabled', 'true', 'Pause the read and the live feed.'],
        ['pollMs', '30000', 'Poll interval while there is no live socket (0 = never).'],
        ['safetyPollMs', 'none', 'A slow poll while the socket is live.'],
        ['debounceMs', '250', 'Events inside this window are handled as one patch.'],
        [
          'includeOwn',
          'false',
          "Also react to this tab's own writes (a save never echoes back by default)."
        ],
        ['fields (useLiveRecord)', 'all', 'Fields to read; enables the partial re-read.']
      ]
    },
    {
      type: 'note',
      text: "The socket only says THAT a record changed (its id, the action and the changed field names). Values always come from a fresh read through the viewer's own permission-checked `/items` route, so row filters, User Scopes and field policies apply exactly as on the first load. A list read always carries `id` (it is added to an explicit `fields` list) so rows can be matched to events. Changes to a related record (a filter on `customer.region`) do not reach a list of orders; pass `safetyPollMs` when that matters."
    },
    {
      type: 'p',
      text: 'Query keys are `liveRecordKey(collection, id, fields)` and `liveListKey(collection, query)` — invalidate them yourself after a write if you set `includeOwn: false` and want the list re-sorted at once.'
    }
  ]
}

export const sdkNotifications: DocSection = {
  id: 'sdk-notifications',
  label: 'Notifications & Inbox',
  content: [
    { type: 'h1', id: 'sdk-notifications', text: 'SDK — Notifications & Inbox' },
    {
      type: 'p',
      text: "Read and work the caller's own inbox. Notifications are created by rules, pipelines, comments (@mentions), alerts and people. Every command acts on the caller's own rows only."
    },
    {
      type: 'pre',
      code: `import {
  listNotifications, readUnreadNotificationCount,
  markNotificationRead, markNotificationsRead, markAllNotificationsRead, deleteNotification
} from '@nivaro/sdk'

// One page of the inbox (default 50, max 200). Filters match the notification center's own.
const page = await nivaro.request(
  listNotifications({ page: 1, limit: 50, lane: 'attention', search: 'invoice', unread: true })
)
// page.data → NotificationItem[]; page.pinned → acknowledgement-required rows (page 1)
// status: 'inbox' | 'read' | 'archived' | 'all'; snoozed: true lists only sleeping rows

// Badge figures, split by lane
const counts = await nivaro.request(readUnreadNotificationCount())
// → { unread: 5, attention: 3, lanes: { critical, needs_you, fyi } }

await nivaro.request(markNotificationRead(id))
await nivaro.request(markNotificationsRead([id1, id2]))
await nivaro.request(markAllNotificationsRead())
await nivaro.request(deleteNotification(id))`
    },
    { type: 'h3', text: 'Snooze, acknowledge, bulk actions, mutes' },
    {
      type: 'pre',
      code: `import {
  snoozeNotification, acknowledgeNotification, bulkNotificationAction,
  archiveReadNotifications, listSentNotifications, readRecordMute, toggleRecordMute
} from '@nivaro/sdk'

await nivaro.request(snoozeNotification(id, { until: '2026-11-02T09:00:00Z' }))
await nivaro.request(snoozeNotification(id, { untilChange: true }))  // wake when the record moves
await nivaro.request(acknowledgeNotification(id))  // when the sender asked for an acknowledgement

// One action over explicit ids (≤1000) or everything matching a filter (≤2000)
await nivaro.request(bulkNotificationAction({ action: 'archive', filter: { status: 'read', lane: 'fyi' } }))
await nivaro.request(archiveReadNotifications(30))  // read rows older than 30 days

// What I sent, with each recipient's read / acknowledgement state
const { data: sent } = await nivaro.request(listSentNotifications({ lane: 'all' }))

// Mute one record's notifications for me
const { data: mute } = await nivaro.request(toggleRecordMute('orders', 42))  // { muted: true }`
    },
    { type: 'h3', text: 'Delivery history and reminders' },
    {
      type: 'pre',
      code: `import { readNotificationHistory, listReminders, createReminder, deleteReminder } from '@nivaro/sdk'

// What actually reached me: in-app rows, alert firings, report alerts, digest-queued emails
const { data: history } = await nivaro.request(readNotificationHistory(80))
// history[i] → { kind, at, title, detail, collection?, item?, status?, channels: ['in-app', 'push'] }

const { data: r } = await nivaro.request(createReminder({ note: 'Call vendor', remind_at: '2026-11-03T14:00:00Z' }))
const { data: mine } = await nivaro.request(listReminders())
await nivaro.request(deleteReminder(r.id))`
    },
    { type: 'h3', text: 'Live notifications' },
    {
      type: 'pre',
      code: `import { createRealtime, NOTIFICATIONS_CHANNEL, readWsToken } from '@nivaro/sdk'

const rt = createRealtime()
rt.connect('https://nivaro.example.com', () => nivaro.request(readWsToken()).then((r) => r.token))

// notification:new for the signed-in person
rt.subscribe(NOTIFICATIONS_CHANNEL, {}, ([notif]) => console.log('New notification', notif))`
    }
  ]
}

export const sdkActivity: DocSection = {
  id: 'sdk-activity',
  label: 'Activity & Revisions',
  content: [
    { type: 'h1', id: 'sdk-activity', text: 'SDK — Activity, Revisions & Logs' },
    {
      type: 'p',
      text: 'The audit log records every change and notable action; revisions are a record\'s own history; the change feed, request log, job runs and mail log answer "what happened" from the API itself. Reads of the system-wide logs are for administrators.'
    },
    { type: 'h3', text: 'Audit log (administrators)' },
    {
      type: 'pre',
      code: `import { readActivity, readActivityEntry, listActivityActions, logExport } from '@nivaro/sdk'

// Newest first; limit default 25, max 200
const { data: entries, total } = await nivaro.request(
  readActivity({ collection: 'orders', action: 'update', user: 'user-uuid', limit: 50 })
)
// entries[i] → { id, action, collection, item, user, timestamp, ip, comment, origin,
//                first_name, last_name, user_email, via_agent }

const { data: entry } = await nivaro.request(readActivityEntry(entries[0].id))  // + user_agent
const { data: actions } = await nivaro.request(listActivityActions())  // every action in the log

// Anyone signed in: report an export made in the browser (an \`export\` audit row)
await nivaro.request(logExport({ collection: 'orders', row_count: 120, format: 'csv' }))`
    },
    { type: 'h3', text: 'Revisions (a record’s history)' },
    {
      type: 'pre',
      code: `import { readRevisions, readRevision, readLatestRevisionId, rollbackRevision } from '@nivaro/sdk'

// Newest first: up to 100 revisions plus folded pipeline moves and O2M child events.
// Same gate as opening the record; snapshots are cut to the fields you may read. No paging.
const { data: revisions } = await nivaro.request(readRevisions('orders', 42))
for (const rev of revisions) {
  if (rev.event) console.log('moved', rev.event.from_label, '→', rev.event.to_label)
  else console.log(rev.action, 'by', rev.first_name, 'changed', Object.keys(rev.delta ?? {}))
}

const { data: rev } = await nivaro.request(readRevision(revisions[0].id!))
const { data: latest } = await nivaro.request(readLatestRevisionId('orders', 42))  // { latest }
await nivaro.request(rollbackRevision(rev.id!))  // through the items service, as you`
    },
    { type: 'h3', text: 'Change feed' },
    {
      type: 'pre',
      code: `import { readChanges } from '@nivaro/sdk'

// Ids, actions and changed field NAMES only, for records you can see now
let page = (await nivaro.request(readChanges({ since: '2026-10-29T12:00:00Z', collections: ['orders'] }))).data
while (page.has_more) page = (await nivaro.request(readChanges({ cursor: page.cursor }))).data
// keep page.cursor and call again later for what changed since`
    },
    { type: 'h3', text: 'API request log, key usage, jobs and mail (administrators)' },
    {
      type: 'pre',
      code: `import {
  listApiRequests, readApiAnalyticsByKey, readApiKeyUsage, readApiKeyMonthlyUsage,
  listJobRuns, readJobRunLog, cancelJobRun, readBusyJobs,
  listMailLog, readMailLogEntry, resendMail, listRecordMail
} from '@nivaro/sdk'

const { data: failures } = await nivaro.request(listApiRequests({ status: '5xx', hours: 6 }))
const { data: byKey } = await nivaro.request(readApiAnalyticsByKey(24))
const { data: usage } = await nivaro.request(readApiKeyUsage(keyId))          // last 30 days
const csv = await nivaro.request(readApiKeyMonthlyUsage(keyId, '2026-10', 'csv'))

const { data: runs } = await nivaro.request(listJobRuns({ status: 'error' }))
const { data: log } = await nivaro.request(readJobRunLog(runs[0].id))        // { run, lines }
const { data: busy } = await nivaro.request(readBusyJobs())

const { data: mails } = await nivaro.request(listMailLog({ status: 'failed' }))
await nivaro.request(resendMail(mails[0].id))
// Anyone who can read the record: the mail sent about it (headers only)
const { data: recordMail } = await nivaro.request(listRecordMail('orders', 42))`
    },
    { type: 'h3', text: 'Your own jobs and background reads' },
    {
      type: 'pre',
      code: `import { listMyJobs, startBackgroundRun, readBackgroundRun, readBackgroundRunResult } from '@nivaro/sdk'

const { data: jobs } = await nivaro.request(listMyJobs())  // running or finished in the last 30 min

// Hand a slow read to the server; it is replayed as you
const { data: run } = await nivaro.request(
  startBackgroundRun({ method: 'POST', url: '/api/custom-queries/q/execute', body: { params: {} } })
)
const { data: now } = await nivaro.request(readBackgroundRun(run.id))
if (now.status === 'completed') console.log(await nivaro.request(readBackgroundRunResult(run.id)))`
    },
    {
      type: 'note',
      text: 'Every API answer carries an `x-nivaro-request-id` header — the id the slow-trace buffer, the access log and the request log share. The client puts it on `NivaroError.requestId` and on the `onResponse` hook (see Setup). A cross-origin browser call can only read it when the API exposes the header through CORS.'
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
      text: 'Use `nivaro.graphql()` to send typed GraphQL queries and mutations. The method throws on errors — no need to check `response.errors` manually. Uses the same auth (token/cookie) as REST.'
    },
    { type: 'h3', text: 'Queries' },
    {
      type: 'pre',
      code: `import { createNivaro } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com', { token: '...' })

interface ArticlesResult {
  articles: {
    data: Array<{ id: string; name: string; status: string; author_id: string }>
    total: number
  }
}

const result = await nivaro.graphql<ArticlesResult>(\`
  query {
    articles(filter: { status: { _eq: "active" } }, limit: 10) {
      data { id name status author_id }
      total
    }
  }
\`)

result.articles.data.forEach(article => {
  console.log(\`\${article.name} by author \${article.author_id}\`)
})`
    },
    { type: 'h3', text: 'Queries with variables' },
    {
      type: 'pre',
      code: `interface ArticlesResult {
  articles: { data: Article[]; total: number }
}

const result = await nivaro.graphql<ArticlesResult>(
  \`query GetArticles($filter: JSON, $limit: Int) {
    articles(filter: $filter, limit: $limit) {
      data { id name status }
      total
    }
  }\`,
  {
    filter: { status: { _eq: 'active' }, created_at: { _gte: '2024-01-01' } },
    limit: 25,
  },
  'GetArticles'  // optional operationName (for debugging)
)`
    },
    { type: 'h3', text: 'Mutations' },
    {
      type: 'pre',
      code: `interface CreateArticleResult {
  createArticle: { id: string; name: string; status: string }
}

const result = await nivaro.graphql<CreateArticleResult>(\`
  mutation CreateArticle($name: String!, $status: String) {
    createArticle(data: { name: $name, status: $status }) {
      id name status
    }
  }
\`,
  { name: 'New Article', status: 'draft' }
)

console.log('Created:', result.createArticle.id)`
    },
    { type: 'h3', text: 'Subscriptions' },
    {
      type: 'pre',
      code: `// GraphQL subscriptions require a separate WebSocket transport
// Use the Socket.io realtime client instead — it's simpler and handles reconnection

import { createRealtime, readWsToken } from '@nivaro/sdk'

const rt = createRealtime()
rt.connect('https://nivaro.example.com', () => nivaro.request(readWsToken()).then((r) => r.token))

rt.subscribe('articles', { event: 'update' }, (changes) => {
  console.log('Articles changed:', changes.map((c) => c.item))
})`
    },
    {
      type: 'table',
      head: ['Method', 'Purpose'],
      rows: [
        ['nivaro.graphql(query, variables?, operationName?)', 'Send a GraphQL query or mutation'],
        ['nivaro.setToken(token)', 'Set auth token (shared with REST)']
      ]
    },
    {
      type: 'note',
      text: 'The GraphQL schema is auto-generated from your collections, fields, and relations at startup. View the full schema at `/graphql` in the admin UI.'
    }
  ]
}

export const sdkTokens: DocSection = {
  id: 'sdk-tokens',
  label: 'API Keys & Token Management',
  content: [
    { type: 'h1', id: 'sdk-tokens', text: 'SDK — API Keys & Token Management' },
    {
      type: 'p',
      text: 'Generate, revoke, and manage static API tokens programmatically. Tokens are prefixed with `nvk_` and can have custom scopes, expiry dates, and IP allowlists.'
    },
    { type: 'h3', text: 'Generate token for yourself' },
    {
      type: 'pre',
      code: `import { generateToken, revokeToken } from '@nivaro/sdk'

// Generate a new token
const { data: result } = await nivaro.request(generateToken())
// result.token → "nvk_abc123..." (shown only once!)

// Use it immediately or store in secure location
console.log('Save this token:', result.token)
nivaro.setToken(result.token)

// Later: revoke it
await nivaro.request(revokeToken())`
    },
    { type: 'h3', text: 'Admin: Generate token for another user' },
    {
      type: 'pre',
      code: `import { generateUserToken, revokeUserToken } from '@nivaro/sdk'

// Generate token for a user (admin only)
const { data } = await nivaro.request(generateUserToken('user-uuid'))
console.log('Token for user:', data.token)

// Revoke it
await nivaro.request(revokeUserToken('user-uuid'))`
    },
    { type: 'h3', text: 'Token configuration (API keys admin page)' },
    {
      type: 'p',
      text: 'When creating a token in the admin UI, you can configure:'
    },
    {
      type: 'table',
      head: ['Setting', 'Description', 'Example'],
      rows: [
        ['Scopes', 'What the token can do (read, write, admin)', '["read:all", "write:articles"]'],
        ['Expires at', 'Expiry datetime (optional)', '2025-12-31T23:59:59Z'],
        ['IP allowlist', 'Restrict to specific IPs (optional)', '["203.0.113.0", "203.0.113.1"]'],
        ['Rate limit', 'Requests per minute (optional)', '100']
      ]
    },
    {
      type: 'warn',
      text: 'Token values are only returned in the API response once. After you leave the page or close the dialog, the value cannot be retrieved. Copy it to a password manager or secure store immediately.'
    },
    {
      type: 'note',
      text: 'All tokens are stored as sha256 hashes in the database — the plaintext is never persisted. Use `setToken()` to set the SDK token at runtime.'
    }
  ]
}

export const sdkFiles: DocSection = {
  id: 'sdk-files',
  label: 'Files & Upload',
  content: [
    { type: 'h1', id: 'sdk-files', text: 'SDK — Files & Upload' },
    {
      type: 'p',
      text: 'Upload files to the Nivaro file manager and get URLs for serving them. Files are stored locally by default; configure S3 or other providers in settings.'
    },
    { type: 'h3', text: 'Upload a file' },
    {
      type: 'pre',
      code: `import { createNivaro } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com', { token: '...' })

// From a file input
const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const file = fileInput.files![0]

const result = await nivaro.upload(file, {
  title: 'Q2 Report',  // optional: display name
  folder: 'folder-uuid-here',  // optional: folder ID
})

// result → FileUploadResult
console.log('Uploaded:', result.id, result.filesize, 'bytes')`
    },
    { type: 'h3', text: 'Get file URL' },
    {
      type: 'pre',
      code: `// Generate a download URL
const url = nivaro.fileUrl(fileId)
// url → https://nivaro.example.com/api/files/<id>/content

// Display in an img tag
<img src={url} alt="Report" />

// Or link for download
<a href={url} download>Download Report</a>`
    },
    { type: 'h3', text: 'FileUploadResult shape' },
    {
      type: 'table',
      head: ['Field', 'Type', 'Description'],
      rows: [
        ['id', 'string', 'UUID primary key (use for fileUrl).'],
        ['filename_disk', 'string', 'Hashed filename on disk (for deduplication).'],
        ['filename_download', 'string', 'Original filename from upload.'],
        ['title', 'string | null', 'Custom display title.'],
        ['type', 'string', 'MIME type, e.g. "image/png", "application/pdf".'],
        ['filesize', 'number', 'File size in bytes.'],
        ['width', 'number | null', 'Image width in pixels (images only).'],
        ['height', 'number | null', 'Image height in pixels (images only).'],
        ['folder', 'string | null', 'Folder ID, or null if in root.'],
        ['uploaded_on', 'string', 'ISO 8601 upload timestamp.']
      ]
    },
    { type: 'h3', text: 'Usage in forms' },
    {
      type: 'pre',
      code: `// Upload and store file ID in a field
async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0]
  if (!file) return

  const uploaded = await nivaro.upload(file)
  form.setValue('attachment_id', uploaded.id)  // store the ID
}

// On render, show the file
const fileId = form.values.attachment_id
if (fileId) {
  const url = nivaro.fileUrl(fileId)
  return <a href={url}>{fileId}</a>
}`
    }
  ]
}

export const sdkRealtime: DocSection = {
  id: 'sdk-realtime',
  label: 'Realtime (Socket.io)',
  content: [
    { type: 'h1', id: 'sdk-realtime', text: 'SDK — Realtime (Socket.io)' },
    {
      type: 'p',
      text: 'Hear record changes and notifications as they happen. `createRealtime()` signs the socket in, joins one read-gated room per subscribed collection, and re-joins after every reconnect. Events carry ids, the action and changed field NAMES only — never values; read the record through the REST API when you need it.'
    },
    { type: 'h3', text: 'Connect and sign in' },
    {
      type: 'pre',
      code: `import { createNivaro, createRealtime, readWsToken } from '@nivaro/sdk'

const nivaro = createNivaro('https://nivaro.example.com', { token: process.env.NIVARO_TOKEN })
const rt = createRealtime()

// A ws-token works for every sign-in (session cookie, API key, static token). It is single-use,
// so pass a getter: it is asked again on every reconnect.
rt.connect('https://nivaro.example.com', () => nivaro.request(readWsToken()).then((r) => r.token))

// A user's static token or a View-as token may be passed as a plain string instead.
rt.onAuthenticated((userId) => console.log('signed in as', userId))`
    },
    { type: 'h3', text: 'Subscribe to a collection' },
    {
      type: 'pre',
      code: `const unsubscribe = rt.subscribe('orders', { event: 'update' }, (changes) => {
  for (const c of changes) {
    // c → { collection, item, action, changed_fields?, source?, coalesced?, many? }
    if (c.many) refetchList()          // a burst too large to list ids
    else refetchRow(c.item)
  }
})

rt.subscribe('orders', { event: '*' }, (changes) => {})  // create + update + delete

unsubscribe()   // leaves the room when no subscription on it is left
rt.disconnect()`
    },
    {
      type: 'table',
      head: ['Event', 'Fires on', 'Payload (one RealtimeChange per record)'],
      rows: [
        ['create', 'A record was created', '{ collection, item, action: "create" }'],
        ['update', 'A record changed', '{ collection, item, action: "update", changed_fields? }'],
        ['delete', 'A record was deleted', '{ collection, item, action: "delete" }'],
        [
          'NOTIFICATIONS_CHANNEL',
          'notification:new for the signed-in person',
          'The notification object'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Wire protocol: the client emits `auth {token}` after connecting (the server answers `auth:ok`), then `collection:join {collection}` per room; the server sends `collection:update` (bursts coalesced as `{ items, many, count, coalesced: true }`) and `notification:new`. A collection whose realtime mode is `off` sends nothing — poll it. SDK 0.2.x and earlier emitted `subscribe` and listened for `items:*`, which the server never handled.'
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
