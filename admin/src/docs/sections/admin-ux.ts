import type { DocSection } from '../types.js'

export const adminUxGlobalSearch: DocSection = {
  id: 'global-search',
  label: 'Global Search (Cmd+K)',
  content: [
    { type: 'h1', id: 'global-search', text: 'Global Search (Cmd+K)' },
    {
      type: 'p',
      text: 'Press Cmd+K (Ctrl+K on Windows/Linux) anywhere to open the command palette. It searches across every collection you can read, plus admin pages and quick actions, and ranks results as you type.'
    },
    {
      type: 'pre',
      code: `GET /api/global-search?q=acme
// → { items: [...per-collection matches...], pages: [...], actions: [...] }`
    },
    {
      type: 'ul',
      items: [
        'Item results respect RBAC — only collections the user can read are searched.',
        'Page results jump straight to admin routes (e.g. "sla" → SLA Rules).',
        'Action results trigger things like "Create item in …" or "Switch workspace".'
      ]
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
      text: 'A configured collection browser state — filters, sort, visible columns — can be saved as a named view (`nivaro_saved_views`). Views appear as pills above the filter bar for one-click switching, and can be kept private, shared with everyone, or scoped to a role.'
    },
    {
      type: 'ul',
      items: [
        'Save the current browser state with "Save view"; pick private, shared, or role-scoped visibility.',
        'Clicking a pill applies the stored filters/sort/columns instantly.',
        'Shared and role-scoped views are read-only for non-owners; owners and admins can update or delete them.'
      ]
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
      text: 'The import wizard gains a "From URL" tab: paste a link to a CSV (or JSON array) and the server fetches it and feeds it into the normal import queue — column mapping, duplicate strategy, and live progress all work identically to file uploads.'
    },
    {
      type: 'pre',
      code: `POST /api/imports/from-url
{ "collection": "products", "url": "https://example.com/export.csv" }`
    },
    {
      type: 'warn',
      text: 'The fetch is SSRF-guarded — URLs resolving to private, loopback, or link-local addresses are rejected, as on every other server-side fetch in Nivaro.'
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
      text: 'In the import wizard\'s mapping step, "Map with AI" sends the CSV headers and a data sample to Claude, which proposes a column → field mapping. Each suggestion carries a confidence badge; accept all, or fix individual mappings before continuing.'
    },
    {
      type: 'pre',
      code: `POST /api/ai/map-columns
{ "collection": "products", "headers": ["SKU", "Product Name", "Unit Price"], "sample": [ ... ] }
// → { "mappings": [ { "column": "SKU", "field": "sku", "confidence": 0.97 }, ... ] }`
    },
    {
      type: 'note',
      text: 'Requires an Anthropic API key (env or Settings → AI Features). Without one the button is hidden and manual mapping works as before.'
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
      text: 'The collection browser gains an "Ask AI" bar: describe what you want in natural language ("orders over 5000 created last month, not yet shipped") and Claude translates it into the filter DSL, which is applied as a normal filter you can inspect and tweak.'
    },
    {
      type: 'pre',
      code: `POST /api/ai/query
{ "collection": "orders", "prompt": "orders over 5000 from last month that are not shipped" }
// → { "filter": { "_and": [
//      { "total": { "_gt": 5000 } },
//      { "created_at": { "_gte": "2026-05-01" } },
//      { "status": { "_neq": "shipped" } } ] } }`
    },
    {
      type: 'note',
      text: 'The generated filter is applied client-side through the existing filter bar — nothing is executed that the user could not build by hand, and RBAC applies unchanged.'
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
      text: 'Records can be searched by meaning rather than keywords. Text fields are embedded into vectors stored in `nivaro_embeddings`; a semantic query embeds the search text and returns the nearest records by cosine similarity.'
    },
    {
      type: 'pre',
      code: `POST /api/search/semantic
{ "collection": "articles", "query": "onboarding new customers", "limit": 10 }
// → ranked items with similarity scores

POST /api/search/semantic/reindex     # rebuild embeddings (admin)
{ "collection": "articles" }`
    },
    {
      type: 'ul',
      items: [
        'Embeddings provider: Voyage AI when VOYAGE_API_KEY is set; otherwise a local hashing fallback (cheaper, lower quality, zero external calls).',
        'Embeddings update on item create/update; use the reindex endpoint after bulk imports or after switching providers.'
      ]
    },
    {
      type: 'warn',
      text: 'Vectors from different providers are not comparable — after switching between Voyage and the local fallback, run a full reindex or results will be meaningless.'
    }
  ]
}
