import type { DocSection } from '../types.js'

export const graphqlOverview: DocSection = {
  id: 'graphql-overview',
  label: 'Overview',
  content: [
    { type: 'h1', id: 'graphql-overview', text: 'GraphQL API — Overview' },
    {
      type: 'p',
      text: 'Nivaro auto-generates a GraphQL schema from the live `nivaro_collections` + `nivaro_fields` metadata — the same source used to build the OpenAPI spec. Every non-hidden collection gets query and mutation fields automatically. Schema is rebuilt in the `onReady` hook when the server starts, and can be manually rebuilt at runtime.'
    },
    {
      type: 'table',
      head: ['Endpoint', 'Description'],
      rows: [
        [
          'GET /api/graphql',
          'GraphiQL explorer — interactive browser IDE. Administrators can run it as any named API key (Security → API keys → Run the playground as a key).'
        ],
        ['POST /api/graphql', 'GraphQL endpoint. Body: { query, variables?, operationName? }.'],
        [
          'POST /api/graphql/rebuild',
          'Admin — rebuild the schema from current nivaro_collections/fields.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'GraphQL queries and mutations go through the same RBAC permission layer as the REST API. Unauthenticated requests receive `UNAUTHENTICATED` errors; forbidden operations receive `FORBIDDEN` errors.'
    },
    { type: 'h2', id: 'graphql-cost-limits', text: 'Query cost limits' },
    {
      type: 'p',
      text: 'A query is measured before it executes. The total number of selected fields is capped at `GRAPHQL_MAX_SELECTIONS` (default 2500). Nesting depth is unlimited by default — set `GRAPHQL_MAX_DEPTH` on the instance to cap it, or give a named API key its own `graphql_max_depth`, which applies only to that key. A refused query answers HTTP 400 with an `errors[]` message naming the measured cost and the limit.'
    },
    { type: 'h2', id: 'graphql-analytics', text: 'Operation analytics' },
    {
      type: 'p',
      text: "Every GraphQL request logs the operation it ran (its name, else the first root field), its kind, the measured depth and selection count, how many errors the answer carried, and which `@deprecated` fields it selected. Monitoring → API Analytics → GraphQL by operation shows each operation's calls, p50/p95 latency, error rate, average cost, top callers and slowest calls (`GET /api/api-analytics/graphql?hours=`); a strip above it names every deprecated field still being selected and by whom — what to check before the deprecation window closes."
    }
  ]
}

export const graphqlSchema: DocSection = {
  id: 'graphql-schema',
  label: 'Schema Structure',
  content: [
    { type: 'h1', id: 'graphql-schema', text: 'Schema Structure' },
    {
      type: 'p',
      text: 'For each non-hidden collection with at least one visible field, the schema includes:'
    },
    {
      type: 'ul',
      items: [
        'An object type named after the collection (e.g. `articles`)',
        'A page-facts type named `collectionName_metadata` with `total`, `limit`, and `offset`',
        'Three query fields: `collectionName` (list of items), `collectionName_metadata` (page facts for the same arguments) and `collectionName_by_id` (single)',
        'Three mutation fields: `create_collectionName`, `update_collectionName_item`, `delete_collectionName_item`',
        'A typed filter input type named `collectionName_filter` with per-field operator inputs and `_and`/`_or` combinators'
      ]
    },
    { type: 'h3', text: 'Relation fields' },
    {
      type: 'p',
      text: 'Fields that have a registered relation in `nivaro_relations` are resolved as nested types rather than raw scalar values:'
    },
    {
      type: 'table',
      head: ['Relation type', 'GraphQL field type', 'Resolver'],
      rows: [
        ['M2O (many-to-one FK)', 'RelatedType (nullable)', 'Fetches related record by FK value'],
        [
          'O2M (one-to-many virtual)',
          '[RelatedType!]!',
          'Fetches all records pointing back to parent'
        ],
        ['M2M (many-to-many virtual)', '[OtherType!]!', 'Joins through junction table']
      ]
    },
    {
      type: 'pre',
      code: `# M2O — FK field resolves to a full object
query {
  inventory_requests_by_id(id: "abc") {
    id
    project {        # M2O: project_id FK → projects table
      id
      name
      division { name }   # nested M2O
    }
  }
}

# O2M — virtual field returns array
query {
  projects_by_id(id: "xyz") {
    id
    name
    inventory_requests {   # O2M: all requests for this project
      id
      status
    }
  }
}`
    },
    { type: 'h3', text: 'Links that may point at several collections' },
    {
      type: 'p',
      text: 'A relation whose junction names the target\'s collection per row (a contact that is a user or an external address, a log entry about an invoice or a workflow) reads as a list of `<collection>_<field>_m2a` rows: `id` is the junction row, the discriminator column says which collection, `item_id` the stored id, and `item` is a union of the allowed collections\' types — select the arms you want with `... on`. Users read as the `User` type. The field takes `collection: ["…"]` to keep only links into those collections, and `limit` / `offset` over the links. A link into a collection the schema does not carry, or one the caller cannot read, resolves `item: null`.'
    },
    {
      type: 'pre',
      code: `{
  inventory_request(limit: 5) {
    id
    internal_contact(collection: ["directus_users"]) {
      id
      collection
      item {
        __typename
        ... on User { id email firstName lastName }
        ... on additional_emails { id email }
      }
    }
  }
}`
    },
    { type: 'h3', text: 'Permissions on nested fields' },
    {
      type: 'p',
      text: "A nested field is read with the caller's own access to the related collection. Read permission, row filters, user scopes and the policy's field list all apply, exactly as they do when the related collection is queried on its own. A to-many field returns only the rows the caller may read; a to-one field returns `null` when the caller may not read the related record. API keys that carry scope restrictions are narrowed the same way, whoever owns them."
    },
    { type: 'h3', text: 'Scalar type mapping' },
    {
      type: 'table',
      head: ['Nivaro field type', 'GraphQL type'],
      rows: [
        ['string, text, uuid, hash, csv', 'String'],
        ['integer, bigInteger', 'Int'],
        ['float, decimal', 'Float'],
        ['boolean', 'Boolean'],
        ['datetime, date, time', 'String (ISO 8601)'],
        ['json', 'JSON (custom scalar — any value)'],
        ['id field (any type)', 'ID']
      ]
    }
  ]
}

export const graphqlQueries: DocSection = {
  id: 'graphql-queries',
  label: 'Queries',
  content: [
    { type: 'h1', id: 'graphql-queries', text: 'Queries' },
    { type: 'h3', text: 'List query' },
    {
      type: 'p',
      text: 'A list query returns the items directly. Page facts (`total`, `limit`, `offset`) live on the sibling `<collection>_metadata` query, which takes the same `filter` / `search` / `limit` / `offset` arguments — ask for both in one request when you paginate.'
    },
    {
      type: 'pre',
      code: `query {
  articles(
    filter: { status: { _eq: "active" } }
    sort: ["-created_at"]
    limit: 10
    offset: 0
    search: "fiber"
  ) {
    id
    name
    status
  }
  articles_metadata(
    filter: { status: { _eq: "active" } }
    search: "fiber"
    limit: 10
    offset: 0
  ) {
    total
    limit
    offset
  }
}`
    },
    { type: 'h3', text: 'Single item query' },
    {
      type: 'pre',
      code: `query {
  articles_by_id(id: "123") {
    id
    name
    status
    owner_id
  }
}`
    },
    { type: 'h3', text: 'List query arguments' },
    {
      type: 'table',
      head: ['Argument', 'Type', 'Description'],
      rows: [
        [
          'filter',
          'JSON',
          'Filter DSL object — same operators as REST (e.g. { status: { _eq: "active" } })'
        ],
        ['sort', '[String]', 'Array of sort fields. Prefix with - for descending.'],
        ['limit', 'Int', 'Max items (server default: 25, max: 1000).'],
        ['offset', 'Int', 'Row offset for pagination.'],
        ['search', 'String', 'Fulltext search across string/text fields.'],
        [
          'after',
          'String',
          'Keyset paging: "start" for the first page, then the next_cursor of the page before. Replaces offset.'
        ]
      ]
    },
    { type: 'h3', text: 'Walking a large collection' },
    {
      type: 'p',
      text: "Ask for the rows and for `<collection>_metadata` with the same arguments. `next_cursor` is the `after` of the next page and null on the last one. Sort by the record's own stored fields; `id` is added as the tie-break."
    },
    {
      type: 'pre',
      code: `query Walk($after: String!) {
  orders(sort: ["-amount"], limit: 500, after: $after) { id amount }
  orders_metadata(sort: ["-amount"], limit: 500, after: $after) { next_cursor }
}
# first call: { "after": "start" }, then the next_cursor of each answer`
    },
    { type: 'h3', text: 'Nested lists take the list arguments' },
    {
      type: 'p',
      text: 'A to-many field inside a record takes `filter`, `sort`, `limit` and `offset` of its own. The rows are the ones the caller may read in the related collection.'
    },
    { type: 'h3', text: 'Aggregates' },
    {
      type: 'p',
      text: '`<collection>_aggregated(filter, search, groupBy, sort, limit, offset)` answers counts, sums and averages over the rows the same filter would list for the caller. Which figures are computed is read from the selection, so a query pays for what it asks.'
    },
    {
      type: 'pre',
      code: `query {
  # one row for the whole set
  orders_aggregated(filter: { status: { _eq: "open" } }) {
    countAll
    sum { amount }
    avg { amount }
    count { vendor }
  }

  # one row per group, largest first
  byType: orders_aggregated(groupBy: ["order_type"], sort: ["-sum.amount"]) {
    group
    countAll
    sum { amount }
    max { created_at }
  }
}`
    },
    {
      type: 'note',
      text: '`group` is a JSON object of the group-by values. `sum` and `avg` list number fields; `min` and `max` list number, date and short text fields; `count` and `countDistinct` list every stored field. Up to 4 group fields and 1000 groups per page. A refusal carries `extensions.code` (`AGGREGATE_FIELD_INVALID`, `AGGREGATE_TOO_WIDE`, `AGGREGATE_SORT_INVALID`).'
    }
  ]
}

export const graphqlFilters: DocSection = {
  id: 'graphql-filters',
  label: 'Typed Filters',
  content: [
    { type: 'h1', id: 'graphql-filters', text: 'GraphQL — Typed Filters' },
    {
      type: 'p',
      text: 'Every collection gets a generated `collectionName_filter` input type with typed operator inputs per field — no raw JSON required. The filter arg is fully type-safe in GraphiQL autocomplete.'
    },
    { type: 'h3', text: 'Scalar filters' },
    {
      type: 'pre',
      code: `query {
  inventory_requests(filter: {
    status: { _eq: "pending" }
    amount: { _gt: 50000 }
    title: { _contains: "fiber" }
    submitted_at: { _nnull: true }
  }) {
    id status amount
  }
}`
    },
    { type: 'h3', text: 'Logical combinators' },
    {
      type: 'pre',
      code: `query {
  projects(filter: {
    _or: [
      { status: { _eq: "active" } }
      { priority: { _gte: 3 } }
    ]
  }) {
    id name status
  }
}`
    },
    { type: 'h3', text: 'M2O nested filter' },
    {
      type: 'p',
      text: 'Use the relation alias (field name without `_id`) to filter across the join. Generates a `WHERE EXISTS` subquery — no cartesian product.'
    },
    {
      type: 'pre',
      code: `# Requests from a specific division (M2O chain)
query {
  inventory_requests(filter: {
    project: {
      division: { name: { _eq: "Network Engineering" } }
    }
  }) {
    id title
  }
}`
    },
    { type: 'h3', text: 'Filters that are not fields' },
    {
      type: 'p',
      text: 'Every collection filter also takes `_state`, `_origin`, `_addendums`, `_at_risk` and `_integrations`. They are the REST keys `$state`, `$origin` and so on, spelled with an underscore because a GraphQL name cannot start with `$`. They work at every depth, inside `_and` / `_or` and inside relation filters.'
    },
    {
      type: 'pre',
      code: `query {
  # started, and touched by an integration in the last 7 days
  orders(filter: {
    _state: { _in: ["started"] }
    _origin: { _in: [integration], days: 7 }
  }) { id }

  # never edited by a person, or with an addendum in flight
  orders_metadata(filter: {
    _or: [{ _origin: { _nin: [person] } }, { _addendums: active }]
  }) { total }
}`
    },
    { type: 'h3', text: 'Filtering on the link itself' },
    {
      type: 'p',
      text: 'A many-to-many filter takes `_link`, which filters the junction row of the link: a membership that only applies in one region, a role on the link. Inside `_some` or `_none` it must hold on the same link as the other keys. On its own it means "some link like this".'
    },
    {
      type: 'pre',
      code: `query {
  articles(filter: {
    tags: { _some: { name: { _eq: "featured" }, _link: { region_id: { _eq: 3 } } } }
  }) { id }
}`
    },
    { type: 'h3', text: 'Linked records inside `_some`' },
    {
      type: 'p',
      text: "Inside `_some` and `_none` the filter of the related collection is typed in full, so it may follow that record's own links: a many-to-one field, a further to-many relation, or both. A part that cannot be compiled is refused with a code (`FILTER_OPERATOR_UNKNOWN`, `FILTER_PATH_UNSUPPORTED`, `UNKNOWN_FIELD`); it is never dropped."
    },
    {
      type: 'pre',
      code: `query {
  orders(filter: {
    lines: { _some: { product: { category: { name: { _eq: "cables" } } } } }
  }) { id }
}`
    },
    { type: 'h3', text: 'O2M / M2M filters' },
    {
      type: 'p',
      text: 'Use `_some` (at least one match) or `_none` (no matches) for one-to-many and many-to-many relations.'
    },
    {
      type: 'pre',
      code: `# Projects that have at least one pending request
query {
  projects(filter: {
    inventory_requests: { _some: { status: { _eq: "pending" } } }
  }) {
    id name
  }
}

# Requests not tagged "archived"
query {
  inventory_requests(filter: {
    tags: { _none: { label: { _eq: "archived" } } }
  }) {
    id title
  }
}`
    },
    {
      type: 'table',
      head: ['Filter type', 'Input type', 'Notes'],
      rows: [
        [
          'String / text / hash / csv',
          'StringFilter',
          '_eq _neq _contains _ncontains _starts_with _ends_with _in _nin _null _nnull'
        ],
        ['Integer / bigInteger', 'IntFilter', '_eq _neq _gt _gte _lt _lte _in _nin _null _nnull'],
        ['Float / decimal', 'FloatFilter', 'Same as IntFilter'],
        ['Boolean', 'BoolFilter', '_eq _neq _null _nnull'],
        ['Datetime / date / time', 'DateFilter', '_eq _neq _gt _gte _lt _lte _null _nnull'],
        ['UUID / id fields', 'IDFilter', '_eq _neq _in _nin _null _nnull'],
        [
          'O2M / M2M virtual',
          'col_field_relation_filter / col_field_m2m_filter',
          '_some _none wrapping the related collection filter'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Every registered collection is exposed in GraphQL, including hidden ones — `hidden` is a UI flag (keep it out of the nav), not an API exclusion. Junction collections therefore have full query/mutation fields (e.g. delete_workflows_files_items), matching the REST items API.'
    }
  ]
}

export const graphqlSort: DocSection = {
  id: 'graphql-sort',
  label: 'Nested Sort',
  content: [
    { type: 'h1', id: 'graphql-sort', text: 'GraphQL — Nested Sort' },
    {
      type: 'p',
      text: 'The `sort` argument accepts an array of field paths. Prefix with `-` for descending. Dotted paths traverse M2O relations via `LEFT JOIN`.'
    },
    {
      type: 'pre',
      code: `# Simple multi-field sort
query {
  inventory_requests(sort: ["-submitted_at", "title"]) {
    id title submitted_at
  }
}

# Sort by related field (M2O)
query {
  inventory_requests(sort: ["project.name", "-submitted_at"]) {
    id title
  }
}

# Two-hop M2O sort
query {
  inventory_requests(sort: ["project.division.name"]) {
    id title
  }
}`
    },
    {
      type: 'table',
      head: ['Path', 'Behaviour'],
      rows: [
        ['field', 'ORDER BY field ASC'],
        ['-field', 'ORDER BY field DESC'],
        ['relation.field', 'LEFT JOIN relation → ORDER BY relation.field ASC'],
        ['-relation.field', 'LEFT JOIN relation → ORDER BY relation.field DESC'],
        ['a.b.field', 'LEFT JOIN a → LEFT JOIN b → ORDER BY b.field ASC']
      ]
    },
    {
      type: 'note',
      text: 'Only M2O hops are supported in sort paths. O2M and M2M are intentionally excluded — a row has many related values so there is no single value to sort by.'
    }
  ]
}

export const graphqlMutations: DocSection = {
  id: 'graphql-mutations',
  label: 'Mutations',
  content: [
    { type: 'h1', id: 'graphql-mutations', text: 'Mutations' },
    {
      type: 'p',
      text: 'Every collection has three mutation fields: create, update, and delete. They follow the same naming pattern as query fields.'
    },
    { type: 'h3', text: 'Create' },
    {
      type: 'pre',
      code: `mutation {
  create_articles(data: {
    name: "New Article"
    status: "draft"
    body: "Content here..."
    author_id: "user-42"
  }) {
    id
    name
    status
    created_at
  }
}`
    },
    { type: 'h3', text: 'Update' },
    {
      type: 'pre',
      code: `mutation {
  update_articles_item(id: "123", data: {
    status: "published"
    body: "Updated content..."
  }) {
    id
    name
    status
    updated_at
  }
}`
    },
    { type: 'h3', text: 'Delete' },
    {
      type: 'pre',
      code: `mutation {
  delete_articles_item(id: "123") {
    id
    name
  }
}`
    },
    { type: 'h3', text: 'Mutation response' },
    {
      type: 'p',
      text: 'Mutations return the full record as it was after the operation. Request any fields you need — the operation executes regardless. Validation errors return `400` with details.'
    },
    {
      type: 'table',
      head: ['Mutation', 'Arguments', 'Auth'],
      rows: [
        [
          'create_collectionName',
          'data: JSON (all fields optional)',
          'User with create permission'
        ],
        [
          'create_collectionName_item',
          'data: JSON — Directus-compatible alias',
          'User with create permission'
        ],
        [
          'create_collectionName_items',
          'data: [JSON] — batch, one row per entry',
          'User with create permission'
        ],
        [
          'update_collectionName_item',
          'id: ID!, data: JSON (partial)',
          'User with update permission'
        ],
        [
          'update_collectionName_items',
          'ids: [ID!]!, data: JSON — the same change to several records',
          'User with update permission'
        ],
        [
          'update_collectionName_batch',
          'data: [JSON] — each entry is { id, …fields }',
          'User with update permission'
        ],
        ['delete_collectionName_item', 'id: ID!', 'User with delete permission'],
        [
          'delete_collectionName_items',
          'ids: [ID!]! — batch, returns { ids }',
          'User with delete permission'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Create/update payloads accept Directus-era relation shapes: an M2O may be `{ id: … }`, and an M2M alias may be a single object, an array of `{ junction_field: { id } }` entries, or `{ create: [...] }` — alias writes are additive (junction rows are created, never detached).'
    },
    { type: 'h3', text: 'Rehearse a create' },
    {
      type: 'p',
      text: '`create_<collection>_dry_run(data)` answers the same report as REST `?dry_run=1`, as JSON: the record as it would be stored, what the server would fill, the keys stored nowhere, and the refusal if there is one. Nothing is stored and no number is taken.'
    },
    {
      type: 'pre',
      code: `mutation {
  create_orders_dry_run(data: { customer: 12, note: "test" })
}
# → { "data": { "create_orders_dry_run": { "dry_run": true, "ok": true, "would": "create", "status": 201, "data": { ... } } } }`
    },
    { type: 'h3', text: 'Changing several records in one call' },
    {
      type: 'pre',
      code: `mutation {
  # the same change to each
  update_orders_items(ids: [11, 12, 13], data: { status: "approved" }) { id status }

  # a different change per record
  update_orders_batch(data: [
    { id: 11, total: 120 },
    { id: 12, total: 80, status: "held" }
  ]) { id total status }
}`
    },
    {
      type: 'ul',
      items: [
        'Each record is changed as the caller, one after the other, with the same rules as a single update.',
        'All or nothing. When one record is refused, the records changed before it get their earlier values back and the error says so.',
        'At most 500 records per call.'
      ]
    },
    { type: 'h3', text: 'Refused mutations' },
    {
      type: 'p',
      text: 'A refused mutation answers HTTP 200 with `errors`. Each error carries `extensions.code` and `extensions.status`, the same code and status the REST API gives for the same refusal. Refusals that list details carry them too: `violations`, `conflicts`, `fields`, `nested`.'
    },
    {
      type: 'pre',
      code: `{
  "errors": [{
    "message": "A linked record does not exist (fk_orders_customer)",
    "path": ["create_orders_item"],
    "extensions": { "code": "LINKED_RECORD_MISSING", "status": 422 }
  }],
  "data": null
}`
    },
    { type: 'h3', text: 'When a create matches an existing record' },
    {
      type: 'p',
      text: "A create whose values match an existing record on the collection's natural key updates that record. The response names each such record under `extensions.upserts`."
    },
    {
      type: 'pre',
      code: `{
  "data": { "create_forecasts_item": { "id": 8812 } },
  "extensions": {
    "upserts": [{ "collection": "forecasts", "matched_id": 8812, "keys": ["order", "year"] }]
  }
}`
    },
    { type: 'h3', text: 'Create a record with its related rows' },
    {
      type: 'p',
      text: "One-to-many rows ride inside `data` under the relation's field name, and the selection set can read them straight back. One mutation replaces the create-parent, read-id, create-children sequence."
    },
    {
      type: 'pre',
      code: `mutation {
  create_orders_item(data: {
    customer: { id: 42 }
    lines: [
      { product: { id: 7 }, quantity: 2, price: 19.5 }
      { product: { id: 9 }, quantity: 1, price: 120 }
    ]
    payments: [{ amount: 159, method: "card" }]
  }) {
    id
    total
    lines { id quantity price }
    payments { id amount }
  }
}`
    },
    {
      type: 'note',
      text: 'Rows are created in payload order through the normal create path, as the caller. A refused row undoes the whole create and the error names it (`lines[2]: …`). On update, rows with an id are changed in place, rows without one are added, `{delete: [ids]}` removes and `{set: [...]}` replaces the child set; a plain array never removes. Many-to-many links take the same `set` / `delete` forms under the relation name, and a polymorphic link names its collection. See Items API → Create with related rows and Links under a relation name.'
    },
    {
      type: 'note',
      text: 'The `data` argument accepts the `JSON` scalar — pass a plain object with the fields you want to set. Unknown fields are ignored; field-level permission checks apply.'
    },
    { type: 'h3', text: 'Safe retries' },
    {
      type: 'p',
      text: 'Send an `Idempotency-Key` header with a mutation request. A repeat of the same request under the same key returns the first answer and writes nothing. A mutation that answered with `errors` releases its key, so the retry runs again. Queries are never deduplicated. See Items API → Safe retries with Idempotency-Key for the full rules.'
    }
  ]
}

export const graphqlSubscriptions: DocSection = {
  id: 'graphql-subscriptions',
  label: 'Subscriptions',
  content: [
    { type: 'h1', id: 'graphql-subscriptions', text: 'GraphQL Subscriptions' },
    {
      type: 'p',
      text: 'Nivaro supports GraphQL subscriptions over WebSocket using the `graphql-ws` protocol. Connect to the dedicated WebSocket endpoint:'
    },
    {
      type: 'pre',
      code: `// WebSocket endpoint (graphql-ws protocol)
ws://your-host/api/graphql-ws

// Authenticate via connectionParams:
{ "authorization": "Bearer <static-token>" }`
    },
    { type: 'h3', text: 'Available subscriptions' },
    {
      type: 'table',
      head: ['Subscription', 'Arguments', 'Fires when'],
      rows: [
        [
          'workflowStateChanged',
          'collection, item',
          'A workflow instance transitions to a new state.'
        ],
        [
          'pipelineStateChanged',
          'collection, item',
          'A pipeline instance transitions to a new state.'
        ],
        [
          'itemMutated',
          'collection, item, fields, actions',
          'A record is created, updated or deleted. `fields` narrows to updates that changed one of the named fields; `actions` narrows to create, update or delete.'
        ]
      ]
    },
    { type: 'h3', text: 'Example — subscribe to field changes' },
    {
      type: 'pre',
      code: `subscription {
  itemMutated(collection: "orders", fields: ["status", "total"]) {
    collection
    item
    action
    changed_fields
    at
  }
}

// { "itemMutated": { "collection": "orders", "item": "1001",
//   "action": "update", "changed_fields": ["status"], "at": "…" } }`
    },
    {
      type: 'ul',
      items: [
        'Leave `item` out to hear the whole collection, or pass an id to hear one record.',
        'The event names what changed and never carries values. Read the record to get them, so your permissions apply.',
        'Subscribing needs read permission on the collection.',
        'Writes made through the REST API, GraphQL, imports that use the items service and automation all produce events. Writes made by raw SQL do not.'
      ]
    },
    { type: 'h3', text: 'Example — subscribe to workflow changes' },
    {
      type: 'pre',
      code: `subscription {
  workflowStateChanged(collection: "projects", item: "123") {
    collection
    item
    state {
      key
      label
      color
    }
    timestamp
  }
}`
    },
    { type: 'h3', text: 'Example — using graphql-ws client' },
    {
      type: 'pre',
      code: `import { createClient } from 'graphql-ws'

const client = createClient({
  url: 'ws://nivaro.example.com/api/graphql-ws',
  connectionParams: { authorization: 'Bearer your-token' },
})

const unsub = client.subscribe(
  {
    query: \`subscription {
      workflowStateChanged(collection: "projects", item: "123") {
        state { key label }
        timestamp
      }
    }\`,
  },
  {
    next: (data) => console.log(data),
    error: console.error,
    complete: () => console.log('done'),
  },
)

// Later:
unsub()`
    },
    {
      type: 'h3',
      text: 'Authentication'
    },
    {
      type: 'p',
      text: 'Pass a static token via `connectionParams.authorization`. The server validates it before allowing subscriptions. Session cookies are not supported on WebSocket — use static tokens.'
    },
    {
      type: 'note',
      text: 'The GraphiQL explorer at `GET /api/graphql` does not support subscriptions (HTTP-only). Use a WebSocket-capable client such as graphql-ws or a tool like Altair GraphQL Client.'
    }
  ]
}

export const graphqlAuth: DocSection = {
  id: 'graphql-auth',
  label: 'Authentication',
  content: [
    { type: 'h1', id: 'graphql-auth', text: 'GraphQL Authentication' },
    {
      type: 'p',
      text: 'GraphQL requests authenticate the same way as REST requests — session cookie or static token Bearer header. Unauthenticated requests are allowed to reach the endpoint but all resolvers return `UNAUTHENTICATED` errors.'
    },
    { type: 'h3', text: 'Using GraphiQL' },
    {
      type: 'p',
      text: 'Open `GET /api/graphql` in a browser. If you are already logged in to the admin UI your session cookie is sent automatically. To use a static token instead, open the Headers panel at the bottom of GraphiQL and add:'
    },
    {
      type: 'pre',
      code: `{ "Authorization": "Bearer 3a7f2b9c1d4e..." }`
    },
    { type: 'h3', text: 'Programmatic requests' },
    {
      type: 'pre',
      code: `// With fetch
const res = await fetch('https://nivaro.example.com/api/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer 3a7f2b9c...',
  },
  body: JSON.stringify({ query: '{ articles { id name } articles_metadata { total } }' }),
})
const { data, errors } = await res.json()

// With axios
import axios from 'axios'

const client = axios.create({
  baseURL: 'https://nivaro.example.com',
  headers: { Authorization: 'Bearer 3a7f2b9c...' },
})

const { data } = await client.post('/api/graphql', {
  query: '{ articles { id name } articles_metadata { total } }',
})`
    },
    {
      type: 'note',
      text: 'Permissions are evaluated per field — you can request any fields in a query, but only permitted ones are resolved. Missing fields in the response indicate permission denial.'
    }
  ]
}

export const graphqlRebuild: DocSection = {
  id: 'graphql-rebuild',
  label: 'Schema Rebuild',
  content: [
    { type: 'h1', id: 'graphql-rebuild', text: 'Schema Rebuild' },
    {
      type: 'p',
      text: 'When you register a new collection or field via the Collections API, the GraphQL schema is not automatically updated — it was built at server startup. Call the rebuild endpoint to pick up the changes without restarting.'
    },
    {
      type: 'pre',
      code: `POST /api/graphql/rebuild
Authorization: Bearer <admin-token>

→ 200 { "ok": true, "types": 42 }`
    },
    {
      type: 'h3',
      text: 'When to rebuild'
    },
    {
      type: 'ul',
      items: [
        'After registering a new collection via `POST /api/collections`',
        'After adding a new field via `POST /api/collections/:name/fields`',
        'After registering a new relation that affects type generation',
        'After hiding/unhiding a collection or field that affects schema visibility'
      ]
    },
    {
      type: 'note',
      text: 'Rebuild is admin-only. It is safe to call at any time — in-flight GraphQL requests use the old schema until they complete; new requests after the rebuild use the updated schema.'
    },
    { type: 'h3', text: 'Changelog and deprecation policy' },
    {
      type: 'p',
      text: 'Every rebuild that changes the schema writes a line-level diff (`+ type`, `- workflows.old_field`) to the changelog, `GET /api/graphql/changelog` (admin), and a removal notifies administrators. A field is retired in two steps: mark it deprecated in the Table Editor (Behavior → Deprecated for API callers, with a note naming the replacement) — the schema then carries `@deprecated(reason: …)` and clients that introspect see it — and remove it once the policy window has passed. Removing a served field before then is refused with `409` `FIELD_NOT_DEPRECATED` or `FIELD_DEPRECATION_TOO_RECENT`, naming the date it becomes removable; an administrator may force it with `?force=1`, which the activity log records. The window is Settings → Content → API field deprecation window: blank = 14 days, 0 = no policy.'
    }
  ]
}
