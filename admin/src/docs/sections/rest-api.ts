import type { DocSection } from '../types.js'

export const apiOverview: DocSection = {
  id: 'api-overview',
  label: 'Overview & Auth',
  content: [
    { type: 'h1', id: 'api-overview', text: 'REST API — Overview & Auth' },
    {
      type: 'p',
      text: 'The Nivaro REST API is a Fastify v5 server running on port 3055. All routes are under the `/api` prefix. Two authentication mechanisms are supported on every protected endpoint.'
    },
    { type: 'h2', id: 'api-auth-session', text: 'Session (browser)' },
    {
      type: 'p',
      text: 'Microsoft OIDC login sets an `HttpOnly` session cookie. The browser sends it automatically. The admin UI uses `withCredentials: true` on every request.'
    },
    {
      type: 'table',
      head: ['Endpoint', 'Description'],
      rows: [
        ['GET /api/auth/login', 'Start OIDC login — redirects to Microsoft.'],
        ['GET /api/auth/callback', 'OAuth2 callback — exchanges code, sets session cookie.'],
        ['POST /api/auth/logout', 'Destroys session and clears cookie.'],
        ['GET /api/auth/me', 'Returns current user + role. 401 if unauthenticated.']
      ]
    },
    { type: 'h2', id: 'api-auth-token', text: 'Static token (scripts / SDK)' },
    {
      type: 'p',
      text: "Pass a static token in the `Authorization` header. The token is validated against `nivaro_users.static_token` and the user's role and permissions apply normally."
    },
    { type: 'pre', code: 'Authorization: Bearer 3a7f2b9c1d4e...' },
    {
      type: 'note',
      text: 'If an `Authorization: Bearer` header is present but the token is invalid, the request returns 401 immediately — it does not fall back to the session cookie.'
    },
    { type: 'h2', id: 'api-errors', text: 'Error responses' },
    { type: 'p', text: 'All error responses use JSON with an `error` string field:' },
    {
      type: 'pre',
      code: '{ "error": "Not found" }\n{ "error": "Forbidden" }\n{ "error": "Invalid token" }'
    }
  ]
}

export const apiStaticTokens: DocSection = {
  id: 'static-tokens',
  label: 'Static Tokens',
  content: [
    { type: 'h1', id: 'static-tokens', text: 'Static Tokens' },
    {
      type: 'p',
      text: 'Static tokens let scripts, server-side processes, and the SDK authenticate without a browser session. Each user can have one token at a time. Generating a new token immediately invalidates the previous one.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth', 'Description'],
      rows: [
        ['POST', '/api/users/me/token', 'Any authenticated user', 'Generate a token for yourself.'],
        ['DELETE', '/api/users/me/token', 'Any authenticated user', 'Revoke your token.'],
        ['POST', '/api/users/:id/token', 'Admin', 'Generate a token for another user.'],
        ['DELETE', '/api/users/:id/token', 'Admin', "Revoke another user's token."]
      ]
    },
    { type: 'h3', text: 'Response' },
    {
      type: 'pre',
      code: 'POST /api/users/me/token\n→ 200 { "data": { "token": "3a7f2b9c1d4e5f6a7b8c9d0e1f2a3b4c..." } }\n\nDELETE /api/users/me/token\n→ 204 No Content'
    },
    {
      type: 'warn',
      text: 'Tokens are returned only once — on generation. Store them securely. The token value is not readable again after the response is closed; only a hash indicator is stored.'
    },
    { type: 'h3', text: 'Using a token' },
    {
      type: 'pre',
      code: "# curl\ncurl -H \"Authorization: Bearer 3a7f2b9c...\" https://nivaro.example.com/api/items/articles\n\n# fetch\nfetch('/api/items/articles', {\n  headers: { 'Authorization': 'Bearer 3a7f2b9c...' }\n})"
    }
  ]
}

