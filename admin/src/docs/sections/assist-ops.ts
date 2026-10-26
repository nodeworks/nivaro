import type { DocSection } from '../types.js'

export const aiChatDocs: DocSection = {
  id: 'ai-chat',
  label: 'Ask Your Data',
  content: [
    { type: 'h1', id: 'ai-chat', text: 'Ask Your Data' },
    {
      type: 'p',
      text: 'The /ask page answers natural-language questions about your business data. Claude runs a tool-use loop against the CMS — every tool call executes as the requesting user, so RBAC, field allow-lists and row-level security apply exactly as on the REST API.'
    },
    {
      type: 'pre',
      code: `POST /api/ai/chat
{ "messages": [{ "role": "user", "content": "How many workflows per payment status?" }] }

→ { "data": { "reply": "…markdown…", "trace": [
    { "tool": "aggregate", "input": {…}, "summary": "count by payment_status: 3 group(s)" }
  ] } }`
    },
    {
      type: 'ul',
      items: [
        "Tools: list_collections, query_items (items service — RLS applies), aggregate (refuses when the user is row-filtered), semantic_search (hits intersected with the permission-checked read), integration_status (the obligation ledger for a record), record_event_path (the newest integration events naming a record and the path each set off — writes, transitions, flows, partner calls, where it failed), explain_access (why the asker — or, for administrators, another user — can or cannot see a record), record_integrity (a record's live integrity findings, or a collection's newest sweep totals) run_custom_query (a saved SQL query from the catalogue the assistant is given — only queries whose access admits the asker, User-Scope params injected, 200 rows at most) and queue_summary (a queue the asker may read, by name or id from the queue catalogue in the prompt: totals, by-state counts, SLA breaches with hours over and owners, the oldest and unowned records as friendly ids with links, and the at-risk rules firing most — read as the asker through the queue service, so scopes apply), waiting_on_me (the asker's own My Work “Waiting on you” list — records whose current pipeline step they own, SLA-breached first, plus approval steps naming them; no person parameter, narrowed to records the asker may read; an empty list is said as “nothing waiting”, never replaced by another list).",
        'Ask about a queue from its page: the queue toolbar\'s "Ask about this queue" opens /ask with the question seeded (`/ask?q=…` seeds and sends one question, then drops the parameter).',
        'Reads are direct; mutations only ever happen through the proposal gate (see AI Actions & Dashboards) — the model can never write without your approval.',
        'Every answer shows the tool trace: exactly which queries produced it.',
        'A breakdown or a series (per state, per month, per vendor) comes with a chart: the model attaches a fenced `chart` block ({type, title, data:[{label, value}]}) that renders as a bar, line or pie under the prose.',
        'The same standalone question by the same person inside the answer-cache window (Settings → AI Features, default 15 minutes) answers from cache — the page says when it was first answered and offers "Ask again". Answers that propose an action are never cached; `fresh: true` in the request skips the cache.',
        'An answer written only from the in-app docs (search_docs and no other tool, no page context, no remembered notes) is also kept for everyone: the next person asking the same question in the same language, with the same docs audience (administrators see more sections), gets it from cache. Any data tool keeps an answer private, and a new docs index never serves an answer quoting the old one.',
        'Within one conversation, a read the assistant already made (same tool, same arguments, same person) is reused instead of queried again, as long as nothing in that collection changed since — the steps say "reused". A write in between, a configuration change, or 30 minutes passing makes it read again.',
        'Tool results reach the model as compact tables (column names once, each link label once); Show the steps and exports keep the readable rows.',
        'When an administrator switches on "Start cheap" for Ask AI (AI Quality → Cost savings), a quick answer from the smaller model says so and offers "Try harder", which asks the main model.',
        'Under a single number (an ungrouped count, sum, average, minimum or maximum) the page offers "Tell me when this goes over…": pick a threshold (goes over, reaches, drops under, falls to) or a trend watch (alerts when the series changes direction or moves outside its recent range, using the anomaly engine statistics), and how often to check (daily or hourly). The watch is re-read hourly AS YOU, so permissions and row-level security apply; you get an in-app notification when it crosses (once per crossing, not every check). "Numbers you watch" at the top of /ask lists each with its current value, change today, threshold and last alert — edit the threshold, pause or stop watching. Watches live in your own account preferences (20 at most) via `GET/POST/PATCH/DELETE /api/ai/watches` (`POST /:id/check` reads one now), and appear in your daily summary with the change since yesterday and whether they are close to the threshold. Ask "what am I watching" to have the assistant list them (my_watches).',
        'The past_state tool reads revision and pipeline history under the same read gates as the revision API: "what did this record look like on March 1" (as_of), "when did the amount change and who changed it" (changes), "how long was it in Finance Review" (time_in_state).',
        'Uses the chat model from Settings → AI Features → Model per feature; a model the gateway refuses falls back to the default model.',
        'Answers stream as they are written: send `stream: true` and the route answers `202 {data: {stream_id}}` at once, then emits `ai:delta` (text, with its round), `ai:status` (the tool running), `ai:done` (the full normal body — proposals, trace, request_id) and `ai:error` to your Socket.io user room; add `Accept: text/event-stream` to get the same events as SSE instead (widgets, hosts without the socket). A caller with neither gets the plain reply. `POST /api/ai/chat/:stream_id/stop` halts a running answer. /summarize and /generate take the same `stream` option with text deltas only. The /ask page streams by default, shows what the model is doing while tools run, and has a Stop button.'
      ]
    }
  ]
}

