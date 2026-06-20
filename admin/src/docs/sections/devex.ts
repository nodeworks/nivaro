import type { DocSection } from '../types.js'

export const devexCodegen: DocSection = {
  id: 'ts-codegen',
  label: 'TypeScript Codegen',
  content: [
    { type: 'h1', id: 'ts-codegen', text: 'Schema → TypeScript Codegen' },
    {
      type: 'p',
      text: 'Automatically generate TypeScript interfaces for every collection from the metadata registry. The endpoint returns a ready-to-commit .ts file with one fully-typed interface per collection, including field types, relations, computed fields, and validation rules.'
    },
    {
      type: 'h3',
      id: 'ts-codegen-usage',
      text: 'Generating Types'
    },
    {
      type: 'pre',
      code: `# Download and save types
curl -H "Authorization: Bearer <token>" \\
  https://nivaro.example.com/api/dev-tools/types.ts > src/nivaro-types.ts

# Or via SDK
const typesTs = await nivaro.request(getTypes());
console.log(typesTs);  // raw TypeScript code`
    },
    {
      type: 'h3',
      id: 'ts-codegen-example',
      text: 'Generated Output'
    },
    {
      type: 'pre',
      code: `// Example generated interface

export interface Article {
  id: string;
  title: string;
  slug: string;
  content: string;
  status: "draft" | "published" | "archived";
  published_at: string | null;
  view_count: number;
  author: {
    id: string;
    name: string;
    email: string;
  };
  tags: { id: string; name: string }[];
  word_count?: number;  // computed field
  _inherited?: { parent_title: string };  // from inherited fields
}`
    },
    {
      type: 'h3',
      id: 'ts-codegen-features',
      text: 'Features'
    },
    {
      type: 'ul',
      items: [
        'One-to-many relations: expanded as objects/arrays with display fields',
        'Many-to-many relations: array of related objects',
        'Select fields: union types (e.g., "draft" | "published")',
        'Computed fields: marked optional with ? (read-only)',
        'Inherited fields: _inherited sidecar with parent field values',
        'Nullable fields: union with null (e.g., string | null)',
        'Validation rules: JSDoc comments describing constraints'
      ]
    },
    {
      type: 'h3',
      id: 'ts-codegen-workflow',
      text: 'Recommended Workflow'
    },
    {
      type: 'ul',
      items: [
        'Set up a pre-commit hook or build step: `curl ... > src/nivaro-types.ts`',
        'Regenerate after schema changes (new collections, fields, relations)',
        'Commit the generated file alongside your code for reproducibility',
        'Use with SDK: `nivaro.request(readItems<Article>("articles"))`'
      ]
    },
    {
      type: 'h3',
      id: 'ts-codegen-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `GET /api/dev-tools/types.ts
  # Returns TypeScript file with all collection interfaces
  # Admin or api key with dev-tools scope required

SDK equivalent:
cms.request(getTypes())`
    },
    {
      type: 'note',
      text: 'The generated file reflects the live registry at request time. After schema changes, regenerate to keep types in sync with your collections.'
    }
  ]
}

export const devexOpenApi: DocSection = {
  id: 'openapi-export',
  label: 'OpenAPI / Postman / Bruno',
  content: [
    { type: 'h1', id: 'openapi-export', text: 'OpenAPI 3.1 & API Collection Exports' },
    {
      type: 'p',
      text: 'Export the full REST API surface as an OpenAPI 3.1 specification, Postman collection, or Bruno collection. The spec includes all system endpoints plus dynamic per-collection CRUD endpoints generated from your schema, with real request/response models.'
    },
    {
      type: 'h3',
      id: 'openapi-formats',
      text: 'Available Formats'
    },
    {
      type: 'ul',
      items: [
        'OpenAPI 3.1.0 JSON: Feed into client generators or documentation tools',
        'Postman v2.1: Import directly; auth headers auto-configured',
        'Bruno: Local-first API client format (git-friendly)',
        'GraphQL schema: Introspection query and full SDL export'
      ]
    },
    {
      type: 'h3',
      id: 'openapi-endpoints',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `GET /api/dev-tools/openapi.json     # Full OpenAPI 3.1 spec
GET /api/dev-tools/postman.json     # Postman collection
GET /api/dev-tools/bruno.json       # Bruno collection format
GET /api/dev-tools/graphql-schema   # GraphQL SDL

# SDK equivalents:
cms.request(getOpenApi())
cms.request(getPostmanCollection())
cms.request(getBrunoCollection())`
    },
    {
      type: 'h3',
      id: 'openapi-content',
      text: 'What\'s Included'
    },
    {
      type: 'ul',
      items: [
        'System endpoints: /collections, /users, /roles, /workflows, /pipelines, /webhooks, /rules, /flows, etc.',
        'Collection CRUD endpoints: POST (create), GET (read), PATCH (update), DELETE (delete)',
        'Bulk operations: POST /items/bulk with batch create/update/delete',
        'Query filters: Full filter DSL documentation with operator reference',
        'Authentication: Bearer token examples, API key alternatives',
        'Pagination: limit/offset/cursor examples',
        'Error codes and schemas for each endpoint'
      ]
    },
    {
      type: 'h3',
      id: 'openapi-schemas',
      text: 'Request/Response Schemas'
    },
    {
      type: 'p',
      text: 'Schemas are derived from nivaro_collections and nivaro_fields metadata, so each collection endpoint has accurate request/response models reflecting current fields, relations, and computed fields.'
    },
    {
      type: 'pre',
      code: `// Example from OpenAPI spec

POST /api/articles
requestBody:
  content:
    application/json:
      schema:
        type: object
        properties:
          title: { type: string }
          slug: { type: string }
          content: { type: string }
          status: { enum: ["draft", "published", "archived"] }
          author: { type: string }  # UUID to users
          tags: { type: array; items: { type: string } }  # M2M
        required: [title, content]

responses:
  200:
    schema:
      $ref: '#/components/schemas/Article'`
    },
    {
      type: 'h3',
      id: 'openapi-usage',
      text: 'Usage Examples'
    },
    {
      type: 'ul',
      items: [
        'Postman/Bruno: Import the collection, set Bearer token variable, browse endpoints with autocomplete',
        'Client generation: `npx openapi-typescript spec.json --output types.ts`',
        'Documentation: Generate docs with Swagger UI or ReDoc from the OpenAPI spec',
        'Testing: Use as a source for automated test case generation'
      ]
    },
    {
      type: 'h3',
      id: 'openapi-regeneration',
      text: 'Regeneration'
    },
    {
      type: 'p',
      text: 'Specs are generated on-demand from the live registry, reflecting schema changes immediately. No manual rebuild needed — but store them in version control for reproducibility.'
    },
    {
      type: 'note',
      text: 'Postman/Bruno auth variables are pre-configured with a Bearer token placeholder. Replace it with your actual API key or static token before use.'
    }
  ]
}

export const devexWebhookDeliveries: DocSection = {
  id: 'webhook-deliveries',
  label: 'Webhook Delivery Log, Retry & Replay',
  content: [
    { type: 'h1', id: 'webhook-deliveries', text: 'Webhook Delivery Log, Retry & Replay' },
    {
      type: 'p',
      text: 'Every webhook attempt is recorded in `nivaro_webhook_deliveries` with full request/response metadata, duration, and retry count. Failed deliveries can be retried individually, and any past activity event can be replayed through the webhook pipeline without manual recreation.'
    },
    {
      type: 'h3',
      id: 'webhook-deliveries-what-is-logged',
      text: 'What Is Logged'
    },
    {
      type: 'ul',
      items: [
        'Request: full payload sent, including all mutation fields',
        'Response: status code, headers, body snippet (first 5KB)',
        'Metadata: webhook ID, event type, trigger timestamp, duration (ms)',
        'Attempt: current attempt number, max retries configured'
      ]
    },
    {
      type: 'h3',
      id: 'webhook-deliveries-viewing',
      text: 'Viewing Delivery History'
    },
    {
      type: 'p',
      text: 'The webhook editor (Webhooks → select webhook) shows a Deliveries tab with a chronological log. Each delivery is expandable to show full payload and response.'
    },
    {
      type: 'pre',
      code: `GET /api/webhooks/webhook-123/deliveries?page=1&limit=50

{
  "deliveries": [
    {
      "id": "delivery-456",
      "webhook_id": "webhook-123",
      "event_type": "items.update",
      "collection": "orders",
      "item": "order-42",
      "status": 200,
      "duration_ms": 45,
      "attempt": 1,
      "max_attempts": 3,
      "sent_at": "2026-06-15T10:30:45Z",
      "payload": { ... full mutation ... },
      "response_body": "{ \"status\": \"ok\" }"
    },
    {
      "id": "delivery-457",
      "webhook_id": "webhook-123",
      "event_type": "items.create",
      "status": 500,
      "duration_ms": 3000,
      "attempt": 1,
      "sent_at": "2026-06-15T10:31:00Z",
      "error": "timeout"
    }
  ],
  "total": 147,
  "page": 1
}`
    },
    {
      type: 'h3',
      id: 'webhook-deliveries-retry',
      text: 'Retrying Failed Deliveries'
    },
    {
      type: 'p',
      text: 'Retry a specific delivery manually without waiting for automatic backoff. The retry re-sends the original payload with the same signature.'
    },
    {
      type: 'pre',
      code: `POST /api/webhooks/deliveries/delivery-457/retry

# Response: enqueues a new delivery attempt
{
  "id": "delivery-458",
  "status": "queued"
}`
    },
    {
      type: 'h3',
      id: 'webhook-deliveries-replay',
      text: 'Replaying Activity Events'
    },
    {
      type: 'p',
      text: 'Replay any past activity event (create/update/delete) through the entire webhook pipeline. The system reconstructs the original mutation payload from the activity/revision record and sends it to all matching webhooks.'
    },
    {
      type: 'pre',
      code: `POST /api/webhooks/replay/activity-789

# Webhooks matching { collection: "orders", event: "update" } are triggered

{
  "deliveries_queued": 3,
  "webhooks": [
    { "id": "webhook-123", "url": "..." },
    { "id": "webhook-456", "url": "..." }
  ]
}`
    },
    {
      type: 'h3',
      id: 'webhook-deliveries-dead-letter',
      text: 'Dead Letter Queue'
    },
    {
      type: 'p',
      text: 'When a delivery exhausts its retry attempts and still fails, it lands in the dead letter queue instead of being silently dropped. Inspect and manually retry from the /dead-letters admin page.'
    },
    {
      type: 'note',
      text: 'Deliveries retain their original request ID and timestamp for correlation. Use the delivery log to audit all webhook activity.'
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
      text: 'Secure webhooks with HMAC-SHA256 signatures. Configure a signing secret when creating a webhook, and every delivery will include an `X-Nivaro-Signature` header. Receivers can verify the signature to confirm the delivery came from Nivaro and has not been tampered with.'
    },
    {
      type: 'h3',
      id: 'webhook-signing-setup',
      text: 'Configuration'
    },
    {
      type: 'p',
      text: 'When creating or editing a webhook, optionally set a Signing Secret. This is a random string you choose — save it securely on your end. Every delivery will include a signature computed from this secret and the request body.'
    },
    {
      type: 'h3',
      id: 'webhook-signing-header',
      text: 'Signature Header'
    },
    {
      type: 'pre',
      code: `# Every webhook delivery includes:
X-Nivaro-Signature: sha256=<hex-encoded HMAC-SHA256>

# Example:
X-Nivaro-Signature: sha256=a1b2c3d4e5f6...`
    },
    {
      type: 'h3',
      id: 'webhook-signing-verification',
      text: 'Verification (Node.js)'
    },
    {
      type: 'pre',
      code: `import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyWebhookSignature(
  rawBody: string | Buffer,
  header: string,
  signingSecret: string
): boolean {
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
  const expected = 'sha256=' + createHmac('sha256', signingSecret)
    .update(bodyStr)
    .digest('hex');

  try {
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;  // length mismatch
  }
}`
    },
    {
      type: 'h3',
      id: 'webhook-signing-best-practices',
      text: 'Best Practices'
    },
    {
      type: 'ul',
      items: [
        'Always verify before parsing JSON — signature is over raw bytes',
        'Use timing-safe comparison to prevent timing attacks',
        'Store signing secrets in environment variables, not code',
        'Rotate secrets periodically by creating new webhooks'
      ]
    },
    {
      type: 'warn',
      text: 'Critical: Verify against the raw request body stream received from the network, before any JSON parsing or deserialization. Re-serialized JSON will not match the signature due to whitespace or key ordering differences.'
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
      text: 'Nivaro supports advanced authentication methods for external APIs beyond basic bearer/api-key: HMAC-SHA256 request signing and AWS Signature Version 4. Configure signing credentials in the External API config, and all calls via callExternalApi() automatically apply the signature without exposing keys to extensions or flows.'
    },
    {
      type: 'h3',
      id: 'external-api-signing-types',
      text: 'Signing Methods'
    },
    {
      type: 'table',
      head: ['Auth Type', 'What Is Signed', 'Typical Use'],
      rows: [
        ['hmac', 'HTTP method + path + body (HMAC-SHA256)', 'Partner APIs with request signing requirements'],
        ['aws_sigv4', 'Canonical AWS request format', 'AWS services (SigV4) and S3-compatible storage'],
        ['bearer', 'None (standard OAuth)', 'OAuth2 endpoints'],
        ['api_key', 'None (appended as header/query)', 'Simple API key authentication']
      ]
    },
    {
      type: 'h3',
      id: 'external-api-signing-setup',
      text: 'Configuration'
    },
    {
      type: 'p',
      text: 'When creating an External API config, select the auth type. For HMAC and AWS SigV4, provide the shared secret/credentials, and Nivaro handles signing automatically.'
    },
    {
      type: 'pre',
      code: `POST /api/external-apis
{
  "name": "Partner API",
  "base_url": "https://partner.example.com/api",
  "auth_type": "hmac",
  "auth_config": {
    "secret": "shared-secret-from-partner"
  }
}

// Or for AWS SigV4:
{
  "name": "S3 Bucket",
  "base_url": "https://s3.amazonaws.com/my-bucket",
  "auth_type": "aws_sigv4",
  "auth_config": {
    "access_key": "AKIAIOSFODNN7EXAMPLE",
    "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "region": "us-east-1",
    "service": "s3"
  }
}`
    },
    {
      type: 'h3',
      id: 'external-api-signing-usage',
      text: 'Usage in Extensions/Flows'
    },
    {
      type: 'p',
      text: 'Call the signed external API the same way as any other external API. Signing happens transparently inside callExternalApi().'
    },
    {
      type: 'pre',
      code: `// Extension or flow code
const result = await callExternalApi(apiId, {
  method: 'POST',
  path: '/v1/orders',
  body: { order_id: '123', total: 500 }
});
// Nivaro automatically signs the request with the configured credentials`
    },
    {
      type: 'h3',
      id: 'external-api-signing-security',
      text: 'Security'
    },
    {
      type: 'ul',
      items: [
        'Signing secrets/keys are masked on GET and never exposed to client',
        'Preserved on PATCH if masked value is re-submitted (allows update without showing secret)',
        'Signing happens server-side only — extensions never see raw credentials',
        'Store credentials in External API configs, never in extension code'
      ]
    },
    {
      type: 'note',
      text: 'Signing credentials stay isolated inside the External API config. Extensions and flows call callExternalApi() without any knowledge of the signing method or keys.'
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
      text: 'All API requests are rate-limited per principal using a Redis fixed-window counter. A global limit applies to all keys; individual API keys can override with their own per-key limits. Every response includes standard X-RateLimit headers so clients can adjust their request rate.'
    },
    {
      type: 'h3',
      id: 'rate-limits-configuration',
      text: 'Configuration'
    },
    {
      type: 'pre',
      code: `# .env
RATE_LIMIT_PER_MINUTE=600    # Global limit (default: 600)
RATE_LIMIT_BURST=100         # Allow temporary bursts (optional)`
    },
    {
      type: 'h3',
      id: 'rate-limits-api-key-overrides',
      text: 'Per-API-Key Overrides'
    },
    {
      type: 'p',
      text: 'Named API keys can have their own rate limit. Set when creating the key:'
    },
    {
      type: 'pre',
      code: `POST /api/api-keys
{
  "name": "Mobile App",
  "scopes": ["read:items", "create:items"],
  "rate_limit": 2000  # This key gets 2000 req/min instead of global 600
}`
    },
    {
      type: 'h3',
      id: 'rate-limits-headers',
      text: 'Response Headers'
    },
    {
      type: 'pre',
      code: `X-RateLimit-Limit: 600          # Requests allowed per minute
X-RateLimit-Remaining: 597       # Requests remaining in current window
X-RateLimit-Reset: 1718000460    # Epoch seconds when window resets`
    },
    {
      type: 'h3',
      id: 'rate-limits-exceeded',
      text: 'When Limit Exceeded'
    },
    {
      type: 'pre',
      code: `HTTP/1.1 429 Too Many Requests

Retry-After: 45
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1718000460

{
  "error": "Rate limit exceeded",
  "retry_after_seconds": 45
}`
    },
    {
      type: 'h3',
      id: 'rate-limits-best-practices',
      text: 'Best Practices'
    },
    {
      type: 'ul',
      items: [
        'Check X-RateLimit-Remaining before making requests to avoid unnecessary 429s',
        'Implement exponential backoff when receiving 429 responses',
        'Respect Retry-After header — it tells you exactly how long to wait',
        'Use per-key limits for trusted integrations or high-volume workloads',
        'Distribute requests across multiple API keys if doing bulk operations'
      ]
    },
    {
      type: 'h3',
      id: 'rate-limits-reliability',
      text: 'Reliability'
    },
    {
      type: 'ul',
      items: [
        'Rate limiting fails open — if Redis is down, requests are allowed (limits are advisory, not hard blocks)',
        'Fixed-window counters reset at minute boundaries (60-second window)',
        'Static tokens (user session cookies) and API keys share the same limit pool'
      ]
    },
    {
      type: 'note',
      text: 'The rate limiter is per-principal (per user or per API key), not global. Each client has its own counter, so one user\'s burst does not affect another.'
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
      text: 'Subscribe to a real-time server-sent-events stream of every item mutation (create/update/delete) across all collections. Useful for cache invalidation, search indexing, audit systems, and downstream replication without polling.'
    },
    {
      type: 'h3',
      id: 'cdc-stream-subscription',
      text: 'Subscribing'
    },
    {
      type: 'pre',
      code: `curl -N -H "Authorization: Bearer <admin-token>" \\
  https://nivaro.example.com/api/stream

event: change
data: {"action":"update","collection":"articles","item":"42","user":"user-123","timestamp":"2026-06-15T10:30:45Z"}

event: change
data: {"action":"create","collection":"orders","item":"order-99","user":"user-456","timestamp":"2026-06-15T10:31:00Z"}`
    },
    {
      type: 'h3',
      id: 'cdc-stream-event-format',
      text: 'Event Format'
    },
    {
      type: 'pre',
      code: `{
  "action": "create" | "update" | "delete",
  "collection": "articles",
  "item": "article-42",
  "user": "user-123",
  "timestamp": "2026-06-15T10:30:45Z"
}`
    },
    {
      type: 'h3',
      id: 'cdc-stream-javascript',
      text: 'Client Example'
    },
    {
      type: 'pre',
      code: `const eventSource = new EventSource('/api/stream', {
  headers: { Authorization: 'Bearer <token>' }
});

eventSource.addEventListener('change', (event) => {
  const mutation = JSON.parse(event.data);
  invalidateCache(mutation.collection, mutation.item);
});

eventSource.addEventListener('error', () => {
  eventSource.close();
});`
    },
    {
      type: 'ul',
      items: [
        'Admin only — requires admin role',
        'Real-time — events emitted milliseconds after database commit',
        'Standard EventSource API — automatic reconnection with exponential backoff'
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
      text: 'Pre-register GraphQL queries and execute them by ID, reducing payload size and locking the query surface for security. Supports both explicit IDs and Apollo-style Automatic Persisted Queries (APQ). Stored in `nivaro_persisted_queries`.'
    },
    {
      type: 'h3',
      id: 'persisted-queries-management',
      text: 'Managing Queries'
    },
    {
      type: 'p',
      text: 'The /persisted-queries admin page lists all registered queries with usage stats. Register a new query by name and GraphQL text, edit existing registrations, or delete.'
    },
    {
      type: 'pre',
      code: `POST /api/persisted-queries
{
  "id": "dashboard-articles",
  "query": "query GetArticles($limit: Int!) { articles(limit: $limit) { id title status } }"
}

// Response
{
  "id": "dashboard-articles",
  "hash": "a1b2c3...",
  "created_at": "2026-06-15T10:30:00Z"
}`
    },
    {
      type: 'h3',
      id: 'persisted-queries-explicit',
      text: 'Executing by ID'
    },
    {
      type: 'pre',
      code: `POST /api/graphql
{
  "id": "dashboard-articles",
  "variables": { "limit": 10 }
}`
    },
    {
      type: 'h3',
      id: 'persisted-queries-apq',
      text: 'Apollo Automatic Persisted Queries (APQ)'
    },
    {
      type: 'p',
      text: 'Send query hash + query text on first request to auto-register. Subsequent requests send only the hash.'
    },
    {
      type: 'pre',
      code: `// First request (register)
POST /api/graphql
{
  "query": "query GetArticles($limit: Int!) { articles(limit: $limit) { id title } }",
  "extensions": {
    "persistedQuery": {
      "version": 1,
      "sha256Hash": "a1b2c3d4e5f6..."
    }
  },
  "variables": { "limit": 10 }
}

// Subsequent requests (cached)
POST /api/graphql
{
  "extensions": {
    "persistedQuery": {
      "version": 1,
      "sha256Hash": "a1b2c3d4e5f6..."
    }
  },
  "variables": { "limit": 10 }
}`
    },
    {
      type: 'h3',
      id: 'persisted-queries-benefits',
      text: 'Benefits'
    },
    {
      type: 'ul',
      items: [
        'Reduced payload: send only hash or ID, not full query text',
        'Security: lock query surface, prevent unexpected queries',
        'Performance: pre-validated queries, no parse overhead',
        'Monitoring: track usage per query from admin page'
      ]
    },
    {
      type: 'note',
      text: 'When a request carries an id or APQ hash, the stored query text is substituted before execution. Query strings sent with a known hash are ignored (unless registering for the first time).'
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
      text: 'Webhook deliveries, flow runs, and notification sends that exhaust their retry attempts land in the dead letter queue. Inspect failures, manually retry, or discard from the /dead-letters admin page. Nothing is silently dropped.'
    },
    {
      type: 'h3',
      id: 'dead-letters-sources',
      text: 'What Lands in DLQ'
    },
    {
      type: 'ul',
      items: [
        'Webhook delivery: final attempt failed after N retries',
        'Flow run: operation failed (e.g., external API timeout)',
        'Notification send: delivery failed (email/SMS provider error)'
      ]
    },
    {
      type: 'h3',
      id: 'dead-letters-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `GET /api/dead-letters?source=webhook&page=1&limit=50
{
  "dead_letters": [
    {
      "id": "dlq-123",
      "source": "webhook",
      "webhook_id": "webhook-456",
      "attempt": 3,
      "error": "Connection timeout after 30s",
      "payload": { ... original request ... },
      "queued_at": "2026-06-15T10:30:45Z"
    }
  ],
  "total": 5,
  "page": 1
}

GET /api/dead-letters/dlq-123     # Get details

POST /api/dead-letters/dlq-123/retry  # Re-enqueue (new attempt)

DELETE /api/dead-letters/dlq-123  # Discard`
    },
    {
      type: 'h3',
      id: 'dead-letters-retry-workflow',
      text: 'Retry Workflow'
    },
    {
      type: 'ul',
      items: [
        'Inspect the dead letter to understand the failure',
        'Fix the underlying issue (e.g., webhook endpoint is back online)',
        'Click Retry to re-enqueue the operation',
        'If retry fails again, a new dead letter is created with attempt count incremented'
      ]
    },
    {
      type: 'h3',
      id: 'dead-letters-retention',
      text: 'Retention'
    },
    {
      type: 'ul',
      items: [
        'Dead letters are retained indefinitely (manual action required)',
        'Use the /dead-letters page to purge old entries',
        'Export for audit before deleting'
      ]
    },
    {
      type: 'note',
      text: 'Retry that fails again increments the attempt count and creates a fresh dead letter entry, preserving the failure history. Full payload is retained for context.'
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
      text: 'Every flow save creates an immutable snapshot of the full definition (trigger + operation graph). View version history in the flow editor, restore any past version as the current definition, or compare versions. In-flight runs continue with the version they started on.'
    },
    {
      type: 'h3',
      id: 'flow-versioning-workflow',
      text: 'Workflow'
    },
    {
      type: 'ul',
      items: [
        'Edit a flow (trigger, operations, connections)',
        'Click Save → creates a new version snapshot automatically',
        'Open Versions panel to see history (newest first)',
        'Click Restore on any version to make it current',
        'Restore creates a new version (never overwrites history)'
      ]
    },
    {
      type: 'h3',
      id: 'flow-versioning-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `GET /api/flows/flow-123/versions?page=1&limit=20
{
  "versions": [
    {
      "id": "version-456",
      "flow_id": "flow-123",
      "definition": { ... trigger + operations ... },
      "created_by": "user-123",
      "created_at": "2026-06-15T10:30:00Z",
      "is_current": true
    },
    {
      "id": "version-455",
      "flow_id": "flow-123",
      "definition": { ... previous version ... },
      "created_by": "user-456",
      "created_at": "2026-06-15T09:00:00Z",
      "is_current": false
    }
  ]
}

POST /api/flows/flow-123/versions/version-455/restore
# Makes version-455 current; creates a new version entry`
    },
    {
      type: 'h3',
      id: 'flow-versioning-in-flight-runs',
      text: 'In-Flight Runs'
    },
    {
      type: 'ul',
      items: [
        'Runs started on version A continue on version A even if you restore version B',
        'New triggers use the current (restored) version',
        'Completed runs retain their version reference for audit'
      ]
    },
    {
      type: 'note',
      text: 'Version history is immutable. Restoring a version creates a new version entry rather than rewriting history.'
    }
  ]
}

export const devexEnvSync: DocSection = {
  id: 'environment-sync',
  label: 'Environment Sync (Schema Promote)',
  content: [
    { type: 'h1', id: 'environment-sync', text: 'Environment Sync (Schema Promote)' },
    {
      type: 'p',
      text: 'Promote schema changes between environments (dev → staging → prod) safely using schema snapshots. Export from source, diff against target, apply additions. The process is strictly non-destructive — only creates missing collections/fields/relations, never drops or alters.'
    },
    {
      type: 'h3',
      id: 'environment-sync-workflow',
      text: 'Workflow'
    },
    {
      type: 'ul',
      items: [
        'Source environment: Export current schema as snapshot (JSON)',
        'Target environment: POST snapshot to /diff endpoint',
        'Review diff showing new collections/fields/relations to be created',
        'POST to /import to apply additions',
        'Destructive changes (drops, renames) are flagged but not applied'
      ]
    },
    {
      type: 'h3',
      id: 'environment-sync-api',
      text: 'API Reference'
    },
    {
      type: 'pre',
      code: `# Source environment: Export schema
GET /api/schema-snapshot/export
{
  "version": 1,
  "exported_at": "2026-06-15T10:30:00Z",
  "collections": [
    {
      "name": "articles",
      "fields": [
        { "name": "title", "type": "string", "required": true },
        { "name": "status", "type": "select", "options": ["draft", "published"] }
      ]
    }
  ],
  "relations": [ ... ]
}

# Target environment: Diff
POST /api/schema-snapshot/diff
{ ... snapshot JSON ... }

{
  "additions": [
    { "type": "collection", "name": "articles", "reason": "does not exist" },
    { "type": "field", "collection": "articles", "name": "title", "reason": "does not exist" }
  ],
  "conflicts": [
    { "type": "field", "collection": "articles", "name": "status", "reason": "different select options" }
  ],
  "destructive_changes": [ ... ]
}

# Apply additions
POST /api/schema-snapshot/import
{ ... snapshot JSON ... }
{
  "created_collections": 1,
  "created_fields": 5,
  "created_relations": 2,
  "skipped_conflicts": 1
}`
    },
    {
      type: 'h3',
      id: 'environment-sync-conflicts',
      text: 'Handling Conflicts'
    },
    {
      type: 'ul',
      items: [
        'Conflicts: field exists but schema differs (type, required, etc.) — skipped on import',
        'Destructive: drops/renames flagged in diff — never applied automatically',
        'Use Live Schema Migrations or manual migrations to handle destructive changes'
      ]
    },
    {
      type: 'h3',
      id: 'environment-sync-safety',
      text: 'Safety'
    },
    {
      type: 'ul',
      items: [
        'Non-destructive only: adds new, skips conflicts, ignores drops',
        'Audit trail: every import logged with user + timestamp',
        'Reversible: restored data is unaffected; can revert by exporting target, importing to source'
      ]
    },
    {
      type: 'warn',
      text: 'Destructive changes (field drops, type changes, relation deletes) are reported in the diff but never applied. Use Live Schema Migrations (POST /change-type, /rename) to handle these explicitly.'
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
      text: 'Perform schema migrations live without downtime: change a field\'s column type, rename a field, or update computed field formulas. Previously required hand-written migrations; now available from the Data Model UI.'
    },
    {
      type: 'h3',
      id: 'live-schema-migrations-change-type',
      text: 'Changing Field Type'
    },
    {
      type: 'pre',
      code: `POST /api/data-model/collections/products/fields/price/change-type
{
  "type": "decimal",
  "precision": 10,
  "scale": 2
}

// System validates with TRY_CAST on sample of existing rows
// If any row would lose data, returns 400
{
  "error": "Cannot safely convert existing values",
  "sample_failures": [
    { "id": "product-123", "current": "12.5 GB", "reason": "exceeds numeric precision" }
  ]
}

// Force conversion (failed rows become NULL)
POST /api/data-model/collections/products/fields/price/change-type
{
  "type": "decimal",
  "force": true
}

// Success
{
  "field_id": "field-456",
  "old_type": "string",
  "new_type": "decimal",
  "rows_affected": 1000,
  "rows_set_to_null": 2
}`
    },
    {
      type: 'h3',
      id: 'live-schema-migrations-rename',
      text: 'Renaming a Field'
    },
    {
      type: 'pre',
      code: `POST /api/data-model/collections/products/fields/price/rename
{
  "new_name": "unit_price",
  "update_relations": true  // also rename M2O/M2M alias fields
}

// Updates:
// 1. Physical DB column via sp_rename
// 2. nivaro_fields metadata
// 3. Relations + aliases that reference the field
// 4. Computed field formulas ({{price}} → {{unit_price}})
// All in one atomic transaction

{
  "field_id": "field-456",
  "old_name": "price",
  "new_name": "unit_price",
  "relations_updated": 3,
  "computed_fields_updated": 1
}`
    },
    {
      type: 'h3',
      id: 'live-schema-migrations-computed',
      text: 'Updating Computed Field Formula'
    },
    {
      type: 'pre',
      code: `PATCH /api/data-model/collections/orders/fields/total_cost/
{
  "computed_formula": "{{unit_price}} * {{quantity}} + {{tax}}"
}

// Formula is parsed and validated before save
// Only affects future reads (existing computed values not retroactively updated)`
    },
    {
      type: 'h3',
      id: 'live-schema-migrations-best-practices',
      text: 'Best Practices'
    },
    {
      type: 'ul',
      items: [
        'Test type changes on staging first — some conversions may result in data loss',
        'Rename with caution — updates all relations and computed formulas atomically',
        'During migration, API remains available — no downtime',
        'All changes logged to activity for audit',
        'GraphQL schema rebuilt on next request'
      ]
    },
    {
      type: 'note',
      text: 'Live schema migrations write to the activity log and invalidate cached schemas. GraphQL schema regenerates automatically on the next request.'
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
      text: 'Browse and install extensions from a marketplace registry. Admin users can install extensions with one click — the server downloads, verifies, unpacks, and loads the tarball without downtime.'
    },
    {
      type: 'h3',
      id: 'extension-marketplace-configuration',
      text: 'Configuration'
    },
    {
      type: 'pre',
      code: `# .env
EXTENSION_REGISTRY_URL=https://registry.nivaro.io/extensions.json`
    },
    {
      type: 'h3',
      id: 'extension-marketplace-registry-format',
      text: 'Registry Format'
    },
    {
      type: 'pre',
      code: `{
  "extensions": [
    {
      "id": "slack-notifier",
      "name": "Slack Notifier",
      "version": "1.0.0",
      "description": "Send notifications to Slack channels",
      "author": "Nivaro Team",
      "homepage": "https://github.com/nivaro/ext-slack",
      "download_url": "https://cdn.example.com/slack-notifier-1.0.0.tar.gz",
      "checksum": "sha256:a1b2c3d4..."
    }
  ]
}`
    },
    {
      type: 'h3',
      id: 'extension-marketplace-installing',
      text: 'Installing Extensions'
    },
    {
      type: 'ul',
      items: [
        'Navigate to Extensions → Marketplace tab',
        'Browse available extensions, click Install on one',
        'Server downloads tarball from registry',
        'Tarball verified against checksum',
        'Extracted into api/extensions/<id>/',
        'Extension auto-loaded (no server restart needed)',
        'Appears in Installed tab'
      ]
    },
    {
      type: 'h3',
      id: 'extension-marketplace-security',
      text: 'Security'
    },
    {
      type: 'ul',
      items: [
        'Admin only — requires admin role to install',
        'SSRF guarded — download URLs to private IPs rejected',
        'Checksum verification — tarball hash verified against registry',
        'Path traversal — entries with ../ in paths rejected',
        'No shell-outs — built-in ustar parser (no tar dependency)'
      ]
    },
    {
      type: 'h3',
      id: 'extension-marketplace-management',
      text: 'Management'
    },
    {
      type: 'ul',
      items: [
        'Installed extensions appear alongside local extensions',
        'Disable/enable extension without removing files',
        'Delete to remove files and unload',
        'Version upgrades via re-install (overwrites files)'
      ]
    },
    {
      type: 'note',
      text: 'Marketplace extensions are treated identically to locally-created extensions. They appear in the same list and use the same loading mechanism.'
    }
  ]
}

export const devexPlayground: DocSection = {
  id: 'playground',
  label: 'Playground',
  content: [
    { type: 'h1', id: 'playground', text: 'Playground' },
    {
      type: 'p',
      text: 'An in-browser REPL for @nivaro/sdk. Write and test SDK code against the live instance using your current session permissions. Inspect results in real-time without leaving the admin UI — great for prototyping queries before code commit.'
    },
    {
      type: 'h3',
      id: 'playground-access',
      text: 'Accessing the Playground'
    },
    {
      type: 'p',
      text: 'Navigate to /playground in the admin UI. The playground is available to all authenticated users (runs with their permissions).'
    },
    {
      type: 'h3',
      id: 'playground-example',
      text: 'Example Snippet'
    },
    {
      type: 'pre',
      code: `// Get published articles
const articles = await nivaro.request(
  readItems('articles', {
    filter: { status: { _eq: 'published' } },
    limit: 5,
    sort: [{ field: 'published_at', direction: 'desc' }]
  })
);

console.log(\`Found \${articles.length} articles\`);
return articles;`
    },
    {
      type: 'h3',
      id: 'playground-features',
      text: 'Features'
    },
    {
      type: 'ul',
      items: [
        'Full SDK API available: readItems, createOne, updateOne, deleteOne, etc.',
        'TypeScript autocomplete if using TS mode',
        'Console.log support for debugging',
        'Result inspection: view JSON, errors, execution time',
        'Permissions enforced: code executes with your role/access level',
        'No persistence: snippets not saved (reload clears)'
      ]
    },
    {
      type: 'h3',
      id: 'playground-security',
      text: 'Security'
    },
    {
      type: 'ul',
      items: [
        'Runs in browser only — code does not execute server-side',
        'Auth context inherited from your session — respects your permissions',
        'No file system access or environment variable access',
        'Use your session token (no need to create special test tokens)'
      ]
    },
    {
      type: 'h3',
      id: 'playground-use-cases',
      text: 'Use Cases'
    },
    {
      type: 'ul',
      items: [
        'Test filter DSL before using in app code',
        'Prototype GraphQL queries and mutations',
        'Check what data is accessible with current permissions',
        'Verify relation traversals work as expected',
        'Debug computed field formulas'
      ]
    },
    {
      type: 'note',
      text: 'Code runs in the browser with your current session token. Only API calls to the backend execute — all other code runs in-browser JavaScript.'
    }
  ]
}

export const devexRevisionDiff: DocSection = {
  id: 'revision-diff',
  label: 'Side-by-Side Revision Diff',
  content: [
    { type: 'h1', id: 'revision-diff', text: 'Side-by-Side Revision Diff' },
    {
      type: 'p',
      text: 'View item changes in side-by-side diff format. The revisions panel on item edit pages supports both compact delta view and visual side-by-side comparison, with changed fields highlighted for easy scanning.'
    },
    {
      type: 'h3',
      id: 'revision-diff-views',
      text: 'View Modes'
    },
    {
      type: 'ul',
      items: [
        'Delta table: compact list of changed fields and their old/new values (default)',
        'Side-by-side: full records in left/right columns with changed fields highlighted',
        'Full snapshot: create/delete revisions show complete record state'
      ]
    },
    {
      type: 'h3',
      id: 'revision-diff-usage',
      text: 'Usage'
    },
    {
      type: 'ul',
      items: [
        'Open an item for editing',
        'Click "Revisions" panel on the right',
        'Select any past revision to view changes',
        'Toggle "Side-by-side" button to switch view modes',
        'Changed fields are highlighted in both views'
      ]
    },
    {
      type: 'h3',
      id: 'revision-diff-benefits',
      text: 'Benefits'
    },
    {
      type: 'ul',
      items: [
        'Delta view: scan many changes quickly',
        'Side-by-side: see full context around changed fields',
        'Better for text/JSON: wrapped text more readable in side-by-side',
        'Highlighting: unchanged fields grayed out, changed fields bold/colored'
      ]
    },
    {
      type: 'note',
      text: 'Create revisions show the full new record snapshot. Delete revisions show the final state before deletion. Only update revisions support both delta and side-by-side modes.'
    }
  ]
}
