import type { DocSection } from '../types.js'

export const whatIsNivaro: DocSection = {
  id: 'what-is-nivaro',
  label: 'What is Nivaro?',
  content: [
    { type: 'h1', id: 'what-is-nivaro', text: 'What is Nivaro?' },
    {
      type: 'p',
      text: 'Nivaro is a headless CMS that provides a metadata registry on top of an existing MSSQL database, a clean RBAC permissions model, a React admin UI, and a plugin system for custom business logic extensions.'
    },
    {
      type: 'p',
      text: 'Nivaro includes a full schema editor — collections, fields, relations, and computed fields are configured through the admin UI at `/data-model` and stored in the `nivaro_`-prefixed metadata registry. The registry drives the permission-aware REST API, GraphQL schema, and admin interface automatically.'
    },
    {
      type: 'table',
      head: ['Feature', 'Implementation'],
      rows: [
        ['Collections/Fields UI', 'nivaro_collections + nivaro_fields metadata registry'],
        ['Roles / Permissions', 'RBAC via nivaro_roles + nivaro_policies'],
        ['Auth (OIDC)', 'openid-client with Microsoft OIDC (PKCE flow)'],
        ['Extensions', 'Plugin loader at api/extensions/'],
        ['Flows / Automation', 'Inngest + in-process flow executor'],
        ['WebSockets / Real-time', 'Socket.io + Redis pub/sub adapter'],
        ['File Management', 'multer + local storage + nivaro_files'],
        ['Activity Log', 'nivaro_activity + nivaro_revisions'],
        ['Mail', 'nodemailer + LiquidJS templates (planned)'],
        ['Admin UI', 'React 19 + Vite + shadcn/ui']
      ]
    }
  ]
}

export const architecture: DocSection = {
  id: 'architecture',
  label: 'Architecture',
  content: [
    { type: 'h1', id: 'architecture', text: 'Architecture' },
    {
      type: 'p',
      text: 'Nivaro is a pnpm monorepo with two packages: `api` (Fastify, port 3055) and `admin` (React + Vite, port 3056 in dev). In production the admin is a static bundle served by a web server or CDN; in dev, Vite proxies `/api` requests to the Fastify process.'
    },
    {
      type: 'table',
      head: ['Layer', 'Technology'],
      rows: [
        ['API Framework', 'Fastify v5 — TypeScript-first plugin ecosystem'],
        [
          'Database',
          'Knex + MSSQL (tedious driver) — nivaro_ prefix tables alongside existing data'
        ],
        ['Sessions / Cache', 'Redis (ioredis) — sessions stored as sess:<id> keys'],
        ['Auth', 'openid-client PKCE flow — Microsoft OIDC'],
        ['Job Queue', 'Inngest — event-driven background jobs and flows'],
        ['WebSockets', 'Socket.io + @socket.io/redis-adapter'],
        ['Admin UI', 'React 19 + Vite 6 + shadcn/ui + Tanstack Query v5'],
        ['Linter / Formatter', 'Biome v2 — replaces ESLint + Prettier']
      ]
    },
    {
      type: 'pre',
      code: `nivaro/
├── api/src/
│   ├── index.ts          # Entry — migrations, server start
│   ├── server.ts         # Fastify instance + plugin registration
│   ├── config.ts         # Zod-validated env (loaded from .env)
│   ├── auth/             # OIDC + session helpers
│   ├── db/               # Knex instance + migrations
│   ├── extensions/       # Extension loader
│   ├── middleware/        # authenticate.ts (req.user, req.isAdmin)
│   ├── plugins/          # inngest, redis, cron, socketio
│   ├── routes/           # REST endpoints
│   └── services/         # Business logic (permissions, items, etc.)
└── admin/src/
    ├── App.tsx           # Router + AuthProvider
    ├── layouts/          # AppLayout (sidebar shell)
    ├── pages/            # One file per route
    └── lib/              # api.ts, auth.tsx, utils.ts`
    }
  ]
}