export const apiSchemaEndpoints: DocSection = {
  id: 'schema-endpoints',
  label: 'Schema & Docs',
  content: [
    { type: 'h1', id: 'schema-endpoints', text: 'Schema & API Docs' },
    {
      type: 'p',
      text: 'Nivaro auto-generates an OpenAPI 3.1 specification from the live `nivaro_collections` + `nivaro_fields` metadata. The spec is always current — it is re-built on every request, so adding a new collection shows up immediately without a restart.'
    },
    {
      type: 'table',
      head: ['Endpoint', 'Description'],
      rows: [
        [
          'GET /api/schema.json',
          'OpenAPI 3.1 spec as JSON. Safe to consume from CI, code generators, Postman, etc.'
        ],
        [
          'GET /api/schema',
          'Swagger UI explorer — interactive, try-it-out enabled, Bearer auth persisted.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'The spec includes a component schema for every non-hidden collection, a list-response wrapper with `data`, `total`, `limit`, and `offset`, and full path definitions for GET list, GET by ID, POST, PATCH, and DELETE.'
    },
    {
      type: 'note',
      text: 'The spec references two security schemes: `bearerToken` (static token) and `sessionCookie`. In Swagger UI, click Authorize and paste your static token to make authenticated requests directly from the browser.'
    }
  ]
}

export const apiItems: DocSection = {
  id: 'items-api',
  label: 'Items API',
  content: [
    { type: 'h1', id: 'items-api', text: 'Items API' },
    {
      type: 'p',
      text: 'The generic items API works against any table registered in `nivaro_collections`. All requests require authentication and pass through the RBAC permission layer.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/items/:collection',
          'List records. Supports filter, sort, fields, limit, offset, search.'
        ],
        ['GET', '/api/items/:collection/:id', 'Single record by primary key.'],
        ['POST', '/api/items/:collection', 'Create a record.'],
        ['PATCH', '/api/items/:collection/:id', 'Update a record (partial).'],
        ['DELETE', '/api/items/:collection/:id', 'Delete a record.']
      ]
    },
    { type: 'h3', text: 'Query parameters (GET list)' },
    {
      type: 'table',
      head: ['Param', 'Default', 'Description'],
      rows: [
        ['fields', '* (all allowed)', 'Comma-separated field names: id,name,created_at'],
        ['filter', 'none', 'JSON filter object — see Filter DSL below.'],
        ['sort', 'none', 'Comma-separated. Prefix - for descending: -created_at,name'],
        ['limit', '25', 'Max rows (hard cap 1000).'],
        ['offset', '0', 'Row offset for pagination.'],
        ['page', '1', 'Shorthand for offset. page=2&limit=25 → offset=25.'],
        ['search', 'none', 'Fulltext search across string/text fields.'],
        ['picker', '0', 'When 1, applies picker filters and exclusions; used by relation pickers.'],
        ['translate', '0', 'When 1, includes `_translations` map for each translatable field.']
      ]
    },
    { type: 'h3', text: 'List example' },
    {
      type: 'pre',
      code: `GET /api/items/articles?limit=10&offset=0&sort=-created_at&fields=id,name,status

// Response (200)
{
  "data": [
    { "id": "uuid-1", "name": "Getting started", "status": "published" },
    { "id": "uuid-2", "name": "Advanced tips", "status": "draft" }
  ],
  "total": 127,
  "limit": 10,
  "offset": 0
}`
    },
    { type: 'h3', text: 'Single record example' },
    {
      type: 'pre',
      code: `GET /api/items/articles/uuid-1

// Response (200)
{
  "data": {
    "id": "uuid-1",
    "name": "Getting started",
    "status": "published",
    "body": "Long article text...",
    "author_id": "user-42",
    "author": {
      "id": "user-42",
      "first_name": "Jane",
      "email": "jane@example.com"
    },
    "tags": [
      { "id": "tag-1", "name": "tutorial" },
      { "id": "tag-2", "name": "beginner" }
    ],
    "created_at": "2026-01-15T09:00:00Z",
    "updated_at": "2026-06-10T14:30:00Z"
  }
}`
    },
    { type: 'h3', text: 'Create example' },
    {
      type: 'pre',
      code: `POST /api/items/articles
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "New article",
  "status": "draft",
  "author_id": "user-42",
  "body": "Article content here..."
}

// Response (201)
{
  "data": {
    "id": "uuid-new",
    "name": "New article",
    "status": "draft",
    "author_id": "user-42",
    "body": "Article content here...",
    "created_at": "2026-06-15T12:00:00Z",
    "updated_at": "2026-06-15T12:00:00Z"
  }
}`
    },
    { type: 'h3', text: 'Update example' },
    {
      type: 'pre',
      code: `PATCH /api/items/articles/uuid-1
Content-Type: application/json
Authorization: Bearer <token>

{
  "status": "published",
  "body": "Updated article content..."
}

// Response (200)
{
  "data": {
    "id": "uuid-1",
    "name": "Getting started",
    "status": "published",
    "body": "Updated article content...",
    "updated_at": "2026-06-15T15:00:00Z"
  }
}`
    },
    { type: 'h3', text: 'Delete example' },
    {
      type: 'pre',
      code: `DELETE /api/items/articles/uuid-1
Authorization: Bearer <token>

// Response (204 No Content)`
    },
    { type: 'h3', text: 'Error responses' },
    {
      type: 'table',
      head: ['Status', 'Scenario'],
      rows: [
        ['400', 'Invalid filter syntax, bad request body, invalid field names.'],
        ['401', 'Missing or invalid authentication.'],
        ['403', 'Authenticated but lacks permission (collection/field/action).'],
        ['404', 'Record not found (single read/update/delete).'],
        ['409', 'Conflict — concurrent update, item locked, or relation constraint violated.'],
        ['422', 'Validation rule violation or hard-block AI rule triggered.']
      ]
    },
    {
      type: 'note',
      text: 'Relations (M2O FK, M2M, O2M) are resolved automatically in single-record reads. In list responses, M2O relations are included as nested objects; O2M and M2M are not included (use relation option endpoints to fetch related records separately).'
    }
  ]
}

