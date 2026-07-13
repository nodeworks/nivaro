import type { DocSection } from '../types.js'

export const opsBackups: DocSection = {
  id: 'backups',
  label: 'Backups',
  content: [
    { type: 'h1', id: 'backups', text: 'Backups' },
    {
      type: 'p',
      text: 'Settings → Backups downloads a logical backup of the instance: a gzip stream of newline-delimited JSON, one record per row, with a meta header line describing the export.'
    },
    {
      type: 'pre',
      code: `GET /api/backups/export?include_system=true   (admin)
GET /api/backups/manifest?include_system=true  (admin — what would be exported)

// stream shape (gunzip → one JSON object per line)
{"type":"nivaro-backup","version":1,"exported_at":"…","tables":[…]}
{"table":"projects","row":{…}}
{"table":"projects","row":{…}}`
    },
    {
      type: 'ul',
      items: [
        'Business collections come from the schema registry (physical tables only).',
        'include_system=true adds nivaro_* configuration tables — schema registry, roles, policies, workflows, layouts.',
        'Volatile/derived tables are always excluded: sessions, API logs, page views, embeddings, queue caches, migrations.',
        'Files on disk/object storage are not part of the stream — back the storage root or bucket up separately.'
      ]
    },
    { type: 'note', text: 'Export only. Restore into a live instance is intentionally not offered through the API.' }
  ]
}

export const opsContentPromotion: DocSection = {
  id: 'content-promotion',
  label: 'Content Promotion',
  content: [
    { type: 'h1', id: 'content-promotion', text: 'Content Promotion' },
    {
      type: 'p',
      text: 'Move records between instances (staging → production) with a diff preview. Export a bundle on the source, load it on the target, review per-collection create/update/unchanged counts, then apply.'
    },
    {
      type: 'pre',
      code: `POST /api/promotion/export  { "collections": ["projects", "regions"] }
POST /api/promotion/preview { "bundle": { … } }   // diff only, no writes
POST /api/promotion/apply   { "bundle": { … } }   // id-keyed upsert`
    },
    {
      type: 'ul',
      items: [
        'Upserts by primary key: changed rows update, missing rows insert (identity PKs handled), matching rows skip.',
        'Never deletes target data, and only writes columns that exist on the target table.',
        'Business collections only, capped at 10,000 rows per collection per bundle.',
        'Admin-only; exports and applies are activity-logged.'
      ]
    },
    { type: 'warn', text: 'Apply is a write operation on production data — always read the preview table first. The admin page (System → Content Promotion) enforces this order.' }
  ]
}

export const opsFileUsage: DocSection = {
  id: 'file-usage',
  label: 'File Usage',
  content: [
    { type: 'h1', id: 'file-usage', text: 'File Usage' },
    {
      type: 'p',
      text: 'Answers "where is this file referenced, and can I safely delete it?". Discovery is foreign-key driven: every column with a FK into nivaro_files counts as a usage site.'
    },
    {
      type: 'pre',
      code: `GET /api/files/:id/usage        → { usages: [{ table, column, count }], total }
GET /api/files/usage/orphans    → files referenced by nothing (admin)`
    },
    {
      type: 'ul',
      items: [
        'Files page: the link icon on each row shows referencing tables and counts; "Not referenced anywhere" means safe to delete.',
        'The All / Unused toggle in the header lists orphaned files — deletion candidates.',
        'Columns holding file ids without a real FK constraint are invisible to the scan — add the constraint rather than special-casing.'
      ]
    }
  ]
}

export const opsPermissionSimulator: DocSection = {
  id: 'permission-simulator',
  label: 'Permission Simulator',
  content: [
    { type: 'h1', id: 'permission-simulator', text: 'Permission Simulator' },
    {
      type: 'p',
      text: 'Roles → Simulator answers "what would a user with this role see?" by running the same checks the API enforces: policy match, field allow-list, row-level security, tree permissions, and hidden admin pages.'
    },
    {
      type: 'pre',
      code: `POST /api/roles/:id/simulate   (admin)
{ "collection": "projects", "action": "read", "item_id": "42" }

→ { "allowed": true,
    "reason": "Allowed by the 'projects' 'read' policy",
    "fields": null,                 // null = all fields
    "row_filter": [{ "field": "owner", "op": "eq", "value": "$CURRENT_USER" }],
    "tree_permission": { "result": null, "note": "No tree rules apply" },
    "ui_disabled_routes": ["/settings"] }`
    },
    {
      type: 'ul',
      items: [
        'Every verdict carries a reason — which policy matched (exact vs wildcard) or why access is denied.',
        'Pass item_id to evaluate subtree rules for a specific record.',
        'Admin-access roles short-circuit: all checks bypass.'
      ]
    }
  ]
}

export const opsErrorTracking: DocSection = {
  id: 'error-tracking',
  label: 'Error Tracking',
  content: [
    { type: 'h1', id: 'error-tracking', text: 'Error Tracking' },
    {
      type: 'p',
      text: 'Server 5xx responses and admin UI render crashes are captured into the Issues log automatically — no external service required.'
    },
    {
      type: 'ul',
      items: [
        'Server: any unhandled error on an /api route creates an issue with route, message, and stack.',
        'Client: the admin error boundary reports crashes via POST /api/issues/client with the component stack.',
        'Dedupe: repeats of the same error (fingerprint of source + route + message) bump occurrence_count on the open issue instead of flooding the list.',
        'Resolving an issue and hitting the error again opens a fresh issue — regressions surface as new rows.'
      ]
    },
    { type: 'note', text: 'Issues appear at /issues with severity high, source server or client, and a live last-seen timestamp.' }
  ]
}

export const opsErdView: DocSection = {
  id: 'erd-view',
  label: 'ERD View',
  content: [
    { type: 'h1', id: 'erd-view', text: 'ERD View' },
    {
      type: 'p',
      text: 'Data Model → ERD renders the whole schema as an interactive entity-relationship diagram: every registered collection as a node, every relation as an edge.'
    },
    {
      type: 'ul',
      items: [
        'M2M junction pairs collapse into a single dashed edge labeled with the junction table.',
        'Hover a table to highlight its relations and neighbors; the FK field name appears on each highlighted edge.',
        'Scroll to zoom, drag to pan, search to highlight, click a table to open it in the Table Editor.',
        'Layout groups connected tables near each other automatically.'
      ]
    }
  ]
}