export const userDashboard: DocSection = {
  id: 'dashboard',
  label: 'Overview',
  content: [
    { type: 'h1', id: 'dashboard', text: 'Dashboard' },
    {
      type: 'p',
      text: 'The dashboard is the first screen after login. It shows live system health, key counts, and recent activity.'
    },
    { type: 'h3', text: 'System health bar' },
    {
      type: 'p',
      text: 'The colored indicator at the top right of the info panel reflects the state of both the database and Redis connections. It refreshes every 30 seconds automatically. If either service is unreachable the indicator turns amber and shows "System degraded."'
    },
    { type: 'h3', text: 'Stats cards' },
    {
      type: 'p',
      text: 'Counts for Collections, Users, Active Flows, and Extensions. These are live queries — no manual refresh needed.'
    },
    { type: 'h3', text: 'Recent activity' },
    {
      type: 'p',
      text: 'The last 10 entries from the `nivaro_activity` audit log, shown in reverse chronological order. Click any entry to see the related record.'
    }
  ]
}

export const userCollections: DocSection = {
  id: 'collections',
  label: 'Collections',
  content: [
    { type: 'h1', id: 'collections', text: 'Collections' },
    {
      type: 'p',
      text: 'The Collections page lists every table registered in the `nivaro_collections` metadata registry. Clicking a collection opens a paginated data browser for that table.'
    },
    { type: 'h3', text: 'Browsing data' },
    {
      type: 'p',
      text: 'The collection browser displays up to 25 rows per page by default. Use the search box at the top to filter rows across all string and text fields. Clicking a row opens the item editor.'
    },
    { type: 'h3', text: 'Field metadata' },
    {
      type: 'p',
      text: 'Field display names, types, and visibility are controlled by entries in `nivaro_fields`. Hidden fields are not shown in the UI. Read-only fields are displayed but not editable. These are registered by an administrator — the UI has no schema editor.'
    },
    {
      type: 'note',
      text: 'Only tables registered in `nivaro_collections` are browsable. Business tables must be registered by an administrator using the collections API or a seed script.'
    }
  ]
}

export const userUsersRoles: DocSection = {
  id: 'users-roles',
  label: 'Users & Roles',
  content: [
    { type: 'h1', id: 'users-roles', text: 'Users & Roles' },
    { type: 'h2', id: 'users', text: 'Users' },
    {
      type: 'p',
      text: 'The Users page lists all Nivaro users. Users are created automatically on first Microsoft OIDC login, or manually by an administrator.'
    },
    {
      type: 'ul',
      items: [
        '**Status** — `active` users can log in; `suspended` users are blocked at the authenticate middleware.',
        '**Role** — each user has one role. Role assignment controls what collections and actions are permitted.',
        '**Admin access** — if the assigned role has `admin_access: true`, all permission checks are bypassed.'
      ]
    },
    { type: 'h2', id: 'roles', text: 'Roles & Permissions' },
    {
      type: 'p',
      text: 'Roles are defined in `nivaro_roles`. Each role has zero or more policies (in `nivaro_policies`) that grant access.'
    },
    {
      type: 'table',
      head: ['Policy field', 'Description'],
      rows: [
        ['collection', 'Table name the policy applies to, e.g. articles'],
        ['action', 'One of: read, create, update, delete'],
        ['fields', 'Optional JSON array of allowed field names. Null = all fields.']
      ]
    },
    {
      type: 'p',
      text: 'Policies are additive — a user with two policies granting read on different field sets gets the union of those fields.'
    },
    {
      type: 'warn',
      text: 'Deleting a role that has users assigned to it is blocked. Reassign users to another role first.'
    }
  ]
}

