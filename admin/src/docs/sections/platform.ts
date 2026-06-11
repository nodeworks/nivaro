import type { DocSection } from '../types.js'

export const aiContentValidation: DocSection = {
  id: 'ai-content-validation',
  label: 'AI Content Validation',
  content: [
    { type: 'h1', id: 'ai-content-validation', text: 'AI Content Validation' },
    {
      type: 'p',
      text: 'AI content validation checks items against natural-language rules before they are saved. Rules are written in plain English per collection ("the title must not contain pricing information", "the summary must be in a professional tone") and evaluated by Claude against the submitted values. Each rule is either soft (warn) or hard (block).'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Open Data Model → select a table → Settings tab → "AI Features" card. Add validation rules as plain-text statements and choose Warn or Block per rule. Settings are stored per collection in `nivaro_ai_collection_settings`. In the item editor, violations of soft rules appear as inline warnings next to the affected fields — the save still goes through. Hard rules block the save.'
    },
    { type: 'h3', text: 'Soft warn vs hard block' },
    {
      type: 'table',
      head: ['Mode', 'Item editor', 'API behaviour'],
      rows: [
        [
          'Soft (warn)',
          'Inline warning banner per violated rule; user may save anyway.',
          'Save succeeds; violations are returned for display only.'
        ],
        [
          'Hard (block)',
          'Save is prevented until the content passes or the rule is changed.',
          'Create/update is rejected with `422 Unprocessable Entity` listing the violated rules.'
        ]
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `POST /api/ai/validate
Authorization: Bearer <token>

{
  "collection": "articles",
  "data": { "title": "Cheap deal — only $9.99!", "body": "..." }
}

→ {
  "data": {
    "valid": false,
    "violations": [
      {
        "rule": "The title must not contain pricing information",
        "severity": "block",
        "explanation": "The title mentions a specific price ($9.99)."
      }
    ]
  }
}`
    },
    {
      type: 'note',
      text: 'Hard rules are also enforced server-side via a before-create/before-update hook — direct API writes that violate a blocking rule receive a 422 regardless of which client sent them. Requires an Anthropic API key (env or Settings → AI Features); without a key, validation is skipped entirely.'
    }
  ]
}

export const aiDuplicateDetection: DocSection = {
  id: 'ai-duplicate-detection',
  label: 'AI Duplicate Detection',
  content: [
    { type: 'h1', id: 'ai-duplicate-detection', text: 'AI Duplicate Detection' },
    {
      type: 'p',
      text: 'Duplicate detection warns users before they create a record that looks like an existing one. The new record\'s text fields are embedded into a vector and compared against existing records by cosine similarity — semantically similar records ("Acme Corp." vs "ACME Corporation Inc.") are caught even when no keyword matches.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Open Data Model → select a table → Settings tab → "AI Features" card. Toggle "Duplicate detection" on and set the similarity threshold (0–1; higher = stricter, fewer matches). When enabled, the create-item page shows a pre-create panel listing potential duplicates with similarity scores before the save — the user can open a match or proceed with the create.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `POST /api/ai/check-duplicates
Authorization: Bearer <token>

{
  "collection": "companies",
  "data": { "name": "ACME Corporation Inc.", "city": "Berlin" }
}

→ {
  "data": {
    "matches": [
      { "id": "uuid", "similarity": 0.93, "preview": { "name": "Acme Corp.", "city": "Berlin" } }
    ]
  }
}`
    },
    {
      type: 'note',
      text: 'Detection is advisory — it never blocks the create. The toggle and threshold live in `nivaro_ai_collection_settings` alongside the validation rules. Embeddings use the same provider chain as semantic search.'
    }
  ]
}

export const anomalyDetection: DocSection = {
  id: 'anomaly-detection',
  label: 'Anomaly Detection',
  content: [
    { type: 'h1', id: 'anomaly-detection', text: 'Anomaly Detection Alerts' },
    {
      type: 'p',
      text: 'Alert definitions support a statistical detection mode in addition to fixed thresholds. An anomaly alert learns what "normal" looks like for a numeric field — a rolling window of up to ~200 rows over the last 90 days — and fires when a new value deviates from the mean by more than the configured number of standard deviations.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Open Alerts → create or edit a definition → set Detection type to "Anomaly" (instead of "Threshold"). The threshold/operator inputs are replaced by a Sensitivity setting — the standard-deviation multiplier (e.g. 2 = fire on values more than 2σ from the mean; lower = more sensitive). Subscriptions, cooldown, and the alert log work exactly as for threshold alerts.'
    },
    { type: 'h3', text: 'How it evaluates' },
    {
      type: 'ul',
      items: [
        "The baseline window samples up to ~200 recent rows from the last 90 days for the watched field (respecting the definition's filters).",
        'Mean and standard deviation are computed over the window; a new value with |z-score| greater than the sensitivity fires the alert.',
        'Notifications include the z-score and, when an Anthropic API key is configured, a short Claude-generated explanation of why the value is unusual.',
        '`detection_type` (`threshold` | `anomaly`) and `sensitivity` are columns on `nivaro_alert_definitions`.'
      ]
    },
    {
      type: 'note',
      text: 'Anomaly alerts need enough history to compute a meaningful baseline — with very few rows the standard deviation is unstable and the alert stays quiet rather than firing on noise.'
    }
  ]
}

export const smtpConfig: DocSection = {
  id: 'smtp-config',
  label: 'Email / SMTP',
  content: [
    { type: 'h1', id: 'smtp-config', text: 'Email / SMTP Configuration' },
    {
      type: 'p',
      text: 'SMTP settings are configured in Settings → Email. DB values take precedence over env vars — any field left blank falls back to the corresponding env var, so you can bootstrap with env vars and migrate to DB config without downtime.'
    },
    { type: 'h3', text: 'Provider presets' },
    {
      type: 'p',
      text: 'Click a provider chip to auto-fill host, port, and TLS setting. Credentials (username/password) are always entered manually.'
    },
    {
      type: 'table',
      head: ['Provider', 'Host', 'Port', 'TLS'],
      rows: [
        ['Gmail', 'smtp.gmail.com', '587', 'STARTTLS'],
        ['Outlook / Office 365', 'smtp.office365.com', '587', 'STARTTLS'],
        ['SendGrid', 'smtp.sendgrid.net', '587', 'STARTTLS'],
        ['Mailgun', 'smtp.mailgun.org', '587', 'STARTTLS'],
        ['Amazon SES', 'email-smtp.us-east-1.amazonaws.com', '587', 'STARTTLS'],
        ['Postmark', 'smtp.postmarkapp.com', '587', 'STARTTLS'],
        ['Resend', 'smtp.resend.com', '465', 'TLS'],
        ['Brevo', 'smtp-relay.brevo.com', '587', 'STARTTLS'],
        ['Mailchimp / Mandrill', 'smtp.mandrillapp.com', '587', 'STARTTLS'],
        ['Yahoo Mail', 'smtp.mail.yahoo.com', '587', 'STARTTLS']
      ]
    },
    { type: 'h3', text: 'Fields' },
    {
      type: 'table',
      head: ['Field', 'Env var fallback', 'Notes'],
      rows: [
        ['SMTP host', 'SMTP_HOST', 'Auto-filled by provider presets'],
        ['SMTP port', 'SMTP_PORT', 'Auto-filled by provider presets'],
        ['Secure (TLS)', 'SMTP_SECURE', 'Auto-filled; enable for port 465, off for STARTTLS'],
        ['SMTP username', 'SMTP_USER', 'Omit for unauthenticated relay'],
        ['SMTP password', 'SMTP_PASSWORD', 'Masked on GET; preserved if placeholder re-submitted'],
        ['Mail from', 'MAIL_FROM', 'Sender address, e.g. `Nivaro <no-reply@example.com>`']
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `GET   /api/settings          # smtp_pass → ••••••
PATCH /api/settings          # smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_secure

POST  /api/settings/mail/test  { "to": "you@example.com" }
      # → { "ok": true } | { "error": "<SMTP error>" }`
    },
    { type: 'h3', text: 'Using from extensions' },
    {
      type: 'pre',
      code: `import { sendMail, sendRawMail } from '../../src/services/mail.js';

await sendMail({ to: 'user@example.com', subject: 'Shipped', template: 'order-shipped', data: { orderNumber: '123' } });
await sendRawMail({ to: 'user@example.com', subject: 'Notice', html: '<p>Hello</p>' });`
    },
    {
      type: 'note',
      text: 'Both functions no-op with a console.warn when no SMTP host is set — safe in local dev.'
    }
  ]
}

export const smsConfig: DocSection = {
  id: 'sms-config',
  label: 'SMS',
  content: [
    { type: 'h1', id: 'sms-config', text: 'SMS Configuration' },
    {
      type: 'p',
      text: 'SMS delivery is configured in Settings → SMS. Select a provider, enter credentials, and optionally send a test message. All providers are implemented without external SDKs — Twilio, Vonage, Sinch, and MessageBird use plain fetch; Amazon SNS uses native crypto.subtle for SigV4 signing.'
    },
    { type: 'h3', text: 'Supported providers' },
    {
      type: 'table',
      head: ['Provider', 'Account ID field', 'Token field', 'Extra'],
      rows: [
        ['Twilio', 'Account SID', 'Auth token', '—'],
        ['Amazon SNS', 'Access key ID', 'Secret access key', 'Region (default us-east-1)'],
        ['Vonage (Nexmo)', 'API key', 'API secret', '—'],
        ['Sinch', 'Service plan ID', 'API token', '—'],
        ['MessageBird', 'API key', 'API key (repeated)', '—']
      ]
    },
    { type: 'h3', text: 'Fields stored in nivaro_settings' },
    {
      type: 'table',
      head: ['Column', 'Description'],
      rows: [
        ['sms_provider', 'twilio | aws-sns | vonage | sinch | messagebird'],
        ['sms_account_sid', 'Account ID / API key for the provider'],
        ['sms_auth_token', 'Secret — masked on GET, preserved if placeholder re-submitted'],
        ['sms_from', 'Sender number (E.164) or alphanumeric ID'],
        ['sms_region', 'AWS region for SNS (default us-east-1)']
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `GET   /api/settings           # sms_auth_token → ••••••
PATCH /api/settings           # sms_provider, sms_account_sid, sms_auth_token, sms_from, sms_region

POST  /api/settings/sms/test  { "to": "+12125550100" }
      # → { "ok": true } | { "error": "<provider error>" }`
    },
    { type: 'h3', text: 'Using from extensions' },
    {
      type: 'pre',
      code: `import { sendSms } from '../../src/services/sms.js';

// Reads provider + credentials from nivaro_settings at call time
await sendSms('+12125550100', 'Your verification code is 482910');`
    },
    {
      type: 'note',
      text: '`sendSms` no-ops with a console.warn when no provider is configured. Use it from notification channel extensions or hooks to add SMS delivery alongside in-app and email.'
    }
  ]
}

export const digestEmails: DocSection = {
  id: 'digest-emails',
  label: 'Digest Emails',
  content: [
    { type: 'h1', id: 'digest-emails', text: 'Digest Emails' },
    {
      type: 'p',
      text: 'Notification subscriptions can be delivered as a daily or weekly digest instead of one email per event. Digests bundle everything that matched a subscription since the last digest into a single summary mail, cutting inbox noise for high-volume collections.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Open Notification Subscriptions → each subscription row has a Delivery column with three options: Instant (default — one mail per event), Daily, or Weekly. The setting is per subscription, so you can keep critical subscriptions instant while batching noisy ones.'
    },
    { type: 'h3', text: 'Schedule' },
    {
      type: 'table',
      head: ['Frequency', 'When it sends'],
      rows: [
        ['Daily', 'Every day at 08:00 (server time).'],
        ['Weekly', 'Every Monday at 08:00 (server time).']
      ]
    },
    {
      type: 'ul',
      items: [
        "Each digest covers events since the user's `last_digest_at` watermark; sending a digest advances the watermark.",
        'In-app notifications are unaffected — digests only change email delivery.',
        'Subscriptions store the choice in `nivaro_notification_subscriptions.digest_frequency` (`instant` | `daily` | `weekly`).'
      ]
    },
    {
      type: 'note',
      text: 'The daily and weekly crons share the same per-user watermark — a user with both daily and weekly subscriptions never receives the same event twice across digests.'
    }
  ]
}

export const rowLevelSecurity: DocSection = {
  id: 'row-level-security',
  label: 'Row-Level Security',
  content: [
    { type: 'h1', id: 'row-level-security', text: 'Row-Level Security (RLS)' },
    {
      type: 'p',
      text: 'Row-level security restricts which rows of a collection a role can see and touch. Each policy can carry a `row_filter` — a set of conditions evaluated against every row — so a role might only read orders where `owner = $CURRENT_USER` or update records in its own region. RLS is opt-in per policy: policies without a row filter behave exactly as before.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Open Roles → select a role → expand a policy → "Row-level security" section. Build conditions with field/operator/value rows; use the special tokens below as values to scope rows to the requesting user. The filter applies to read, update, and delete for that policy\'s collection + action.'
    },
    { type: 'h3', text: 'Tokens' },
    {
      type: 'table',
      head: ['Token', 'Resolves to'],
      rows: [
        ['$CURRENT_USER', 'The id of the user making the request.'],
        ['$CURRENT_ROLE', "The id of the requesting user's role."]
      ]
    },
    { type: 'h3', text: 'Filter format' },
    {
      type: 'pre',
      code: `// nivaro_policies.row_filter (JSON):
{
  "conditions": [
    { "field": "owner",  "operator": "_eq", "value": "$CURRENT_USER" },
    { "field": "status", "operator": "_neq", "value": "archived" }
  ]
}
// All conditions must pass (AND). Operators: _eq | _neq | _null | _nnull | _in | _contains`
    },
    {
      type: 'ul',
      items: [
        'Read: filtered rows are invisible — lists exclude them and direct reads return 404.',
        'Update / delete: mutations against rows outside the filter are rejected with 403.',
        'Admins bypass RLS entirely, like the rest of the permission system.'
      ]
    },
    {
      type: 'warn',
      text: 'RLS applies wherever the items service is used — REST, GraphQL, SDK, bulk actions, and Zapier actions all enforce the same row filters. Raw custom SQL queries are not filtered.'
    }
  ]
}

export const roleUiPermissions: DocSection = {
  id: 'role-ui-permissions',
  label: 'Role UI Access',
  content: [
    {
      type: 'p',
      text: 'Admins can restrict which admin UI sections are visible per role. Go to Roles → select a role → "UI Access" tab. Uncheck any nav item to hide it from that role and block direct URL access.'
    },
    {
      type: 'note',
      text: 'Admin roles always have full UI access — restrictions never apply to admins. The API is not affected; use policies to restrict API access. UI permissions only control what is visible in the admin interface.'
    },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        ['PATCH', '/api/roles/:id/ui-permissions', 'Update UI permissions. Body: { disabled: string[] } — array of route paths to block, e.g. ["/erp-submissions", "/workspaces"].']
      ]
    }
  ]
}

