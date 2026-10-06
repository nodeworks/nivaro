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
    {
      type: 'p',
      text: 'A refused request answers with its HTTP status, a sentence in `message`, and a machine `code` to branch on. `error` holds the status text. Some routes answer with `error` alone; read `message` first and fall back to `error`.'
    },
    {
      type: 'pre',
      code: `HTTP/1.1 401 Unauthorized

{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "This API key expired on 2026-09-01",
  "code": "API_KEY_EXPIRED"
}`
    },
    { type: 'h3', text: 'Sign-in and credential codes' },
    {
      type: 'table',
      head: ['Code', 'Status', 'Meaning'],
      rows: [
        ['NOT_SIGNED_IN', '401', 'No credential was sent and there is no session.'],
        ['TOKEN_INVALID', '401', 'The bearer token matches no account.'],
        [
          'ACCOUNT_NOT_ACTIVE',
          '401',
          'The credential is real. The account behind it is suspended.'
        ],
        ['API_KEY_INVALID', '401', 'The API key matches none on file.'],
        ['API_KEY_REVOKED', '401', 'The API key is switched off.'],
        [
          'API_KEY_EXPIRED',
          '401',
          'The API key passed its expiry date. The message names the date.'
        ],
        ['API_KEY_OWNER_INACTIVE', '401', 'The account that owns the API key is not active.'],
        [
          'API_KEY_IP_NOT_ALLOWED',
          '403',
          "The call came from outside the key's address allowlist."
        ],
        [
          'API_KEY_SCOPE_MISSING',
          '403',
          'The key has no scope for the action on that collection. `scope` names both.'
        ],
        [
          'API_KEY_RATE_LIMITED',
          '429',
          'The key went past its calls-per-minute limit. `Retry-After` says how long to wait.'
        ],
        ['RATE_LIMITED', '429', 'The caller went past the instance limit, when one is set.'],
        ['MASQUERADE_EXPIRED', '401', 'A view-as session ran out.'],
        ['ADMIN_ONLY', '403', 'The route is for administrators.']
      ]
    },
    { type: 'h3', text: 'Codes for refused writes' },
    {
      type: 'table',
      head: ['Code', 'Status', 'Meaning'],
      rows: [
        ['LINKED_RECORD_MISSING', '422', 'A field points at a record that does not exist.'],
        ['RECORD_IN_USE', '409', 'The record cannot be removed while other records point at it.'],
        ['DUPLICATE_RECORD', '409', 'A record with the same unique value already exists.'],
        ['VALUE_TOO_LONG', '422', 'A value is longer than its field allows.'],
        [
          'FIELD_NOT_FILTERABLE',
          '400',
          'A filter or sort names a calculated field that cannot be compared in the database.'
        ],
        [
          'VALIDATION_RULE_FAILED',
          '400',
          'A field rule refused the value. `violations` lists field, rule and message.'
        ],
        [
          'CHANGE_REASON_REQUIRED',
          '422',
          'The change needs `_change_reason`. `violations` lists the fields.'
        ],
        [
          'MIDAIR_COLLISION',
          '409',
          'Someone else changed the same fields. `conflicts` lists them.'
        ],
        ['DELETE_GUARDED', '409', 'A deletion guard on the collection refused the delete.'],
        [
          'DUPLICATE_ROW',
          '409',
          'A row of the same parent already holds these values. `rule` names the relation, `fields` the values compared, `existing_id` the row.'
        ],
        [
          'LINK_LIMIT_REACHED',
          '409',
          'The record already holds as many links of this kind as the relation allows. `rule`, `max` and `current` say which and how many.'
        ],
        [
          'PICKER_RULE_VIOLATED',
          '400',
          "The value is one the field's picker would not offer for this record (a field set to enforce its picker rules on every write). `rule` says which rule, `field` which field, `parents` the parent fields a cascade read."
        ]
      ]
    },
    {
      type: 'note',
      text: 'A refusal from the database names the constraint that refused the write. It never includes the statement or the database name. Administrators read every refused credential under Monitoring, Integrations, Inbound, in the Refused credentials list.'
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
        [
          'GET',
          '/api/items/:collection/aggregate',
          'Counts, sums and averages over the rows a list read would match, optionally grouped.'
        ],
        [
          'any',
          '/items/:collection[/:id]',
          'The same routes at the host root, for callers written against the legacy base URL. Answered by the /api handler: one request-log row, same authentication, same body and query string.'
        ],
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
        [
          'after',
          'none',
          'Keyset paging. `start` for the first page, then the `next_cursor` of the page before. Replaces offset and page.'
        ],
        ['count', '1', 'When 0, the count query is skipped and `total` answers null.'],
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
    { type: 'h3', text: 'Related rows in `fields`' },
    {
      type: 'p',
      text: 'A field list may name a to-many relation and the fields wanted from it: `fields=id,lines.amount,tags.name`. Each record on the page answers with a list under that name. The related rows are read as the caller, so the permissions, field list, row filter and scopes of the related collection apply. A caller who may not read the related collection gets empty lists.'
    },
    {
      type: 'pre',
      code: `GET /api/items/orders?limit=2&fields=id,number,lines.amount,lines.line_number,tags.name

{
  "data": [
    {
      "id": 41,
      "number": "SO-1041",
      "lines": [
        { "id": 900, "order": 41, "amount": 120, "line_number": 1 },
        { "id": 901, "order": 41, "amount": 80, "line_number": 2 }
      ],
      "tags": [{ "id": 3, "name": "rush" }]
    }
  ],
  "total": 127, "limit": 2, "offset": 0
}`
    },
    {
      type: 'note',
      text: 'A record lists 200 related rows per relation at most. When a list was cut, the response names the relation in `truncated_relations`. Related rows nest two levels deep. One read per relation per page is made, never one per record.'
    },
    {
      type: 'p',
      text: 'A field name the collection does not have answers 400 with code `UNKNOWN_FIELD` and the names in `fields`.'
    },
    { type: 'h3', text: 'Links to several collections' },
    {
      type: 'p',
      text: 'A relation whose links point at different collections row by row (a contact that is either a person or an outside email address) answers one entry per link: the link id, the collection it names, the linked id, and the linked record under `item`. `fields=contacts.*` or `contacts.item.*` reads the whole linked record; `contacts.item.email` (or the shorthand `contacts.email`) reads only the fields named; asking only for `contacts.id,contacts.collection` skips the linked record. People answer what the person directory (GET /users) shows and nothing more: the directory fields, never a suspended, redacted or placeholder account, and nothing at all through an API key whose scopes leave out nivaro_users. Every other collection is read as the caller, and a record the caller may not read, or a collection the relation does not allow, answers `item: null`. A relation left out of the field list the caller may read answers nothing. One read per linked collection per page, never one per link. The same works on a single record and through a relation (`request.contacts.*`).'
    },
    {
      type: 'pre',
      code: `GET /api/items/requests/32842?fields=id,contacts.item.email

{
  "data": {
    "id": 32842,
    "contacts": [
      { "id": 52295, "collection": "directus_users", "item_id": "7A0411F3-…", "item": { "id": "7A0411F3-…", "email": "pat@example.com" } },
      { "id": 52296, "collection": "additional_emails", "item_id": "5", "item": { "id": 5, "email": "ops@example.com" } }
    ]
  }
}`
    },
    { type: 'h3', text: 'Several reads in one request' },
    {
      type: 'p',
      text: '`POST /api/items/batch-read` carries up to 20 reads. Each is a list read (no `id`) or a single-record read, with the query keys the GET routes take (`fields`, `filter`, `sort`, `limit`, `offset`, `page`, `search`, `after`, `count`, `conditions`) as strings or structured values. Every read runs as the caller exactly as its own GET would and answers its own status — a forbidden collection is 403, a missing record 404, a bad filter 400 — so one refused read never fails the others. A list read answers its rows in `data` and its paging facts in `meta`. Writes never batch. SDK: `readMany([...])`; a host can let `NivaroProvider batchReads` gather the record reads its components fire in the same moment into one batch.'
    },
    {
      type: 'pre',
      code: `POST /api/items/batch-read
{ "reads": [
  { "key": "regions", "collection": "regions", "query": { "fields": "id,short_name", "limit": 5 } },
  { "key": "order", "collection": "orders", "id": 41, "query": { "fields": "id,number" } },
  { "key": "gone", "collection": "orders", "id": 999999 }
] }

{ "results": [
  { "key": "regions", "status": 200, "data": [ ... ], "meta": { "total": 31, "limit": 5, "offset": 0 } },
  { "key": "order", "status": 200, "data": { "id": 41, "number": "SO-1041" } },
  { "key": "gone", "status": 404, "error": "Not found", "code": "NOT_FOUND" }
] }`
    },
    { type: 'h3', text: 'Walking a large collection (`after`)' },
    {
      type: 'p',
      text: 'Offset paging pays for every row it skips, and rows written during the walk shift the pages. A cursor names the last row of the page just read, so the next page costs the same however far the walk is, and a write elsewhere moves nothing. Send `after=start` for the first page and the `next_cursor` of each page for the next. `next_cursor` is null on the last page.'
    },
    {
      type: 'pre',
      code: `GET /api/items/orders?limit=500&sort=-amount&fields=id,amount&after=start&count=0

{
  "data": [{ "id": 307072, "amount": 249387248 }, ...],
  "total": null,
  "limit": 500,
  "offset": 0,
  "next_cursor": "eyJjIjoib3JkZXJzIiwicyI6Ii1hbW91bnQsaWQiLCJ2IjpbMjA2NDE1ODg4LDMwNzA3M119.cpwlTAiHQtYYCTiyaoatX_"
}

GET /api/items/orders?limit=500&sort=-amount&fields=id,amount&count=0&after=eyJjIjoib3JkZXJz...`
    },
    {
      type: 'table',
      head: ['Rule', 'Detail'],
      rows: [
        [
          'Sort',
          "By the record's own stored fields. `id` is added as the tie-break, so no two rows tie."
        ],
        [
          'Same request',
          'Keep `sort`, `filter` and `search` the same for the whole walk. The cursor is signed for one collection and one sort.'
        ],
        [
          '`CURSOR_SORT_UNSUPPORTED`',
          'The sort names a linked record or a calculated field that is not stored.'
        ],
        ['`CURSOR_MISMATCH`', 'The cursor was made for another collection or another sort.'],
        ['`CURSOR_INVALID`', 'The cursor was changed or cut.']
      ]
    },
    { type: 'h3', text: 'Aggregates' },
    {
      type: 'p',
      text: '`GET /api/items/:collection/aggregate` answers figures over the rows a list read with the same `filter` and `search` would match for the caller. It never counts a row the caller could not list.'
    },
    {
      type: 'table',
      head: ['Param', 'Description'],
      rows: [
        [
          'groupBy',
          'Up to 4 stored fields, comma-separated. Without it, one row for the whole set.'
        ],
        ['countAll', 'When 1, the number of rows in each group.'],
        ['count', 'Fields: rows that hold a value.'],
        ['countDistinct', 'Fields: different values.'],
        ['sum, avg', 'Number fields.'],
        ['min, max', 'Number, date and short text fields.'],
        ['sort', 'Group fields, `countAll`, or `<function>.<field>`. Prefix - for descending.'],
        ['limit, offset', 'Groups per page. Default 100, 1000 at most.']
      ]
    },
    {
      type: 'pre',
      code: `GET /api/items/orders/aggregate?groupBy=status&sum=amount&countAll=1&sort=-sum.amount
    &filter={"created_at":{"_gte":"2026-01-01"}}

{
  "data": [
    { "group": { "status": "open" }, "countAll": 329, "sum": { "amount": 33592071.85 } },
    { "group": { "status": "closed" }, "countAll": 5, "sum": { "amount": 21633.18 } }
  ],
  "total": 2, "limit": 100, "offset": 0
}`
    },
    {
      type: 'note',
      text: 'Refusals answer 400 with a code: `AGGREGATE_FIELD_INVALID` (a sum over text, a field that is not stored), `AGGREGATE_TOO_WIDE` (more than 4 group fields or 24 figures), `AGGREGATE_SORT_INVALID` (a sort that is not part of the request).'
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
    { type: 'h3', text: 'Rehearse a create (`dry_run`)' },
    {
      type: 'p',
      text: '`POST /api/items/:collection?dry_run=1` reports what the create would do and stores nothing. Contracts, the natural-key match, hooks, rules, row rules, generated ids, computed fields and validation all run. The insert is tried inside a transaction that is rolled back, so a missing linked record, a duplicate or a value that is too long is found as well. No sequence number is taken, and no notification, webhook or rollup runs.'
    },
    {
      type: 'pre',
      code: `POST /api/items/orders?dry_run=1
{ "customer": 12, "note": "test", "lines": [{ "product": 4, "quantity": 2, "price": 5 }], "colour": "red" }

// Response (200)
{
  "dry_run": true,
  "ok": true,
  "status": 201,             // what the real request would answer
  "would": "create",         // or "update" when the natural key matches a record
  "data": { "id": null, "number": "SO-1042", "customer": 12, "note": "test", "created_by": "..." },
  "filled": ["number", "created_by"],   // set by the server
  "ignored": ["colour"],                // stored nowhere
  "links": {},                          // many-to-many links it would add
  "nested": { "lines": [{ "index": 0, "ok": true, "data": { "quantity": 2, "price": 5, "amount": 10, "id": null } }] },
  "notes": ["Child rows were checked without their parent, ..."]
}

// A create that would be refused (still 200: the rehearsal ran)
{ "dry_run": true, "ok": false, "status": 422, "code": "LINKED_RECORD_MISSING",
  "error": "A linked record does not exist (fk_orders_customers)", "would": null, "data": null, ... }`
    },
    {
      type: 'table',
      head: ['Case', 'Answer'],
      rows: [
        ['The caller may not create in the collection', 'A real `403`, as for a create.'],
        ['The collection does not exist', 'A real `404`.'],
        [
          'The natural key matches a record',
          '`would: "update"`, `matched_id`, `keys`, and `changes` listing each stored field the payload would change. The update itself is not rehearsed.'
        ],
        ['`id`', 'null unless the caller sent one. The id is not reserved.'],
        [
          'Generated ids',
          'The value the next create would take. Two rehearsals show the same value.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Extension hooks receive `ctx.dryRun = true`. A hook may read and shape the payload. It must not write, send or notify while the flag is set.'
    },
    { type: 'h3', text: 'Create with related rows' },
    {
      type: 'p',
      text: "A create or update may carry the rows of a one-to-many relation under the relation's field name. The record and its rows are written in one request, so a caller never has to read the new id back before posting the children."
    },
    {
      type: 'pre',
      code: `POST /api/items/orders
Content-Type: application/json
Authorization: Bearer <token>

{
  "customer": 42,
  "lines": [
    { "product": 7, "quantity": 2, "price": 19.5 },
    { "product": 9, "quantity": 1, "price": 120 }
  ],
  "payments": { "create": [{ "amount": 159, "method": "card" }] }
}`
    },
    {
      type: 'ul',
      items: [
        'Accepted shapes per relation: an array of rows, `{ "create": [...] }`, or a single row object.',
        'Each row is created through the same path as `POST /items/<child>`, as the same caller: permissions, validation, hooks, field rules and computed fields apply per row. The foreign key to the parent is set for you.',
        'Sets are written in the order they appear in the payload, rows in array order. List a set first when a later one depends on it (a cap on payments that reads the sum of lines).',
        'All or nothing on create: if any row is refused, the rows already written and the new record are removed and the error names the row, e.g. `lines[2]: … — nothing was created`.',
        'Side effects wait for the whole create. Webhooks, event flows, watch and subscription notifications, auto-started pipelines, auto transitions and realtime broadcasts for the record and its rows run only once every row has landed, in the order the writes happened. A refused row drops them, so a partner is never told about a record that was undone. Rollups, activity and revisions still write with each row — they describe the row itself and compensation reverses them by deleting it.',
        'On update, a row that carries an `id` is changed in place (the id must be a row of this record, else `422` `NESTED_ROW_NOT_OWNED`); a row without one is created. `{ "delete": [ids] }` removes rows, `{ "set": [...] }` makes the child set exactly the rows listed (rows with an id changed, rows without one created, every other child removed). A plain array on update never removes anything.',
        'All or nothing on update too: changes land first, then creates, then removals. A refused row puts the rows already changed back to their earlier values and removes the rows already created.',
        'At most 500 rows per relation per request.'
      ]
    },
    {
      type: 'pre',
      code: `PATCH /api/items/orders/41
{
  "lines": [
    { "id": 900, "quantity": 3 },              // changed in place
    { "product": 12, "quantity": 1, "price": 8 } // created
  ],
  "payments": { "delete": [77] }
}

PATCH /api/items/orders/41
{ "lines": { "set": [{ "id": 900, "quantity": 3 }, { "product": 12, "quantity": 1, "price": 8 }] } }
// order 41 now has exactly those two lines`
    },
    {
      type: 'note',
      text: 'Every row costs the same as a separate create, so a large set makes one long request. Raise client and proxy timeouts accordingly, or split very large sets.'
    },
    { type: 'h3', text: 'Links under a relation name' },
    {
      type: 'p',
      text: 'A many-to-many relation takes its links under the relation\'s field name, on create and on update. Plain arrays add links and never remove one. `{ "delete": [ids] }` removes links, `{ "set": [ids] }` makes the record\'s links exactly the ids listed. Links are written through the junction collection as the caller, so its permissions, history and any limit apply.'
    },
    {
      type: 'pre',
      code: `PATCH /api/items/articles/9
{ "tags": [3, 4] }                    // adds 3 and 4
{ "tags": { "delete": [3] } }         // removes 3
{ "tags": { "set": [4, 5] } }         // the article is tagged 4 and 5, nothing else

// a polymorphic link names the collection of each id
PATCH /api/items/orders/41
{ "contacts": { "set": [{ "collection": "nivaro_users", "id": "…" }] } }`
    },
    {
      type: 'note',
      text: 'A polymorphic link (a relation that allows several collections) stores the collection beside the id. An entry that is a bare id takes the collection the record form would write: `directus_users` when the relation allows it, else the first allowed collection. A modern name is stored under its legacy spelling when only that is allowed.'
    },
    { type: 'h3', text: 'Many rows in one request' },
    {
      type: 'p',
      text: '`POST /api/items/<collection>/bulk` writes up to 500 rows and answers `207` with one result per row, in request order. A row that carries an `id` is an update; a row without one is a create. Every row goes through the same path as a single write, as the same caller, so permissions, validation, hooks and rules apply per row.'
    },
    {
      type: 'pre',
      code: `POST /api/items/orders/bulk
Content-Type: application/json
Authorization: Bearer <token>

{
  "rows": [
    { "customer": 42, "total": 159 },
    { "id": 1001, "status": "shipped" },
    { "customer": 99999, "total": 10 }
  ]
}

// 207
{
  "data": {
    "ok": 2,
    "failed": 1,
    "results": [
      { "index": 0, "op": "create", "status": 201, "id": 1044, "data": { … } },
      { "index": 1, "op": "update", "status": 200, "id": 1001, "data": { … } },
      { "index": 2, "op": "create", "status": 422,
        "code": "LINKED_RECORD_MISSING",
        "error": "A linked record does not exist (fk_orders_customers)" }
    ]
  }
}`
    },
    {
      type: 'ul',
      items: [
        'The body may be `{ "rows": [...] }` or a bare array of rows.',
        '`"atomic": true` makes the call all or nothing. It takes creates only. The first refused row stops the run, the rows created before it are removed, and the answer is `422` naming the row.',
        '`?return=ids` leaves the records out of the results and returns status and id per row.',
        '`?async=1` queues the run and answers `202` with a `run_id`. Read the results from `GET /api/items/<collection>/bulk/<run_id>`; they are kept for 24 hours. The run also appears under Background Jobs.',
        'A refused row never stops the others unless `atomic` is set.',
        'Outbound effects of the run (webhooks, event flows, notifications, auto transitions, realtime) are held until the run ends and dropped when an atomic run rolls back — nobody hears about rows that no longer exist. Without `atomic`, every row that landed has its effects sent once the run finishes.'
      ]
    },
    { type: 'h3', text: 'Safe retries with Idempotency-Key' },
    {
      type: 'p',
      text: 'Send an `Idempotency-Key` header with any `POST` under `/api/items` or with a GraphQL mutation. The first request runs. A repeat of the same request under the same key within 24 hours returns the first answer and writes nothing, with the header `Idempotent-Replay: true`. Use a fresh unique value per logical write, such as a UUID, and reuse it only when retrying that write.'
    },
    {
      type: 'pre',
      code: `POST /api/items/orders
Authorization: Bearer <token>
Idempotency-Key: 5f0c1d5e-7d0a-4c59-9a40-1d6c1c0f2a11
Content-Type: application/json

{ "customer": 42, "total": 159 }`
    },
    {
      type: 'table',
      head: ['Situation', 'Answer'],
      rows: [
        [
          'Same key, same request, first one finished',
          'The first answer again, `Idempotent-Replay: true`.'
        ],
        [
          'Same key, same request, first one still running',
          '`409` `IDEMPOTENCY_IN_PROGRESS` with `Retry-After`.'
        ],
        ['Same key, different path or body', '`422` `IDEMPOTENCY_KEY_REUSED`.'],
        ['The first request failed', 'The key is released. The retry runs as a new request.'],
        ['Key longer than 200 characters or containing spaces', '`400` `IDEMPOTENCY_KEY_INVALID`.']
      ]
    },
    {
      type: 'note',
      text: 'Keys belong to the caller that sent them. Two API keys, or two users, may use the same value without meeting each other. `IDEMPOTENCY_TTL_SECONDS` changes how long answers are kept.'
    },
    { type: 'h3', text: 'When a create matches an existing record' },
    {
      type: 'p',
      text: 'A collection may name a natural key. A `POST` whose values match an existing record on that key updates that record and creates nothing. The answer says so: `meta.upserted` is true, `meta.matched_id` is the record that was updated, `meta.keys` lists the key fields, and the header `X-Nivaro-Upserted` carries the id. In a bulk call each such row carries `upserted: true`.'
    },
    {
      type: 'pre',
      code: `HTTP/1.1 201 Created
X-Nivaro-Upserted: 8812

{
  "data": { "id": 8812, "order": 42, "year": 2026, "total": 159 },
  "meta": { "upserted": true, "matched_id": 8812, "keys": ["order", "year"] }
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
    { type: 'h3', text: 'Pipeline state (`$state`)' },
    {
      type: 'pre',
      code: '// In one of these states\n?filter={"$state":{"_in":["started","in_review"]}}\n\n// Anything but canceled — records that run no pipeline are kept\n?filter={"$state":{"_nin":["canceled"]}}\n\n// Records that run no pipeline at all\n?filter={"$state":{"_in":["__none__"]}}\n\n// Runs a pipeline and is not canceled\n?filter={"$state":{"_nin":["__none__","canceled"]}}'
    },
    {
      type: 'p',
      text: "State keys are the pipeline's own keys. `__none__` stands for a record with no pipeline instance: name it in `_in` to include such records, or in `_nin` to leave them out."
    },
    { type: 'h3', text: 'Reading the pipeline instance (`$workflow_instance`)' },
    {
      type: 'p',
      text: "Ask for `$workflow_instance` in `fields` on any collection bound to a pipeline and each record carries its current instance: the current state (with the name partners are sent, `external_label`), when it entered that state, and the transitions the caller's role may run from it. Add `$workflow_instance.history` for the transition log. It is never part of `*`, a record with no pipeline reads `null`, and a whole page is read in a fixed number of queries. `$state` is the lighter read when only the state is needed."
    },
    {
      type: 'pre',
      code: '// Current state + available transitions\n?fields=id,workflow_id,$workflow_instance\n\n// ... plus the transition log\n?fields=id,$workflow_instance.history\n\n// On a related record\n?fields=id,workflow.$workflow_instance'
    },
    {
      type: 'note',
      text: 'Available transitions are filtered by role, not by their condition rules — the transition endpoint still judges those, so a listed transition can be refused.'
    },
    { type: 'h3', text: 'Who wrote to it (`$origin`)' },
    {
      type: 'p',
      text: 'Every write is recorded with its origin: person, machine, import or integration. `$origin` filters records by the writes they have received. `_in` keeps records that have a write of those origins; `_nin` keeps records that have none. `days`, `since`, `until`, `by` (an account id) and `action` (create, update, delete) narrow which writes count.'
    },
    {
      type: 'pre',
      code: '// Touched by an integration or an import in the last 7 days\n?filter={"$origin":{"_in":["integration","import"],"days":7}}\n\n// Never edited by a person\n?filter={"$origin":{"_nin":["person"]}}\n\n// Updated by one account since a date\n?filter={"$origin":{"_in":["person"],"by":"<user id>","action":["update"],"since":"2026-09-21"}}'
    },
    {
      type: 'note',
      text: 'Writes made before origins were stored carry none and match no origin. An origin name that does not exist matches nothing.'
    },
    { type: 'h3', text: 'Addendums, highlight rules, integrations' },
    {
      type: 'table',
      head: ['Key', 'Values', 'Keeps'],
      rows: [
        [
          '`$addendums`',
          'active, none, any',
          'Records with an addendum in flight, with none in flight, or that ever had one.'
        ],
        [
          '`$at_risk`',
          'a rule id, a list of ids, or "any"',
          'Records that match one of the named highlight rules.'
        ],
        [
          '`$integrations`',
          'danger, warning, positive, none',
          'Records by how they stand with their integration partners.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'These keys work in `filter`, inside `_and` and `_or`, and as paths in `conditions`. GraphQL spells them `_state`, `_origin`, `_addendums`, `_at_risk` and `_integrations`.'
    },
    { type: 'h3', text: 'Calculated fields' },
    {
      type: 'p',
      text: "A calculated field made of arithmetic or `coalesce` over the record's own columns can be filtered and sorted like a column; the comparison runs in the database. `GET /api/collections/<collection>` marks such fields with `sql_filterable: true`. Any other calculated field, and every rollup that is not stored, exists only after the rows are read: naming one in a filter or sort is refused with `400` `FIELD_NOT_FILTERABLE`."
    },
    {
      type: 'pre',
      code: '// remaining = budget - spent  (a calculated field)\n?filter={"remaining":{"_lt":0}}&sort=-remaining\n\n// Any calculated field may be named in fields=, filterable or not\n?fields=id,name,remaining,open_order_total'
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
    },
    { type: 'h3', text: 'Linked records inside `_some`' },
    {
      type: 'p',
      text: 'Inside `_some` and `_none` a filter may follow further links of the related record: a many-to-one field, another to-many relation, or both. Every hop compiles to SQL.'
    },
    {
      type: 'pre',
      code: `// orders with a line whose product belongs to the "cables" category
?filter={"lines":{"_some":{"product":{"category":{"name":{"_eq":"cables"}}}}}}

// articles with a tag that is used by an article of one author
?filter={"tags":{"_some":{"articles":{"_some":{"author":{"_eq":"<user id>"}}}}}}`
    },
    { type: 'h3', text: 'Filters that cannot be compiled' },
    {
      type: 'p',
      text: 'A filter is checked before it runs. A part that cannot be compiled is refused with 400 and a code. It is never dropped, because a dropped part answers more rows than were asked for.'
    },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        [
          '`FILTER_OPERATOR_UNKNOWN`',
          'The operator does not exist. `operator` names it, `path` says where.'
        ],
        ['`FILTER_PATH_UNSUPPORTED`', 'A nested key under a field that links to no other record.'],
        [
          '`FILTER_VALUE_INVALID`',
          '`_in` and `_nin` take a list, `_between` takes two values, `_and` and `_or` take a list of filters.'
        ],
        ['`FILTER_TOO_DEEP`', 'More than 8 levels of nesting.'],
        ['`UNKNOWN_FIELD`', 'The collection has no such field. `fields` names it.'],
        ['`FIELD_NOT_FILTERABLE`', 'A calculated field that cannot be expressed in SQL.']
      ]
    },
    { type: 'h3', text: 'Filtering on the link itself (`_link`)' },
    {
      type: 'p',
      text: 'When an M2M junction row carries columns of its own — a membership that only applies in one region, a role on the link — put a `_link` filter inside `_some` / `_none`. Every other key filters the related record; `_link` filters the junction row, and both must hold on the SAME link.'
    },
    {
      type: 'pre',
      code: `// articles tagged "featured" through a link that is global or scoped to region 3
?filter={"tags":{"_some":{"name":{"_eq":"featured"},"_link":{"_or":[{"region_id":{"_null":true}},{"region_id":{"_eq":3}}]}}}}

// the same without _some: a _link on its own means "some link like this"
?filter={"tags":{"_link":{"region_id":{"_eq":3}}}}`
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
        [
          'PATCH',
          '/api/collections/:name/fields/:field',
          'Update field metadata (label, interface, etc).'
        ],
        [
          'DELETE',
          '/api/collections/:name/fields/:field',
          'Unregister a field (column is not dropped).'
        ]
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
        ['delegate_id', 'uuid | null', 'User who receives delegation while out of office.'],
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
      text: 'Manage flows — automated workflows with triggers and operations.'
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
        [
          'PATCH',
          '/api/files/:id',
          'Update metadata (title, description, folder, expires_at, tags, filename_download — the download name; one path segment, no separators).'
        ],
        [
          'POST',
          '/api/files/:id/replace',
          'Re-upload: swap the bytes behind an existing id (multipart, field `file`). Same id, so every reference keeps working; new storage key, old object + cached transforms deleted, a dead-link flag cleared.'
        ],
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