export const userFlows: DocSection = {
  id: 'flows',
  label: 'Flows',
  content: [
    { type: 'h1', id: 'flows', text: 'Flows' },
    {
      type: 'p',
      text: 'Flows are automated workflows. Each flow has a trigger (how it starts) and a sequence of operations (what it does).'
    },
    { type: 'h2', id: 'flow-triggers', text: 'Triggers' },
    {
      type: 'table',
      head: ['Trigger', 'Description'],
      rows: [
        [
          'manual',
          'Started by clicking "Run Flow" in the UI or calling POST /api/flows/:id/trigger'
        ],
        ['schedule', 'Runs on a cron schedule. Specify a cron expression in Trigger Options.'],
        ['event', 'Triggered by an Inngest event name (planned).'],
        ['webhook', 'Triggered by an incoming HTTP request (planned).']
      ]
    },
    { type: 'h2', id: 'flow-operations', text: 'Operations' },
    {
      type: 'p',
      text: "Operations run in order of their position (top to bottom, left to right). Output from each operation is passed to the next as the flow's data payload."
    },
    {
      type: 'table',
      head: ['Type', 'Status', 'Description'],
      rows: [
        [
          'log',
          '✅ Live',
          'Writes a structured line to the API server log (pino). Configure message and level in options.'
        ],
        [
          'webhook',
          '✅ Live',
          'HTTP fetch to an external URL. Configure url and method in options.'
        ],
        [
          'condition',
          '⚙️ Stub',
          'Branch on a condition expression (not yet implemented — resolves forward).'
        ],
        ['exec-script', '⚙️ Stub', 'Run arbitrary Node.js code (not yet implemented).'],
        ['mail', '⚙️ Stub', 'Send email via nodemailer (not yet implemented).'],
        ['notification', '⚙️ Stub', 'Create an in-app notification (not yet implemented).']
      ]
    },
    { type: 'h3', text: 'Configuring a log operation' },
    {
      type: 'p',
      text: 'Click the pencil icon on any operation row to open the options editor. For a log operation:'
    },
    {
      type: 'ul',
      items: [
        '**Message** — the text written to the server log. Defaults to the operation name if left blank.',
        '**Level** — `info`, `warn`, `error`, or `debug`. Log output appears in the API process stdout (visible in `pnpm dev:api`).'
      ]
    },
    { type: 'h2', id: 'flow-status', text: 'Status' },
    {
      type: 'p',
      text: 'Only `active` flows execute. Toggling a flow to `inactive` immediately unregisters its cron job. Scheduled flows are re-registered automatically when the API restarts.'
    }
  ]
}

export const userFiles: DocSection = {
  id: 'files',
  label: 'Files',
  content: [
    { type: 'h1', id: 'files', text: 'Files' },
    {
      type: 'p',
      text: 'The file manager lets you upload, browse, and delete files. Uploaded files are stored on local disk and metadata is tracked in `nivaro_files`.'
    },
    {
      type: 'table',
      head: ['Endpoint', 'Description'],
      rows: [
        ['POST /api/files', 'Upload a file (multipart/form-data). Returns nivaro_files metadata.'],
        ['GET /api/files/:id/content', 'Serve the file with correct Content-Type.'],
        ['DELETE /api/files/:id', 'Delete file from disk and remove metadata.']
      ]
    }
  ]
}

export const userExtensions: DocSection = {
  id: 'extensions',
  label: 'Extensions',
  content: [
    { type: 'h1', id: 'extensions', text: 'Extensions' },
    {
      type: 'p',
      text: "Extensions are Node.js plugins that extend Nivaro's behavior — custom routes, hooks, scheduled jobs, and Inngest functions. The Extensions page shows all discovered plugins and their status."
    },
    {
      type: 'table',
      head: ['Status', 'Meaning'],
      rows: [
        ['loaded', 'Extension is registered and active.'],
        ['error', 'Extension was found but threw an error during registration.'],
        ['missing', 'Entry exists in config but the folder no longer exists on disk.']
      ]
    },
    {
      type: 'p',
      text: 'Use the toggle switch to enable or disable an extension without removing it. Disabled extensions have their hooks skipped and cron jobs paused. The enabled state persists across restarts via `api/extensions/.config.json`.'
    },
    {
      type: 'p',
      text: 'Click **Scan for new** to pick up any extensions added to `api/extensions/` since the server started, without restarting.'
    },
    {
      type: 'p',
      text: 'Missing extensions (folder deleted but config entry remains) can be removed by clicking the trash icon on the amber card.'
    }
  ]
}

