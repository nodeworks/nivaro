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
        'Tools: list_collections, query_items (items service — RLS applies), aggregate (refuses when the user is row-filtered), semantic_search (hits intersected with the permission-checked read).',
        'Reads are direct; mutations only ever happen through the proposal gate (see AI Actions & Dashboards) — the model can never write without your approval.',
        'Every answer shows the tool trace: exactly which queries produced it.',
        'Uses the model configured in Settings → AI Features.'
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
        'Applies only to rules with "business hours only" enabled; other rules use wall-clock hours.'
      ]
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
        'New schedules activate on the next server restart (crons register at boot); Send now works immediately.'
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
