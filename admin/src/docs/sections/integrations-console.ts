import type { DocSection } from '../types.js'

export const integrationsConsole: DocSection = {
  id: 'integrations-console',
  label: 'Integrations Console',
  content: [
    { type: 'h1', id: 'integrations-console', text: 'Integrations Console' },
    {
      type: 'p',
      text: "One console for watching every partner integration, deciding what counts as a problem, and drilling into exactly what happened — replacing the old /integration-health page (same address; the old body is now the console's admin-only extra tab) and /integration-events (now redirects here). A host application (an extension's own UI, or a headless frontend) can add its own tab alongside the built-in ones."
    },
    { type: 'h2', id: 'ic-tabs', text: 'Tabs' },
    {
      type: 'table',
      head: ['Tab', 'What it answers'],
      rows: [
        [
          'Firefight',
          'What is broken right now, ranked (critical first, then oldest). Snooze, dismiss, retry, or drill in without leaving the list.'
        ],
        [
          'Partners',
          'Per-external-API health cards (a sparkline, a health word, TEST/MOCK/auth flags) and a detail sheet: Recent calls, Submissions, Obligations, Contracts.'
        ],
        [
          'Events',
          'A chronological feed from every integration that registers a notes source — what happened, on which record, and whether it can be replayed. Full detail in the "Integration Events & Replay" section.'
        ],
        [
          '(host tabs)',
          "A hosting app or extension's own tab, passed in via `extraTabs` — e.g. a partner-specific operations tab (errors by cause, stuck-order reasons, flow charts)."
        ],
        [
          'Inbound',
          'Who is calling INTO this instance (per-caller request log), the health of every scheduled/staged import including its staleness cadence, plus an optional host panel (`inboundExtra`) for a queue or backlog that lives outside the signal registry.'
        ],
        [
          'Alerts',
          'Opt in to be told about a problem (real-time and/or a daily summary), and edit the thresholds that decide when it counts as one.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Firefight, Partners and Events are console-owned; Inbound and Alerts render the same shared components everywhere. A host renders `<IntegrationsConsole extraTabs={...} inboundExtra={...} onOpenRecord={...} />` from `@nivaro/react`.'
    },

    { type: 'h2', id: 'ic-registry', text: 'The signal registry' },
    {
      type: 'p',
      text: 'A signal is one KIND of integration problem — "a push failed", "an import hasn\'t run on schedule", "a partner keeps rejecting our calls" — not one occurrence of it. Core registers eight generic signals (`services/integration-signals-core.ts`): `core:partner-failing`, `core:push-failed`, `core:obligation-missing`, `core:obligation-overdue`, `core:inbound-errors`, `core:import-failed`, `core:import-stale`, `core:flow-failed`. Any extension registers its own the same way.'
    },
    {
      type: 'pre',
      code: `interface IntegrationSignal {
  id: string           // "owner:name" — e.g. "core:push-failed", "my-ext:sync-lag"
  label: string
  description: string
  tab: string          // 'partners' | 'pushes' | 'inbound' | a custom string
  severity: 'critical' | 'warn'
  thresholds: SignalThreshold[]
  evaluate(ctx: SignalEvalContext): Promise<{ count: number; rows: SignalRow[] }>
}

interface SignalThreshold {
  key: string          // 'min_age_minutes', or dynamic "cadence_hours:<import key>"
  label: string
  default: number
  unit: string
  min?: number
  max?: number
}

interface SignalEvalContext {
  thresholds: Record<string, number>          // resolved defaults + admin overrides
  businessDaysAgo(n: number): Promise<Date>    // core SLA schedule (days + holidays)
}`
    },
    {
      type: 'p',
      text: '`evaluate()` returns the REAL total in `count` even when `rows` is capped at `ROW_CAP` (500) — a signal with 900 open problems still reports 900; a row-ordering caller (a signal read at evaluation time, as opposed to a paged route) should sort oldest-first with an id tiebreak so the cap drops the newest problems, never an arbitrary slice. A signal that throws or exceeds its evaluation budget (60 s default) is isolated — its count/rows come back empty for that pass, but its EXISTING open rows are left completely untouched; a broken checker must never read as "everything just got fixed."'
    },
    { type: 'h3', text: 'SignalRow — one open problem instance' },
    {
      type: 'pre',
      code: `interface SignalRow {
  key: string            // STABLE identity of the PROBLEM — never a message or timestamp
  group?: string
  group_label?: string
  title: string
  detail?: string
  since?: string
  occurrence?: string    // identity of THIS INSTANCE — see "Snapshot semantics" below
  api?: string
  record?: { collection: string; id: string; label?: string }
  actions: SignalAction[]
  drill?: { kind: 'submission' | 'import_run'; id: string }
}

interface SignalAction {
  kind: 'retry_submission' | 'resend' | 'open' | 'explain' | 'extension'
  label: string
  id?: string             // submission id (retry), extension action id, ...
  payload?: Record<string, unknown>
}`
    },
    {
      type: 'warn',
      text: '`key` must be STABLE across evaluations of the SAME problem, and it must never be built from a message string, a count or a timestamp. It is the unique identity `UNIQUE(signal, row_key) WHERE cleared_at IS NULL` matches on — a key that shifts every cycle (e.g. one that embeds "N days ago") mints a brand-new row every 5 minutes instead of updating the one that already exists, which breaks first_seen, snoozes, dismissals and "happened again" wording all at once. Use a durable id: a record id, a submission id, an import key — never a rendered sentence.'
    },
    {
      type: 'p',
      text: 'A `kind: "extension"` action needs a matching `SignalActionHandler`, registered separately, that the console dispatches through `POST /integration-signals/actions`:'
    },
    {
      type: 'pre',
      code: `interface SignalActionHandler {
  id: string
  label: string
  run(args: {
    rows: SignalRow[]
    userId: string | null
    authHeaders: Record<string, string>
  }): Promise<Array<{ key: string; ok: boolean; message: string }>>
}`
    },

    { type: 'h2', id: 'ic-snapshot', text: 'Evaluation cycle and snapshot semantics' },
    {
      type: 'p',
      text: 'A 5-minute cron (`integration-signals`) runs every enabled, registered signal and writes the result into `nivaro_integration_signal_rows` — the Firefight tab reads that snapshot, it never evaluates on page load. The cycle is single-flight: a second call while one is already running gets back the SAME in-flight result rather than starting a concurrent pass. `POST /integration-signals/refresh` runs it on demand.'
    },
    {
      type: 'ul',
      items: [
        "A key present now that was NOT open before → INSERT (a new row; `first_seen` = the row's own `since` when it names one, else now).",
        'A key present now that WAS open, with an identical serialized payload and group → touch `last_seen` ONLY, in a bulk `UPDATE … WHERE id IN (…)` batched in chunks of ≤1000 ids — no per-row write at all.',
        'A key present now whose payload (or group) genuinely differs → a real per-row `UPDATE`; `first_seen` is untouched — the SAME problem, updated in place.',
        'A key that was open before and is absent now → `cleared_at` is set (the row survives for history; a later recurrence of the same key opens a FRESH row, since the unique index only covers `cleared_at IS NULL`).',
        'Cleared rows older than 30 days are deleted at the end of each cycle, in chunks, so the table does not only grow.'
      ]
    },
    {
      type: 'p',
      text: '`row_key` and `group_key` are 300-character columns. A longer key is stored as its first 300 characters and every comparison against a stored key (the snapshot diff, snoozes, Dismiss) uses that prefix, so a long key still updates its one open row instead of inserting a new one every cycle.'
    },
    {
      type: 'note',
      text: 'Self-hosted only: the core signals and the `integration-signals` cron are registered in self-hosted mode. A cloud deployment runs no evaluation cycle, so its console has no core signals to show.'
    },
    {
      type: 'note',
      text: "The batched write (touch vs. changed vs. insert vs. clear) is what keeps a full cycle fast — before it, one plain per-row `UPDATE` per open row dominated the cycle's wall time almost entirely; batching cut a representative full refresh from roughly a minute to a few seconds with byte-identical results (row counts, `first_seen`, `group_key` all unchanged; only `last_seen` legitimately advances further on every open row)."
    },
    {
      type: 'h3',
      text: '`occurrence` — the difference between "still broken" and "happened again"'
    },
    {
      type: 'p',
      text: '`key` names the PROBLEM and stays the same for as long as it is open. `occurrence` names THIS INSTANCE of it — a submission attempt id, a failing run id, an obligation id, a snapshot timestamp — whatever the signal knows best; unset, it falls back to the row\'s `since`, then to a hash of the row\'s own text with digits masked out. An `occurrence` should mark where the problem STARTED, never its newest event — a value that moves every cycle while the same problem continues makes a steady outage read as "happened again" every 5 minutes and undoes Dismiss. The core signals follow that rule: `core:partner-failing` uses the first failing call after the partner\'s last success, `core:inbound-errors` the first error after a quiet hour, `core:flow-failed` and `core:import-failed` the first failing run since the last successful one. A row whose `occurrence` differs from what was stored last cycle is a re-occurrence: the database write is still a plain `UPDATE` (the row was never cleared, so `first_seen` never moves), but the cycle reports it in `CycleSummary.results[].new_keys` alongside genuinely brand-new keys — and separately in `reoccurred_keys`, so delivery wording can say "happened again" rather than "new". One case is deliberately excluded: a row stored with NO explicit `occurrence` at all (it predates the signal ever setting one) compared against a fresh row that now sets one for the first time is NOT counted as a re-occurrence — a signal gaining richer identity is not the same event as its problem coming back, and treating it as one would flag every already-open row the moment a signal\'s code changes.'
    },

    { type: 'h2', id: 'ic-snooze-dismiss', text: 'Snoozes and Dismiss' },
    {
      type: 'p',
      text: 'Two separate mechanisms sit on every row, at three possible scopes — this row, everything in its `group`, or the whole signal:'
    },
    {
      type: 'table',
      head: ['Mechanism', 'Scope', 'Reawakens when'],
      rows: [
        ['Snooze — for a time', 'row / group / signal', 'the chosen date passes'],
        [
          'Snooze — "Until it changes"',
          'row only',
          "the row's title/group/detail changes in any way OTHER than a digit (a masked sha256 hash of the three, so a re-run with the same wording but a different age number never reawakens it)"
        ],
        [
          'Dismiss — "this occurrence"',
          'row only',
          "the row's `occurrence` changes — a genuinely new instance of the same problem, tracked by real identity (an id or timestamp) rather than a text hash"
        ]
      ]
    },
    {
      type: 'p',
      text: 'Dismiss is the more precise of the two for a signal that carries a real `occurrence`: a resend that fails with the IDENTICAL error message still un-dismisses the row (a new submission id = a new occurrence), which "Until it changes" cannot do since its hash sees no difference. A row with no meaningful `occurrence` falls back to the same since/hash comparison "Until it changes" uses, so Dismiss is never worse, only sometimes equivalent.'
    },
    {
      type: 'pre',
      code: `POST /api/integration-signals/snoozes
{ "signal": "core:import-stale", "row_key": "import:orders",
  "until_occurrence": true, "note": "will fix Monday" }   // exactly one of
                                                            // until / until_change / until_occurrence

POST /api/integration-signals/dismiss    // bulk "Dismiss selected"
{ "signal": "core:import-stale", "row_keys": ["import:orders", "import:invoices"] }
// -> { data: { dismissed: 2, skipped: [] } }  — a row already closed on its own is reported, not an error

DELETE /api/integration-signals/snoozes/:id   // Undo / Unsnooze`
    },
    {
      type: 'note',
      text: "A Dismiss whose row hasn't been seen in 30 days is pruned automatically at the end of every evaluation cycle — a stale dismissal never lingers as dead configuration."
    },

    { type: 'h2', id: 'ic-drill', text: 'Row drill-down — "Details"' },
    {
      type: 'p',
      text: 'A Firefight row whose signal sets `drill` (`{ kind: "submission" | "import_run", id }`) gets a "Details" disclosure that expands the row IN PLACE — no modal. For a failed push, the panel is seven parts, in order:'
    },
    {
      type: 'ul',
      items: [
        '1. **Summary line** — partner name, method + path, a link to the record, status, attempt count, first sent / last tried.',
        "2. **What went wrong** — the FULL error text, never clamped, plus the linked obligation's own reason when it differs.",
        '3. **Attempts** — every attempt, and who started each one.',
        "4. **Request and response** — the latest (or only) attempt's payload and response, pretty-printed, foldable past 40 lines, with copy.",
        '5. **Why it was sent — and who** — the resolved trigger, the requester, "Retried by" when a later attempt\'s starter differs from the original, and the linked obligation.',
        '6. **Call log** — matching partner call-log rows (method, status, duration, user, trigger), with a link into Call Logs.',
        '7. **Actions** — Retry, with the exact refusal reason shown inline when it is not offered.'
      ]
    },
    {
      type: 'p',
      text: 'A failed import run (`kind: "import_run"`) shows that run\'s own log text and a link into the Import Console instead. `GET /api/erp-submissions/:id` (admin) returns the whole thing in one call: partner, endpoint, the linked obligation, the trigger, the requester, every attempt\'s requester, matching call-log rows, and retry eligibility with its reason.'
    },

    { type: 'h2', id: 'ic-who', text: 'Who triggered it — recorded vs. inferred' },
    {
      type: 'p',
      text: "Every submission and every attempt records `requested_by` (the user, when a person was behind it) and `requested_via` — `transition`, `auto-transition`, `resend`, `api`, `retry`, `cron`, `item-action` or `flow`. A later Retry by someone else is that attempt's own requester, not the original sender's."
    },
    {
      type: 'warn',
      text: "These two columns are NULLABLE and carry no foreign key — a deleted or merged user must never block a push from being recorded, and a database that hasn't reached this migration yet must never fail an insert over it. Every writer goes through `requesterInsertFields(table, by, via)` / `requesterSelectColumns(table)` (`services/erp-requester-columns.ts`; extensions keep a local copy of these helpers, since they can't import `api/src`), which probe `db.schema.hasColumn(table, \"requested_by\")` once per TENANT per table (one database when self-hosted): a hit is cached forever, a miss is re-checked after 60 seconds (so a database that catches up mid-session is picked up without a restart, but a genuinely absent column is never re-probed every request). One tenant being migrated never makes another, un-migrated tenant name the columns. Still migrate every tenant before rolling a new image. When the columns are missing, the insert or select simply OMITS them rather than naming a column that doesn't exist — the submission row is still written either way."
    },
    {
      type: 'p',
      text: "A push recorded before these columns existed — or landed via a path this instance hasn't updated yet — is answered by INFERENCE instead, in order: the matching partner call log's user, the transition made moments before (scoped to the SAME transition when the linked obligation names one), a person's edit of the record just before the send (only for a hook/unknown/api-shaped trigger — a scheduled, flow-driven or item-action send must never borrow a coincidental edit by someone else), or the schedule/flow that ran it. The drill marks an inferred answer with a dashed chip naming the evidence it used; anything still unresolved reads \"Not recorded\", and a machine account always reads as the account, never as a person."
    },

    { type: 'h2', id: 'ic-resend', text: 'Resending a push' },
    {
      type: 'p',
      text: 'Two distinct mechanisms, both offered as a row action:'
    },
    {
      type: 'ul',
      items: [
        '**Retry** (`kind: "retry_submission"`) — `POST /api/erp-submissions/:id/retry`, re-sends the exact SAME stored payload.',
        "**Rerun a transition's push action** — re-renders and re-sends ONE `erp_submit` action from a workflow transition, without moving the record's pipeline state at all."
      ]
    },
    {
      type: 'pre',
      code: `POST /api/pipelines/instance/:collection/:item/actions/rerun   // admin only
{ "transition_id": "...", "action_index": 0 }
// -> { data: { submission: { id, status, last_error }, skipped_reason: null } }`
    },
    {
      type: 'p',
      text: "The route refuses anything that isn't an `erp_submit` action at that index (a `create_record` action can never be re-run this way), requires the record to actually hold an instance of that transition's OWN pipeline template (a transition id from an unrelated template 404s), renders the payload against the record's CURRENT state rather than the transition's target state, and always produces a brand-new submission row — exactly like a first send, obligation-trigger `manual`. When a guard or `push_when` would have skipped the push instead of sending it, the response carries `skipped_reason` naming why, and no submission is produced."
    },

    { type: 'h2', id: 'ic-event-paths', text: 'Event paths' },
    {
      type: 'p',
      text: "Open any row on the Events tab to see everything it set off: the records it created or updated, the transitions and flows those writes ran, the pushes to partners and what each partner answered. The sheet opens on the first failure. Large runs of writes to one collection fold into a single line, and the tree stops at 2,000 steps (pushes, transitions and flows are kept before plain writes). The Events tab lists outbound pushes, inbound calls made with integration accounts or API keys (tick \"Include people's tokens\" to add calls made with a person's own token; GraphQL calls count only when they are mutations) and each extension's own feed."
    },
    {
      type: 'p',
      text: 'Exact paths are recorded as they happen: every API request, scheduled job, import run and extension feed event starts a chain, and every write, push, partner call, transition and flow run it causes is stamped with that chain. Events from before this feature, or on an instance that has not run migration 351, are matched by account and time instead and marked Inferred; each inferred step says why it was matched. A replay links to the event it replays, and the original links to its replays.'
    },
    {
      type: 'p',
      text: "On a record, the history sheet's Integration activity section lists every integration chain that touched it (integration accounts and API keys only), and each push under External requests has Show path. A record reader sees the path without request or response bodies, full error text or URL query strings; steps on records they cannot read are left out and counted."
    },
    {
      type: 'note',
      text: 'Routes: `GET /integration-events` (admin; filters `source`, `partner`, `caller`, `include_people`, `record`), `GET /integration-events/:source/:id/path` and `GET /integration-events/chain/:chainId/path` (admin), `GET /integration-events/record/:collection/:item` and `.../path?source=&id=` (read permission on the record; the path 404s unless the event names the record or shares one of its chains). A path that cannot be built answers 503, never 500. Extensions start a chain for their own feed events with `ctx.chain.begin` and list them with `ctx.integrations.registerEventSource`.'
    },

    { type: 'h2', id: 'ic-partners', text: 'Partners tab' },
    {
      type: 'p',
      text: 'A health card per registered external API — a health word (idle / healthy / degraded / failing, with an auth-failure override), a 48-hour call sparkline, and TEST / MOCK / "sign-in failing" / "turned off" flags. Opening a card shows the detail sheet: Recent calls, Submissions, Obligations, Contracts.'
    },
    { type: 'h3', text: 'Recent calls' },
    {
      type: 'p',
      text: 'Merges the lightweight outbound log (every call, no body) with the API-call log (calls a writer explicitly logged, WITH the full request and response) over the last 14 days / 200 calls, newest first. A row backed by a logged call expands in place to headers, pretty or raw body (foldable past 40 lines, with copy), the resolved trigger, and who sent it — a resolved user always wins over a bare trigger string.'
    },
    {
      type: 'pre',
      code: 'GET /api/integration-partners/:id/calls/:callId   // scoped to that partner; headers and bodies masked'
    },
    {
      type: 'warn',
      text: "EVERY reader of a stored call log's header columns re-masks them on read, regardless of what is actually stored — never trust that a value was already masked at write time. `maskHeaders()` matches `Authorization`, `Cookie`/`Set-Cookie`, and any header name containing secret, token, password, passwd, key, cookie, auth, session, signature or credential (case-insensitive); `Authorization` keeps its scheme (`Bearer ••••••`)."
    },
    { type: 'h3', text: 'Submissions, Obligations, Contracts' },
    {
      type: 'p',
      text: "Submissions lists this partner's pushes with retry; Obligations embeds the existing per-API obligations board; Contracts lists the partner's endpoint contract tests with a Run button. See the ERP Submission Status and Integration Obligations sections for the underlying models."
    },

    { type: 'h2', id: 'ic-inbound', text: 'Inbound tab' },
    {
      type: 'p',
      text: 'Three groups, in this order: an optional host panel (`inboundExtra` — a queue or backlog view a hosting app owns and wants surfaced here), Scheduled imports, then Inbound callers (the existing per-caller request log; picking a caller scopes it).'
    },
    { type: 'h3', text: 'Import staleness' },
    {
      type: 'p',
      text: "Backed by `core:import-stale`'s own settings, keyed dynamically per import: `cadence_hours:<import key>`. `null` follows the signal's own default (48 h); `0` means \"not monitored\" — the import is excluded from the signal entirely; a positive number pins that one import's expected cadence. An import whose last successful run predates the signal's `dormant_days` threshold (default 90) with no override reads Dormant rather than Stale, so years-old one-off imports don't become permanent noise."
    },
    {
      type: 'p',
      text: 'Editable in TWO places that share one query key, so editing either refreshes both immediately: the Integrations console\'s Inbound tab (a per-row "Stale after" control) and the Import Console\'s Definitions list (the import\'s own "Staleness" field). Both call the same settings endpoints:'
    },
    {
      type: 'pre',
      code: `GET   /api/integration-partners/imports   // every import, effective cadence + source (default|override|excluded|dormant)
PATCH /api/integration-signals/settings/core:import-stale   { "cadence_hours:orders": 6 }
PATCH /api/integration-signals/settings/core:import-stale   { "cadence_hours:orders": 0 }     // not monitored
PATCH /api/integration-signals/settings/core:import-stale   { "cadence_hours:orders": null }  // back to the default`
    },

    { type: 'h2', id: 'ic-alerts', text: 'Alerts — opt-in real-time and daily-summary' },
    {
      type: 'p',
      text: 'Nothing is ever sent unless a person explicitly turns it on for a signal — there is no default recipient. Two independent switches per problem: Real-time (one notification right after the evaluation cycle that found it) and Daily summary (one line per subscribed signal in the existing daily digest, e.g. "Failed pushes — 3 open · 1 new since yesterday"). Subscribing to `*critical` covers every signal whose CURRENTLY RESOLVED severity is critical, without naming them one by one — so it automatically follows a severity override made in the thresholds editor.'
    },
    {
      type: 'pre',
      code: `GET    /api/integration-signals/subscriptions              // own rows
POST   /api/integration-signals/subscriptions               // admin only — see below
{ "signal": "core:push-failed", "mode": "realtime" }         // mode: realtime | digest
DELETE /api/integration-signals/subscriptions/:id            // own row only`
    },
    {
      type: 'warn',
      text: "Admin-only is enforced AGAIN at delivery, not only at subscribe time — a subscriber who is later demoted, suspended or redacted gets NOTHING, silently, rather than an error or a stale notification stream nobody can turn off. `alerted_at` (on the row) and `last_notified_at` (on the subscription) are stamped only after an actual, successful delivery; if every recipient's notification throws or is dropped (muted, suspended, etc.), neither is stamped, and later cycles offer the row again for up to a day after it appeared instead of going quiet forever. Quiet hours only hold back the push notification — the inbox copy still lands, so an alert during quiet hours counts as delivered."
    },
    {
      type: 'p',
      text: '"Happened again" wording is only used for a subscriber who was actually told about the row before — a re-occurrence of a problem nobody was subscribed to yet reads as new to whoever hears about it first, not as a repeat of an alert they never received.'
    },
    {
      type: 'p',
      text: 'A row that re-occurs within 6 hours of its last alert (`REALERT_HOURS`) stays quiet, so a problem that keeps failing is one notification, not one per cycle. A problem that recovers and then fails again is a new problem and alerts again. Each line names the record it is about when it has one ("Partner /orders · ORD-1042"), resolved with the same friendly-id lookup the console uses.'
    },
    {
      type: 'p',
      text: 'The thresholds editor on this tab reads and writes the exact same settings endpoints described under "The signal registry" and "Import staleness" above, with a debounced live preview ("Currently flags N" / "Would currently flag N") before saving; typing a value back to its own default sends `null` (removes the override entirely, rather than pinning "the default number" as if it were a deliberate choice).'
    },

    { type: 'h2', id: 'ic-extension-api', text: 'Extension API' },
    {
      type: 'pre',
      code: `// api/extensions/<name>/index.ts
export default {
  id: 'payments-sync',
  async register({ integrations }) {
    integrations.registerSignal({
      id: 'payments-sync:reconcile-lag',
      label: 'Reconciliation running behind',
      description: 'A payment batch has not reconciled within its expected window.',
      tab: 'partners',          // or any custom tab your host renders alongside it
      severity: 'warn',
      thresholds: [
        { key: 'max_age_hours', label: 'Flag after', default: 6, unit: 'hours', min: 1, max: 72 }
      ],
      async evaluate({ thresholds }) {
        const rows = await findLaggingBatches(thresholds.max_age_hours)
        return {
          count: rows.length,
          rows: rows.map((b) => ({
            key: \`batch:\${b.id}\`,                 // stable — the batch id, never a message
            title: \`Batch \${b.id} — reconciliation is \${b.age_hours}h behind\`,
            occurrence: \`run:\${b.first_late_run_id}\`, // where THIS lag started — unchanged while it lasts
            since: b.started_at,
            record: { collection: 'payment_batches', id: b.id },
            actions: [{ kind: 'open', label: 'Open batch', payload: { collection: 'payment_batches', id: b.id } }]
          }))
        }
      }
    })

    integrations.registerSignalAction({
      id: 'payments-sync:force-reconcile',
      label: 'Force reconcile now',
      async run({ rows, userId }) {
        return Promise.all(rows.map(async (r) => {
          try {
            await forceReconcile(r.record!.id, userId)
            return { key: r.key, ok: true, message: 'Reconciled' }
          } catch (err) {
            return { key: r.key, ok: false, message: String(err) }
          }
        }))
      }
    })
  }
}`
    },
    {
      type: 'p',
      text: "An extension cannot import `api/src` (rootDir), so it mirrors the `IntegrationSignal` / `SignalRow` / `SignalAction` / `SignalActionHandler` shapes locally rather than importing them — the same leaf-module convention used everywhere else in the extension architecture. A signal id keeps the same `owner:name` rule core's does (`payments-sync:reconcile-lag`, not a bare name)."
    },
    {
      type: 'note',
      text: "Every `callExternalApi` call made from inside an extension now always lands in that API's Call Logs — the caller's own trigger (e.g. `cron:<job id>`, when the writer names one explicitly) is kept if given, otherwise it defaults to `extension:<extension id>`. A partner's Recent calls tab therefore shows an extension's scheduled syncs and polls without the extension writer doing anything extra to log them."
    }
  ]
}