export const apiFilter: DocSection = {
  id: 'filter-dsl',
  label: 'Filter DSL',
  content: [
    { type: 'h1', id: 'filter-dsl', text: 'Filter DSL' },
    {
      type: 'p',
      text: 'Filters are URL-encoded JSON objects. The key is the field name, the value is an object with an operator and value. Supports scalar operators, logical combinators, and relation traversal.'
    },
    { type: 'h3', text: 'Scalar operators' },
    {
      type: 'pre',
      code: '// Exact match\n?filter={"status":{"_eq":"active"}}\n\n// Greater than\n?filter={"amount":{"_gt":1000}}\n\n// Substring / string matching\n?filter={"name":{"_contains":"fiber"}}\n?filter={"name":{"_ncontains":"draft"}}\n?filter={"code":{"_starts_with":"Purchase"}}\n?filter={"email":{"_ends_with":"@gmail.com"}}\n\n// Null check\n?filter={"deleted_at":{"_null":true}}\n\n// List membership\n?filter={"status":{"_in":["active","draft"]}}'
    },
    {
      type: 'table',
      head: ['Operator', 'SQL equivalent', 'Notes'],
      rows: [
        ['_eq', '= ?', 'Exact equality.'],
        ['_neq', '!= ?', 'Not equal.'],
        ['_gt', '> ?', 'Greater than.'],
        ['_gte', '>= ?', 'Greater than or equal.'],
        ['_lt', '< ?', 'Less than.'],
        ['_lte', '<= ?', 'Less than or equal.'],
        ['_in', 'IN (?,...)', 'Value must be a JSON array.'],
        ['_nin', 'NOT IN (?,...)', 'Value must be a JSON array.'],
        ['_null', 'IS NULL', 'Value is ignored (pass true).'],
        ['_nnull', 'IS NOT NULL', 'Value is ignored (pass true).'],
        ['_contains', 'LIKE %?%', 'Substring match (case-insensitive).'],
        ['_ncontains', 'NOT LIKE %?%', 'Substring exclusion.'],
        ['_starts_with', 'LIKE ?%', 'Prefix match.'],
        ['_ends_with', 'LIKE %?', 'Suffix match.']
      ]
    },
    { type: 'h3', text: 'Combining filters (AND / OR)' },
    {
      type: 'pre',
      code: `// AND — all conditions must match
?filter={"_and":[{"status":{"_eq":"active"}},{"amount":{"_gt":1000}}]}

// OR — at least one condition matches
?filter={"_or":[{"status":{"_eq":"active"}},{"status":{"_eq":"pending"}}]}

// Nested AND/OR
?filter={"_and":[
  {"_or":[{"status":{"_eq":"active"}},{"status":{"_eq":"pending"}}]},
  {"amount":{"_gte":500}}
]}`
    },
    { type: 'h3', text: 'Relation filters (M2O — many-to-one)' },
    {
      type: 'p',
      text: "Filter on a related record's fields by using the relation field name (or its alias without `_id` suffix) as the key and nesting a filter object inside."
    },
    {
      type: 'pre',
      code: `// Items whose owner's department is Engineering
?filter={"owner":{"department":{"_eq":"Engineering"}}}

// Nested two levels deep (chained M2O)
?filter={"project":{"division":{"name":{"_contains":"North"}}}}

// Combine with scalar filters
?filter={"_and":[
  {"owner":{"department":{"_eq":"Engineering"}}},
  {"status":{"_eq":"active"}}
]}`
    },
    { type: 'h3', text: 'Relation filters (O2M / M2M)' },
    {
      type: 'p',
      text: 'Use `_some` (at least one match) or `_none` (no matches) to filter by whether related records exist.'
    },
    {
      type: 'pre',
      code: `// Items that have at least one tag named "featured"
?filter={"tags":{"_some":{"name":{"_eq":"featured"}}}}

// Items with no rejected approvals
?filter={"approvals":{"_none":{"status":{"_eq":"rejected"}}}}

// Items that have comments from a specific user
?filter={"comments":{"_some":{"author_id":{"_eq":"user-42"}}}}`
    },
    {
      type: 'note',
      text: 'Both `_some` and `_none` work on O2M virtual fields (one-to-many) and M2M junction relations. Use these operators to filter based on existence/non-existence of related records.'
    }
  ]
}