export const aiPlansDocs: DocSection = {
  id: 'ai-plans',
  label: 'Multi-step Plans',
  content: [
    { type: 'h1', id: 'ai-plans', text: 'Multi-step Plans' },
    {
      type: 'p',
      text: 'A request that needs several changes together — "close out the lines on these 12 POs and tell their owners" — comes back from Ask AI as one numbered plan instead of separate proposals. Each step carries its own preview, built as you when the plan is proposed; nothing runs until you approve.'
    },
    {
      type: 'ul',
      items: [
        'Approve & run all runs every step in order; Run next step runs one and pauses, so you can approve step by step. Every step runs as you through the normal services — permissions, row security, validation, hooks and activity all apply.',
        'Step kinds: update records (bulk_update), create a record, create a task, create a dashboard, send a message (an in-app notification to named people and/or the current owners of records — owners are resolved again when the step runs), post to a chat room you can see, and run an active manual flow (administrators only).',
        'A refused step stops the plan with the reason; the steps after it stay pending. A bulk step where some records refuse reports how many and which.',
        'Conditions: a step can say "only if still in Finance Review" (a filter the records must still match) or "only if the amount is unchanged" (fields that must still hold the value they had when the plan was made). A step whose condition fails is skipped and named in the result; on a bulk update only the records that fail are left out and the rest run.',
        'While a plan runs, the card shows each step start, finish, fail or skip as it happens, with a running count of records changed.',
        'Retry: after fixing the cause, Re-check and retry rebuilds the failed step and the ones after it as you now — a bulk step re-reads its filter and, after a partial run, keeps only the records that refused — shows which steps changed, then runs from where the plan stopped.',
        'While an answer is being built, each tool step is listed as a plain line ("Reading workflows… 42 found") above the answer and folds away once the answer starts.',
        'A plan nobody started expires after an hour, like a single proposal.'
      ]
    },
    { type: 'h2', id: 'ai-plans-api', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/ai/plans/step-kinds     the step kinds the model may use
GET  /api/ai/plans/:id            the plan with each step's state (owner or administrator)
POST /api/ai/plans/:id/run        {mode: "all" | "next"} → 202; steps run in the background
POST /api/ai/plans/:id/retry      re-check the failed + remaining steps → status paused
POST /api/ai/plans/:id/cancel     discard, or stop a running plan before its next step`
    },
    {
      type: 'p',
      text: 'The chat answer carries proposed plans in `plans` next to `proposals`. Progress is pushed to your Socket.io user room as `ai:plan` ({plan_id, status, records_changed, step, plan}); `ai:status` events of a streamed answer now also arrive with `done: true` and a short `result` when each tool returns. Plans are stored in nivaro_ai_proposals with action_type `plan`.'
    },
    { type: 'h2', id: 'ai-plans-impact', text: 'Impact and change report' },
    {
      type: 'p',
      text: 'Every plan card leads with its impact, read off the step previews: "Touches 34 records in 3 collections, messages 12 people, moves 5 records to Approved". "What changes" opens the change report — every field the plan would change (or, for steps that ran, did change), per record, old value → new value — with an Excel download. The report is built for whoever looks at it: a record you cannot read shows as #id with no values, a field you cannot read as (hidden).'
    },
    { type: 'h2', id: 'ai-plans-later', text: 'Run later' },
    {
      type: 'p',
      text: '"Run later…" approves the plan for a set time. Each minute the `ai-plans-scheduled` job picks up the due plans; before running, every pending step is rebuilt as you at that moment. If the records a step would act on changed, or a step no longer builds, nothing runs: the plan comes back to you for approval with the new previews and the reason, and you get a notification. Cancel the schedule from the card to approve it again by hand.'
    },
    {
      type: 'p',
      text: 'When a plan finishes, the person who approved it gets a notification (in-app, plus push or Teams by their own notification rules) with the outcome, the failed step if any, and a link to the plan.'
    },
    { type: 'h2', id: 'ai-plans-history', text: 'Plan history, undo and templates' },
    {
      type: 'ul',
      items: [
        '/ai-plans (Home → AI Plans) lists plans with who approved them and when, their steps, impact and outcome. Everyone sees their own; administrators see every plan.',
        "Undo (administrators): a step that wrote records can be reverted record by record, but only where nothing has changed the record since — its newest revision is still the plan's write and every field still holds the value the plan wrote. Records changed since are named and left alone. Messages, chat posts, flows and tasks cannot be undone.",
        "Make a draft flow (administrators, plans that ran to the end): the steps become flow operations, chained in order, with the records as the same ids, the original filter, or whichever record fired an update event. The flow is created switched off and opens in the tester. Record updates and creates use the new Write Records flow operation, which runs as whoever triggered the flow through the normal record rules. When nobody triggers it (a webhook, a schedule, a system event) it runs only as a 'Run as' person named on the operation — never as the flow's author — and refuses without one; that person must be active, and the collection must be named, not templated.",
        "Templates: ready-made plans for common chores (close out a record's open lines, reassign a leaver's open records, move old drafts to a status, tell the owners of matching records). Fill in the blanks and the usual plan preview appears; nothing runs until you approve. Administrators add their own (blanks + steps as JSON).",
        'Data Integrity: on a run\'s field + rule filter, "Fix as a plan…" builds the confident fixes for that cluster as a plan, previewed record by record in the change report before approval.'
      ]
    },
    {
      type: 'pre',
      code: `GET  /api/ai/plans?scope=mine|all&status=
GET  /api/ai/plans/:id/changes          (+ /changes.xlsx)
POST /api/ai/plans/:id/schedule         {"run_at": "2026-10-16T21:00:00Z"}
POST /api/ai/plans/:id/unschedule
GET  /api/ai/plans/:id/undo             administrators
POST /api/ai/plans/:id/undo             {"step_id"?: "…"}  administrators
POST /api/ai/plans/:id/flow             {"records": "same"|"filter"|"trigger"}  administrators
GET  /api/ai/plan-templates
POST /api/ai/plan-templates/propose     {"key": "old-drafts", "values": {…}}
POST /api/config-conformance/runs/:id/plan  {"field", "rule"}  administrators`
    }
  ]
}

export const pipelineSimulatorDocs: DocSection = {
  id: 'pipeline-simulator',
  label: 'Pipeline Simulator',
  content: [
    { type: 'h1', id: 'pipeline-simulator', text: 'Pipeline Simulator' },
    {
      type: 'p',
      text: "Dry-run a record through its pipeline without touching it: who would own every state, which transitions are available and exactly why the others aren't."
    },
    {
      type: 'pre',
      code: `POST /api/pipelines/simulate
{ "collection": "workflows", "item_id": 366518 }`
    },
    {
      type: 'ul',
      items: [
        'Owners resolve per state through the real owner-matrix engine (one batched pass).',
        "Each transition reports from-state match, per-rule condition results with the record's actual values, and role checks.",
        'The SLA rule that would arm in each state is shown with its duration.',
        'Works without an instance too — simulates from the initial state.',
        'UI: the Simulator card at the bottom of a pipeline editor.'
      ]
    }
  ]
}

export const pipelineHealthDocs: DocSection = {
  id: 'pipeline-health',
  label: 'Pipeline Health Checks',
  content: [
    { type: 'h1', id: 'pipeline-health', text: 'Pipeline Health Checks' },
    {
      type: 'p',
      text: 'Three checks that keep a pipeline template honest: can a record reach every state, do the skip rules actually fire, and is the same crew typed into owner cells over and over.'
    },
    { type: 'h2', id: 'pipeline-lint', text: 'Reachability' },
    {
      type: 'pre',
      code: 'GET /api/pipelines/:id/lint'
    },
    {
      type: 'ul',
      items: [
        'A pure check over the template — no records are read. It starts from the initial state and follows every transition, send-backs included; a transition with no from-state counts from every non-terminal state.',
        'Warnings: a state nothing enters, a state only entered from states a record can never reach, a transition that leaves an unreachable state, conditions that contradict each other (two different equals on one field, equals and not-equals of the same value, an equals outside its in-list, empty and filled, a number range with no room, related-some with related-none), a non-terminal state with no way out, and an automatic transition with no conditions on a state that also has manual exits (it fires on the first write, so the buttons are never really offered).',
        'Notes: a terminal state with an exit — normal for an uncancel or reopen path.',
        'UI: the Reachability card in the pipeline editor. The readiness check "Every pipeline template can reach all its states" runs the same lint over every template.'
      ]
    },
    { type: 'h2', id: 'pipeline-skip-report', text: 'Skip criteria in practice' },
    {
      type: 'pre',
      code: 'GET /api/pipelines/:id/skip-report?days=90&sample=120'
    },
    {
      type: 'ul',
      items: [
        'History: per state, how many records entered it in the window and how many jumped over it — a forward move whose from and to states bracket a state the record never visited, the same rule the record’s state track uses. A state on another branch of the template can show skips without any rule.',
        'Right now: for the newest open records (sample, default 120, max 500) every state still ahead with skip rules is judged one rule at a time by the engine’s own evaluator. Owner checks resolve in one batch; lookup thresholds stop at a time limit and the report says how many records it judged.',
        'Each rule gets a verdict — never fires, always fires, fires sometimes, or too few records (under 10). A threshold that never or always fires is usually configured wrong.',
        'UI: the "Skip criteria in practice" card in the pipeline editor (press Analyze).'
      ]
    },
    { type: 'h2', id: 'team-suggestions', text: 'Suggested teams' },
    {
      type: 'pre',
      code: `GET  /api/user-groups/suggestions?template=&min_cells=3&min_members=2
POST /api/user-groups/suggestions/apply
{ "members": [...], "group_ids": [...], "name": "Field crew", "execute": false }`
    },
    {
      type: 'ul',
      items: [
        'Finds owner-matrix cells whose individual members are exactly the same set of two or more people in three or more cells, skipping cells already linked to a team.',
        'apply is a dry run unless `execute: true`: it re-checks every cell, then creates the team (or links an existing team that already has exactly those people), links it to each cell and removes the individual entries it replaces. Ownership does not change — a linked team’s roster is part of the cell.',
        'The removed rows are backed up first: a `zz_backup_og_users_team_<stamp>` table on SQL Server, and always an `owner-team-swap-backup` activity row with every row as JSON. A cell whose members changed since the suggestion is left alone and named in the response.',
        'UI: Teams → Suggested teams. Preview first; the create button only appears after the preview.'
      ]
    }
  ]
}

export const slaScheduleDocs: DocSection = {
  id: 'sla-business-hours',
  label: 'SLA Business Hours',
  content: [
    { type: 'h1', id: 'sla-business-hours', text: 'SLA Business Hours & Holidays' },
    {
      type: 'p',
      text: 'Business-hours SLA math is schedule-driven: working days, day start/end hours, and a holiday list — configured in Settings → SLA and honored everywhere (status endpoints, notifications, queue SLA columns).'
    },
    {
      type: 'ul',
      items: [
        'Holiday dates count zero business hours regardless of weekday.',
        'Defaults: Monday–Friday, 9:00–17:00, no holidays.',
        "Timezone: the day start/end hours are wall-clock times in the IANA zone set in Settings → SLA (e.g. America/New_York). Leave it empty and the API server's own zone applies — deployed containers run UTC, so set it explicitly.",
        "Regional clocks: map a region collection (Settings → SLA → Regional clocks) and each record linked to a mapped region counts business hours on that region's zone. Unmapped regions, and records with no region link, follow the SLA timezone.",
        'Applies to every SLA consumer — status endpoints, queue SLA columns, breach notifications, escalation ladders and My Work.',
        'Applies only to rules with "business hours only" enabled; other rules use wall-clock hours.'
      ]
    },
    { type: 'h2', id: 'sla-record-override', text: "Adjusting one record's clock" },
    {
      type: 'p',
      text: "The owner of a record's current step — or an admin — can extend or shorten that record's SLA clock with \"Adjust clock\" (on the pipeline panel's SLA line, and on the record's SLA banner). A reason is required. The rule itself does not change: the new duration applies to this record only, and only while it stays in this step — leaving the step ends it, and coming back starts the rule's own clock again."
    },
    {
      type: 'ul',
      items: [
        'Every SLA reader honours it: the record banner, queue SLA columns and sorts, My Work, breach notifications and escalation ladders.',
        'The adjustment is written as a note on the record ("SLA clock") and the banner shows who set it, when and why. "Back to the rule" removes it.',
        'Only one adjustment is active per stay; a new one replaces the old.'
      ]
    },
    {
      type: 'pre',
      code: `POST   /api/sla/override/:collection/:item   { "duration_hours": 48, "reason": "Waiting on the vendor quote" }
DELETE /api/sla/override/:collection/:item   ?reason=…   — back to the rule's duration`
    }
  ]
}

