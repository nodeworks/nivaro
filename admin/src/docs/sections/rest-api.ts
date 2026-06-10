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
        ['search', 'none', 'Fulltext search across string/text fields.']
      ]
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
        ['_gt', '> ?', ''],
        ['_gte', '>= ?', ''],
        ['_lt', '< ?', ''],
        ['_lte', '<= ?', ''],
        ['_in', 'IN (?,...)', 'Value must be a JSON array.'],
        ['_nin', 'NOT IN (?,...)', 'Value must be a JSON array.'],
        ['_null', 'IS NULL', 'Value is ignored (pass true).'],
        ['_nnull', 'IS NOT NULL', 'Value is ignored (pass true).'],
        ['_contains', 'LIKE %?%', 'Substring match.'],
        ['_ncontains', 'NOT LIKE %?%', 'Substring exclusion.'],
        ['_starts_with', 'LIKE ?%', 'Prefix match.'],
        ['_ends_with', 'LIKE %?', 'Suffix match.']
      ]
    },
    { type: 'h3', text: 'Logical combinators' },
    {
      type: 'pre',
      code: '// AND — all conditions must match\n?filter={"_and":[{"status":{"_eq":"active"}},{"amount":{"_gt":1000}}]}\n\n// OR — any condition matches\n?filter={"_or":[{"status":{"_eq":"active"}},{"status":{"_eq":"pending"}}]}'
    },
    { type: 'h3', text: 'Relation filters (M2O)' },
    {
      type: 'p',
      text: "Filter on a related record's fields by using the relation field name (or its alias without `_id` suffix) as the key and nesting a filter object inside."
    },
    {
      type: 'pre',
      code: '// Items whose owner\'s department is Engineering\n?filter={"owner":{"department":{"_eq":"Engineering"}}}\n\n// Nested two levels deep\n?filter={"project":{"division":{"name":{"_contains":"fiber"}}}}'
    },
    { type: 'h3', text: 'Relation filters (O2M / M2M)' },
    {
      type: 'p',
      text: 'Use `_some` or `_none` to filter by whether related records exist.'
    },
    {
      type: 'pre',
      code: '// Items that have at least one tag named "featured"\n?filter={"tags":{"_some":{"name":{"_eq":"featured"}}}}\n\n// Items with no rejected approvals\n?filter={"approvals":{"_none":{"status":{"_eq":"rejected"}}}}'
    }
  ]
}

export const apiCollections: DocSection = {
  id: 'collections-api',
  label: 'Collections API',
  content: [
    { type: 'h1', id: 'collections-api', text: 'Collections API' },
    { type: 'p', text: 'All endpoints require admin access.' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/collections', 'List all registered collections.'],
        ['GET', '/api/collections/:name', 'Single collection + its fields.'],
        ['POST', '/api/collections', 'Register a new collection.'],
        ['PATCH', '/api/collections/:name', 'Update collection metadata.'],
        [
          'DELETE',
          '/api/collections/:name',
          'Remove collection from registry (does not drop table).'
        ],
        ['GET', '/api/collections/:name/fields', 'List fields for a collection.'],
        ['POST', '/api/collections/:name/fields', 'Register a field.'],
        ['PATCH', '/api/collections/:name/fields/:field', 'Update field metadata.'],
        ['DELETE', '/api/collections/:name/fields/:field', 'Remove field from registry.']
      ]
    }
  ]
}

export const apiUsers: DocSection = {
  id: 'users-api',
  label: 'Users API',
  content: [
    { type: 'h1', id: 'users-api', text: 'Users API' },
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
    { type: 'h3', text: 'Delegation fields' },
    {
      type: 'p',
      text: 'Users carry four delegation columns. `delegate_id`, `delegate_expires_at`, and `is_out_of_office` are self-editable (or via `POST /api/users/me/delegate`); `manager_id` is admin-only via `PATCH /api/users/:id`.'
    },
    {
      type: 'table',
      head: ['Field', 'Type', 'Notes'],
      rows: [
        ['manager_id', 'uuid | null', 'FK to another user (admin-only).'],
        [
          'delegate_id',
          'uuid | null',
          'FK to the user who receives ownership while out of office.'
        ],
        ['delegate_expires_at', 'datetime | null', 'When delegation lapses; null = indefinite.'],
        ['is_out_of_office', 'boolean', 'Master switch — delegation only applies when true.']
      ]
    },
    {
      type: 'pre',
      code: `// Set your own delegation
POST /api/users/me/delegate
{
  "is_out_of_office": true,
  "delegate_id": "8f3c…",
  "delegate_expires_at": "2026-07-01T17:00:00.000Z"
}`
    },
    {
      type: 'note',
      text: 'The pipeline engine substitutes the delegate for the owner only when is_out_of_office is true, a delegate is set, and the expiry (if any) is in the future.'
    }
  ]
}

