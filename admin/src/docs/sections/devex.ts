import type { DocSection } from '../types.js'

export const devexCodegen: DocSection = {
  id: 'ts-codegen',
  label: 'TypeScript Codegen',
  content: [
    { type: 'h1', id: 'ts-codegen', text: 'Schema → TypeScript Codegen' },
    {
      type: 'p',
      text: 'Generate TypeScript interfaces for every registered collection straight from the metadata registry. The endpoint returns a ready-to-commit `.ts` file with one interface per collection, typed by field type (including relations and computed fields).'
    },
    {
      type: 'pre',
      code: `# Download the generated types
curl -H "Authorization: Bearer <token>" \\
  https://nivaro.example.com/api/dev-tools/types.ts > src/nivaro-types.ts

// Or via the SDK:
const ts = await nivaro.request(getTypes());`
    },
    {
      type: 'note',
      text: "Regenerate after schema changes — the file reflects the live registry at request time. Pair with the SDK for end-to-end typed reads: nivaro.request(readItems<Article>('articles'))."
    }
  ]
}

export const devexOpenApi: DocSection = {
  id: 'openapi-export',
  label: 'OpenAPI / Postman / Bruno',
  content: [
    { type: 'h1', id: 'openapi-export', text: 'OpenAPI 3.1 & Collection Exports' },
    {
      type: 'p',
      text: 'The full REST surface — including per-collection items endpoints generated from your schema — is exported as an OpenAPI 3.1 document, a Postman collection, or a Bruno collection.'
    },
    {
      type: 'pre',
      code: `GET /api/dev-tools/openapi.json    # OpenAPI 3.1 spec
GET /api/dev-tools/postman.json    # Postman v2.1 collection
GET /api/dev-tools/bruno.json      # Bruno collection

// SDK:
const spec = await nivaro.request(getOpenApi());`
    },
    {
      type: 'ul',
      items: [
        'Schemas are derived from nivaro_collections / nivaro_fields, so collection endpoints carry real request/response models.',
        'Import the Postman/Bruno file directly — auth is pre-wired as a Bearer token variable.',
        'Feed openapi.json into client generators (openapi-typescript, Kiota, etc.) for non-TS stacks.'
      ]
    }
  ]
}

export const devexWebhookDeliveries: DocSection = {
  id: 'webhook-deliveries',
  label: 'Webhook Delivery Log',
  content: [
    { type: 'h1', id: 'webhook-deliveries', text: 'Webhook Delivery Log, Retry & Replay' },
    {
      type: 'p',
      text: 'Every webhook attempt is recorded in `nivaro_webhook_deliveries` — request payload, response status, response body snippet, duration, and attempt number. Failed deliveries can be retried individually, and any past activity event can be replayed through the webhook pipeline.'
    },
    { type: 'h3', text: 'Endpoints' },
    {
      type: 'pre',
      code: `GET  /api/webhooks/:id/deliveries          # delivery history for a webhook
POST /api/webhooks/deliveries/:id/retry    # re-send one failed delivery
POST /api/webhooks/replay/:activityId      # replay an activity event through all matching webhooks`
    },
    {
      type: 'ul',
      items: [
        'The webhook editor shows the delivery log inline with status badges and expandable payloads.',
        'Retry re-sends the original payload; replay rebuilds the payload from the activity/revision record.',
        'Deliveries that exhaust retries land in the Dead Letter Queue.'
      ]
    }
  ]
}

export const devexWebhookSigning: DocSection = {
  id: 'webhook-signing',
  label: 'Webhook HMAC Signing',
  content: [
    { type: 'h1', id: 'webhook-signing', text: 'Webhook HMAC Signing' },
    {
      type: 'p',
      text: 'Webhooks can be configured with a `signing_secret`. When set, every delivery includes an `X-Nivaro-Signature` header containing an HMAC-SHA256 of the raw request body, so receivers can verify authenticity and integrity.'
    },
    {
      type: 'pre',
      code: `# Delivery header
X-Nivaro-Signature: sha256=<hex hmac of raw body>

// Receiver verification (Node):
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}`
    },
    {
      type: 'warn',
      text: 'Always verify against the raw request body before JSON parsing — re-serialised JSON will not match the signature.'
    }
  ]
}