export const apiCollections: DocSection = {
  id: 'collections-api',
  label: 'Collections API',
  content: [
    { type: 'h1', id: 'collections-api', text: 'Collections API' },
    {
      type: 'p',
      text: 'All endpoints require admin access. The Collections API manages the `nivaro_collections` and `nivaro_fields` metadata registry.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/collections', 'List all registered collections with field counts.'],
        ['GET', '/api/collections/:name', 'Single collection metadata + its fields array.'],
        ['POST', '/api/collections', 'Register a new collection from existing table.'],
        ['PATCH', '/api/collections/:name', 'Update collection settings (label, icon, etc).'],
        [
          'DELETE',
          '/api/collections/:name',
          'Unregister collection from the CMS (table is not dropped).'
        ],
        ['GET', '/api/collections/:name/fields', 'List all fields for a collection.'],
        ['POST', '/api/collections/:name/fields', 'Register a field from existing column.'],
        ['PATCH', '/api/collections/:name/fields/:field', 'Update field metadata (label, interface, etc).'],
        ['DELETE', '/api/collections/:name/fields/:field', 'Unregister a field (column is not dropped).']
      ]
    },
    { type: 'h3', text: 'Register collection example' },
    {
      type: 'pre',
      code: `POST /api/collections
Authorization: Bearer <admin-token>

{
  "name": "articles",
  "label": "Articles",
  "description": "Blog posts and articles"
}

// Response (201)
{
  "data": {
    "name": "articles",
    "label": "Articles",
    "description": "Blog posts and articles",
    "fields": []
  }
}`
    },
    { type: 'h3', text: 'Register field example' },
    {
      type: 'pre',
      code: `POST /api/collections/articles/fields
Authorization: Bearer <admin-token>

{
  "field": "name",
  "label": "Title",
  "type": "string",
  "required": true
}

// Response (201)
{
  "data": {
    "field": "name",
    "label": "Title",
    "type": "string",
    "required": true,
    "hidden": false,
    "readonly": false
  }
}`
    },
    {
      type: 'note',
      text: 'Collections and fields must correspond to actual database tables and columns. The API validates that the underlying structure exists before registering metadata.'
    }
  ]
}

