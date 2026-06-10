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
        ['GET /api/graphql', 'GraphiQL explorer — interactive browser IDE.'],
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
        'A list wrapper type named `collectionName_list` with `data`, `total`, `limit`, and `offset`',
        'Two query fields: `collectionName` (list) and `collectionName_by_id` (single)',
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
      type: 'pre',
      code: `query {
  articles(
    filter: { status: { _eq: "active" } }
    sort: ["-created_at"]
    limit: 10
    offset: 0
    search: "fiber"
  ) {
    data {
      id
      name
      status
    }
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
        ['search', 'String', 'Fulltext search across string/text fields.']
      ]
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
    data { id status amount }
    total
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
    data { id name status }
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
    data { id title }
  }
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
    data { id name }
  }
}

# Requests not tagged "archived"
query {
  inventory_requests(filter: {
    tags: { _none: { label: { _eq: "archived" } } }
  }) {
    data { id title }
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
      text: 'M2M/O2M wrapper types are only generated when the related collection is visible (not hidden). Hidden junction or system collections are skipped — filter those fields by FK value instead.'
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
    data { id title submitted_at }
  }
}

# Sort by related field (M2O)
query {
  inventory_requests(sort: ["project.name", "-submitted_at"]) {
    data { id title }
  }
}

# Two-hop M2O sort
query {
  inventory_requests(sort: ["project.division.name"]) {
    data { id title }
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
    { type: 'h3', text: 'Create' },
    {
      type: 'pre',
      code: `mutation {
  create_articles(data: { name: "New Project", status: "draft" }) {
    id
    name
    status
  }
}`
    },
    { type: 'h3', text: 'Update' },
    {
      type: 'pre',
      code: `mutation {
  update_articles_item(id: "123", data: { status: "active" }) {
    id
    status
  }
}`
    },
    { type: 'h3', text: 'Delete' },
    {
      type: 'pre',
      code: `mutation {
  delete_articles_item(id: "123") {
    id
  }
}`
    },
    {
      type: 'p',
      text: 'The `data` argument accepts the `JSON` scalar — pass a plain object with the fields you want to set. Unknown fields are ignored; field-level permission checks apply.'
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
        ['itemMutated', 'collection, item', 'An item is created, updated, or deleted.']
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
      code: `import { createClient } from 'graphql-ws';

const client = createClient({
  url: 'ws://nivaro.example.com/api/graphql-ws',
  connectionParams: { authorization: 'Bearer your-token' },
});

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
);

// Later:
unsub();`
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
  body: JSON.stringify({ query: '{ articles { data { id name } total } }' }),
})
const { data, errors } = await res.json()`
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
      type: 'note',
      text: 'Rebuild is admin-only. It is safe to call at any time — in-flight GraphQL requests use the old schema until they complete; new requests after the rebuild use the updated schema.'
    }
  ]
}
