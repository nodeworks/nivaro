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

POST /api/erp-submissions/:id/retry # re-run the submission
GET  /api/erp-submissions/:id       # one push in full (admin): partner, obligation,
                                    # trigger, who sent it, matched call logs, retry eligibility`
    },
    { type: 'h3', text: 'Who sent a push' },
    {
      type: 'p',
      text: "Every submission and every attempt records `requested_by` (the user, when a person was behind it) and `requested_via` (transition, auto-transition, flow, item-action, retry, resend, cron or api). A later Retry by someone else is that attempt's own requester. Pushes recorded before these columns existed are answered by inference — the partner call log's user, the transition made moments before, a person's edit of the record just before, or the schedule/flow that ran it — and the Integrations console marks those answers as inferred. Anything still unresolved reads \"Not recorded\"; machine accounts read as the account, never as a person."
    },
    {
      type: 'p',
      text: 'In the Integrations console, a Failed pushes row (and any row that is really a push or an import run) has a Details button that opens the push in place: the full error, every attempt with who started it, the request and response, what sent it and who, the matched call-log rows and a Retry that says why when it is not offered.'
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
    },
    {
      type: 'note',
      text: 'The write itself bypasses hooks (that is what keeps the chain from looping), but it still leaves history: every row a cross-collection action creates or changes gets an activity row with origin `machine` and the comment "Rule: <rule name>", a revision with the delta (where the target collection keeps revisions), a stored-rollup recalculation and an integrity re-check. A sync that changes nothing writes nothing.'
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
    { type: 'h2', id: 'integration-events-webhook-conditions', text: 'Webhook conditions' },
    {
      type: 'p',
      text: 'A webhook may carry `conditions`: a list of `{ "field", "op", "value" }` that a record must meet, all of them, before the webhook fires for it. An empty list sends every record of the chosen collections, as before. Operators: eq, neq, in (comma list), contains, gt, gte, lt, lte, null, nnull. A field is a column or a path through a relation of up to three parts, such as `vendor.name`.'
    },
    {
      type: 'pre',
      code: `PATCH /api/webhooks/12
{
  "conditions": [
    { "field": "status", "op": "eq", "value": "approved" },
    { "field": "total", "op": "gte", "value": 10000 }
  ]
}

// Would record 1001 fire it? Nothing is sent.
POST /api/webhooks/12/match
{ "collection": "orders", "item": 1001 }

// { "data": { "would_fire": false, "conditions_match": false,
//   "rules": [ { "field": "status", "op": "eq", "value": "approved",
//                "actual": "draft", "pass": false }, … ] } }`
    },
    {
      type: 'ul',
      items: [
        'The webhook editor has an "Only for records where" card with the same check: enter a record id and see which condition holds it back. Unsaved conditions are judged too.',
        'A deleted record is judged on its last values; relation paths are not available for it.',
        'When conditions cannot be judged, the webhook does not fire for that write.'
      ]
    },
    { type: 'h2', id: 'integration-events-webhook-payload', text: 'What a webhook receives' },
    {
      type: 'pre',
      code: `{
  "event": "update",
  "collection": "orders",
  "item": "1001",
  "origin": "person",
  "changed_fields": ["status", "total"],
  "data": { "id": 1001, "status": "approved", "total": 159 },
  "timestamp": "2026-09-27T14:03:11.000Z"
}`
    },
    {
      type: 'ul',
      items: [
        '`origin` says who made the write: person, machine, import or integration.',
        '`changed_fields` lists the fields an update changed. It is empty for a create or a delete. Housekeeping stamps such as the updated-at time are left out.',
        'Conditions may use both: `{ "field": "$origin", "op": "neq", "value": "import" }` skips imported rows, and `{ "field": "$changed", "op": "contains", "value": "status" }` fires only when status changed.',
        '`POST /api/webhooks/:id/match` accepts `origin` and `changed_fields` to judge such conditions for a record without sending anything.'
      ]
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
    { type: 'h3', id: 'integration-events-inbound-children', text: 'Child rows' },
    {
      type: 'p',
      text: "A mapping may also fill one-to-many fields. Each child set names the field, the payload path that holds the rows (`order.lines`; a single object reads as one row) and its own row rules — the import-template line format, with an optional row filter; `{{$resolved.<field>}}` reads a value the record rules produced. The record and all its rows go to the items service as ONE nested payload, so the write is all or nothing: a refused row removes everything, and the entry's result carries `child_error {field, index, message}` naming the payload row. On an upsert that finds the record, a set either adds its rows (`append`) or replaces the record's rows with exactly these (`replace`). Record rules may read nested payload keys with dots (`customer.name`)."
    },
    {
      type: 'pre',
      code: `"children": [
  {
    "target_field": "lines",            // a one-to-many field of the mapping's collection
    "source": "order.lines",            // where the rows are in the payload
    "row_filter": { "column": "qty", "op": "nnull" },
    "columns": [                        // same rule steps as the record rules
      { "target": "quantity", "source": "qty", "steps": [] },
      { "target": "sku", "source": "code", "steps": [{ "type": "trim" }] }
    ],
    "on_update": "append"               // or "replace"
  }
]
// result entry: { ..., "children": [{ "field": "lines", "found": 3, "rows": 2 }],
//                 "child_error": { "field": "lines", "index": 1, "message": "…" } }`
    },
    { type: 'h3', id: 'integration-events-inbound-fixtures', text: 'Fixtures' },
    {
      type: 'p',
      text: 'Fixtures are named partner payloads saved with the mapping (a column on the mapping row, so they travel with it through config copies, snapshots and diffs; at most 20, 64 KB each). Add one from a recent call to the endpoint — any token or API-key call kept its body in the request log — or paste it. Each fixture says what a correct mapping does with it: be written, or be refused (a known-bad payload kept as a guard). The editor re-runs every fixture whenever the rules, child rows or response change, saved or not, and shows green or red with the reason (`Entry 2: lines row 3 — price is required`). A run never writes: would-be creates go through the create pipeline (rules, validation, required fields) without the database insert, so a type or foreign-key refusal only shows on a real call.'
    },
    {
      type: 'pre',
      code: `GET    /api/inbound-mappings/:id/fixtures/candidates      // recent calls with a stored body
POST   /api/inbound-mappings/:id/fixtures                 // { name, payload, expect: write|reject } or { log_id }
PATCH  /api/inbound-mappings/:id/fixtures/:fid            // { name?, payload?, expect? }
DELETE /api/inbound-mappings/:id/fixtures/:fid
POST   /api/inbound-mappings/:id/fixtures/run             // { rules?, children?, response_template?, response_status? }
// → { fixtures: [{ id, name, expect, pass, reason, run, response }], passed, failed }`
    },
    { type: 'h3', id: 'integration-events-inbound-response', text: 'Response shaping' },
    {
      type: 'p',
      text: 'A partner that already parses an envelope keeps it: `response_template` is Liquid (the transition-payload filters, `jsonify` among them) rendered over `record` (the first record written), `records`, `created`, `updated`, `rejected`, `created_ids`, `updated_ids`, `errors` (index, message, issues, child), `results` and `outcome`. Output that parses as JSON is sent as JSON; anything else as text (XML when it starts with `<`). `response_status` maps the outcome — `success` (all written), `partial`, `rejected` — to a status; unset keeps 200 / 207 / 422, and it applies with or without a template. With no template the body is the standard `{data: {results, created, updated, rejected}}`. A template that fails to render never turns a landed write into an error: the standard body goes out. The dry-run tester and every fixture show the response the partner would get.'
    },
    {
      type: 'pre',
      code: `"response_template": "{\\"accepted\\": {{ created }}, \\"orderId\\": {{ record.id | jsonify }}, \\"errors\\": {{ errors | map: 'message' | jsonify }}}",
"response_status": { "success": 201, "rejected": 400 }`
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

export const integrationsOutboundTooling: DocSection = {
  id: 'outbound-call-tooling',
  label: 'Outbound Call Tooling',
  content: [
    { type: 'h1', id: 'outbound-call-tooling', text: 'Outbound Call Tooling' },
    {
      type: 'p',
      text: 'Everything an external API does on the wire is visible from its editor (External APIs → open an API): a flight recorder of every request, redaction rules, health probes with uptime, service levels, a record mode for mocks, and contracts proposed from real traffic.'
    },
    { type: 'h2', id: 'outbound-flight-recorder', text: 'Flight recorder' },
    {
      type: 'p',
      text: 'Every request an external API makes is recorded — partner calls through `callExternalApi` (with or without a call log), mocked answers, OAuth token fetches, health and token probes, editor test calls and SDK calls. Partner calls ride the always-on `nivaro_outbound_log` row (which now also keeps url, endpoint, trigger, headers and bodies); everything that is not a partner call lands in `nivaro_outbound_side_log` so it never moves partner health, failure signals or SLOs. Headers and bodies are kept 24 hours and blanked after; call rows stay 31 days for SLOs.'
    },
    {
      type: 'ul',
      items: [
        '`GET /api/external-apis/:id/recorder?hours=&kind=&failed=1` — the timeline, newest first. kind = call · mock · token · health · token_probe · test · lookup.',
        '`GET /api/external-apis/:id/recorder/:source/:rowId` — one request with headers, bodies and a Copy-as-curl (source = call | side).'
      ]
    },
    { type: 'h2', id: 'outbound-redaction', text: 'Redaction and Copy as curl' },
    {
      type: 'p',
      text: 'Anything whose name looks like a credential (authorization, cookie, *token*, *secret*, *key*, …) is always masked in headers, JSON bodies and query strings. `redaction` on the API adds its own rules: `{ "headers": ["x-partner-session"], "body_paths": ["customer.email", "items[].card", "*.ssn"] }` — header and query parameter names, and JSON body paths where `[]` walks every array element and `*` every key. The rules apply when a call is stored (recorder, call log, recorded mock answers) and again when it is shown. Copy as curl turns every masked value into a `<REDACTED:name>` placeholder for the operator to fill in; the recorder never held the real secret.'
    },
    { type: 'h2', id: 'outbound-health', text: 'Health probes and uptime' },
    {
      type: 'p',
      text: '`health_path` (plus `health_method` GET | HEAD and `health_expect_status`, default 200) turns probing on. The `external-api-health-probes` job probes every such API every 5 minutes on deployed instances (Run now works anywhere) and the editor has Probe now (`POST /api/external-apis/:id/probe`). An OAuth client-credentials API has its token endpoint probed separately first. The newest verdict is stamped on the API (`health_last_ok`, `health_last_at`, `health_last_detail`), `GET /api/external-apis/:id/uptime?hours=24` returns hourly buckets, and the Integrations console Partners card shows a 24-hour uptime strip. Mocked APIs are not probed.'
    },
    { type: 'h2', id: 'outbound-slo', text: 'Service levels and alerts' },
    {
      type: 'p',
      text: '`GET /api/external-apis/:id/slo?days=1|7|30` returns calls, p50 / p95 latency, error rate and availability (from probes when the API has any in the window, else from calls) with a daily trend. Mocked answers never count. Three metric definitions — External API error rate, p95 latency and availability — use the `external_api_slo` metric source; in the Alert Manager scope a rule by API name (or id) and window in minutes (default 15), e.g. "error rate above 5% over 15 minutes". Rules on these metrics are evaluated after every 5-minute probe cycle as well as on their own schedule.'
    },
    { type: 'h2', id: 'outbound-mock-record', text: 'Recording mock answers' },
    {
      type: 'p',
      text: 'Mock mode per instance gains `record: true` ("Record live answers" in the Mock mode card). While mock mode is off and record is on, every real answer the API gives on this instance with a status below 500 and a body under 64 KB becomes a rule for its method and exact path (`recorded_at` stamped, newest first, 200 rules at most; an unchanged answer writes nothing). Credential-looking values and the API\'s body paths are masked in the recorded body. Turn mock mode on later and the recorded answers replay when the partner host is down.'
    },
    { type: 'h2', id: 'outbound-contract-infer', text: 'Contract from real traffic' },
    {
      type: 'p',
      text: 'On a saved endpoint, "Generate from the last 50 calls" (`POST /api/external-apis/endpoints/:eid/contract/infer`) reads the last successful answers the endpoint gave — recorder bodies (24 hours) and the call log (30 days), matched by endpoint id or by method + path template — and proposes the contract they already satisfy: the statuses seen, and every path present in every answer with the type it always had (a path that was ever null keeps no type). Nothing is saved until the admin uses the proposal and saves the endpoint.'
    }
  ]
}