export const userSettings: DocSection = {
  id: 'settings',
  label: 'Settings',
  content: [
    { type: 'h1', id: 'settings', text: 'Settings' },
    {
      type: 'p',
      text: 'App-wide settings stored in the `nivaro_settings` singleton row (always id = 1). All fields are configurable via **Settings** in the admin sidebar. Changes take effect immediately unless noted.'
    },
    { type: 'h3', text: 'Project' },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['project_name', 'Name shown in the browser tab and sidebar logo area.'],
        [
          'project_description',
          'Short subtitle shown under the logo when the sidebar is expanded.'
        ],
        ['project_url', 'Public URL of the application (used in emails, notifications, etc.).'],
        ['project_color', 'Accent hex color used in the sidebar and UI highlights.'],
        ['default_language', 'Locale string, e.g. en-US.']
      ]
    },
    { type: 'h3', text: 'Microsoft' },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['teams_webhook_url', 'Incoming webhook URL — in-app notifications are also posted here.'],
        [
          'ad_group_role_map',
          'JSON array of { ad_group_id, role_id } mappings. First match wins on OIDC login.'
        ]
      ]
    },
    { type: 'h3', text: 'AI Features' },
    {
      type: 'table',
      head: ['Field', 'Default', 'Description'],
      rows: [
        [
          'anthropic_api_key',
          '—',
          'Anthropic API key. Masked on GET. Falls back to ANTHROPIC_API_KEY env var.'
        ],
        [
          'ai_model',
          'claude-haiku-4-5-20251001',
          'Model used for all AI generate and summarize requests.'
        ],
        ['ai_max_tokens_generate', '500', 'Token budget for /ai/generate.'],
        ['ai_max_tokens_summarize', '200', 'Token budget for /ai/summarize.']
      ]
    },
    { type: 'h3', text: 'Presence Tracking' },
    {
      type: 'table',
      head: ['Field', 'Default', 'Description'],
      rows: [
        [
          'presence_session_ttl',
          '20',
          'Redis TTL (seconds) for a session after the last ping. Must exceed the ping interval.'
        ],
        [
          'presence_sweep_interval',
          '8000',
          'How often (ms) the server pushes the current session list to the admin presence page.'
        ],
        [
          'presence_ping_interval',
          '10000',
          'How often (ms) the embedded tracker script pings the server. Takes effect on next script load.'
        ]
      ]
    },
    { type: 'h3', text: 'SLA' },
    {
      type: 'table',
      head: ['Field', 'Default', 'Description'],
      rows: [
        [
          'sla_business_day_start',
          '9',
          'Start of the business day (24h hour, inclusive) for business-hours SLA calculations.'
        ],
        [
          'sla_business_day_end',
          '17',
          'End of the business day (24h hour, exclusive) for business-hours SLA calculations.'
        ],
        [
          'sla_business_days',
          '1,2,3,4,5',
          'Comma-separated day numbers (0=Sun … 6=Sat) treated as working days.'
        ]
      ]
    },
    { type: 'h3', text: 'Content' },
    {
      type: 'table',
      head: ['Field', 'Default', 'Description'],
      rows: [
        [
          'file_max_size_mb',
          '50',
          'Max file upload size in MB. Read at server startup — requires restart after change.'
        ],
        ['collection_page_size', '25', 'Default rows per page in the collection browser.'],
        [
          'activity_retention_days',
          'null',
          'Delete activity log entries older than N days. Null = keep forever. Purge runs daily.'
        ],
        [
          'revision_retention_count',
          'null',
          'Keep only the most recent N revisions per record. Null = keep all. Purge runs daily.'
        ]
      ]
    }
  ]
}

export const userActivity: DocSection = {
  id: 'activity',
  label: 'Activity Log',
  content: [
    { type: 'h1', id: 'activity', text: 'Activity Log' },
    {
      type: 'p',
      text: 'Every create, update, and delete on a tracked collection is recorded in `nivaro_activity`. The Activity page shows a paginated, filterable audit log.'
    },
    {
      type: 'p',
      text: 'For item mutations, a `nivaro_revisions` row stores the full JSON snapshot and a delta of changed fields, allowing point-in-time restoration.'
    },
    {
      type: 'note',
      text: 'Activity logging middleware is planned — the tables exist and are written to by flow triggers, but automatic logging of generic item mutations has not yet been wired up.'
    }
  ]
}