export const scheduledReportsDocs: DocSection = {
  id: 'scheduled-reports',
  label: 'Scheduled Reports',
  content: [
    { type: 'h1', id: 'scheduled-reports', text: 'Scheduled Reports' },
    {
      type: 'p',
      text: 'Email a PDF snapshot of a collection (filtered rows as a table) or a queue (stat strip + items) on a cron schedule. Managed at /reports/scheduled.'
    },
    {
      type: 'ul',
      items: [
        'Recipients get the PDF as an attachment; subject carries the date.',
        'Send now runs the same path as the cron for instant verification.',
        'Reports run as their creator — configure recipients knowing what the report exposes.',
        'A schedule takes effect when it is saved: created, edited, switched off or deleted, on every process within about 5 seconds. The same holds for retention policies, sync jobs and scheduled flows.'
      ]
    }
  ]
}

export const fieldImpactDocs: DocSection = {
  id: 'field-impact',
  label: 'Field Impact Analysis',
  content: [
    { type: 'h1', id: 'field-impact', text: 'Field Impact Analysis' },
    {
      type: 'p',
      text: 'Before renaming or deleting a field, the crosshair icon on any Table Editor field row answers "what references this?" — layouts, queue columns and filters, display templates, computed formulas, field rules, visibility conditions, at-risk rules, alerts, watches, automation rules, workflow conditions, and saved views.'
    },
    {
      type: 'pre',
      code: 'GET /api/data-model/:collection/fields/:field/impact   (admin)'
    },
    {
      type: 'note',
      text: 'Matching errs toward recall — every hit names its source with a link so you can judge before changing the schema.'
    }
  ]
}