export const zeroDowntimeMigrations: DocSection = {
  id: 'zero-downtime-migrations',
  label: 'Zero-Downtime Migrations',
  content: [
    { type: 'h1', id: 'zero-downtime-migrations', text: 'Zero-Downtime Migrations' },
    {
      type: 'p',
      text: 'For multi-replica deployments, Nivaro can run startup migrations safely while other instances keep serving traffic. Safe mode takes a database advisory lock before migrating, so only one instance runs migrations while the rest wait, and SIGTERM triggers a graceful drain instead of killing in-flight requests.'
    },
    { type: 'h3', text: 'Environment' },
    {
      type: 'pre',
      code: `# .env
MIGRATION_SAFE_MODE=true          # take an advisory lock before running migrations
MIGRATION_LOCK_TIMEOUT_MS=60000   # how long a starting instance waits for the lock`
    },
    { type: 'h3', text: 'Behaviour' },
    {
      type: 'ul',
      items: [
        'The advisory lock is per-dialect: `sp_getapplock` on MSSQL, `pg_advisory_lock` on PostgreSQL, `GET_LOCK` on MySQL.',
        'The instance that wins the lock runs pending migrations; others wait up to `MIGRATION_LOCK_TIMEOUT_MS` and then continue startup against the already-migrated schema.',
        'On SIGTERM the server stops accepting new connections, lets in-flight requests finish, then exits — rolling deploys never cut requests mid-flight.'
      ]
    },
    {
      type: 'note',
      text: 'With MIGRATION_SAFE_MODE unset, startup behaves as before (migrate then listen) — appropriate for single-instance deployments.'
    }
  ]
}

