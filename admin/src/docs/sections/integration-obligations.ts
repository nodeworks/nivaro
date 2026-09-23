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
        ['pending', 'Opened, awaiting a decision — the normal state between the trigger firing and the send attempt resolving.'],
        ['sent', 'Delivered. Closed.'],
        ['skipped', 'Deliberately not sent, with a reason (a guard, an empty context, `push_when` deciding nothing changed). Closed — and a GOOD outcome, not a failure.'],
        ['failed', 'An attempt was made and the partner rejected it or the call errored. Still open — it wants a retry or a person.'],
        ['overdue', 'The reconcile sweep looked again after the grace window and the partner still does not have it — either a `pending`/`failed` row that never resolved, or a `skipped` row whose expectation STILL HOLDS, which means the guard that skipped it was wrong.'],
        ['missing', "The reconcile sweep found an expectation with NO obligation row behind it at all — the trigger that should have opened one never fired. The one outcome that says the wiring itself is broken, not just the send."],
        ['superseded', 'The record moved on before this obligation was ever resolved (a later transition, a newer expectation) — closed, and correctly ignored from then on.']
      ]
    },
    {
      type: 'note',
      text: '`sent` and `superseded` are pruned from the ledger after 180 days. `skipped` is kept — its reason is the evidence the wrong-guard detector reads. `failed`, `overdue`, `missing` and `pending` are never pruned: an unanswered question does not expire.'
    },
    { type: 'h2', id: 'integration-obligations-reconcile', text: 'Reconciliation vs. the triggers' },
    {
      type: 'p',
      text: 'Every decision point a kind is registered for (a transition action, a flow, a hook) opens and resolves its own obligation as it runs — that is the TRIGGER path, and it can only ever write what it itself observed. The `integration-reconcile` cron runs separately and asks a different question: derived from DATA ALONE, what does the partner not have right now? A kind\'s `expect(db)` function returns the records the partner is behind on — never records where something happened, only where it has not — and the sweep compares that list against the ledger:'
    },
    {
      type: 'ul',
      items: [
        'An expectation with no obligation row at all → a new `missing` row. The trigger never fired.',
        'A `pending` or `failed` row still open past the API\'s `ack_grace_minutes` → `overdue`.',
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
  safe_to_refire: false            // Phase 2 only — may the sweep act alone?
})`
    },
    {
      type: 'note',
      text: 'A kind\'s `expect` function is a live read (typically a few filtered columns over the bound collection), not a stored expectation — it is asked fresh on every sweep, so a wiring fix or a schema change is picked up the next run with no backfill.'
    },
    { type: 'h2', id: 'integration-obligations-surfaces', text: 'Where it shows up' },
    {
      type: 'ul',
      items: [
        'Board (`/integration-health`, admin-only) — one strip per api, a tile for each outcome with its live count, and `oldest_unmet` so the longest-standing gap sorts to the top.',
        'Record banner — the record\'s own open obligations render inline on the item, same posture as the ERP submission status badge, gated on the caller\'s read permission for that record\'s collection (not admin-only).',
        'Notes thread — a resolved obligation with a reason appears as a machine-authored entry on the record\'s Notes timeline, so "why wasn\'t this sent" has an answer sitting right next to the human conversation.',
        'Ask AI — the `integration_status` tool answers "why did X not get told about this record" directly: it runs as the asking user, gated on read permission for the record\'s collection (nivaro_*/directus_* refused outright, same as every other tool), and returns each obligation\'s api, kind, outcome, reason and trigger with no ids or internal columns the model could misread as a record key.'
      ]
    }
  ]
}