export const formsV2Docs: DocSection = {
  id: 'layout-forms',
  label: 'Layout-Backed Forms',
  content: [
    { type: 'h1', id: 'layout-forms', text: 'Layout-Backed Public Forms' },
    {
      type: 'p',
      text: "A submission form can reference a grouped collection layout instead of a flat field list. The public page then renders the layout's groups as titled sections — or a step wizard with progress dots when the layout uses steps mode — with field visibility rules evaluated live."
    },
    {
      type: 'ul',
      items: [
        'Pick the layout in the form editor; the flat field list is ignored while set.',
        'Only public-safe fields render: physical, visible, non-readonly columns (never id or audit fields).',
        'Select fields render as dropdowns from their configured choices.',
        'Hidden-by-rule fields are excluded from the submitted payload; the server allowlist follows the layout too.',
        'A deleted layout degrades gracefully back to the flat field list.'
      ]
    }
  ]
}

export const ssoDocs: DocSection = {
  id: 'sso-providers',
  label: 'SSO Providers',
  content: [
    { type: 'h1', id: 'sso-providers', text: 'SSO Providers (OIDC + SAML)' },
    {
      type: 'p',
      text: 'The OIDC login flow works with any compliant issuer — Microsoft is just the default branding. SAML 2.0 is available as a second SSO method alongside it.'
    },
    {
      type: 'pre',
      code: `# Generic OIDC (any issuer)
OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / OIDC_REDIRECT_URI
OIDC_PROVIDER_LABEL=Okta        # login button text (default: Microsoft)

# SAML SP
SAML_ENTRY_POINT / SAML_ISSUER / SAML_CERT / SAML_CALLBACK_URL
SAML_PROVIDER_LABEL=Company SSO # login button text (default: SSO)

GET /api/auth/providers         # public discovery — drives the login page
GET /api/auth/saml/metadata     # SP metadata for your IdP`
    },
    {
      type: 'note',
      text: 'Email claims fall back to upn / preferred_username (email-shaped values only) for issuers that do not send a plain email claim. TOTP second factor applies to both flows.'
    },
    { type: 'h2', id: 'sso-new-accounts', text: 'New accounts' },
    {
      type: 'p',
      text: 'A first sign-in creates the account automatically. A returning person is matched by the identity provider subject first; email only links a pre-provisioned account on its first sign-in. Settings → Sign-in providers → New accounts picks the role a new account starts in (after any directory-group mapping) and the role it moves to once the person submits an access request. Admin roles cannot be chosen.'
    },
    {
      type: 'pre',
      code: `POST /api/users/me/access-request
{ "reason": "Forecasting for the Central zone", "divisions": [1, 2], "vendor": null }

# → stores preferences.access_request and, when the account still holds the
#   first-sign-in role, moves it to the access-request role
{ "data": { "access_request": { ... }, "role_changed": true } }`
    }
  ]
}