export const ecommercePrimitives: DocSection = {
  id: 'ecommerce-primitives',
  label: 'E-Commerce Primitives',
  content: [
    { type: 'h1', id: 'ecommerce-primitives', text: 'Headless E-Commerce Primitives' },
    {
      type: 'p',
      text: 'The `ecommerce` collection preset scaffolds the core of a headless shop in one click: products, orders, and inventory movements with the relations and automation wired up. Combine it with submission forms (checkout intake), the Widget SDK (embeddable product lists), and flows (order processing) for a complete storefront backend.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Open the collection presets page (Collections → "Install preset", backed by /collection-presets) and install the E-Commerce preset. Like every preset, installation is idempotent by collection name — existing collections are skipped.'
    },
    { type: 'h3', text: 'What gets created' },
    {
      type: 'table',
      head: ['Piece', 'Details'],
      rows: [
        ['products', 'SKU, name, description, price, stock_on_hand, images, is_active.'],
        [
          'orders',
          'Order number, customer details, status, totals, line items for ordered products.'
        ],
        [
          'inventory_movements',
          'Append-only stock ledger: product FK, quantity delta, reason (sale / restock / adjustment).'
        ],
        [
          'Relation',
          'inventory_movements → products (M2O), so each movement is tied to its product.'
        ],
        [
          'Low-stock alert',
          'A pre-configured alert definition that fires when product stock falls below the threshold.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Everything the preset creates is plain Nivaro schema — extend the collections with your own fields, bind workflows to orders, or expose products through token-gated widget feeds.'
    }
  ]
}

export const widgetSdk: DocSection = {
  id: 'widget-sdk',
  label: 'Embeddable Widget SDK',
  content: [
    { type: 'h1', id: 'widget-sdk', text: 'Embeddable Widget SDK' },
    {
      type: 'p',
      text: 'Widget feeds expose a curated slice of a collection to the public web — a list of records or a submission form — embeddable on any external site with a one-line script tag. No iframe is used: the widget renders directly into the host page DOM with XSS-safe text rendering, and access is gated by a per-feed token.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Open /widgets to manage feeds. Each feed (stored in `nivaro_widget_feeds`) defines the collection, the visible fields, optional filters and limit, and a widget type (list or form). Creating a feed generates its token and a copy-paste embed snippet.'
    },
    { type: 'h3', text: 'Embedding' },
    {
      type: 'pre',
      code: `<!-- List widget -->
<script src="https://nivaro.example.com/api/widget.js"
        data-nivaro-widget="list"
        data-token="wft_..."></script>

<!-- Form widget (public submission) -->
<script src="https://nivaro.example.com/api/widget.js"
        data-nivaro-widget="form"
        data-token="wft_..."></script>`
    },
    {
      type: 'ul',
      items: [
        'The script reads its own data- attributes, fetches the feed data with the token, and renders into a container inserted at the script position.',
        'Only the fields configured on the feed are ever serialized — the token cannot be used to read anything else.',
        'All values are rendered via textContent (never innerHTML), so feed data cannot inject script into the host page.',
        'Revoking or deactivating a feed kills all embeds using its token immediately.'
      ]
    },
    {
      type: 'note',
      text: '`/api/widget.js` is also aliased at the server root, so embeds keep working when the API is mounted behind a path prefix.'
    }
  ]
}

export const zapierMake: DocSection = {
  id: 'zapier-make',
  label: 'Zapier / Make Integration',
  content: [
    { type: 'h1', id: 'zapier-make', text: 'Zapier / Make Integration' },
    {
      type: 'p',
      text: 'A dedicated `/api/zapier` surface makes Nivaro pluggable into Zapier, Make (Integromat), and similar no-code automation platforms: REST-hook triggers for item events, action endpoints for creating and updating records, and discovery endpoints the platforms use to build dynamic dropdowns.'
    },
    { type: 'h3', text: 'Authentication' },
    {
      type: 'p',
      text: "Connections authenticate with a named API key (`nvk_` prefix, created at /api-keys) sent as a Bearer token. `GET /api/zapier/me` is the connection test — it returns the key's identity."
    },
    { type: 'h3', text: 'Endpoints' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Purpose'],
      rows: [
        ['GET', '/api/zapier/me', 'Connection test — identifies the API key / user.'],
        ['GET', '/api/zapier/collections', 'List collections for dynamic dropdowns.'],
        [
          'GET',
          '/api/zapier/triggers/:collection',
          'Polling trigger — recent items for the collection.'
        ],
        [
          'POST',
          '/api/zapier/hooks',
          'Subscribe a REST hook. Body: { collection, event, target_url }.'
        ],
        ['DELETE', '/api/zapier/hooks/:id', 'Unsubscribe a REST hook.'],
        ['POST', '/api/zapier/actions/create', 'Create an item. Body: { collection, data }.'],
        ['POST', '/api/zapier/actions/update', 'Update an item. Body: { collection, id, data }.'],
        [
          'GET',
          '/api/zapier/manifest',
          'Machine-readable description of triggers/actions for app builders.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'REST hooks are stored as rows in `nivaro_webhooks` — they appear on the Webhooks page and reuse the delivery log, retries, and dead-letter queue.',
        'Action endpoints route through the items service, so RBAC, row-level security, hooks, computed fields, and activity logging all apply to records created from Zaps.'
      ]
    },
    {
      type: 'note',
      text: 'Make and other platforms that speak generic REST hooks work with the same endpoints — nothing is Zapier-specific beyond the manifest shape.'
    }
  ]
}

export const publicApiDocs: DocSection = {
  id: 'public-api-docs',
  label: 'Public API Docs Site',
  content: [
    { type: 'h1', id: 'public-api-docs', text: 'Public API Reference Site' },
    {
      type: 'p',
      text: 'The marketing/docs site ships a standalone API reference at `www/api-reference.html` — a static three-pane explorer rendered from `www/openapi.json`. It is linked from the docs navigation as "API Reference ↗" and needs no server beyond static hosting.'
    },
    { type: 'h3', text: 'Regenerating the spec' },
    {
      type: 'pre',
      code: `# Default: build www/openapi.json directly from the database schema
# registry (uses the repo's .env config — no running server, no token):
pnpm docs:api

# Remote mode: fetch from a running instance instead:
pnpm docs:api -- --url https://nivaro.example.com --token <admin-token>`
    },
    {
      type: 'ul',
      items: [
        'Default mode runs `api/src/scripts/generate-openapi.ts` with tsx and builds the spec straight from `nivaro_collections` / `nivaro_fields` — it always reflects the actual schema registry.',
        'Remote mode (`--url`) fetches the live `GET /api/dev-tools/openapi.json` (admin only); the token defaults to `$NIVARO_TOKEN`.',
        'The spec includes per-collection items endpoints, so regenerate after meaningful schema changes to keep the public reference current.',
        'For private/internal use, the same spec is always available live from GET /api/dev-tools/openapi.json (see OpenAPI / Postman / Bruno).'
      ]
    }
  ]
}

export const sdkCoverage: DocSection = {
  id: 'sdk-coverage',
  label: 'Full API Coverage',
  content: [
    { type: 'h1', id: 'sdk-coverage', text: 'SDK Coverage: ~175 Typed Commands' },
    {
      type: 'p',
      text: 'The @nivaro/sdk command surface now covers every feature area — roughly 175 typed `Command<T>` factories spanning items, files, workflows, pipelines, flows, comments, webhooks, rules, custom queries, trees and hierarchies, submission forms, field watches, notification subscriptions, imports, SLA, alerts, AI endpoints (generate, summarize, validate, check-duplicates), translations, drafts, scheduled changes, record templates, saved views, API keys, widget feeds, sync jobs, ERP submissions, PDF templates, pages, and more. If a REST route exists, there is a typed command for it.'
    },
    { type: 'h3', text: 'Discovering commands' },
    {
      type: 'ul',
      items: [
        'Everything is exported from the package root — editor autocomplete on `import { … } from "@nivaro/sdk"` is the fastest index.',
        "The SDK Playground at /sdk-playground runs snippets against the live instance with your session's permissions, with collection and field comboboxes to scaffold calls.",
        'All commands flow through `nivaro.request(command)`, so auth, workspace headers, and error handling are uniform.'
      ]
    },
    {
      type: 'pre',
      code: `import { createNivaro, readItems, aiValidate, listWidgetFeeds } from '@nivaro/sdk';

const nivaro = createNivaro('https://nivaro.example.com').withToken('nvk_...');

const articles = await nivaro.request(readItems('articles', { limit: 5 }));
const check = await nivaro.request(aiValidate('articles', { title: 'Draft post' }));
const feeds = await nivaro.request(listWidgetFeeds());`
    }
  ]
}

export const collectionLayouts: DocSection = {
  id: 'collection-layouts',
  label: 'Collection Layouts',
  content: [
    { type: 'h1', id: 'collection-layouts', text: 'Collection Layouts' },
    {
      type: 'p',
      text: 'Each registered collection can have multiple named layouts. A layout defines how fields are grouped and ordered in the item editor. One layout is marked active and used by ItemEdit automatically; others can be referenced by name via the SDK.'
    },
    { type: 'h3', text: 'Managing layouts' },
    {
      type: 'p',
      text: 'Open Data Model → select a collection → Layout tab. The left panel lists layouts for the collection. Click a layout to edit its groups and field assignments. The active layout (shown with a cyan dot) is what the item editor displays. Double-click a layout name to rename it inline.'
    },
    {
      type: 'table',
      head: ['Action', 'How'],
      rows: [
        ['Create layout', 'Click "+ Add layout" at the bottom of the left panel'],
        ['Set active', 'Open a layout → click "Set active" in the toolbar'],
        ['Clone layout', 'Open a layout → click "Clone" to duplicate groups + field assignments'],
        ['Delete layout', 'Open a layout → click "Delete" (blocked if it is the only layout)'],
        ['Rename layout', 'Double-click the layout name in the left panel']
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/collection-layouts?collection=articles
POST /api/collection-layouts                    { collection, name }
POST /api/collection-layouts/:id/activate
POST /api/collection-layouts/:id/clone          { name }
GET  /api/collection-layouts/:id/assignments
PUT  /api/collection-layouts/:id/assignments    { assignments: [{field, group_key, sort}] }
DELETE /api/collection-layouts/:id`
    },
    { type: 'h3', text: 'SDK' },
    {
      type: 'pre',
      code: `import { readCollectionLayouts, readActiveLayout, readLayoutAssignments, activateLayout, cloneLayout } from '@nivaro/sdk'

// List all layouts
const layouts = await cms.request(readCollectionLayouts('articles'))

// Read active layout with groups + assignments
const active = await cms.request(readActiveLayout('articles'))

// Use a specific layout in @nivaro/react
useNivaroForm('articles', { mode: 'create', layoutId: 42 })`
    }
  ]
}
