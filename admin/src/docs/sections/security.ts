import type { DocSection } from '../types.js'

export const securityMultiDb: DocSection = {
  id: 'multi-db',
  label: 'Multi-Database Support',
  content: [
    { type: 'h1', id: 'multi-db', text: 'Multi-Database Support' },
    {
      type: 'p',
      text: 'Nivaro runs on Microsoft SQL Server, PostgreSQL, or MySQL. The dialect is selected with the `DB_CLIENT` environment variable and the connection is built per-dialect — encryption options, port defaults, and type quirks are handled internally so the rest of the system is dialect-agnostic.'
    },
    { type: 'h3', text: 'Configuration' },
    {
      type: 'pre',
      code: `# .env
DB_CLIENT=mssql        # mssql (default) | pg | mysql2
DB_HOST=localhost
DB_PORT=1433           # optional; defaults per dialect (1433 / 5432 / 3306)
DB_DATABASE=nivaro
DB_USER=sa
DB_PASSWORD=...

# MSSQL-only options (ignored for pg / mysql2)
DB_ENCRYPT=true
DB_TRUST_SERVER_CERT=true`
    },
    {
      type: 'ul',
      items: [
        '`DB_CLIENT=mssql` — SQL Server via tedious (the default and most battle-tested dialect).',
        '`DB_CLIENT=pg` — PostgreSQL via the pg driver.',
        '`DB_CLIENT=mysql2` — MySQL / MariaDB via mysql2.',
        'Database drivers are installed on demand — only the driver for the configured dialect needs to be present.'
      ]
    },
    {
      type: 'note',
      text: 'Migrations are dialect-aware. Pick one dialect per deployment — switching dialects on an existing database is not supported; use Environment Sync (schema snapshot export/import) to move schema between deployments instead.'
    }
  ]
}

export const securityReadReplica: DocSection = {
  id: 'read-replica',
  label: 'Read Replica',
  content: [
    { type: 'h1', id: 'read-replica', text: 'Read Replica Support' },
    {
      type: 'p',
      text: 'Heavy read traffic can be routed to a read replica. When `DB_READ_HOST` is set, Nivaro opens a second Knex connection (`dbRead`) pointing at the replica and uses it for read-only query paths; all writes continue to go to the primary.'
    },
    {
      type: 'pre',
      code: `# .env
DB_READ_HOST=replica.internal
DB_READ_PORT=1433   # optional; defaults to DB_PORT`
    },
    {
      type: 'ul',
      items: [
        'When `DB_READ_HOST` is unset, `dbRead` is the same connection as the primary — zero config changes needed in code.',
        'Credentials, database name, and dialect are inherited from the primary connection settings.',
        'Replication lag is your responsibility: reads through the replica may briefly trail writes.'
      ]
    }
  ]
}