export const apiUsers: DocSection = {
  id: 'users-api',
  label: 'Users API',
  content: [
    { type: 'h1', id: 'users-api', text: 'Users API' },
    {
      type: 'p',
      text: 'User management endpoints. List users, view profiles, manage roles, and handle delegation.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Auth required'],
      rows: [
        ['GET', '/api/users', 'Admin — list all users with pagination.'],
        ['GET', '/api/users/:id', 'Any user (own record) or admin.'],
        ['POST', '/api/users', 'Admin — create a user (email required).'],
        ['PATCH', '/api/users/:id', 'Own record or admin. Admins can change role/status.'],
        ['DELETE', '/api/users/:id', 'Admin — cannot delete yourself.'],
        ['POST', '/api/users/me/token', 'Any authenticated user — generate own static token.'],
        ['DELETE', '/api/users/me/token', 'Any authenticated user — revoke own static token.'],
        ['POST', '/api/users/:id/token', 'Admin — generate token for another user.'],
        ['DELETE', '/api/users/:id/token', "Admin — revoke another user's token."],
        ['POST', '/api/users/me/delegate', 'Any authenticated user — set own delegation.']
      ]
    },
    {
      type: 'note',
      text: 'Use `me` as the ID to target the currently-authenticated user. Token endpoints are also covered in the Static Tokens section above.'
    },
    { type: 'h3', text: 'List users example' },
    {
      type: 'pre',
      code: `GET /api/users?limit=10&offset=0
Authorization: Bearer <admin-token>

// Response (200)
{
  "data": [
    {
      "id": "user-1",
      "email": "jane@example.com",
      "first_name": "Jane",
      "last_name": "Smith",
      "role": "editor",
      "status": "active",
      "manager_id": null,
      "is_out_of_office": false
    },
    {
      "id": "user-2",
      "email": "bob@example.com",
      "first_name": "Bob",
      "last_name": "Johnson",
      "role": "admin",
      "status": "active",
      "manager_id": "user-1",
      "is_out_of_office": false
    }
  ],
  "total": 15,
  "limit": 10,
  "offset": 0
}`
    },
    { type: 'h3', text: 'Create user example' },
    {
      type: 'pre',
      code: `POST /api/users
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "email": "alice@example.com",
  "first_name": "Alice",
  "last_name": "Brown",
  "role": "user"
}

// Response (201)
{
  "data": {
    "id": "user-new",
    "email": "alice@example.com",
    "first_name": "Alice",
    "last_name": "Brown",
    "role": "user",
    "status": "active",
    "created_at": "2026-06-15T12:00:00Z"
  }
}`
    },
    { type: 'h3', text: 'Delegation fields' },
    {
      type: 'p',
      text: 'Users can delegate their ownership to another user when out of office. Delegated users inherit all ownership responsibilities.'
    },
    {
      type: 'table',
      head: ['Field', 'Type', 'Notes'],
      rows: [
        ['manager_id', 'uuid | null', 'Direct manager (admin-only).'],
        [
          'delegate_id',
          'uuid | null',
          'User who receives delegation while out of office.'
        ],
        ['delegate_expires_at', 'datetime | null', 'When delegation expires; null = indefinite.'],
        ['is_out_of_office', 'boolean', 'Master switch — delegation active only when true.']
      ]
    },
    { type: 'h3', text: 'Set delegation example' },
    {
      type: 'pre',
      code: `POST /api/users/me/delegate
Authorization: Bearer <user-token>
Content-Type: application/json

{
  "is_out_of_office": true,
  "delegate_id": "user-42",
  "delegate_expires_at": "2026-07-15T17:00:00.000Z"
}

// Response (200)
{
  "data": {
    "is_out_of_office": true,
    "delegate_id": "user-42",
    "delegate_expires_at": "2026-07-15T17:00:00.000Z"
  }
}`
    },
    {
      type: 'note',
      text: 'The pipeline engine substitutes the delegate for the owner only when `is_out_of_office` is true, a delegate is set, and the expiry (if any) is in the future.'
    }
  ]
}

