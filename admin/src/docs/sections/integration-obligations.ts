import type { DocSection } from '../types.js'

export const integrationObligations: DocSection = {
  id: 'integration-obligations',
  label: 'Integration Obligations',
  content: [
    { type: 'h1', id: 'integration-obligations', text: 'Integration Obligations' },
    {
      type: 'p',
      text: 'An obligation is a ledger row that says a partner SHOULD hear about a record, opened the moment the condition that creates that expectation becomes true — not when a send is attempted. It is then resolved with an outcome. `sent` is one good outcome; `skipped` with a written reason is another, just as good. The point is that every "no" is now on the record: an unmet guard, a `skip_when_empty`/`skip_unless_any` gate, an unconfigured action and a flow condition that rejected are all equally invisible today, and equally visible once they write a row here.'
    },
    { type: 'h2', id: 'integration-obligations-outcomes', text: 'The seven outcomes' },
    {
      type: 'table',
      head: ['Outcome', 'Meaning'],
      rows: [
        [
          'pending',
          'Opened, awaiting a decision — the normal state between the trigger firing and the send attempt resolving.'
        ],
        ['sent', 'Delivered. Closed.'],
        [
          'skipped',
          'Deliberately not sent, with a reason (a guard, an empty context, `push_when` deciding nothing changed). Closed — and a GOOD outcome, not a failure.'
        ],
        [
          'failed',
          'An attempt was made and the partner rejected it or the call errored. Still open — it wants a retry or a person.'
        ],
        [
          'overdue',
          'The reconcile sweep looked again after the grace window and the partner still does not have it — either a `pending`/`failed` row that never resolved, or a `skipped` row whose expectation STILL HOLDS, which means the guard that skipped it was wrong.'
        ],
        [
          'missing',
          'The reconcile sweep found an expectation with NO obligation row behind it at all — the trigger that should have opened one never fired. The one outcome that says the wiring itself is broken, not just the send.'
        ],
        [
          'superseded',
          'The record moved on before this obligation was ever resolved (a later transition, a newer expectation) — closed, and correctly ignored from then on.'
        ]
      ]
    },
    {
      type: 'note',
      text: '`sent` and `superseded` are pruned from the ledger after 180 days. `skipped` is kept — its reason is the evidence the wrong-guard detector reads. `failed`, `overdue`, `missing` and `pending` are never pruned: an unanswered question does not expire.'
    },
    {
      type: 'h2',
      id: 'integration-obligations-reconcile',
      text: 'Reconciliation vs. the triggers'
    },
    {
      type: 'p',
      text: "Every decision point a kind is registered for (a transition action, a flow, a hook) opens and resolves its own obligation as it runs — that is the TRIGGER path, and it can only ever write what it itself observed. The `integration-reconcile` cron runs separately and asks a different question: derived from DATA ALONE, what does the partner not have right now? A kind's `expect(db)` function returns the records the partner is behind on — never records where something happened, only where it has not — and the sweep compares that list against the ledger:"
    },
    {
      type: 'ul',
      items: [
        'An expectation with no obligation row at all → a new `missing` row. The trigger never fired.',
        "A `pending` or `failed` row still open past the API's `ack_grace_minutes` → `overdue`.",
        'A `skipped` row whose expectation STILL HOLDS past `skip_grace_minutes` → `overdue`, because the guard that skipped it has not actually stopped being true.',
        'An expectation that no longer applies (the record moved past the state that created it) → the open row closes `superseded`.'
      ]
    },
    {
      type: 'warn',
      text: 'Reconciliation never sends anything. It only reads and writes ledger rows — the sweep answers "what does the partner not have", it never tries to fix it. A `missing` or `overdue` row is a person\'s job, or (Phase 2) an explicitly opted-in `safe_to_refire` kind.'
    },
    { type: 'h2', id: 'integration-obligations-register', text: 'Registering a kind' },
    {
      type: 'p',
      text: 'Core knows the SHAPE of an obligation; which sends exist is data, registered by whichever extension owns the integration. A decision point core cannot attribute to a registered kind writes nothing at all — an install with no registrations behaves exactly as it did before this feature existed, and no partner name ever appears in core.'
    },
    {
      type: 'pre',
      code: `ctx.integrations.registerObligationKind({
  api: 'Partner',                 // matches nivaro_external_apis.name (or the
                                   // numeric id an erp_submit action stores,
                                   // resolved to the name before matching)
  kind: 'wf.state',                // a short machine key, scoped to this api
  collection: 'workflows',
  label: 'State push',             // what a person reads on the board / banner

  // Optional: several kinds can share one endpoint. A kind WITH a predicate
  // is preferred over a catch-all on the same api+collection; the predicate
  // sees the same context the decision point opened the obligation with
  // (endpoint_path, action_context_keys, action_skip_unless_any, …).
  matches(ctx) {
    return ctx.action_context_keys?.includes('legacy_state') === true
  },

  // Required: records the partner is BEHIND on, derived from data alone —
  // a returned row means "does not have this yet", never "this happened".
  async expect(db) {
    return db('workflows')
      .whereNotNull('last_state_change')
      .andWhere('last_state_change', '>', someCutoff)
      .select({ item: 'id', due_at: 'last_state_change' })
  },

  grace_minutes: 45,               // overrides the api's ack_grace_minutes
  safe_to_refire: false,           // Phase 2 only — may the sweep act alone?

  // Optional: "Send current data". Build the request from the record as it
  // is NOW (the same template the live sender renders). Offered to a person
  // only — the sweep never calls it. Return { refused } when it cannot send.
  async fresh_request(db, item) {
    return { endpoint_path: '/push', body: await buildBody(db, item), summary: 'Approved, PO 1042' }
  }
})`
    },
    {
      type: 'p',
      text: 'Send now repeats a stored request: the obligation\'s own, or — for a `safe_to_refire` kind — the newest earlier one. When nothing is safe to repeat (a status push whose stored body may be out of date, or a send that never happened) and the kind declares `fresh_request`, the record banner and the board offer **Send current data** instead. Its confirm names exactly what goes out ("This sends the record\'s current data (Waiting on Level 3 Approval, requisition PW27-81371, no PO) to LinX now — not the original request."). It goes through the normal send path into a new request row, and the line moves with the answer. Never offered for a kind that belongs to a person (`human`, e.g. a Fusion submit). Routes: `GET /api/integration-obligations/:id/fresh-preview` (builds, sends nothing) and `POST /api/integration-obligations/:id/send {fresh: true}` (admin, remediation switch on).'
    },
    {
      type: 'note',
      text: "A kind's `expect` function is a live read (typically a few filtered columns over the bound collection), not a stored expectation — it is asked fresh on every sweep, so a wiring fix or a schema change is picked up the next run with no backfill."
    },
    { type: 'h2', id: 'integration-obligations-surfaces', text: 'Where it shows up' },
    {
      type: 'ul',
      items: [
        'Board (`/integration-health`, admin-only) — one strip per api, a tile for each outcome with its live count, and `oldest_unmet` so the longest-standing gap sorts to the top.',
        "Record banner — the record's own open obligations render inline on the item, same posture as the ERP submission status badge, gated on the caller's read permission for that record's collection (not admin-only).",
        'Notes thread — a resolved obligation with a reason appears as a machine-authored entry on the record\'s Notes timeline, so "why wasn\'t this sent" has an answer sitting right next to the human conversation.',
        'Ask AI — the `integration_status` tool answers "why did X not get told about this record" directly: it runs as the asking user, gated on read permission for the record\'s collection (nivaro_*/directus_* refused outright, same as every other tool), and returns each obligation\'s api, kind, outcome, reason and trigger with no ids or internal columns the model could misread as a record key.'
      ]
    },
    {
      type: 'h2',
      id: 'integration-obligations-arming-preview',
      text: 'Before switching on: the arming preview'
    },
    {
      type: 'p',
      text: 'Settings → Integrations → "What the first cycle would do" runs the three Phase-2 passes as a dry run against today\'s ledger and shows the result, whichever way the two switches are set: the people the unmet-obligation notice would reach (with how many messages each would get, and the obligations nobody can be told about), the failed sends the retry ladder would try now, is waiting on, or would hand to a person — grouped by why they failed — and the missing messages that would be re-sent by repeating an earlier request, plus the kinds that are never re-sent automatically and how many rows each has waiting. Nothing is claimed, stamped or sent by looking.'
    },
    {
      type: 'pre',
      code: `GET /api/integration-obligations/arming-preview   // admin
// -> { data: {
//   notifications: { enabled, plan: { obligations, messages, recipientless,
//                                     recipients: [{ id, name, messages }], rows: [...] } },
//   remediation:   { enabled,
//                    retry:  { retry: [...], waiting: [...], give_up: [...], by_error_class: {...} },
//                    refire: { refire: [...], queued: [...], left_for_a_person: [...] } },
//   generated_at } }`
    },
    {
      type: 'note',
      text: 'The same functions run the real cycle: `alertUnmetObligations`, `runRetryPass` and `runMissingRefirePass` take `{ dryRun: true }` and return a `plan` instead of acting. Each pass works one batch at a time (200 notices, 50 retries, 25 re-sends), so the preview shows the first cycle, not the whole backlog.'
    },
    {
      type: 'h3',
      id: 'obligations-skip-sends',
      text: 'Records a partner does not take (skip_sends)'
    },
    {
      type: 'p',
      text: 'An external API can list values the partner must never receive in `integration_config.skip_sends`. Each rule names a field of the request body (a dotted path) and `starts_with` or `equals` (case does not matter), with an optional reason. A body that matches is not sent, by a transition action or a flow step, and its obligation is recorded as `skipped` with the reason (\u201cnot sent: workflow_id B254-1 \u2014 MWF does not support market B254 yet\u201d). The reconciliation sweep never turns such a skip into overdue.'
    },
    {
      type: 'pre',
      code: `{ "skip_sends": [
    { "field": "workflow_id", "starts_with": "B254-",
      "reason": "MWF does not support market B254 yet" } ] }`
    },
    {
      type: 'p',
      text: 'A flow\u2019s external API step that gets a 2xx answer whose body says it was accepted (OK / SUCCESS) records its obligation as `sent`; a bare 2xx stays `pending` until the partner acknowledges it.'
    }
  ]
}