export const securityTwoFactor: DocSection = {
  id: 'two-factor',
  label: 'Two-Factor Auth (TOTP)',
  content: [
    { type: 'h1', id: 'two-factor', text: 'Two-Factor Authentication (TOTP)' },
    {
      type: 'p',
      text: 'Users can protect their account with a time-based one-time password (TOTP) from any authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, etc.). Setup is self-service from the Profile page, which shows a QR code to scan plus a manual secret.'
    },
    { type: 'h3', text: 'Enrolment flow' },
    {
      type: 'ul',
      items: [
        'Profile → Two-Factor Authentication card → Enable. The server generates a secret and returns an otpauth:// QR code.',
        'Scan the QR code, then confirm with a 6-digit code to activate.',
        'Once enabled, login requires a second step: after credentials/OIDC succeed the user is redirected to /login?totp=1 and must submit a current code.'
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `POST /api/two-factor/setup     // begin enrolment → { secret, otpauth_url }
POST /api/two-factor/verify    // confirm with { code } → activates 2FA
POST /api/two-factor/disable   // turn off (requires valid code)

// Login second step (session is pending until verified):
POST /api/auth/totp            // { code } → completes the session`
    },
    {
      type: 'note',
      text: 'TOTP applies on top of any primary auth method. Static API tokens and API keys are not affected by 2FA — they authenticate machine-to-machine traffic directly.'
    }
  ]
}

export const securitySaml: DocSection = {
  id: 'saml-sso',
  label: 'SAML SSO',
  content: [
    { type: 'h1', id: 'saml-sso', text: 'SAML 2.0 Single Sign-On' },
    {
      type: 'p',
      text: 'In addition to Microsoft OIDC, Nivaro can act as a SAML 2.0 service provider for identity providers such as Okta, OneLogin, or ADFS. SAML is enabled entirely through environment variables — when `SAML_ENTRY_POINT` is set, the SAML routes activate.'
    },
    { type: 'h3', text: 'Environment' },
    {
      type: 'pre',
      code: `SAML_ENTRY_POINT=https://idp.example.com/sso/saml   # IdP SSO URL
SAML_ISSUER=nivaro                                   # SP entity ID
SAML_CERT="-----BEGIN CERTIFICATE-----..."           # IdP signing certificate
SAML_CALLBACK_URL=https://nivaro.example.com/api/auth/saml/callback
SAML_AUDIENCE=nivaro                                 # expected audience (optional)`
    },
    { type: 'h3', text: 'Endpoints' },
    {
      type: 'table',
      head: ['Endpoint', 'Purpose'],
      rows: [
        ['GET /api/auth/saml/login', 'Redirects the browser to the IdP'],
        ['POST /api/auth/saml/callback', 'Assertion consumer service — creates the session'],
        ['GET /api/auth/saml/metadata', 'SP metadata XML for IdP configuration']
      ]
    },
    {
      type: 'warn',
      text: 'Signed responses AND signed assertions are enforced — assertions that are unsigned or signed with an unexpected certificate are rejected. There is no option to relax this.'
    }
  ]
}

export const securityApiKeys: DocSection = {
  id: 'api-keys',
  label: 'Named API Keys',
  content: [
    { type: 'h1', id: 'api-keys', text: 'Named API Keys with Scopes' },
    {
      type: 'p',
      text: 'Named API keys are a managed alternative to per-user static tokens. Each key has a name, an optional expiry, a set of scopes, an optional IP allowlist, and an optional per-key rate limit. Keys are prefixed with `nvk_` and are shown exactly once at creation — only a SHA-256 hash is stored.'
    },
    { type: 'h3', text: 'Managing in the admin UI' },
    {
      type: 'p',
      text: 'Keys are created and managed on the /api-keys page: name the key, pick scopes, set an optional expiry, IP allowlist, and rate limit, then copy the `nvk_` token from the one-time reveal. Existing keys can be renamed, re-scoped, or revoked from the same list.'
    },
    { type: 'h3', text: 'Properties' },
    {
      type: 'table',
      head: ['Property', 'Behaviour'],
      rows: [
        [
          'Token format',
          '`nvk_` prefix + random secret; sha256 hash stored, plaintext never persisted'
        ],
        ['Scopes', 'Restrict what the key can do (e.g. items:read, items:write, scim)'],
        ['Expiry', 'Optional timestamp; expired keys are rejected'],
        ['IP allowlist', 'Optional list of CIDRs/IPs the key may be used from'],
        ['Rate limit', 'Optional per-key requests-per-minute override']
      ]
    },
    { type: 'h3', text: 'Usage' },
    {
      type: 'pre',
      code: `# Create (admin)
POST /api/api-keys
{ "name": "ci-deploy", "scopes": ["items:read"], "expires_at": "2027-01-01" }
# → { "key": "nvk_..." }   // shown once — store it now

# Authenticate exactly like a Bearer token:
curl -H "Authorization: Bearer nvk_..." https://nivaro.example.com/api/items/articles

# Manage
GET    /api/api-keys        # list (hashes only, never plaintext)
PATCH  /api/api-keys/:id    # rename, change scopes/expiry/allowlist
DELETE /api/api-keys/:id    # revoke immediately`
    },
    {
      type: 'note',
      text: 'Keys are managed in the admin UI at /api-keys. Because only the hash is stored, a lost key cannot be recovered — revoke and re-issue.'
    }
  ]
}

export const securityMasquerade: DocSection = {
  id: 'masquerade',
  label: 'Masquerade',
  content: [
    { type: 'h1', id: 'masquerade', text: 'Masquerade (View as User)' },
    {
      type: 'p',
      text: 'Admins can mint a short-lived masquerade token that authenticates as another user — server-side, so RBAC, row-level security, and activity logging all genuinely run as the target. This is how support and admins reproduce exactly what a user sees.'
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'ul',
      items: [
        '`POST /api/auth/masquerade` (admin only) with `{ "user_id": "<uuid>" }` returns an `nvm_`-prefixed Bearer token backed by Redis with a 4-hour TTL.',
        'The `authenticate` middleware and the Socket.io `auth` handler both resolve `nvm_` tokens to the target user; API requests and realtime events behave identically to a real session.',
        '`GET /api/auth/me` adds `"masquerade": true` while a masquerade token is in use, so frontends can show a banner.',
        '`DELETE /api/auth/masquerade` (called with the `nvm_` token) revokes it immediately; otherwise it expires on its own.',
        'Start and stop are activity-logged as `masquerade-start` / `masquerade-stop` against the issuing admin.'
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `POST /api/auth/masquerade
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "user_id": "57DA6884-E9BD-4A66-8F74-FFA6EC8B8B59" }

→ 200 { "data": { "token": "nvm_...", "user": { "id": "...", "first_name": "...", "last_name": "...", "email": "..." } } }
→ 400 { "error": "user_id is required" }        // or "Cannot masquerade as yourself"
→ 403 { "error": "Forbidden" }                  // caller is not an admin
→ 404 { "error": "User not found or inactive" }

DELETE /api/auth/masquerade
Authorization: Bearer <nvm_-token>

→ 200 { "ok": true }
→ 400 { "error": "Not a masquerade session" }`
    },
    {
      type: 'warn',
      text: 'A masquerade token carries the target user’s full permissions — including admin, if the target is an admin. Tokens live in Redis under `masq:<token>`; restarting Redis revokes all active masquerades.'
    }
  ]
}

export const securityScim: DocSection = {
  id: 'scim',
  label: 'SCIM 2.0 Provisioning',
  content: [
    { type: 'h1', id: 'scim', text: 'SCIM 2.0 User Provisioning' },
    {
      type: 'p',
      text: 'Identity providers (Azure AD / Entra, Okta) can provision and deprovision Nivaro users automatically via SCIM 2.0. The endpoint implements the Users resource with standard SCIM JSON.'
    },
    { type: 'h3', text: 'Setup' },
    {
      type: 'ul',
      items: [
        'Create an API key with the `scim` scope (Admin → API Keys).',
        'Point your IdP at `https://nivaro.example.com/api/scim/v2` with the key as the bearer token.',
        'Provisioned users are matched/created by email; deactivation in the IdP deactivates the Nivaro user.'
      ]
    },
    {
      type: 'pre',
      code: `GET    /api/scim/v2/Users            # list (supports filter=userName eq "...")
GET    /api/scim/v2/Users/:id
POST   /api/scim/v2/Users            # create
PATCH  /api/scim/v2/Users/:id        # partial update (active flag, names)
PUT    /api/scim/v2/Users/:id        # replace
DELETE /api/scim/v2/Users/:id        # deactivate`
    },
    {
      type: 'note',
      text: 'SCIM authenticates only with an API key carrying the scim scope — sessions and static user tokens are rejected on these routes.'
    }
  ]
}

export const securityFieldEncryption: DocSection = {
  id: 'field-encryption',
  label: 'Field Encryption at Rest',
  content: [
    { type: 'h1', id: 'field-encryption', text: 'Field-Level Encryption at Rest' },
    {
      type: 'p',
      text: 'Individual fields can be encrypted at rest with AES-256-GCM. Mark a field as encrypted in the Data Model (stored as `is_encrypted` on nivaro_fields) and the items service transparently encrypts on write and decrypts on read — API consumers and the admin UI see plaintext, the database stores ciphertext.'
    },
    { type: 'h3', text: 'Setup' },
    {
      type: 'pre',
      code: `# .env — 32-byte key (hex or base64)
ENCRYPTION_KEY=4f8d...64-hex-chars...c2a1

# Then in Data Model → field → toggle "Encrypted at rest"`
    },
    {
      type: 'ul',
      items: [
        'Encryption/decryption happens inside the items service — hooks, computed fields, and the REST/GraphQL APIs all see decrypted values.',
        'Each value gets a fresh random IV; ciphertext is stored as iv:tag:data.',
        'Existing plaintext values are encrypted the next time the row is written.'
      ]
    },
    {
      type: 'warn',
      text: 'Encrypted fields are NOT searchable or filterable — the database only sees ciphertext, so WHERE clauses, sort, and full-text search cannot use them. Losing ENCRYPTION_KEY makes encrypted values permanently unrecoverable.'
    }
  ]
}

export const securityRowIsolation: DocSection = {
  id: 'row-level-isolation',
  label: 'Row-Level Workspace Isolation',
  content: [
    { type: 'h1', id: 'row-level-isolation', text: 'Row-Level Workspace Isolation' },
    {
      type: 'p',
      text: 'Workspace isolation now extends beyond collections and roles to individual rows. Add a `workspace_id` column to any business table and the items service automatically filters reads and stamps writes with the active workspace.'
    },
    { type: 'h3', text: 'Rules' },
    {
      type: 'ul',
      items: [
        'The `workspace_id` column is optional per table — tables without it behave exactly as before (no row filtering).',
        'Rows with a NULL `workspace_id`, and tables without the column entirely, belong to the default workspace.',
        'On create, `workspace_id` is stamped with the request workspace (x-workspace header → user.current_workspace → default).',
        'On read, rows are filtered to the active workspace (plus NULL rows when in the default workspace).'
      ]
    },
    {
      type: 'note',
      text: 'This is opt-in per table. Adding the column via Data Model → add field "workspace_id" (uuid) on a collection enables isolation for that collection immediately.'
    }
  ]
}

export const securityQuotas: DocSection = {
  id: 'usage-quotas',
  label: 'Usage Quotas',
  content: [
    { type: 'h1', id: 'usage-quotas', text: 'Usage Quotas per Workspace' },
    {
      type: 'p',
      text: 'Workspaces can be capped on resource usage. Quotas are stored as JSON on `nivaro_workspaces.quotas` and live counters are tracked in `nivaro_usage_counters`. When a quota is exceeded the API returns `429 Too Many Requests` for the relevant operation.'
    },
    { type: 'h3', text: 'Quota shape' },
    {
      type: 'pre',
      code: `// nivaro_workspaces.quotas (JSON)
{
  "max_items": 100000,        // total rows across workspace collections
  "max_storage_mb": 5120,     // uploaded file bytes
  "max_api_requests_day": 500000
}`
    },
    {
      type: 'ul',
      items: [
        'Counters increment as operations happen; exceeding a limit blocks further creates/uploads/requests with 429 until usage drops or the quota is raised.',
        'The Workspaces admin page shows usage meters (current vs. limit) per workspace.',
        'Omit a key (or the whole quotas object) for unlimited.'
      ]
    }
  ]
}

export const securityWorkspaceTemplates: DocSection = {
  id: 'workspace-templates',
  label: 'Workspace Templates',
  content: [
    { type: 'h1', id: 'workspace-templates', text: 'Workspace Templates' },
    {
      type: 'p',
      text: 'A workspace can be snapshotted into a reusable template — its collections, fields, relations, roles, and configuration are captured into `nivaro_workspace_templates` and replayed into any new workspace.'
    },
    { type: 'h3', text: 'Using templates' },
    {
      type: 'ul',
      items: [
        'Workspaces page → a workspace\'s menu → "Save as template" snapshots the workspace schema.',
        'When creating a workspace, choose "From template" to replay a saved template into the new workspace.',
        'Templates capture schema and configuration, not item data.'
      ]
    },
    {
      type: 'note',
      text: 'Replay is additive — it creates collections and roles inside the new (empty) workspace and never touches other workspaces.'
    }
  ]
}

export const securityRetentionPolicies: DocSection = {
  id: 'retention-policies',
  label: 'Privacy & Retention Policies',
  content: [
    { type: 'h1', id: 'retention-policies', text: 'Privacy & Retention Policies' },
    {
      type: 'p',
      text: 'Retention policies identify users who have been inactive for a configurable period and either redact their PII, delete the account, or suspend it. This supports GDPR/CCPA data minimisation requirements without manual intervention.'
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'ul',
      items: [
        'A policy defines an inactivity threshold (months), the action to take, which fields to redact, and protected addresses/roles that are never touched.',
        'Users with no `nivaro_activity` rows since the cutoff — and not in any exclusion list — are candidates.',
        'Redacted users get `is_redacted = true` and are automatically excluded from all user pickers and list endpoints throughout the UI.',
        'Policies can be executed manually (with an optional dry-run preview) or scheduled via a cron expression.',
        'Every execution is recorded in `nivaro_retention_runs` with an affected count and up to 50 sample IDs for audit.'
      ]
    },
    { type: 'h3', text: 'Actions' },
    {
      type: 'table',
      head: ['Action', 'What happens'],
      rows: [
        [
          'redact',
          'Wipes configured PII fields, sets is_redacted=true, suspends account. Default.'
        ],
        ['delete', 'Hard-deletes the user row. Irreversible — use with caution.'],
        ['suspend_only', 'Sets status=suspended and is_redacted=true. No field values changed.']
      ]
    },
    { type: 'h3', text: 'Redaction template' },
    {
      type: 'p',
      text: 'The `redact_value_template` string (default `Redacted_{{id}}`) is used for email and external_id fields so they remain unique in the database. Other fields (first_name, last_name, job_title, avatar) are set to the literal string "Redacted".'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `GET    /api/retention             // list policies (admin)
POST   /api/retention             // create policy
PATCH  /api/retention/:id         // update policy
DELETE /api/retention/:id         // delete policy
POST   /api/retention/:id/run     // execute (add ?dry_run=true for preview)
GET    /api/retention/:id/runs    // run history`
    },
    {
      type: 'note',
      text: 'All retention endpoints require admin access. The dry-run endpoint returns affected_count and up to 50 sample user IDs without writing any changes.'
    }
  ]
}

export const securityUserScopes: DocSection = {
  id: 'user-scopes',
  label: 'User Scopes',
  content: [
    { type: 'h1', id: 'user-scopes', text: 'User Scopes' },
    {
      type: 'p',
      text: 'User Scopes give each user per-dimension DEFAULT filter values (seed their filter UIs) and RESTRICTED values (server-enforced row scoping — the user can only see rows matching the picked values). A scope dimension names a target collection (e.g. a "Zone" dimension targeting `divisions`); how it filters every other business collection is auto-resolved from the relations graph — including junction-table hops — so new collections are covered the moment a relation to the target exists.'
    },
    { type: 'h3', text: 'Dimensions' },
    {
      type: 'ul',
      items: [
        'Manage dimensions at **Settings → User Scopes** (`/scope-dimensions`): name, label, target collection, display field.',
        'The **coverage table** previews how the dimension resolves per collection: `self` (the target itself), `auto` (derived route via relations), `override` (pinned field path), `excluded`, or `unreachable`.',
        '`strict` — restricted users are DENIED (zero rows) on collections the dimension cannot reach, instead of being left unfiltered.',
        '`overrides` pin an explicit field path per collection; `exclusions` opt a collection out entirely.'
      ]
    },
    { type: 'h3', text: 'Per-user values' },
    {
      type: 'ul',
      items: [
        'Admins set both modes on the user page (Scopes card): defaults and restrictions.',
        'Users self-serve their own DEFAULTS from their profile — restrictions are admin-only.',
        'Values are stored as target-collection record ids, so renaming a zone never breaks a scope.'
      ]
    },
    { type: 'h3', text: 'Enforcement and seeding' },
    {
      type: 'ul',
      items: [
        'Restrictions are enforced server-side on every item read (list + single) and on native report widgets, alongside role row filters. Admins bypass.',
        'Defaults are never enforced — they pre-select filter chips and quick filters (collection browser, reports) the first time a surface loads; restricted values also narrow the visible filter options.',
        'Raw-SQL surfaces (custom queries, stored procedures, query-type report widgets, queue caches) cannot be dimension-filtered — treat those as curated, not scoped.'
      ]
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/scope-dimensions                  # registry (authenticated)
POST/PATCH/DELETE /api/scope-dimensions[/:id]  # admin
GET  /api/scope-dimensions/:id/coverage     # live per-collection route preview (admin)
GET  /api/users/me/scopes                   # caller's dimensions + defaults + restricted
PUT  /api/users/me/scopes/:dimension        # self-edit defaults only { values: [ids] }
GET/PUT /api/user-scopes/:userId            # admin: both modes { dimension, mode, values }`
    }
  ]
}