export const apiRoles: DocSection = {
  id: 'roles-api',
  label: 'Roles API',
  content: [
    { type: 'h1', id: 'roles-api', text: 'Roles API' },
    {
      type: 'p',
      text: 'Manage roles and their permissions. Roles control what actions users can perform on which collections and fields.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/roles', 'List all roles with policy counts.'],
        ['GET', '/api/roles/:id', 'Single role + its complete policies array.'],
        ['POST', '/api/roles', 'Create a new role.'],
        ['PATCH', '/api/roles/:id', 'Update role name, description, or admin_access flag.'],
        ['DELETE', '/api/roles/:id', 'Delete role (blocked if users are assigned to it).'],
        ['GET', '/api/roles/:id/policies', 'List all policies for a role.'],
        ['POST', '/api/roles/:id/policies', 'Add a policy: { collection, action, fields? }.'],
        ['DELETE', '/api/roles/policies/:policyId', 'Delete a specific policy.']
      ]
    },
    { type: 'h3', text: 'Create role example' },
    {
      type: 'pre',
      code: `POST /api/roles
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "editor",
  "label": "Content Editor",
  "description": "Can create and edit content"
}

// Response (201)
{
  "data": {
    "id": "role-editor",
    "name": "editor",
    "label": "Content Editor",
    "admin_access": false,
    "policies": []
  }
}`
    },
    { type: 'h3', text: 'Add policy example' },
    {
      type: 'pre',
      code: `POST /api/roles/role-editor/policies
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "collection": "articles",
  "action": "create",
  "fields": null
}

// Response (201) — fields: null means all fields allowed
{
  "data": {
    "id": "policy-1",
    "collection": "articles",
    "action": "create",
    "fields": null
  }
}`
    },
    {
      type: 'table',
      head: ['Action', 'Meaning'],
      rows: [
        ['read', 'List and view records in the collection.'],
        ['create', 'Create new records.'],
        ['update', 'Modify existing records.'],
        ['delete', 'Delete records.']
      ]
    },
    {
      type: 'note',
      text: 'Policies are additive — a user inherits the union of all policies for their role. Field-level restrictions apply only when `fields` is a non-empty array.'
    }
  ]
}

export const apiFlows: DocSection = {
  id: 'flows-api',
  label: 'Flows API',
  content: [
    { type: 'h1', id: 'flows-api', text: 'Flows API' },
    {
      type: 'p',
      text: 'Manage Inngest-backed flows — automated workflows with triggers and operations.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/flows', 'List flows with operation counts and next_run for scheduled flows.'],
        ['GET', '/api/flows/:id', 'Single flow with parsed operations array.'],
        ['POST', '/api/flows', 'Create a new flow.'],
        [
          'PATCH',
          '/api/flows/:id',
          'Update flow — automatically resyncs cron if trigger/status changed.'
        ],
        ['DELETE', '/api/flows/:id', 'Delete flow and cascade-remove all operations.'],
        ['POST', '/api/flows/:id/trigger', 'Manually trigger an active flow immediately.'],
        ['POST', '/api/flows/:id/operations', 'Add an operation to a flow.'],
        ['PATCH', '/api/flows/:id/operations/:opId', 'Update an operation.'],
        ['DELETE', '/api/flows/:id/operations/:opId', 'Delete an operation.'],
        [
          'GET',
          '/api/flows/registered-operations',
          'List available operation types (built-in + extension-registered).'
        ],
        [
          'GET',
          '/api/flows/registered-triggers',
          'List available trigger types (built-in + extension-registered).'
        ]
      ]
    },
    { type: 'h3', text: 'Create flow example' },
    {
      type: 'pre',
      code: `POST /api/flows
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "Send daily digest",
  "trigger": "schedule",
  "trigger_options": { "cron": "0 8 * * *" },
  "enabled": true
}

// Response (201)
{
  "data": {
    "id": "flow-1",
    "name": "Send daily digest",
    "trigger": "schedule",
    "trigger_options": { "cron": "0 8 * * *" },
    "enabled": true,
    "operations": []
  }
}`
    },
    { type: 'h3', text: 'Add operation example' },
    {
      type: 'pre',
      code: `POST /api/flows/flow-1/operations
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "type": "log",
  "name": "Log start",
  "options": { "message": "Digest started", "level": "info" },
  "sort": 0
}

// Response (201)
{
  "data": {
    "id": "op-1",
    "type": "log",
    "name": "Log start",
    "options": { "message": "Digest started", "level": "info" },
    "sort": 0
  }
}`
    },
    { type: 'h3', text: 'Trigger types' },
    {
      type: 'table',
      head: ['Type', 'Description', 'Options'],
      rows: [
        ['schedule', 'Cron-scheduled recurring job', '{ "cron": "0 9 * * *" }'],
        ['manual', 'Triggered by POST /flows/:id/trigger', 'N/A'],
        ['event', 'Custom extension-registered event', 'Varies by event'],
        ['webhook', 'Incoming HTTP request', 'URL pattern']
      ]
    },
    { type: 'h3', text: 'Operation types' },
    {
      type: 'table',
      head: ['Type', 'Description'],
      rows: [
        ['log', 'Write to server log'],
        ['mail', 'Send email via SMTP'],
        ['webhook', 'Make outbound HTTP request'],
        ['notification', 'Create in-app notification'],
        ['external-api', 'Call configured external API'],
        ['condition', 'Branch logic'],
        ['transform', 'Map/set/delete fields'],
        ['<custom>', 'Extension-registered operation type']
      ]
    }
  ]
}

