import type { DocSection } from '../types.js'

export const adminUxGlobalSearch: DocSection = {
  id: 'global-search',
  label: 'Global Search (Cmd+K)',
  content: [
    { type: 'h1', id: 'global-search', text: 'Global Search (Cmd+K)' },
    {
      type: 'p',
      text: 'Press Cmd+K (Ctrl+K on Windows/Linux) anywhere in the admin UI to open the command palette. Search runs across every collection you have read access to, admin pages, and quick actions. Results are ranked by relevance and category as you type, with RBAC enforced on all item results.'
    },
    {
      type: 'h3',
      id: 'global-search-usage',
      text: 'Searching'
    },
    {
      type: 'p',
      text: 'Type a query and results appear in real-time. Use arrow keys to navigate, Enter to select. Ctrl+Enter for new-item quick action in selected collection.'
    },
    {
      type: 'pre',
      code: `// Keyboard shortcuts
Cmd+K (or Ctrl+K)     Open command palette
Arrow Up/Down          Navigate results
Enter                  Select highlighted result
Escape                 Close palette
Cmd+N                  Quick "Create in [collection]" (collection-filtered)`
    },
    {
      type: 'h3',
      id: 'global-search-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `GET /api/global-search?q=acme&limit=20

// Response
{
  "items": [
    {
      "collection": "customers",
      "id": "cust-123",
      "label": "Acme Corp",
      "highlight": "Acme Corp",
      "displayField": "name",
      "score": 0.95
    },
    {
      "collection": "orders",
      "id": "order-456",
      "label": "Order #123456 for Acme",
      "highlight": "Acme",
      "displayField": "title",
      "score": 0.87
    }
  ],
  "pages": [
    {
      "type": "page",
      "label": "SLA Rules",
      "route": "/sla-rules",
      "category": "Monitoring",
      "icon": "Clock"
    },
    {
      "type": "page",
      "label": "Workflows",
      "route": "/workflows",
      "category": "Automation",
      "icon": "GitBranch"
    }
  ],
  "actions": [
    {
      "type": "create",
      "label": "Create customer",
      "collection": "customers",
      "icon": "Plus"
    }
  ]
}`
    },
    {
      type: 'h3',
      id: 'global-search-behavior',
      text: 'Search Behavior'
    },
    {
      type: 'ul',
      items: [
        'Item results respect RBAC — only collections where user has read action are included',
        'Text fields are searched by fuzzy match; display field (collection label setting) is highlighted in results',
        'Page results index all admin routes (Collections, Workflows, Pipelines, etc.)',
        'Actions include quick-create for each accessible collection',
        'Score algorithm: partial matches score lower than prefix/exact matches; recent items boosted'
      ]
    },
    {
      type: 'h3',
      id: 'global-search-integration',
      text: 'Integration'
    },
    {
      type: 'p',
      text: 'Global search is built into AppLayout header and available on every admin page. No SDK method needed — it is UI-only and uses the same backend search as collection browser keyword filtering.'
    }
  ]
}

export const adminUxSavedViews: DocSection = {
  id: 'saved-views',
  label: 'Saved Views',
  content: [
    { type: 'h1', id: 'saved-views', text: 'Saved Views' },
    {
      type: 'p',
      text: 'Named collection browser states (filters, sort, visible columns) can be saved and shared. Saved views appear as pills above the filter bar for instant access, and support private, workspace-wide, or role-based visibility. This feature eliminates the need to rebuild complex filter combinations repeatedly.'
    },
    {
      type: 'h3',
      id: 'saved-views-crud',
      text: 'Creating and Managing Views'
    },
    {
      type: 'p',
      text: 'Configure your browser view (apply filters, set sort, select columns), then click "Save view". Assign a name and choose visibility: personal (private), shared (all users), or role-scoped (specific roles). Each view is a snapshot stored in `nivaro_saved_views`.'
    },
    {
      type: 'pre',
      code: `POST /api/saved-views
{
  "collection": "orders",
  "name": "High-value pending",
  "filters": {
    "_and": [
      { "total": { "_gt": 5000 } },
      { "status": { "_eq": "pending" } }
    ]
  },
  "sort": [{ "field": "created_at", "direction": "desc" }],
  "visible_columns": ["id", "customer", "total", "status", "created_at"],
  "visibility": "shared",
  "role_ids": null
}

// Response
{
  "id": "view-123",
  "collection": "orders",
  "name": "High-value pending",
  "created_by": "user-456",
  "created_at": "2026-06-15T10:30:00Z",
  "visibility": "shared"
}`
    },
    {
      type: 'h3',
      id: 'saved-views-loading',
      text: 'Loading and Switching'
    },
    {
      type: 'p',
      text: 'Saved view pills appear above the filter bar when you open a collection. Click any pill to apply its filters, sort, and column selection. The browser state updates instantly without reloading.'
    },
    {
      type: 'pre',
      code: `// Get all saved views for a collection
GET /api/saved-views?collection=orders

// Response
{
  "views": [
    {
      "id": "view-123",
      "name": "High-value pending",
      "visibility": "shared",
      "created_by": "user-456"
    },
    {
      "id": "view-124",
      "name": "My drafts",
      "visibility": "private",
      "created_by": "current-user"
    }
  ]
}

// Load specific view
GET /api/saved-views/view-123

// Returns full view config with filters, sort, columns`
    },
    {
      type: 'h3',
      id: 'saved-views-permissions',
      text: 'Visibility and Permissions'
    },
    {
      type: 'ul',
      items: [
        'Private: only the creator sees and can edit/delete the view',
        'Shared: visible to all users with read access to the collection; only creator and admins can edit/delete',
        'Role-scoped: visible only to members of specified roles; only creator and admins can edit/delete',
        'Users can create views if they have read access to the collection'
      ]
    },
    {
      type: 'h3',
      id: 'saved-views-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `POST /api/saved-views              Create view
GET /api/saved-views?collection=X  List views for collection
GET /api/saved-views/:id           Get view details
PATCH /api/saved-views/:id         Update view (creator/admin only)
DELETE /api/saved-views/:id        Delete view (creator/admin only)`
    },
    {
      type: 'note',
      text: 'Saved views are lightweight snapshots — they do not create named queries or stored procedures. On load, the browser applies the stored filter/sort/columns to a normal collection list request.'
    }
  ]
}

export const adminUxImportFromUrl: DocSection = {
  id: 'import-from-url',
  label: 'Bulk Import from URL',
  content: [
    { type: 'h1', id: 'import-from-url', text: 'Bulk Import from URL' },
    {
      type: 'p',
      text: 'The import wizard supports fetching CSV or JSON data directly from a URL. Paste a link in the "From URL" tab, and the server downloads it and feeds it into the standard import queue. Column mapping, duplicate handling, and live progress work identically to file uploads.'
    },
    {
      type: 'h3',
      id: 'import-from-url-workflow',
      text: 'Workflow'
    },
    {
      type: 'ul',
      items: [
        'Navigate to Imports → New → "From URL" tab',
        'Select target collection',
        'Paste a public CSV or JSON URL',
        'Map columns to fields (or use AI suggestion)',
        'Choose duplicate strategy (skip/update/error)',
        'Review and confirm'
      ]
    },
    {
      type: 'p',
      text: 'The server fetches and validates the file, then enqueues an import job. Progress is tracked live in the UI via Socket.io.'
    },
    {
      type: 'h3',
      id: 'import-from-url-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `POST /api/imports/from-url
{
  "collection": "products",
  "url": "https://example.com/exports/products.csv",
  "column_map": {
    "SKU": "sku",
    "Product Name": "name",
    "Unit Price": "price"
  },
  "duplicate_strategy": "update",
  "id_field": "sku"
}

// Response (enqueued job)
{
  "id": "job-123",
  "collection": "products",
  "status": "in_progress",
  "progress": {
    "processed": 0,
    "total": 1500
  },
  "created_at": "2026-06-15T10:30:00Z"
}`
    },
    {
      type: 'h3',
      id: 'import-from-url-supported-formats',
      text: 'Supported Formats'
    },
    {
      type: 'ul',
      items: [
        'CSV: RFC 4180, auto-detected headers from first row, UTF-8 encoding',
        'JSON: array of objects `[{col1, col2, ...}, ...]` or newline-delimited JSON (NDJSON)',
        'TSV: tab-delimited, auto-detected'
      ]
    },
    {
      type: 'h3',
      id: 'import-from-url-security',
      text: 'Security'
    },
    {
      type: 'ul',
      items: [
        'URL must be publicly accessible (SSRF-guarded: private IPs, loopback, link-local rejected)',
        'File size limited to 100MB',
        'Only admin users can initiate imports',
        'Credentials in URLs are logged and should not be used — use signed URLs or public endpoints'
      ]
    },
    {
      type: 'warn',
      text: 'SSRF Protection: requests to 127.0.0.1, 192.168.*, 10.0.0.0/8, link-local, or metadata endpoints (AWS, GCP, Azure) are rejected. Use publicly accessible, non-authenticated URLs.'
    }
  ]
}

export const adminUxAiMapping: DocSection = {
  id: 'ai-field-mapping',
  label: 'AI Field Mapping',
  content: [
    { type: 'h1', id: 'ai-field-mapping', text: 'AI Field Mapping (Import Wizard)' },
    {
      type: 'p',
      text: 'In the import wizard\'s mapping step, click "Map with AI" to have Claude automatically suggest column-to-field mappings. Send CSV headers and a data sample, receive confidence-ranked suggestions, and accept/edit before importing. This accelerates large bulk imports with complex headers.'
    },
    {
      type: 'h3',
      id: 'ai-mapping-workflow',
      text: 'Workflow'
    },
    {
      type: 'ul',
      items: [
        'Upload or paste CSV/JSON data',
        'Arrive at mapping step — click "Map with AI"',
        'Claude analyzes headers and sample rows, returns suggested mappings with confidence scores',
        'Review suggestions: green checkmarks (high confidence), yellow warnings (medium), or edit manually',
        'Click "Apply mappings" to accept all or keep selected edits'
      ]
    },
    {
      type: 'h3',
      id: 'ai-mapping-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `POST /api/ai/map-columns
{
  "collection": "products",
  "headers": ["SKU", "Product Name", "Unit Price", "Stock Qty", "Category"],
  "sample": [
    ["PROD-001", "Widget Pro", "49.99", "150", "Tools"],
    ["PROD-002", "Gadget Plus", "29.99", "200", "Electronics"]
  ]
}

// Response
{
  "mappings": [
    { "column": "SKU", "field": "sku", "confidence": 0.98 },
    { "column": "Product Name", "field": "name", "confidence": 0.97 },
    { "column": "Unit Price", "field": "price", "confidence": 0.96 },
    { "column": "Stock Qty", "field": "inventory_count", "confidence": 0.92 },
    { "column": "Category", "field": "category_id", "confidence": 0.85, "warning": "requires relation lookup" }
  ],
  "unmapped_columns": []
}`
    },
    {
      type: 'h3',
      id: 'ai-mapping-confidence',
      text: 'Confidence Scoring'
    },
    {
      type: 'ul',
      items: [
        '0.95+: Exact match between header and field name/label; safe to auto-apply',
        '0.80–0.95: Strong semantic match; review but likely correct',
        '0.60–0.80: Plausible match; manual verification recommended',
        '< 0.60: Uncertain; displayed for reference but not auto-applied'
      ]
    },
    {
      type: 'h3',
      id: 'ai-mapping-configuration',
      text: 'Configuration'
    },
    {
      type: 'ul',
      items: [
        'Requires Anthropic API key: set ANTHROPIC_API_KEY env var or configure in Settings → AI Features',
        'Uses claude-haiku-4-5 model for fast, cost-effective analysis',
        'Button is hidden if no API key is configured',
        'Fallback: manual column-to-field mapping always available'
      ]
    },
    {
      type: 'note',
      text: 'AI mapping is a suggestion layer — you retain full control to accept, edit, or discard any suggestion. The mapping is applied client-side before the import request, so all normal duplicate-strategy and validation rules apply unchanged.'
    }
  ]
}

export const adminUxAiQuery: DocSection = {
  id: 'ai-query-builder',
  label: 'AI Query Builder',
  content: [
    { type: 'h1', id: 'ai-query-builder', text: 'AI Query Builder' },
    {
      type: 'p',
      text: 'The collection browser includes an "Ask AI" bar where you describe records you want in plain English. Claude translates your request into the filter DSL, applies it as a normal browser filter, and displays results. You can inspect, edit, or refine the generated filter like any other filter.'
    },
    {
      type: 'h3',
      id: 'ai-query-usage',
      text: 'Usage'
    },
    {
      type: 'p',
      text: 'Open a collection, click the "Ask AI" bar at the top of the filter panel, and describe what you need. Examples: "high-value customers in California", "orders created last week that are not yet shipped", "invoices over 10000 with payment pending".'
    },
    {
      type: 'h3',
      id: 'ai-query-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `POST /api/ai/query
{
  "collection": "orders",
  "prompt": "orders with total over 5000 created in the last month that haven't been shipped"
}

// Response
{
  "filter": {
    "_and": [
      { "total": { "_gt": 5000 } },
      { "created_at": { "_gte": "2026-05-15" } },
      { "status": { "_neq": "shipped" } }
    ]
  },
  "explanation": "Matching orders with total > 5000, created since 2026-05-15, and status != shipped",
  "estimated_matches": 47
}`
    },
    {
      type: 'h3',
      id: 'ai-query-field-resolution',
      text: 'Field Resolution'
    },
    {
      type: 'p',
      text: 'Claude matches natural-language references to actual field names using the collection schema. Ambiguous field names are disambiguated using field labels and types. Relations are resolved by traversing FK paths (e.g., "customer in California" → "customer.state = California").'
    },
    {
      type: 'pre',
      code: `// Examples of field resolution
Prompt: "high-value customers"
→ Resolves to customer.lifetime_value > threshold

Prompt: "orders from last week"
→ created_at between [now-7days, now]

Prompt: "assigned to John"
→ assignee.name contains "John" (relation traversal)

Prompt: "priority is urgent or critical"
→ priority in ["urgent", "critical"] (multi-value OR)`
    },
    {
      type: 'h3',
      id: 'ai-query-limitations',
      text: 'Limitations'
    },
    {
      type: 'ul',
      items: [
        'Filter DSL only — no aggregations, sorting, or column selection',
        'Fuzzy field matching — ambiguous prompts may misinterpret fields; always review generated filter',
        'Single collection scope — cannot span unrelated collections (relations OK)',
        'Time references are relative (today, this month, last week); use dates for exact ranges'
      ]
    },
    {
      type: 'h3',
      id: 'ai-query-best-practices',
      text: 'Best Practices'
    },
    {
      type: 'ul',
      items: [
        'Be specific: "total > 1000" is better than "large orders"',
        'Use field names if you know them: "status = pending" is clearer than "incomplete"',
        'Review generated filters before running — Claude may misinterpret complex logic',
        'Combine with manual filters for fine-tuning; AI filter is a starting point, not final',
        'Use for ad-hoc queries; save useful filters as named views for repeated use'
      ]
    },
    {
      type: 'note',
      text: 'The AI query is applied client-side through the normal filter bar — all RBAC, row-level security, and field visibility rules apply. Nothing is executed that a user with sufficient permissions could not build manually.'
    }
  ]
}

export const adminUxSemanticSearch: DocSection = {
  id: 'semantic-search',
  label: 'Semantic Search',
  content: [
    { type: 'h1', id: 'semantic-search', text: 'Semantic Search' },
    {
      type: 'p',
      text: 'Search records by meaning and intent, not just keywords. Text fields are embedded into vectors stored in `nivaro_embeddings`. A semantic query embeds your search text and returns the nearest records by cosine similarity, enabling you to find relevant content even with different phrasing.'
    },
    {
      type: 'h3',
      id: 'semantic-search-how-it-works',
      text: 'How It Works'
    },
    {
      type: 'ul',
      items: [
        'Text fields (type: text, long_text) are automatically embedded into vectors on create/update',
        'Your search query is embedded using the same model',
        'Results are ranked by cosine similarity (0.0–1.0, higher = more relevant)',
        'Only fields marked as searchable are included in embeddings'
      ]
    },
    {
      type: 'h3',
      id: 'semantic-search-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `POST /api/search/semantic
{
  "collection": "articles",
  "query": "onboarding new customers",
  "limit": 10,
  "min_similarity": 0.75
}

// Response
{
  "results": [
    {
      "id": "article-123",
      "label": "Getting started with our platform",
      "similarity": 0.89,
      "matched_fields": ["title", "description"]
    },
    {
      "id": "article-456",
      "label": "First-time user guide",
      "similarity": 0.81,
      "matched_fields": ["description"]
    },
    {
      "id": "article-789",
      "label": "Account setup instructions",
      "similarity": 0.76,
      "matched_fields": ["content"]
    }
  ],
  "total": 3
}`
    },
    {
      type: 'h3',
      id: 'semantic-search-providers',
      text: 'Embedding Providers'
    },
    {
      type: 'p',
      text: 'Nivaro supports two embedding strategies:'
    },
    {
      type: 'ul',
      items: [
        'Voyage AI (recommended): Set VOYAGE_API_KEY env var. High-quality vectors, ~$0.02 per 1M tokens. Requires internet access. Recommended for production.',
        'Local hash fallback: No external calls, zero cost. Deterministic hashing of text. Lower quality but useful for testing or air-gapped deployments.'
      ]
    },
    {
      type: 'h3',
      id: 'semantic-search-configuration',
      text: 'Configuration'
    },
    {
      type: 'pre',
      code: `// .env
VOYAGE_API_KEY=pa-...   # Optional; falls back to local hash if unset

// Settings → Semantic Search
Enable semantic indexing: ON/OFF (per collection)
Min similarity threshold: 0.75 (default)`
    },
    {
      type: 'h3',
      id: 'semantic-search-reindex',
      text: 'Rebuilding Embeddings'
    },
    {
      type: 'p',
      text: 'Embeddings are updated automatically on create/update. Rebuild if:'
    },
    {
      type: 'ul',
      items: [
        'Switching embedding provider (Voyage → local or vice versa)',
        'After bulk import of historical data',
        'After updating searchable fields on the schema',
        'To refresh quality of existing embeddings'
      ]
    },
    {
      type: 'pre',
      code: `// Admin only
POST /api/search/semantic/reindex
{
  "collection": "articles"
}

// Response (async job)
{
  "job_id": "reindex-job-123",
  "collection": "articles",
  "status": "queued",
  "estimated_duration_seconds": 45
}`
    },
    {
      type: 'h3',
      id: 'semantic-search-performance',
      text: 'Performance'
    },
    {
      type: 'ul',
      items: [
        'First query: ~500ms (vendor API latency)',
        'Cached results: ~50ms (local similarity computation)',
        'Results cached per query string for 1 hour',
        'Reindexing: ~1 item per 100ms (speed depends on provider)'
      ]
    },
    {
      type: 'h3',
      id: 'semantic-search-limitations',
      text: 'Limitations'
    },
    {
      type: 'ul',
      items: [
        'Only searches text fields — numbers, dates, booleans are not embedded',
        'Language: English-optimized (Voyage AI supports 100+ languages)',
        'Cannot mix providers — reindex required when switching (vectors incompatible)',
        'Similarity threshold: 0.0–1.0 scale; tune based on collection content'
      ]
    },
    {
      type: 'warn',
      text: 'Provider mismatch: Vectors from Voyage AI and local hash are incompatible. Switching providers without reindexing produces meaningless results. Always run a full reindex after changing VOYAGE_API_KEY.'
    },
    {
      type: 'note',
      text: 'Semantic search respects RBAC and row-level security — only collections and records the user can read are searched.'
    }
  ]
}

export const adminUxListSignals: DocSection = {
  id: 'list-signals',
  label: 'Fulfilment, Send-backs & Back to Queue',
  content: [
    { type: 'h1', id: 'list-signals', text: 'Fulfilment, Send-backs & Back to Queue' },
    { type: 'h2', id: 'list-signals-fulfilment', text: 'Shipped n / m on lists' },
    {
      type: 'p',
      text: 'A collection whose records get fulfilled in parts (a request the warehouse ships line by line) declares its figures once, in `browser_config.fulfilment`: `{shipped_field, requested_field, remaining_field?, label?}` — plain columns, typically stored rollups over the record\'s lines. The collection browser and every queue over that collection then show a "Shipped n / m" pill per record (Not shipped / Partial / Shipped) with a matching filter. Hovering the pill shows the last three events an integration recorded on the record — the same entries the Notes thread lists. `remaining_field` is what lets the browser filter "Shipped" server-side; queues judge the status in memory.'
    },
    { type: 'h2', id: 'list-signals-send-backs', text: 'Sent back' },
    {
      type: 'p',
      text: 'Queues over a workflow-bound collection can show a Sent-back column: how many times the record moved backwards on its pipeline and the reason given the last time, with the edge and when on hover. Filter by "at least once", "2+ times" or "never", sort by count. Add it from Customize Columns; it lives on the live path, so a materialized queue live-resolves when it is filtered or sorted.'
    },
    { type: 'h2', id: 'list-signals-back', text: 'Back to the queue' },
    {
      type: 'p',
      text: 'Opening a record from a queue remembers where the queue was — scope, filters, sort, page, grouping and scroll position. The record shows a "Back to <queue>" chip above its content; it returns to the same URL and the worklist re-applies that state and scrolls back to the row. The memory lasts six hours and is per browser tab session.'
    },
    { type: 'h2', id: 'list-signals-open-tabs', text: 'Open in tabs' },
    {
      type: 'p',
      text: 'Select two or more rows in the collection browser or a queue and "Open in tabs" opens each record in its own tab (up to 15). Browsers allow a burst of tabs from one click only when pop-ups are allowed for the site — otherwise the first opens and the toast says how many were blocked.'
    },
    { type: 'h2', id: 'list-signals-recent', text: 'Recently viewed' },
    {
      type: 'p',
      text: 'The home page lists the records you opened last, with each one\'s current state, from the same per-user view watermarks the "since you last looked" recap uses (`GET /record-views/recent`). Collections you cannot read are skipped.'
    },
    { type: 'h2', id: 'list-signals-owner-load', text: 'Owner load' },
    {
      type: 'p',
      text: "Team Throughput ends with Owner load: open records per owner right now, split by state, with how many are past or near their SLA. It is computed live over every open instance with the same owner resolver and SLA evaluator the queues use, so it always agrees with each person's worklist (`GET /reports/owner-load?collection=`)."
    },
    {
      type: 'h2',
      id: 'list-signals-saved-view-widget',
      text: 'Dashboard widgets from a saved view'
    },
    {
      type: 'p',
      text: 'A dashboard widget of type "Saved view" counts — or, with a sum field, sums — exactly the rows a saved browser view shows. The view\'s filters compile the way the browser compiles them and the read runs as the viewer, so the number is the one that person would get in the browser. Every widget also takes its own refresh interval (15 s to hourly; default one minute).'
    },
    { type: 'h2', id: 'list-signals-sla-presets', text: 'SLA duration presets' },
    {
      type: 'p',
      text: 'The SLA rule editor offers presets under the hours box — 4 business hours, 1 / 2 / 3 / 5 business days, 24 or 72 calendar hours. A business day is the eight working hours the business-hours clock counts, so a business preset also switches that clock on; a calendar preset switches it off.'
    },
    { type: 'h2', id: 'list-signals-row-flags', text: 'Row flags on a catalog picker' },
    {
      type: 'p',
      text: 'A catalog-picker grid may declare `catalog_mode.row_flags: [{label, when}]` — `when` is a boolean expression over the child row (`{{shipped_qty}} > {{quantity}}`). A row the expression matches carries the label as an amber flag in the Summary table. Pair it with an extension-registered Data Integrity check when the sweep should report the same fact across records.'
    },
    {
      type: 'p',
      text: 'With a to-many `section_by`, `catalog_mode.link_filter` filters the JUNCTION row between item and section — for memberships that carry their own columns (an item that belongs to a category only in one region). An item lists under a section only through a link that passes, the catalog read requires one such link to an in-scope section (`_link` inside the `_some`), and an item with no passing link is left out rather than shown as Uncategorized. `$parent.<field>` tokens resolve and gate the list like `filter`.'
    },
    {
      type: 'p',
      text: 'An O2M whose rows are MEMBERSHIPS — one row per (member, scope), where a blank scope means "every scope" — can set `options.membership_set: {key_field, value_field, empty_label?, key_label?, value_label?}` on the inline-table field. The grid is replaced by one line per member with its scopes as a multi-select (toggle chips up to ten options, a searchable checklist beyond). Storage is unchanged: nothing picked = a single row with a blank scope; picks = one row per picked value. The first pick re-points the blank row and clearing the last pick blanks it again, so a member never drops out mid-edit. Writes are immediate and go through the items API.'
    }
  ]
}

export const adminUxFormCollaboration: DocSection = {
  id: 'form-collaboration',
  label: 'Form Collaboration & Drafts',
  content: [
    { type: 'h1', id: 'form-collaboration', text: 'Form Collaboration & Drafts' },
    {
      type: 'p',
      text: 'Four record-form behaviours for people working on the same records at the same time, or on the same record from two devices.'
    },
    { type: 'h2', id: 'form-collaboration-drafts', text: 'Unsaved drafts follow you' },
    {
      type: 'p',
      text: 'While a form is dirty its unsaved draft (changed fields, staged lines, staged links) is stored in the browser AND mirrored to the server about a second after each change (`PUT /api/drafts/:collection/:item`, one row per user + collection + record, 256 KB cap). Opening the record elsewhere — another browser, another device — offers “Restore your unsaved changes”; the newer of the local and server copies wins. Saving, Discard, or the form going clean deletes both copies. `GET /api/drafts` lists your own drafts.'
    },
    { type: 'h2', id: 'form-collaboration-section-lock', text: 'Section locked for a role' },
    {
      type: 'p',
      text: 'A layout section can be locked for specific roles (Table Editor → Layout → section ⚙ → “Locked for roles”, a sibling of “Hidden for roles”): those roles see every field in it read-only with the reason on the lock glyph, while the rest of the form stays editable. The server drops those fields from an update by a locked role (`nivaro_field_groups.locked_for_roles`); admins are exempt.'
    },
    {
      type: 'h2',
      id: 'form-collaboration-row-ghost',
      text: 'Someone changed the line you are editing'
    },
    {
      type: 'p',
      text: 'When a grid row is open in its editor and another person saves a change to that same row, a strip above the fields lists each changed field as was → now, with Take theirs (per field or all) and Keep mine. Fields you already set to their value are not listed, nor are write-computed columns that merely follow their inputs.'
    },
    { type: 'h2', id: 'form-collaboration-cursors', text: 'Shared cursors in grids' },
    {
      type: 'p',
      text: 'Beyond “Robert is editing this line”, the cell a colleague has focus in is outlined with their name — the grid announces `cell:<collection>:<row>:<field>` through the record-presence channel (window event `nvr:cell-editing`, relayed by the host as a `field:focus`), and the host marks the matching `[data-grid-cell]`.'
    }
  ]
}