export const devexRequestSigning: DocSection = {
  id: 'external-api-signing',
  label: 'External API Request Signing',
  content: [
    { type: 'h1', id: 'external-api-signing', text: 'External API Request Signing' },
    {
      type: 'p',
      text: 'External API configs support two additional auth types beyond bearer/basic/api-key: `hmac` (HMAC-SHA256 of the request, header-delivered) and `aws_sigv4` (full AWS Signature Version 4 for S3-compatible and AWS APIs). Credentials stay inside the config — extensions and flows still call via callExternalApi without ever seeing them.'
    },
    {
      type: 'table',
      head: ['Auth type', 'What is signed', 'Typical use'],
      rows: [
        [
          'hmac',
          'Method + path + body, HMAC-SHA256 with shared secret',
          'Partner APIs requiring signed requests'
        ],
        [
          'aws_sigv4',
          'Canonical AWS request (headers, payload hash)',
          'AWS APIs, S3-compatible object stores'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Like all External API secrets, signing keys are masked on GET and preserved when the masked value is re-submitted.'
    }
  ]
}

export const devexRateLimits: DocSection = {
  id: 'rate-limits',
  label: 'Rate Limiting',
  content: [
    { type: 'h1', id: 'rate-limits', text: 'Rate Limiting & Headers' },
    {
      type: 'p',
      text: 'API requests are rate-limited per principal using a Redis fixed-window counter. Configure the global window with `RATE_LIMIT_PER_MINUTE`; named API keys may carry their own per-key override. Every response includes standard X-RateLimit headers.'
    },
    {
      type: 'pre',
      code: `# .env
RATE_LIMIT_PER_MINUTE=600

# Response headers
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 597
X-RateLimit-Reset: 1718000460   # epoch seconds of window reset

# When exceeded → 429 with Retry-After`
    },
    {
      type: 'note',
      text: 'The limiter fails open: if Redis is unreachable, requests are allowed through rather than blocked, so a cache outage never takes the API down.'
    }
  ]
}

export const devexCdcStream: DocSection = {
  id: 'cdc-stream',
  label: 'CDC Event Stream',
  content: [
    { type: 'h1', id: 'cdc-stream', text: 'Change Data Capture Stream (SSE)' },
    {
      type: 'p',
      text: 'Admins can subscribe to a server-sent-events stream of every item mutation (create/update/delete) across all collections — useful for cache invalidation, search indexing, and downstream sync without polling activity.'
    },
    {
      type: 'pre',
      code: `# Admin-only SSE stream
curl -N -H "Authorization: Bearer <admin-token>" \\
  https://nivaro.example.com/api/stream

event: change
data: {"action":"update","collection":"articles","item":"42","user":"...","timestamp":"..."}`
    },
    {
      type: 'ul',
      items: [
        'Standard EventSource semantics — reconnect with Last-Event-ID to resume.',
        'Events mirror what lands in nivaro_activity, emitted in real time.',
        'Admin only; use a dedicated API key for long-lived consumers.'
      ]
    }
  ]
}

export const devexPersistedQueries: DocSection = {
  id: 'persisted-queries',
  label: 'GraphQL Persisted Queries',
  content: [
    { type: 'h1', id: 'persisted-queries', text: 'GraphQL Persisted Queries' },
    {
      type: 'p',
      text: 'Pre-registered GraphQL queries are stored in `nivaro_persisted_queries` and executed by id, cutting payload size and locking the query surface. Both explicit ids and Apollo-style automatic persisted queries (APQ) via the extensions field are supported.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Persisted queries are managed on the /persisted-queries page: register a named query with its GraphQL text, see usage, edit the stored text, or delete a registration. APQ-registered hashes appear in the same list.'
    },
    { type: 'h3', text: 'Executing' },
    {
      type: 'pre',
      code: `// Explicit id form:
POST /api/graphql
{ "id": "dashboard-articles", "variables": { "limit": 10 } }

// APQ form (sha256 of the query string):
POST /api/graphql
{
  "extensions": {
    "persistedQuery": { "version": 1, "sha256Hash": "<hash>" }
  },
  "variables": { "limit": 10 }
}
// First call with hash + query registers it; subsequent calls send the hash only.`
    },
    {
      type: 'note',
      text: 'When a request carries an id or APQ hash, the stored query text is substituted before execution — a query string sent alongside a known hash is ignored unless it is the initial registration.'
    }
  ]
}

export const devexDeadLetters: DocSection = {
  id: 'dead-letters',
  label: 'Dead Letter Queue',
  content: [
    { type: 'h1', id: 'dead-letters', text: 'Dead Letter Queue' },
    {
      type: 'p',
      text: 'Webhook deliveries, flow runs, and notification sends that exhaust their retries land in the dead letter queue instead of disappearing. Inspect, retry, or discard them from the /dead-letters admin page.'
    },
    {
      type: 'pre',
      code: `GET    /api/dead-letters            # list (filter by source: webhook | flow | notification)
GET    /api/dead-letters/:id        # full payload + failure reason
POST   /api/dead-letters/:id/retry  # re-enqueue the original operation
DELETE /api/dead-letters/:id        # discard`
    },
    {
      type: 'note',
      text: 'A retry that fails again creates a fresh dead letter with an incremented attempt count, preserving the failure history.'
    }
  ]
}

export const devexFlowVersioning: DocSection = {
  id: 'flow-versioning',
  label: 'Flow Versioning',
  content: [
    { type: 'h1', id: 'flow-versioning', text: 'Flow Versioning' },
    {
      type: 'p',
      text: 'Every save of a flow snapshots its full definition (trigger + operations graph) into `nivaro_flow_versions`. The flow editor shows the version history with author and timestamp; any version can be restored as the current definition.'
    },
    {
      type: 'ul',
      items: [
        'FlowEdit → Versions panel lists snapshots newest-first.',
        'Restore copies the snapshot back as a new version — history is never rewritten.',
        'In-flight runs keep executing the version they started with.'
      ]
    }
  ]
}

export const devexEnvSync: DocSection = {
  id: 'environment-sync',
  label: 'Environment Sync',
  content: [
    { type: 'h1', id: 'environment-sync', text: 'Environment Sync (Schema Promote)' },
    {
      type: 'p',
      text: 'Promote schema between environments (dev → staging → prod) using schema snapshots: export a snapshot from the source, diff it against the target, and apply. The apply step is strictly non-destructive — it creates missing collections/fields/relations but never drops or alters existing ones.'
    },
    {
      type: 'pre',
      code: `# On the source environment
GET  /api/schema-snapshot/export          # → snapshot JSON

# On the target environment
POST /api/schema-snapshot/diff            # body: snapshot → { additions, conflicts }
POST /api/schema-snapshot/import          # applies additions only`
    },
    {
      type: 'warn',
      text: 'Destructive changes (drops, type changes, renames) are reported in the diff but never applied automatically — handle those deliberately via Live Schema Migrations or manual migrations.'
    }
  ]
}

export const devexSchemaMigrations: DocSection = {
  id: 'live-schema-migrations',
  label: 'Live Schema Migrations',
  content: [
    { type: 'h1', id: 'live-schema-migrations', text: 'Live Schema Migrations' },
    {
      type: 'p',
      text: "Two schema operations that previously required hand-written migrations can now be performed live from the Data Model: changing a field's column type and renaming a field."
    },
    {
      type: 'pre',
      code: `POST /api/data-model/collections/:collection/fields/:field/change-type
{ "type": "integer" }            // validates with TRY_CAST first
{ "type": "integer", "force": true }   // proceed even if some rows fail the cast (they become NULL)

POST /api/data-model/collections/:collection/fields/:field/rename
{ "new_name": "customer_ref" }   // uses sp_rename; metadata + relations updated atomically`
    },
    {
      type: 'ul',
      items: [
        'change-type runs a TRY_CAST sample across existing data first and refuses if any row would be lost — pass force to override.',
        'rename updates the physical column, nivaro_fields, and any relations referencing the field in one transaction.',
        'Both operations write an activity entry and invalidate the GraphQL schema (rebuild on next request).'
      ]
    }
  ]
}

export const devexMarketplace: DocSection = {
  id: 'extension-marketplace',
  label: 'Extension Marketplace',
  content: [
    { type: 'h1', id: 'extension-marketplace', text: 'Extension Marketplace' },
    {
      type: 'p',
      text: 'The Extensions page gains a Marketplace tab listing extensions from a configurable registry. Admins can install an extension with one click — the server downloads the package tarball, verifies and unpacks it into api/extensions/, and loads it.'
    },
    {
      type: 'pre',
      code: `# .env
EXTENSION_REGISTRY_URL=https://registry.example.com/extensions.json`
    },
    {
      type: 'ul',
      items: [
        'Install is admin-only and the download URL is SSRF-guarded (no private/internal addresses).',
        'Tarballs are unpacked with a built-in ustar parser — no external tar dependency, no shell-outs, path traversal rejected.',
        'Installed extensions appear alongside local ones and can be disabled or removed from the same page.'
      ]
    }
  ]
}

export const devexSdkPlayground: DocSection = {
  id: 'sdk-playground',
  label: 'SDK Playground',
  content: [
    { type: 'h1', id: 'sdk-playground', text: 'SDK Playground' },
    {
      type: 'p',
      text: "The /sdk-playground admin page is an in-browser REPL for @nivaro/sdk. Write SDK code against the live instance with your current session's permissions, run it, and inspect the result — handy for prototyping queries and verifying filters before they go into application code."
    },
    {
      type: 'pre',
      code: `// Example playground snippet
const articles = await nivaro.request(
  readItems('articles', { filter: { status: { _eq: 'published' } }, limit: 5 })
);
return articles;`
    },
    {
      type: 'note',
      text: 'Code runs in the browser with your auth context — nothing is executed server-side beyond the API calls the snippet makes.'
    }
  ]
}

export const devexRevisionDiff: DocSection = {
  id: 'revision-diff',
  label: 'Side-by-Side Revision Diff',
  content: [
    { type: 'h1', id: 'revision-diff', text: 'Changelog Side-by-Side Diff' },
    {
      type: 'p',
      text: 'The revisions panel on item edit pages gains a side-by-side diff toggle. Instead of the delta table, view the previous and new values in two aligned columns with changed fields highlighted — clearer for long text fields and JSON values.'
    },
    {
      type: 'ul',
      items: [
        'Toggle between "Delta" (compact table) and "Side-by-side" per revision.',
        'Works for update revisions; create/delete revisions still render the full snapshot.'
      ]
    }
  ]
}
