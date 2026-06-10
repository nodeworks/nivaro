import type { DocSection } from '../types.js'

export const integrationsErp: DocSection = {
  id: 'erp-submissions',
  label: 'ERP Submission Status',
  content: [
    { type: 'h1', id: 'erp-submissions', text: 'ERP Submission Status Tracking' },
    {
      type: 'p',
      text: 'When records are pushed to an external ERP (or any downstream system), each push is tracked in `nivaro_erp_submissions` with a status lifecycle: submitted → pending → accepted / rejected. The item editor shows a status badge for the latest submission, and rejected submissions can be retried.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'The /erp-submissions page lists every submission across collections with status filters — drill into a submission to see its payload, the ERP response, and the retry history. On the record itself, the item edit page shows the latest status badge with the full history in a panel, including a Retry button for rejected submissions.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/erp-submissions?collection=orders&item=42   # history for a record
POST /api/erp-submissions                              # record a submission
{ "collection": "orders", "item": "42", "target": "sap", "status": "submitted", "payload": { ... } }

PATCH /api/erp-submissions/:id      # update status (e.g. from a callback/webhook)
{ "status": "accepted", "response": { "erp_id": "SO-1001" } }

POST /api/erp-submissions/:id/retry # re-run the submission`
    },
    {
      type: 'ul',
      items: [
        'Statuses: submitted, pending, accepted, rejected.',
        'The item edit page shows the latest status as a badge with the full history in a panel.',
        'Combine with flows: a flow pushes to the ERP via callExternalApi and records/updates the submission row.'
      ]
    }
  ]
}

export const integrationsSyncJobs: DocSection = {
  id: 'sync-jobs',
  label: 'Bi-Directional Sync Jobs',
  content: [
    { type: 'h1', id: 'sync-jobs', text: 'Bi-Directional Sync Jobs' },
    {
      type: 'p',
      text: 'Sync jobs keep a Nivaro collection aligned with an external API in either direction. A job (stored in `nivaro_sync_jobs`) defines the direction (pull or push), the External API to talk to, a field mapping, and a conflict strategy. Jobs run on a cron schedule or on demand.'
    },
    { type: 'h3', text: 'Configuration' },
    {
      type: 'table',
      head: ['Setting', 'Options', 'Meaning'],
      rows: [
        ['direction', 'pull | push', 'pull = external → Nivaro; push = Nivaro → external'],
        [
          'field mapping',
          'external path → collection field',
          'Dotted paths supported on the external side'
        ],
        [
          'conflict strategy',
          'newest-wins | source-wins | manual',
          'How concurrent edits on both sides resolve'
        ],
        ['schedule', 'cron expression', 'Optional; jobs can also be run manually']
      ]
    },
    {
      type: 'ul',
      items: [
        'Manage jobs at /sync-jobs — each job shows last run, rows processed, and errors.',
        '"Run now" triggers an immediate sync outside the schedule.',
        'manual conflict strategy parks conflicting rows for review instead of overwriting either side.'
      ]
    },
    {
      type: 'note',
      text: 'Sync jobs authenticate through External API configs, so credentials are managed centrally and never duplicated into the job.'
    }
  ]
}

export const integrationsConnector: DocSection = {
  id: 'api-connector',
  label: 'No-Code API Connector',
  content: [
    { type: 'h1', id: 'api-connector', text: 'No-Code API Connector' },
    {
      type: 'p',
      text: 'The External API editor gains a Connector tab that turns an API into a sync pipeline without writing code: fetch a sample response, explore the returned field tree, map external fields to collection fields by clicking, and generate a ready-to-run sync job.'
    },
    { type: 'h3', text: 'Flow' },
    {
      type: 'ul',
      items: [
        '1. Open an External API → Connector tab → set the sample endpoint and click "Fetch sample".',
        '2. The response is rendered as an expandable field tree (arrays and nested objects supported).',
        '3. Map fields: pick a target collection, then pair external paths with collection fields.',
        '4. Click "Generate sync job" — a pre-configured pull job appears in /sync-jobs ready to schedule.'
      ]
    },
    {
      type: 'note',
      text: 'The generated job is a normal sync job — edit its mapping, conflict strategy, or schedule afterwards like any other.'
    }
  ]
}

export const integrationsParallelBranches: DocSection = {
  id: 'parallel-branches',
  label: 'Parallel Workflow Branches',
  content: [
    { type: 'h1', id: 'parallel-branches', text: 'Parallel Workflow Branches (Split / Join)' },
    {
      type: 'p',
      text: 'A workflow instance can be split into parallel branches that progress independently — e.g. legal review and finance review happening at the same time. When every branch reaches a terminal state, the branches auto-join and the parent instance resumes.'
    },
    {
      type: 'pre',
      code: `// Split an instance into branches
POST /api/workflows/instance/:id/split
{ "branches": ["legal-review", "finance-review"] }   // state keys to start each branch in

// Each branch transitions independently via the normal transition endpoint.
// When ALL branches reach a terminal state, the join fires automatically
// and the parent instance continues.`
    },
    {
      type: 'ul',
      items: [
        'The workflow panel on item edit shows each active branch with its own state badge and transitions.',
        'Role gating applies per branch transition exactly as for linear workflows.',
        'Split/join events are recorded in the workflow history.'
      ]
    }
  ]
}

export const integrationsCrossTriggers: DocSection = {
  id: 'cross-collection-triggers',
  label: 'Cross-Collection Triggers',
  content: [
    { type: 'h1', id: 'cross-collection-triggers', text: 'Cross-Collection Triggers' },
    {
      type: 'p',
      text: 'Rules gain a `cross_collection` action type: when a record in one collection changes, create or update a record in another collection. Field values support `{{field}}` templates resolved against the triggering record.'
    },
    {
      type: 'pre',
      code: `// Rule action (Rules editor → action type "Cross-collection")
{
  "type": "cross_collection",
  "target_collection": "audit_entries",
  "operation": "create",
  "data": {
    "source": "orders",
    "order_number": "{{order_number}}",
    "note": "Order {{id}} moved to {{status}}"
  }
}

// Inspect configured triggers:
GET /api/cross-triggers`
    },
    {
      type: 'warn',
      text: 'Cross-collection writes can themselves fire rules. A recursion guard caps the trigger chain depth — beyond it, further cross-collection actions are skipped and logged rather than looping forever.'
    }
  ]
}
