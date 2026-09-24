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

export const integrationsEvents: DocSection = {
  id: 'integration-events',
  label: 'Integration Events & Replay',
  content: [
    { type: 'h1', id: 'integration-events', text: 'Integration Events & Replay' },
    {
      type: 'p',
      text: "Every integration that registers a notes source (`ctx.notes.registerSource`) can also answer two more questions: what happened lately across every record, and can this event be re-applied. The Events tab of the Integrations console (Operations → Integrations → Events; the old /integration-events address lands there) lists the newest events from every source grouped by day, with a status dot (ok / error / info), the record they belong to by its friendly id, and a Replay action where the source offers one. Filter by source and by status (All · Problems · OK · Info); Show older pages back through what the sources keep. The same Replay sits on the record's Notes thread beside each replayable external entry."
    },
    {
      type: 'pre',
      code: `// Extension side — list + replay are optional on a notes source
ctx.notes.registerSource({
  id: 'my-ext:orders',
  collection: 'orders',
  label: 'Order API',
  load: async (itemId) => [...],                 // per-record thread entries
  list: async ({ limit, status }) => [...],      // newest events across records
  replay: async (entryId, { userId }) => ({ detail: 'Re-applied shipment 123' })
})

// Routes
GET  /api/integration-events?provider=&status=&limit=&before=  // admin feed (integration= also accepted)
POST /api/integration-events/:provider/replay { entry_id } // admin, or update rights on the source collection
GET  /api/comments/related?collection=&item=               // entries carry provider, replayable, status`
    },
    {
      type: 'note',
      text: 'Replay means whatever the source says it means — the server only checks access, calls the provider, and logs `integration-event-replay` (or `-failed`) on the record. Requests that were pushed OUT are typically not replayable; events that arrived are.'
    },
    {
      type: 'h2',
      id: 'integration-events-header',
      text: 'Per-integration status in the record header'
    },
    {
      type: 'p',
      text: "A record that has been pushed to up to three integrations shows one chip per integration in its header — the LATEST push's status for that record (green accepted, blue pending, red failed) with the time and error on hover. More than three fold back into the External requests count."
    },
    { type: 'h2', id: 'integration-events-search', text: 'Searching submission payloads' },
    {
      type: 'p',
      text: "ERP Submissions gained a payload search: `GET /api/erp-submissions/search?q=&status=&external_api=&collection=&days=` looks through the stored payload, response, last error and external reference of the last 90 days (LIKE, admin only) and says where each hit matched. Clicking a hit loads that record's history."
    },
    { type: 'h2', id: 'integration-events-retry', text: 'Inline retries on external APIs' },
    {
      type: 'p',
      text: "An external API's `retry_policy` now carries `inline_retries` (0–3), `inline_backoff_ms` (100–10000, doubles per attempt) and `retry_on` (any of network, 5xx, 429). Transient failures are retried INSIDE `callExternalApi` before the call reports failure; the scheduled `max_attempts` / `backoff_minutes` pair remains the slow path for ERP pushes and is optional. GET returns the policy parsed."
    },
    {
      type: 'h2',
      id: 'integration-events-webhooks',
      text: 'Webhook test and replay with a payload'
    },
    {
      type: 'p',
      text: "`POST /api/webhooks/:id/test` accepts `{ delivery_id }` (resend a stored delivery's body) or `{ payload }` (any JSON); the response says `payload_source`: sample, delivery N or edited. `POST /api/webhooks/deliveries/:id/retry` accepts `{ payload }` too. The webhook editor lists recent deliveries with a Use-as-test-payload action that fills an editable payload box above the Test button."
    },
    { type: 'h2', id: 'integration-events-mock', text: 'Mock mode per instance' },
    {
      type: 'p',
      text: 'An external API row carries `mock_config` keyed by instance name (NIVARO_INSTANCE, else NODE_ENV): `{ "<instance>": { "enabled": true, "rules": [{ "method": "GET", "path": "/orders/*", "status": 200, "body": {…}, "delay_ms": 0 }], "fallback": { "status": 418, "body": {…} } } }`. While enabled on THIS instance, every `callExternalApi` answers from the first matching rule (exact path, or a prefix ending in `*`), then the fallback, else `200 {"mock": true}` — nothing leaves the process, the call still logs with a `[mock]` marker and the result carries `mock: true`. The API list shows a MOCK badge, the editor has a Mock mode card, and the readiness check `external-api-mock-mode` warns while any API is mocked here.'
    },
    { type: 'h3', text: 'Test endpoints, day to day' },
    {
      type: 'p',
      text: 'Every external API also carries `endpoint_environment` — read off the host this instance actually calls (its per-instance override wins): `test` when a host label is uat, stg, staging, sandbox, sbx, test, qa, dev, preprod or nonprod, `local` for loopback, else `live`. The API list shows a TEST badge with the label that decided it, and Integration Health leads with one strip naming every enabled integration on this instance that is mocked or pointed at a test host — fine before cutover, and the list that should read empty on go-live night. A heuristic, so an operator who names a live host `test-` gets a badge to read past, never a block.'
    },
    { type: 'h2', id: 'integration-events-instances', text: 'Per-instance credentials and hosts' },
    {
      type: 'p',
      text: '`instance_overrides` on the same row — `{ "<instance>": { "base_url", "auth_config": {…}, "headers": {…} } }` — is folded into the call for the current instance only (`resolveInstanceRow`), so staging and production share one API definition but reach different hosts with different secrets. Secrets are masked on read per instance and a masked value sent back keeps the stored one. The editor\'s “Per-instance credentials & host” card edits them; the Test call honours them too.'
    },
    { type: 'h2', id: 'integration-events-contracts', text: 'Endpoint contract tests' },
    {
      type: 'pre',
      code: `// On an endpoint (Endpoints card → Contract): what a healthy answer looks like
{
  "expect_status": 200,              // number or [200, 204]; default 2xx
  "expect_json": true,               // default
  "expect_paths": [
    { "path": "data", "type": "array" },
    { "path": "meta.version", "equals": 2 }
  ],
  "allow_mutation": false,           // POST/PUT/PATCH endpoints run only when true
  "timeout_ms": 15000
}

POST /api/external-apis/endpoints/:eid/contract/run   // one endpoint
POST /api/external-apis/:id/contracts/run             // every contract on the API
GET  /api/external-apis/contracts                     // targets
// cron external-api-contracts 02:20 nightly (dry-run lists the targets); a failing
// endpoint raises one deduped issue; readiness check external-api-contracts`
    },
    {
      type: 'p',
      text: 'The verdict is stamped on the endpoint (`contract_last_run`, `contract_last_ok`, `contract_last_detail`) and rendered as a pass / fail chip with a Run button on the endpoint row. Mock mode and instance overrides apply, so a contract can be exercised against mocked answers.'
    },
    { type: 'h2', id: 'integration-events-inbound', text: 'Inbound mappings' },
    {
      type: 'p',
      text: "Monitoring → Inbound Mappings defines a key an integration POSTs its OWN payload shape to. The mapping's rules are the import-template header-rule format (trim / remap / expression / lookup / const; source = a key on the posted object) and its target is a collection; mode `create` always inserts, `upsert` matches on the listed mapped fields first. `POST /api/inbound/<key>` takes one object or an array (≤500) from any authenticated caller and writes through the items service AS THAT CALLER — permissions, validation, hooks, activity all apply. The reply lists per-entry `created | updated | rejected` with the mapped values and issues (207 when some entries were rejected, 422 when all were). The editor's “Try a payload” panel dry-runs the rules as currently edited."
    },
    { type: 'h2', id: 'integration-events-replay-inbound', text: 'Replaying an inbound request' },
    {
      type: 'p',
      text: 'The request log keeps the JSON body of every inbound integration write (token or API-key caller, capped at 64 KB). Expanding such a row on API Analytics or the Integrations page shows the body with Replay and Edit & replay: `POST /api/api-analytics/requests/:id/replay { body? }` re-dispatches the same method and path in-process AS THE ADMIN who clicked (the original credential is never stored), tags the new request with `x-nivaro-replay-of`, and logs `api-request-replay`.'
    },
    {
      type: 'h2',
      id: 'integration-events-flows',
      text: 'Flow version diff and the field-watch trigger'
    },
    {
      type: 'p',
      text: "`GET /api/flows/:id/versions/:version/diff?against=current|N` returns the flow-level field changes plus added / removed / changed operations between two definitions; the flow editor's Versions card has a Diff button per version. Saving a flow whose definition matches the latest version mints no new version. Flows can also trigger on `field-watch` — fired whenever a watched field changes through the items service, with collection, item, field, watch_name, old and new in the payload."
    }
  ]
}