export const apiFiles: DocSection = {
  id: 'files-api',
  label: 'Files API',
  content: [
    { type: 'h1', id: 'files-api', text: 'Files API' },
    {
      type: 'p',
      text: 'Upload, manage, and serve files. Files are stored in configurable backends (local, S3, Azure) with optional image transformations.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/files', 'List files with optional folder / search filters.'],
        ['POST', '/api/files', 'Upload file (multipart/form-data). Field: `file`.'],
        ['GET', '/api/files/:id', 'File metadata (size, mime type, dates).'],
        ['GET', '/api/files/:id/content', 'Serve file with correct Content-Type header.'],
        ['PATCH', '/api/files/:id', 'Update metadata (title, description, folder, expires_at).'],
        ['DELETE', '/api/files/:id', 'Delete file from storage backend + metadata.'],
        ['GET', '/api/files/:id/transform', 'Resize/transcode image (w, h, fit, format, q params).']
      ]
    },
    { type: 'h3', text: 'Upload example' },
    {
      type: 'pre',
      code: `POST /api/files
Authorization: Bearer <token>
Content-Type: multipart/form-data

file=@article-image.jpg
folder=articles

// Response (201)
{
  "data": {
    "id": "file-uuid",
    "name": "article-image.jpg",
    "mime_type": "image/jpeg",
    "size": 245123,
    "folder": "articles",
    "url": "/api/files/file-uuid/content",
    "created_at": "2026-06-15T12:00:00Z"
  }
}`
    },
    { type: 'h3', text: 'Image transformation example' },
    {
      type: 'pre',
      code: `// Resize to 400x300, cover crop, convert to webp
GET /api/files/file-uuid/transform?w=400&h=300&fit=cover&format=webp&q=80

// Params
// w, h         — target dimensions (optional)
// fit          — cover | contain | fill | inside | outside (default: cover)
// format       — webp | avif | jpeg | png (default: source format)
// q            — quality 1-100 for lossy formats (default: 80)`
    },
    { type: 'h3', text: 'Set file expiry' },
    {
      type: 'pre',
      code: `PATCH /api/files/file-uuid
Authorization: Bearer <token>
Content-Type: application/json

{
  "expires_at": "2026-07-15T00:00:00Z"
}

// Response (200) — file will 404 after expiry; hourly cleanup removes bytes`
    },
    {
      type: 'note',
      text: 'Files support storage providers: local disk (default), S3-compatible (R2, AWS), or Azure Blob. Configure via `STORAGE_PROVIDER` env var. Image transformations require sharp; non-images return 400.'
    }
  ]
}

export const apiHealth: DocSection = {
  id: 'health-api',
  label: 'Health',
  content: [
    { type: 'h1', id: 'health-api', text: 'Health Check' },
    {
      type: 'p',
      text: 'The health endpoint is unauthenticated and safe to poll from load balancers or monitoring systems.'
    },
    {
      type: 'pre',
      code: `GET /api/health

// Healthy response (200)
{
  "status": "ok",
  "version": "1.0.0",
  "environment": "production",
  "db": {
    "status": "ok",
    "database": "your_database",
    "host": "db.example.com"
  },
  "redis": {
    "status": "ok",
    "url": "redis://cache.example.com:6379"
  },
  "ts": "2026-06-15T12:00:00.000Z"
}

// Degraded response (503) — same shape with status: "error"
{
  "status": "error",
  "db": { "status": "error", "error": "Connection timeout" },
  "redis": { "status": "ok" }
}`
    },
    { type: 'h3', text: 'Detailed health check' },
    {
      type: 'pre',
      code: `GET /api/health/detailed
Authorization: Bearer <token>

// Response includes subsystem details
{
  "db": { "ok": true, "latency_ms": 4 },
  "redis": { "ok": true },
  "inngest": { "ok": true },
  "migrations": { "ok": true, "pending": 0 },
  "sockets": { "connected": 42 }
}`
    },
    {
      type: 'note',
      text: 'The simple `/api/health` endpoint is unauthenticated for load balancer usage. The detailed endpoint requires authentication and is for admin monitoring.'
    }
  ]
}