export const apiRoles: DocSection = {
  id: 'roles-api',
  label: 'Roles API',
  content: [
    { type: 'h1', id: 'roles-api', text: 'Roles API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/roles', 'List all roles.'],
        ['GET', '/api/roles/:id', 'Single role + its policies.'],
        ['POST', '/api/roles', 'Create role.'],
        ['PATCH', '/api/roles/:id', 'Update role.'],
        ['DELETE', '/api/roles/:id', 'Delete role (blocked if users assigned).'],
        ['GET', '/api/roles/:id/policies', 'List policies for a role.'],
        ['POST', '/api/roles/:id/policies', 'Add a policy: { collection, action, fields? }.'],
        ['DELETE', '/api/roles/policies/:policyId', 'Delete a specific policy.']
      ]
    }
  ]
}

export const apiFlows: DocSection = {
  id: 'flows-api',
  label: 'Flows API',
  content: [
    { type: 'h1', id: 'flows-api', text: 'Flows API' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/flows', 'List flows with operation counts and next_run for scheduled flows.'],
        ['GET', '/api/flows/:id', 'Single flow with parsed operations array.'],
        ['POST', '/api/flows', 'Create flow.'],
        [
          'PATCH',
          '/api/flows/:id',
          'Update flow — automatically resyncs cron if trigger/status changed.'
        ],
        ['DELETE', '/api/flows/:id', 'Delete flow and cascade-remove operations.'],
        ['POST', '/api/flows/:id/trigger', 'Manually trigger an active flow.'],
        ['POST', '/api/flows/:id/operations', 'Add an operation.'],
        ['PATCH', '/api/flows/:id/operations/:opId', 'Update operation options.'],
        ['DELETE', '/api/flows/:id/operations/:opId', 'Delete an operation.'],
        [
          'GET',
          '/api/flows/registered-operations',
          'List extension-registered custom operation types. Auth required.'
        ],
        [
          'GET',
          '/api/flows/registered-triggers',
          'List extension-registered custom trigger types. Auth required.'
        ]
      ]
    },
    { type: 'h3', text: 'trigger_options schema (schedule trigger)' },
    { type: 'pre', code: '{ "cron": "0 9 * * 1-5" }   // weekdays at 9am UTC' },
    { type: 'h3', text: 'Built-in operation types' },
    {
      type: 'table',
      head: ['Type', 'Description'],
      rows: [
        ['condition', 'Branch on a field value — resolve path if true, reject if false'],
        ['exec-script', 'Run arbitrary JavaScript with access to flow data'],
        ['log', 'Write a message to the server log at a configurable level'],
        ['mail', 'Send an email via SMTP'],
        ['notification', 'Create an in-app notification for a user'],
        ['webhook', 'Make an outbound HTTP request to a custom URL'],
        ['transform', 'Map, set, or delete fields in flow data'],
        ['run-flow', 'Trigger another flow by ID'],
        [
          'external-api',
          'Call a predefined External API config or a custom URL with SSRF protection'
        ],
        [
          '<ext-id>:<type>',
          'Custom op registered by an extension via `ctx.flows.registerOperation()`'
        ]
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
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['GET', '/api/files', 'List files with optional folder filter.'],
        ['POST', '/api/files', 'Upload (multipart/form-data). Field: file.'],
        ['GET', '/api/files/:id', 'File metadata.'],
        ['GET', '/api/files/:id/content', 'Serve file with correct Content-Type.'],
        ['PATCH', '/api/files/:id', 'Update metadata (title, description, folder).'],
        ['DELETE', '/api/files/:id', 'Delete file from disk and remove row.']
      ]
    }
  ]
}

export const apiHealth: DocSection = {
  id: 'health-api',
  label: 'Health',
  content: [
    { type: 'h1', id: 'health-api', text: 'Health' },
    {
      type: 'p',
      text: 'The health endpoint is unauthenticated and safe to poll from load balancers or monitoring systems.'
    },
    {
      type: 'pre',
      code: 'GET /api/health\n\n// Healthy response (200)\n{\n  "status": "ok",\n  "version": "1.0.0",\n  "environment": "development",\n  "db": { "status": "ok", "database": "your_database", "host": "your-db-host..." },\n  "redis": { "status": "ok", "url": "redis://localhost:6679" },\n  "ts": "2025-06-05T12:00:00.000Z"\n}\n\n// Degraded response (503) — same shape, status fields show "error"'
    }
  ]
}
