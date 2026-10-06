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
        "Tools: list_collections, query_items (items service — RLS applies), aggregate (refuses when the user is row-filtered), semantic_search (hits intersected with the permission-checked read), integration_status (the obligation ledger for a record), record_event_path (the newest integration events naming a record and the path each set off — writes, transitions, flows, partner calls, where it failed), explain_access (why the asker — or, for administrators, another user — can or cannot see a record), record_integrity (a record's live integrity findings, or a collection's newest sweep totals) run_custom_query (a saved SQL query from the catalogue the assistant is given — only queries whose access admits the asker, User-Scope params injected, 200 rows at most) and queue_summary (a queue the asker may read, by name or id from the queue catalogue in the prompt: totals, by-state counts, SLA breaches with hours over and owners, the oldest and unowned records as friendly ids with links, and the at-risk rules firing most — read as the asker through the queue service, so scopes apply).",
        'Ask about a queue from its page: the queue toolbar\'s "Ask about this queue" opens /ask with the question seeded (`/ask?q=…` seeds and sends one question, then drops the parameter).',
        'Reads are direct; mutations only ever happen through the proposal gate (see AI Actions & Dashboards) — the model can never write without your approval.',
        'Every answer shows the tool trace: exactly which queries produced it.',
        'A breakdown or a series (per state, per month, per vendor) comes with a chart: the model attaches a fenced `chart` block ({type, title, data:[{label, value}]}) that renders as a bar, line or pie under the prose.',
        'The same standalone question by the same person inside the answer-cache window (Settings → AI Features, default 15 minutes) answers from cache — the page says when it was first answered and offers "Ask again". Answers that propose an action are never cached; `fresh: true` in the request skips the cache.',
        'Uses the chat model from Settings → AI Features → Model per feature; a model the gateway refuses falls back to the default model.',
        'Answers stream as they are written: send `stream: true` and the route answers `202 {data: {stream_id}}` at once, then emits `ai:delta` (text, with its round), `ai:status` (the tool running), `ai:done` (the full normal body — proposals, trace, request_id) and `ai:error` to your Socket.io user room; add `Accept: text/event-stream` to get the same events as SSE instead (widgets, hosts without the socket). A caller with neither gets the plain reply. `POST /api/ai/chat/:stream_id/stop` halts a running answer. /summarize and /generate take the same `stream` option with text deltas only. The /ask page streams by default, shows what the model is doing while tools run, and has a Stop button.'
      ]
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
      text: 'Email a PDF snapshot of a collection (filtered rows as a table) or a queue (stat strip + items) on a cron schedule. Managed at /scheduled-reports.'
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