export const adminI18nDocs: DocSection = {
  id: 'admin-i18n',
  label: 'Admin Languages',
  content: [
    { type: 'h1', id: 'admin-i18n', text: 'Admin Interface Languages' },
    {
      type: 'p',
      text: 'The admin shell (navigation, layout chrome) is translatable — English, Español, Deutsch, Français ship built in. Pick the language in Settings → Localization; it applies per browser, instantly.'
    },
    {
      type: 'note',
      text: "This is separate from content localization (field translations / available_locales) — it changes the admin UI itself. Page-level translation is incremental: components call t('key', 'English fallback') from @/lib/i18n, so untranslated screens keep working in English."
    }
  ]
}

export const aiQualityDocs: DocSection = {
  id: 'ai-quality',
  label: 'AI Quality & Budgets',
  content: [
    { type: 'h1', id: 'ai-quality', text: 'AI Quality & Budgets' },
    {
      type: 'p',
      text: 'Admin page /ai/quality (Insights → AI → Quality). Review poor answers, set optional daily spend caps, watch provider health, and try another model before switching.'
    },
    { type: 'h2', id: 'ai-quality-review', text: 'Review queue' },
    {
      type: 'p',
      text: "Every thumbs-down Ask AI answer lands here with the question, tool calls, answer and the person's comment, sorted by an automatic cause (wrong tool, wrong filter, missing data, permission, misunderstood question). Reassign the cause, delete the learned playbook, add a hint to the data guide, or mark it handled."
    },
    { type: 'h2', id: 'ai-quality-budgets', text: 'Budgets and fallback' },
    {
      type: 'ul',
      items: [
        'Caps are off by default (no limit). Each cap is a daily dollar amount per person, per role or for everyone, optionally for one feature, per person or as a shared pool. The day is UTC.',
        "Past a cap the feature switches to the cap's cheaper model if one is set, otherwise it stops with a message naming the cap and when it resets.",
        'People see what is left today under the Ask AI box, only when a cap applies to them.',
        'A fallback model (same provider) is tried when a call fails; the answer says a fallback wrote it. With none set, AI features say AI is unavailable.'
      ]
    },
    { type: 'h2', id: 'ai-quality-savings', text: 'Cost savings' },
    {
      type: 'ul',
      items: [
        "Start cheap (off by default): pick a small model and the features that may start on it — Ask AI, record review, record summaries and field generation. The first call goes to the small model; it moves up to the feature's main model when a tool call fails, before any proposal or plan (always the main model), when the reply is not the JSON the feature asked for, or when the small model says it cannot answer. Streamed summaries and field drafts stay on the main model.",
        '"Try harder" under a quick Ask AI answer asks the main model straight away.',
        "What starting cheap saved: every call is logged with its model and cost; the figure is what the small model's useful calls would have cost on the main model, minus what they cost, minus any cheap calls thrown away (a question asked again on the main model, or replaced by Try harder). This month or the last 30 days.",
        'Tool results sent to the model: per tool, the readable size and the compact size actually sent (about four characters per token), and how many results were reused from earlier in the conversation.',
        'The figures need migration 469 (nivaro_ai_calls.meta); until it has run the switches work and the figures say so.'
      ]
    },
    { type: 'h2', id: 'ai-quality-tools', text: 'Compare, replay and live calls' },
    {
      type: 'p',
      text: 'Compare runs one prompt on two models; Replay re-runs up to 50 recent Ask AI questions as their askers (read-only, no proposals) on a candidate model. Both show a cost estimate you confirm first, are logged as admin activity and count against budgets. Live calls streams each finished AI call (feature, model, person, cost, status) while the tab is open.'
    },
    { type: 'h2', id: 'ai-quality-spend', text: 'Spend, forecast and the bill' },
    {
      type: 'ul',
      items: [
        'Spend shows this month so far and a projected month end per model, feature and person, with last month beside it. The projection adds the last seven finished days’ pace to what is already spent.',
        'Admins get one notice a month when the projection passes a daily budget (counted over the whole month) or last month by a percentage you set. The same figures ride the Monday operations summary.',
        'Last month survives the 30-day call log because a nightly job rolls the log up per day.',
        'Log against the bill: enter or import (CSV lines month,model,usd) what the provider charged. A gap means calls that never reached the log, or prices that drifted; set the billed price per million tokens and new calls are costed with it.'
      ]
    },
    { type: 'h2', id: 'ai-quality-prompt-cost', text: 'Prompt cost' },
    {
      type: 'p',
      text: 'Tokens each part of a request carried (tool definitions, system rules, data guides, glossary, collection lists, playbooks, attachments, history, the question), counted from what was actually sent and scaled to the provider’s own count. Per feature you see the biggest parts and how much was served from cache (only the stable start of a prompt can be); a table by release shows bloat as it ships.'
    },
    { type: 'h2', id: 'ai-quality-tool-board', text: 'Tool reliability' },
    {
      type: 'p',
      text: 'Per Ask AI tool: calls, error rate, empty results, retries after an error (and how many worked, each a wasted round), answers where zero rows were read as “none”, rounds per answer and time. Open a row for its recent failing calls and slowest runs.'
    },
    { type: 'h2', id: 'ai-quality-models', text: 'Model catalogue' },
    {
      type: 'p',
      text: 'A nightly check asks the provider which models it offers (its list where it has one, otherwise a one-token probe per known model). New and retired models are listed. A new model automatically runs Compare and a small replay of saved questions so the side-by-side is waiting; a model still named in the settings that was retired raises a readiness warning and tells admins. Nothing ever switches a model by itself.'
    },
    {
      type: 'p',
      text: 'Extension tools lists the tools extensions give Ask AI (`ctx.ai.registerTool`): the extension each comes from, whether answers that used it may be shared (only a read-only tool its extension declared replayable), and its calls and failures since the server started. A tool whose name a built-in already uses is marked and never offered.'
    },
    {
      type: 'pre',
      code: `GET  /api/ai/spend/forecast     admin: month so far, projection, last month, alerts
GET  /api/ai/spend/reconcile    admin: logged vs billed per month and model
PUT  /api/ai/spend/settings     admin: prices, alert percentage, catalogue switches
PUT  /api/ai/spend/bills        admin: bills (JSON or CSV)
GET  /api/ai/prompt-cost        admin: tokens per prompt part per feature and release
GET  /api/ai/tool-reliability   admin: per-tool board
GET  /api/ai/catalogue          admin: models and side-by-sides
POST /api/ai/catalogue/check    admin: check now (202)
GET  /api/ai/health              provider reachable / slow / failing
GET  /api/ai/budget/me          caller's remaining budget (enabled:false = nothing to show)
GET  /api/ai/budget/status      admin: spend against each cap
GET  /api/ai/review-queue       admin: thumbs-down answers
GET  /api/ai/quality/savings    admin: routing savings + tool payload sizes (?window=month|30d)
PUT  /api/ai/quality/config     admin: caps + fallback model
POST /api/ai/compare/run        admin: needs confirmed_cost_usd from /compare/estimate
POST /api/ai/replay/run         admin: needs confirmed_cost_usd from /replay/estimate`
    }
  ]
}
