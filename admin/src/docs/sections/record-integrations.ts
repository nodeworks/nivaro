import type { DocSection } from '../types.js'

export const recordIntegrations: DocSection = {
  id: 'record-integrations',
  label: 'Integrations on the Record',
  content: [
    { type: 'h1', id: 'record-integrations', text: 'Integrations on the Record' },
    {
      type: 'p',
      text: 'The record form answers four questions about partner systems without anyone opening a log: what the next push will tell each partner, whether a push is ready before its button is pressed, which outside caller last wrote a field, and every change an inbound caller made.'
    },
    { type: 'h2', id: 'record-integrations-next-push', text: 'What goes out next' },
    {
      type: 'p',
      text: 'The Integrations chip in the record header opens a dialog whose first block lists, per partner, what the next push would change compared with the payload that partner last received: "MWF will receive on next push: State, PO number". Below it, each step out of the current state that sends to that partner, and when it actually sends — every time the step runs, or only when what it would send has changed (`push_when`). Expand a card for every value that would change, last sent vs next push. Values under credential-looking names are shown as changed but never printed. A record that has sent nothing yet still opens the dialog: the next push is its first.'
    },
    {
      type: 'p',
      text: 'The preview runs the real push path read-only: the same `skip_when_empty` / `skip_unless_any` gates, the guard, the context queries and the payload template — then compares with the newest accepted or pending submission to the same endpoint. Nothing is sent, written, or opened on the obligation ledger.'
    },
    {
      type: 'pre',
      code: 'GET /api/integration-preview/:collection/:item/outbound\n→ { data: { state, integrations: [{ api_name, endpoint_path, first_push, last, summary, changes: [{ path, from, to }], triggers: [{ transition_label, auto, available, when, status, reason }] }] } }'
    },
    { type: 'h2', id: 'record-integrations-readiness', text: 'Push readiness' },
    {
      type: 'p',
      text: 'A transition that carries a partner push shows a small chip beside its button in the record header: a green "Ready", or what stands in the way. Click it for the list — "2 lines missing Sales order" names the lines, and each line or field jumps into view (the form switches to the step that holds it and opens the line). The same chip appears on the Integrations dialog next to each step, and beside item actions that can pre-flight.'
    },
    {
      type: 'ul',
      items: [
        'Block — the transition would refuse: a requirement the lines or the record do not meet yet, a condition that does not hold, a blocking push whose guard fails.',
        'Warn — the transition goes through, but a push would be skipped by its guard, could not be built, or would leave a contract-required value empty.',
        'Could not check — the pre-flight itself failed. Never read as ready.'
      ]
    },
    {
      type: 'pre',
      code: 'GET /api/integration-preview/:collection/:item/preflight?transition_id=<id>\nGET /api/item-actions/:id/preflight?collection=&item=\n→ { data: { ready, issues: [{ severity, message, field?, collection?, rows? }], pushes? } }'
    },
    {
      type: 'p',
      text: 'An extension item action opts in by declaring `preflight({collection, itemId, userId})` beside `execute` — the same pre-validations `execute` runs, read-only, returning `ItemActionPreflightIssue[]` (`@nivaro/extension-kit`). Actions without it show no chip. Available transitions carry `pushes` (how many partner pushes they send), so the header only asks about the ones that send something.'
    },
    {
      type: 'p',
      text: 'Anything can bring a field or a line of the open record into view by dispatching `nvr:record-focus` on window with `{collection, item, field}` or `{collection, item, childCollection, rowId}` (`focusRecordTarget` in @nivaro/react).'
    },
    { type: 'h2', id: 'record-integrations-provenance', text: 'Who wrote a field' },
    {
      type: 'p',
      text: 'A field last written by a call on a static token or an API key names its caller — the API key’s name, else the account’s — instead of just "integration": "Order sync · 2h ago" under a header figure, and the same on the field in Summary mode. Click it for the request: method, path, status, when; administrators also see the body and can replay it; "Show the path it took" opens everything that request set off.'
    },
    {
      type: 'p',
      text: 'Every activity row records the credential it arrived on: `nivaro_activity.auth_method` (session, token, api_key, masquerade, key_sim) and `api_key_id` (migration 384). A named key acts as its owner, so before this a partner’s writes through a key read as that person’s edits. Rows written before the migration fall back to the writer’s account kind (a machine identity).'
    },
    {
      type: 'pre',
      code: 'GET /api/revisions/field-touch?collection=&item=&fields=a,b\n→ { data: { <field>: { at, who, via, activity_id, caller: { name, kind, key } | null } } }\nGET /api/inbound-attribution/activity/:id/request\n→ { data: { log_id, method, path, status, auth, api_key_name, user_name, at, chain_id, body, matched_by } | null }'
    },
    {
      type: 'note',
      text: 'The request is found through the event chain (exact) or, for writes without one, the same caller’s nearest call within a couple of minutes ("matched by time"). The request log keeps 14 days; older writes still name their caller but no longer open a request.'
    },
    { type: 'h2', id: 'record-integrations-inbound-log', text: 'Inbound changes, per caller' },
    {
      type: 'p',
      text: 'Inbound writes appear in the record’s Notes thread as their own entries — "Order sync · changed Vendor, Amount" — under the Integration filter, each with a Request button. On API Analytics → Inbound calls, picking a caller card lists every record change that caller made, newest first, with the record linked and the request one click away.'
    },
    {
      type: 'pre',
      code: 'GET /api/inbound-attribution/changes?caller=k<api key id>|u<user id>&hours=168&page=1\n→ { data: [{ activity_id, at, action, collection, item, record_label, fields, sentence, caller }], has_more }'
    }
  ]
}
