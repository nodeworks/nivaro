import type { DocSection } from '../types.js'

export const extOverview: DocSection = {
  id: 'ext-overview',
  label: 'Overview',
  content: [
    { type: 'h1', id: 'ext-overview', text: 'Extension Development — Overview' },
    {
      type: 'p',
      text: 'Extensions are Node.js plugins that live in `api/extensions/<name>/`. Each extension exports a default object with an `id` string and a `register(ctx)` function. The loader discovers them automatically at startup and after a "Scan for new" request.'
    },
    {
      type: 'p',
      text: 'Both TypeScript (`index.ts`) and compiled JS (`index.js`) are supported. TypeScript files are loaded directly via `tsx` in development.'
    },
    { type: 'h3', text: 'Minimal extension' },
    {
      type: 'pre',
      code: `// api/extensions/my-extension/index.ts
import type { Extension } from '../../src/extensions/loader.js';

const plugin: Extension = {
  id: 'my-extension',
  async register(ctx) {
    ctx.logger.info('my-extension registered');
  },
};

export default plugin;`
    }
  ]
}

export const extContext: DocSection = {
  id: 'ext-context',
  label: 'Extension Context',
  content: [
    { type: 'h1', id: 'ext-context', text: 'Extension Context' },
    {
      type: 'p',
      text: 'The `ctx` object passed to `register()` exposes everything an extension needs:'
    },
    {
      type: 'table',
      head: ['Property', 'Type', 'Description'],
      rows: [
        ['app', 'FastifyInstance', 'The Fastify server. Register routes, decorators, hooks.'],
        ['database', 'Knex', 'Knex connection to the MSSQL database.'],
        ['inngest', 'Inngest', 'Inngest client for sending events and registering functions.'],
        ['logger', 'FastifyBaseLogger', 'Structured pino logger, prefixed with the extension id.'],
        [
          'hooks',
          '{ before, after }',
          'Scoped hook helpers — tagged with the extension id for enable/disable.'
        ],
        [
          'cron',
          '{ schedule, unschedule }',
          'Scoped cron helpers — paused/resumed when extension is toggled.'
        ],
        [
          'callExternalApi',
          '(nameOrId, options?) => Promise',
          'Call a configured external API by name or numeric ID. Auth (bearer, api_key, basic, oauth2_cc) resolved automatically from the stored config.'
        ],
        [
          'flows',
          '{ registerOperation, registerTrigger, emit }',
          'Register custom flow operation types and trigger types. They appear in the flow editor automatically. Call `emit()` to fire flows using a custom trigger.'
        ],
        [
          'bulkActions',
          '{ register(def) }',
          'Register a bulk action that appears in the collection browser selection bar. `def.execute({ collection, ids })` is called server-side.'
        ],
        [
          'itemActions',
          '{ register(def) }',
          'Register a contextual action button in the item editor toolbar. `def.execute({ collection, itemId })` is called server-side.'
        ],
        [
          'notificationChannels',
          '{ register(def) }',
          'Register a notification delivery channel (e.g. Slack, SMS). `def.deliver(ctx)` is called for every notification routed to this channel.'
        ],
        [
          'dashboardWidgets',
          '{ register(def) }',
          'Register a custom dashboard widget type. Appears in the widget picker with the declared label, icon, and config schema.'
        ],
        [
          'storage',
          '{ register(name, adapter), setActive(name) }',
          'Register a named file storage adapter (e.g. S3, Azure Blob). Call `setActive()` to route all new uploads through it.'
        ],
        [
          'fieldTypes',
          '{ register(def) }',
          'Register a custom field type with optional serialize/deserialize transforms. Appears in the field type picker in Data Model.'
        ],
        [
          'collectionViews',
          '{ register(def) }',
          'Register a custom collection view mode (Kanban, calendar, Gantt, map). Shown in the view switcher on collection browser pages.'
        ],
        [
          'importParsers',
          '{ register(def) }',
          'Register a file import parser for additional formats (Excel, JSON, XML). Parser is selected automatically by MIME type or extension in the import wizard.'
        ],
        [
          'validators',
          '{ register(def) }',
          'Register a custom field validator operator (e.g. `phone_e164`, `iban`). The operator becomes available in Data Model → Field → Validation Rules.'
        ]
      ]
    }
  ]
}

export const extHooks: DocSection = {
  id: 'ext-hooks',
  label: 'Hooks',
  content: [
    { type: 'h1', id: 'ext-hooks', text: 'Hooks' },
    {
      type: 'p',
      text: 'Hooks let extensions intercept and react to CRUD operations on any collection. They use the `ctx.hooks.before()` and `ctx.hooks.after()` helpers.'
    },
    {
      type: 'pre',
      code: `ctx.hooks.before('articles', 'create', async (payload) => {
  // Validate or transform payload before the row is written.
  // Throw a Fastify error to reject the operation.
  if (!payload.data?.owner) {
    throw { statusCode: 400, message: 'owner is required' };
  }
});

ctx.hooks.after('articles', 'create', async (payload) => {
  // payload.data is the newly created row.
  ctx.logger.info({ id: payload.data?.id }, 'New project created');
});

// Use '*' to match all collections or all actions:
ctx.hooks.after('*', 'delete', async (payload) => {
  ctx.logger.info({ collection: payload.collection, id: payload.itemId }, 'Record deleted');
});`
    },
    { type: 'h3', text: 'Hook payload shape' },
    {
      type: 'table',
      head: ['Field', 'Description'],
      rows: [
        ['collection', 'Table name, e.g. articles'],
        ['action', 'read | create | update | delete'],
        ['data', 'For write operations: the new row data. For reads: query result.'],
        ['itemId', 'Primary key of the affected record (update/delete).'],
        ['userId', 'ID of the Nivaro user who initiated the action.']
      ]
    }
  ]
}

export const extCron: DocSection = {
  id: 'ext-cron',
  label: 'Cron Jobs',
  content: [
    { type: 'h1', id: 'ext-cron', text: 'Cron Jobs' },
    {
      type: 'p',
      text: 'Use `ctx.cron.schedule()` to register a recurring job. Job IDs are automatically namespaced to the extension, so there is no risk of collision with other extensions or flow cron jobs.'
    },
    {
      type: 'pre',
      code: `ctx.cron.schedule('daily-report', '0 8 * * *', async () => {
  const rows = await ctx.database('articles')
    .where({ status: 'active' })
    .count('id as n')
    .first();
  ctx.logger.info({ count: rows?.n }, 'Daily project count');
});

// To cancel a job (e.g. on cleanup):
ctx.cron.unschedule('daily-report');`
    },
    {
      type: 'p',
      text: 'When an extension is disabled via the Extensions page, all of its cron jobs are automatically paused. They resume when the extension is re-enabled.'
    },
    {
      type: 'note',
      text: 'Cron jobs run in-process. For heavy or long-running work, fire an Inngest event from the cron callback and handle the work in an Inngest function.'
    }
  ]
}

export const extRoutes: DocSection = {
  id: 'ext-routes',
  label: 'Custom Routes',
  content: [
    { type: 'h1', id: 'ext-routes', text: 'Custom Routes' },
    {
      type: 'p',
      text: 'Register custom Fastify routes by calling `ctx.app.register()`. All extension routes are part of the same Fastify server and share the same session, Redis, and database decorators.'
    },
    {
      type: 'pre',
      code: `ctx.app.register(async (fastify) => {
  // Prehandler runs authentication on every route in this scope
  fastify.addHook('preHandler', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Unauthorized' });
  });

  fastify.get('/api/custom/summary', async (req, reply) => {
    const rows = await ctx.database('articles')
      .select('status')
      .count('id as n')
      .groupBy('status');
    return reply.send({ data: rows });
  });

  fastify.post('/api/custom/action', async (req, reply) => {
    const body = req.body as { projectId: string };
    // ... do work ...
    return reply.send({ ok: true });
  });
});`
    }
  ]
}

export const extInngest: DocSection = {
  id: 'ext-inngest',
  label: 'Inngest Functions',
  content: [
    { type: 'h1', id: 'ext-inngest', text: 'Inngest Functions' },
    {
      type: 'p',
      text: 'Inngest is mounted at `/api/inngest`. Register functions by adding them to the functions array in `api/src/plugins/inngest.ts`, or create them from within an extension.'
    },
    {
      type: 'pre',
      code: `const sendReport = ctx.inngest.createFunction(
  { id: 'send-daily-report' },
  { event: 'app/report.requested' },
  async ({ event, step }) => {
    const { userId } = event.data as { userId: string };

    const user = await step.run('load-user', async () => {
      return ctx.database('nivaro_users').where({ id: userId }).first();
    });

    await step.run('send-email', async () => {
      // nodemailer logic here
    });

    return { sent: true };
  },
);

// Send the event from a cron job or route:
await ctx.inngest.send({ name: 'app/report.requested', data: { userId: '...' } });`
    },
    {
      type: 'warn',
      text: 'In development, Inngest requires the local dev server (`npx inngest-cli dev`) to be running for functions to execute. Set `INNGEST_EVENT_KEY=local` and `INNGEST_SIGNING_KEY=local` in .env to bypass cloud auth.'
    }
  ]
}

export const extExample: DocSection = {
  id: 'ext-example',
  label: 'Full Example',
  content: [
    { type: 'h1', id: 'ext-example', text: 'Full Example Extension' },
    {
      type: 'note',
      text: 'Working examples for all extension types (inngest, socket.io, UI plugins, flows) live in `examples/my-project/extensions/`. Copy any folder into `api/extensions/` to activate it.'
    },
    {
      type: 'pre',
      code: `// api/extensions/project-sync/index.ts
import type { Extension } from '../../src/extensions/loader.js';

const plugin: Extension = {
  id: 'project-sync',

  async register(ctx) {

    // ── Hook: enforce required field on new projects ──────────────────
    ctx.hooks.before('articles', 'create', async (payload) => {
      if (!payload.data?.owner_id) {
        throw { statusCode: 400, message: 'owner_id is required for new projects' };
      }
    });

    // ── Hook: log all deletions ───────────────────────────────────────
    ctx.hooks.after('articles', 'delete', async (payload) => {
      ctx.logger.info({ id: payload.itemId }, 'Project deleted');
    });

    // ── Cron: nightly summary ─────────────────────────────────────────
    ctx.cron.schedule('nightly-summary', '0 0 * * *', async () => {
      const [{ n }] = await ctx.database('articles')
        .count('id as n')
        .where({ status: 'active' });
      ctx.logger.info({ active: n }, 'Nightly project count');
    });

    // ── Custom route ─────────────────────────────────────────────────
    ctx.app.register(async (fastify) => {
      fastify.get('/api/ext/project-sync/status', async (_req, reply) => {
        return reply.send({ ok: true, extensionId: 'project-sync' });
      });
    });

    ctx.logger.info('project-sync extension registered');
  },
};

export default plugin;`
    }
  ]
}

export const extExternalApis: DocSection = {
  id: 'ext-external-apis',
  label: 'External API Calls',
  content: [
    { type: 'h1', id: 'ext-external-apis', text: 'External API Calls' },
    {
      type: 'p',
      text: 'Extensions can call any configured external API via `ctx.callExternalApi()`. Authentication is resolved automatically from the stored config — the extension never sees raw credentials.'
    },
    {
      type: 'pre',
      code: `ctx.hooks.after('purchase_orders', 'create', async ({ data }) => {
  const res = await ctx.callExternalApi('Oracle EBS', {
    method: 'POST',
    path: '/invoices',
    body: { po_number: data.po_number, amount: data.total },
  });

  if (res.status >= 400) {
    ctx.logger.error({ status: res.status, body: res.body }, 'EBS invoice failed');
  } else {
    ctx.logger.info({ invoiceId: res.body?.id }, 'EBS invoice created');
  }
});`
    },
    { type: 'h3', text: 'Using a predefined endpoint template' },
    {
      type: 'pre',
      code: `// Use a named endpoint template — method, path, body, query, headers are pre-filled.
// Caller options override the template defaults.
ctx.hooks.after('purchase_orders', 'create', async ({ data }) => {
  const res = await ctx.callExternalApi('Oracle EBS', {
    endpoint: 'Create Invoice',   // name (or numeric id) of the predefined template
    body: { po_number: data.po_number, amount: data.total },  // overrides template default_body
  });
  ctx.logger.info({ invoiceId: res.body?.id }, 'EBS invoice created');
});`
    },
    { type: 'h3', text: 'Signature' },
    {
      type: 'pre',
      code: `ctx.callExternalApi(
  nameOrId: string | number,  // API name or numeric id from nivaro_external_apis
  options?: {
    endpoint?: string | number; // predefined endpoint name or id — sets method/path/body/query/headers defaults
    method?: string;            // default 'GET' (overrides endpoint default)
    path?: string;              // appended to base_url (overrides endpoint default)
    body?: unknown;             // auto-serialized to JSON (overrides endpoint default)
    headers?: Record<string, string>;  // merged over stored static headers + endpoint defaults
    query?: Record<string, string>;    // merged over endpoint default_query
    timeoutMs?: number;         // default 10000 (10s)
  }
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: unknown;              // parsed JSON or raw text string
}>`
    },
    {
      type: 'table',
      head: ['Auth type', 'What happens automatically'],
      rows: [
        ['bearer', 'Authorization: Bearer <token> injected.'],
        ['api_key', 'Key injected as header or query param per config.'],
        ['basic', 'Authorization: Basic base64(user:pass) injected.'],
        ['oauth2_cc', 'Client credentials token fetched from token_url, then Bearer injected.']
      ]
    },
    {
      type: 'warn',
      text: '`callExternalApi` throws if the API name/ID is not found or the API is disabled. Wrap in try/catch for graceful error handling.'
    }
  ]
}

export const extFlows: DocSection = {
  id: 'ext-flows',
  label: 'Custom Flow Ops & Triggers',
  content: [
    { type: 'h1', id: 'ext-flows', text: 'Custom Flow Operations & Triggers' },
    {
      type: 'p',
      text: 'Extensions can register custom operation types and trigger types. Once registered, they appear in the flow editor alongside built-in ops and triggers — no custom UI code required. Config fields are described with a schema and the editor renders them automatically.'
    },
    { type: 'h3', text: 'Registering a custom operation' },
    {
      type: 'pre',
      code: `ctx.flows.registerOperation({
  type: 'my-ext:send-sms',        // namespace with extension id
  label: 'Send SMS',
  description: 'Send a text via Twilio',
  color: '#7c3aed',               // optional badge color
  fields: [
    { key: 'to',      label: 'Recipient',  type: 'string',   required: true },
    { key: 'message', label: 'Message',    type: 'textarea', required: true },
    {
      key: 'provider',
      label: 'Provider',
      type: 'select',
      options: [
        { value: 'twilio',  label: 'Twilio' },
        { value: 'sinch',   label: 'Sinch' },
      ],
      defaultValue: 'twilio',
    },
  ],

  async handler(opts, data, ctx) {
    const to      = String(opts.to ?? '');
    const message = String(opts.message ?? '');
    // ... send SMS using opts.provider ...
    ctx.log.info({ flowId: ctx.flowId, to }, 'SMS sent');
    return { status: 'resolve', output: { ...data, $sms_sent: true } };
  },
});`
    },
    { type: 'h3', text: 'OpFieldSchema' },
    {
      type: 'table',
      head: ['Field', 'Type', 'Description'],
      rows: [
        ['key', 'string', "Key written into / read from the operation's options object"],
        ['label', 'string', 'Display label in the flow editor config panel'],
        [
          'type',
          "'string'|'number'|'boolean'|'select'|'textarea'|'json'",
          'Input type rendered in the editor'
        ],
        ['options', 'Array<{ value, label }>', 'Required when type is select'],
        ['placeholder', 'string?', 'Input placeholder text'],
        [
          'required',
          'boolean?',
          'Shows a red asterisk in the editor (validation is up to the handler)'
        ],
        ['description', 'string?', 'Help text shown below the input'],
        ['defaultValue', 'unknown?', 'Initial value populated in the editor']
      ]
    },
    { type: 'h3', text: 'Handler signature' },
    {
      type: 'pre',
      code: `type OpHandler = (
  opts: Record<string, unknown>,   // parsed options from the editor config
  data: Record<string, unknown>,   // current flow data (read + write)
  ctx: {
    flowId:   string;
    flowName: string;
    trigger:  string;
    payload:  Record<string, unknown>;  // original trigger payload
    log:      FastifyBaseLogger;
    userId?:  string;
  },
) => Promise<{ status: 'resolve' | 'reject'; output: Record<string, unknown> }>;`
    },
    {
      type: 'note',
      text: "Return `{ status: 'reject', output: { ...data, $error: '...' } }` to branch to the reject path. Never put raw `String(err)` into `$error` — log server-side and return a generic message."
    },
    { type: 'h3', text: 'Registering a custom trigger' },
    {
      type: 'pre',
      code: `// 1. Register the trigger type (call during extension register())
ctx.flows.registerTrigger({
  type: 'my-ext:crm-contact-updated',
  label: 'CRM Contact Updated',
  description: 'Fires when a contact is updated in the external CRM',
  fields: [
    {
      key: 'entity_type',
      label: 'Entity Type',
      type: 'select',
      options: [
        { value: 'contact', label: 'Contact' },
        { value: 'company', label: 'Company' },
      ],
    },
  ],
});

// 2. Emit the trigger from a webhook route, hook, or cron job
ctx.app.register(async (fastify) => {
  fastify.post('/api/crm-webhook', async (req, reply) => {
    const body = req.body as { entity_type: string; record: unknown };
    ctx.flows.emit('my-ext:crm-contact-updated', {
      entity_type: body.entity_type,
      record:      body.record,
    });
    return reply.send({ ok: true });
  });
});`
    },
    {
      type: 'p',
      text: "`ctx.flows.emit()` is fire-and-forget. It looks up all active flows with `trigger = 'my-ext:crm-contact-updated'` in the database and executes them asynchronously. Safe to call from hooks, cron callbacks, or route handlers."
    },
    { type: 'h3', text: 'Discovery endpoints' },
    {
      type: 'table',
      head: ['Method', 'Path', 'Description'],
      rows: [
        [
          'GET',
          '/api/flows/registered-operations',
          'List all extension-registered op types (without handler fn). Auth required.'
        ],
        [
          'GET',
          '/api/flows/registered-triggers',
          'List all extension-registered trigger types. Auth required.'
        ]
      ]
    },
    { type: 'h3', text: 'Example: example-flows extension' },
    {
      type: 'p',
      text: 'A full working example is at `examples/my-project/extensions/example-flows/index.ts`. It registers two triggers (`record-flagged`, `daily-digest`) and two operations (`format-text`, `db-lookup`) with complete field schemas and handlers.'
    }
  ]
}

export const systemTables: DocSection = {
  id: 'system-tables',
  label: 'System Tables',
  content: [
    { type: 'h1', id: 'system-tables', text: 'System Tables' },
    {
      type: 'p',
      text: 'All Nivaro tables use a `nivaro_` prefix to coexist with existing application tables in the same MSSQL database. Migration history is tracked in `nivaro_knex_migrations`.'
    },
    {
      type: 'table',
      head: ['Table', 'Purpose'],
      rows: [
        ['nivaro_roles', 'Role definitions. admin_access and app_access flags.'],
        ['nivaro_users', 'Nivaro users linked to Microsoft OIDC via external_id.'],
        ['nivaro_policies', 'Per-role permissions: collection + action + optional field list.'],
        ['nivaro_sessions', 'Session store (Redis-backed; DB row is a fallback reference).'],
        ['nivaro_collections', 'Metadata registry — display names, icons, archive config, etc.'],
        ['nivaro_fields', 'Field metadata — type, interface, options, hidden, required, sort.'],
        ['nivaro_relations', 'Relation definitions (M2O, O2M, M2M, M2A).'],
        ['nivaro_settings', 'App-wide singleton settings (always id = 1).'],
        ['nivaro_file_folders', 'Folder hierarchy for the file manager.'],
        ['nivaro_files', 'File metadata — storage path, MIME type, dimensions.'],
        ['nivaro_activity', 'Audit log — who did what, when, on which record.'],
        ['nivaro_revisions', 'Full snapshot + delta history for item changes.'],
        ['nivaro_notifications', 'In-app notifications per user.'],
        ['nivaro_flows', 'Flow definitions — trigger, status, trigger_options.'],
        [
          'nivaro_flow_operations',
          'Flow operation nodes — type, position, options, resolve/reject links.'
        ],
        ['nivaro_workflow_templates', 'Workflow state machine blueprints.'],
        [
          'nivaro_workflow_states',
          'States within a template. Includes skip_criteria JSON for auto-advance rules.'
        ],
        [
          'nivaro_workflow_transitions',
          'Edges: from_state → to_state with label, color, required_roles (JSON).'
        ],
        [
          'nivaro_workflow_bindings',
          'Maps a template to a collection; optional state_field syncs state key to a record column.'
        ],
        [
          'nivaro_workflow_instances',
          'Per-record runtime: current_state, started_at, completed_at.'
        ],
        [
          'nivaro_workflow_history',
          'Immutable log of every transition taken (instance, from, to, user, comment).'
        ],
        [
          'nivaro_pipeline_owner_groups',
          'Owner group per state — filters (JSON), sort, priority for tie-breaking.'
        ],
        ['nivaro_pipeline_owner_group_users', 'M2M link: owner group → nivaro_user.'],
        [
          'nivaro_pipeline_owner_dimensions',
          'Dimension config per binding — field (dotted path), label, is_row_axis, sort, required.'
        ],
        ['nivaro_pipeline_instance_owners', 'Per-record manual owner overrides.'],
        [
          'nivaro_external_apis',
          'Configured external API endpoints — base_url, auth_type, auth_config (JSON), headers (JSON), enabled, integration_type (plugin tag), integration_config (plugin JSON blob).'
        ],
        [
          'nivaro_external_api_endpoints',
          'Predefined endpoint templates per API — name, method, path, default_body/query/headers (JSON), sort. CASCADE-deleted with parent API.'
        ],
        [
          'nivaro_comments',
          'Per-record comments — collection, item, user FK, text (nvarchar(max)), timestamps.'
        ],
        [
          'nivaro_comment_mentions',
          'M2M link from a comment to mentioned users — comment FK, user FK.'
        ],
        ['nivaro_dashboards', 'Dashboard definitions — name, user FK, is_shared, timestamps.'],
        [
          'nivaro_dashboard_widgets',
          'Widget rows per dashboard — type, title, collection, field, filters (JSON), grid position (col/row/width/height).'
        ],
        [
          'nivaro_workspaces',
          'Workspace definitions — name, slug (unique), icon, color, timestamps. Default workspace seeded with fixed UUID.'
        ]
      ]
    }
  ]
}

export const permissionsModel: DocSection = {
  id: 'permissions-model',
  label: 'Permissions Model',
  content: [
    { type: 'h1', id: 'permissions-model', text: 'Permissions Model' },
    {
      type: 'p',
      text: "Permissions are enforced by `api/src/services/permissions.ts`. The `can(userId, collection, action)` function returns `true` if any policy on the user's role grants the requested action on the requested collection."
    },
    {
      type: 'p',
      text: 'Admin users (`role.admin_access = true`) bypass all checks. All other users must have an explicit policy.'
    },
    { type: 'h3', text: 'Field-level restrictions' },
    {
      type: 'p',
      text: 'If a policy specifies a `fields` array, only those fields are returned in read responses and only those fields are writable for write operations. The `getAllowedFields()` function returns the union of all field grants across matching policies.'
    },
    {
      type: 'pre',
      code: `// Check if a user can read a collection:
const allowed = await can(userId, 'articles', 'read');

// Get allowed fields:
const fields = await getAllowedFields(userId, 'articles', 'read');
// → ['id', 'name', 'status'] or null (null = all fields)`
    }
  ]
}

export const extPluginSystem: DocSection = {
  id: 'ext-plugin-system',
  label: 'UI Plugin System',
  content: [
    { type: 'h1', id: 'ext-plugin-system', text: 'UI Plugin System' },
    {
      type: 'p',
      text: 'Extensions can include an admin UI bundle (`ui.js`) that injects React components into named slots in the admin interface. This works at runtime — no rebuild of Nivaro required. Docker volume mounts are the primary deployment mechanism.'
    },
    {
      type: 'p',
      text: 'When an extension has a `manifest.json` declaring a `uiBundle`, Nivaro serves the bundle at `/api/extensions/<id>/ui.js`. The admin SPA fetches the manifest on boot and injects a `<script>` tag for each enabled plugin. Each script self-registers by calling `window.__NIVARO__.registerPlugin(plugin)`.'
    },
    { type: 'h3', text: 'How it works' },
    {
      type: 'ul',
      items: [
        'API starts → scans `extensions/` → reads `manifest.json` → registers route to serve `ui.js`',
        'Admin boots → fetches `GET /api/extensions/manifest` → injects `<script>` for each UI plugin',
        'Script executes → calls `window.__NIVARO__.registerPlugin(plugin)` → plugin components appear in slots',
        'Disabling an extension via the Extensions page removes it from the manifest response → its UI is not loaded on next boot'
      ]
    },
    { type: 'h3', text: 'window.__NIVARO__ runtime globals' },
    {
      type: 'p',
      text: 'Nivaro exposes a global object so plugin bundles can use React without bundling their own copy (which would cause hook errors):'
    },
    {
      type: 'table',
      head: ['Property', 'Type', 'Description'],
      rows: [
        ['React', 'typeof React', 'The React object — use for createElement, Fragment, etc.'],
        ['useState', 'Hook', 'React.useState'],
        ['useEffect', 'Hook', 'React.useEffect'],
        ['useCallback', 'Hook', 'React.useCallback'],
        ['useMemo', 'Hook', 'React.useMemo'],
        ['useRef', 'Hook', 'React.useRef'],
        ['registerPlugin', '(plugin) => void', 'Self-register the plugin and its slot components']
      ]
    },
    {
      type: 'note',
      text: 'Plugin bundles must NOT bundle React — they must reference it exclusively via `window.__NIVARO__.React` (or destructure from `window.__NIVARO__`). Bundling a second React instance causes "invalid hook call" runtime errors.'
    }
  ]
}

export const extPluginManifest: DocSection = {
  id: 'ext-plugin-manifest',
  label: 'Plugin Manifest',
  content: [
    { type: 'h1', id: 'ext-plugin-manifest', text: 'Plugin manifest.json' },
    {
      type: 'p',
      text: 'A `manifest.json` file in the extension directory tells Nivaro the extension has a UI bundle. It is optional — extensions without a manifest work exactly as before.'
    },
    {
      type: 'pre',
      code: `// api/extensions/my-plugin/manifest.json
{
  "name": "My Plugin",
  "version": "1.0.0",
  "uiBundle": "ui.js",
  "slots": ["external-api-detail", "nav-sidebar"]
}`
    },
    {
      type: 'table',
      head: ['Field', 'Required', 'Description'],
      rows: [
        ['name', 'No', 'Display name shown in the Extensions list'],
        ['version', 'No', 'Semantic version string'],
        [
          'uiBundle',
          'Yes (for UI)',
          'Filename of the compiled IIFE bundle. Must be a bare filename with no path separators.'
        ],
        ['slots', 'No', 'Informational list of slot names the plugin uses']
      ]
    },
    {
      type: 'warn',
      text: 'Extension IDs are validated against `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` and bundle filenames against `/^[a-zA-Z0-9._-]+$/` before routes are registered. IDs or filenames that fail validation are skipped with a warning log.'
    }
  ]
}

export const extPluginSlots: DocSection = {
  id: 'ext-plugin-slots',
  label: 'Plugin Slots',
  content: [
    { type: 'h1', id: 'ext-plugin-slots', text: 'Plugin Slots' },
    {
      type: 'p',
      text: 'Slots are named injection points in the admin UI. A plugin registers components for one or more slots. Multiple plugins can fill the same slot — all matching components are rendered in registration order.'
    },
    {
      type: 'table',
      head: ['Slot name', 'Where it renders', 'Context props'],
      rows: [
        [
          'external-api-detail',
          'Bottom of the External API edit page',
          '{ api } — the full External API object including integration_type and integration_config'
        ],
        [
          'item-detail-sidebar',
          'Sidebar panel on item edit pages',
          '{ collection, item } — collection name and the full item record'
        ],
        [
          'nav-sidebar',
          'Extensions section at the bottom of the sidebar nav',
          '{ section, label, icon, href } — declares the link, not a component'
        ],
        [
          'settings-tab',
          'New tab injected into the Settings page',
          'none — component receives no props'
        ],
        [
          'collection-toolbar',
          'Toolbar area on collection list pages',
          '{ collection, selectedIds } — collection name and currently selected row IDs'
        ],
        [
          'list-row-action',
          'Action items in collection list row menus',
          '{ collection, item } — collection name and the row record'
        ]
      ]
    },
    { type: 'h3', text: 'Slot filter' },
    {
      type: 'p',
      text: 'Most slots support an optional `filter` function. If provided, the component only renders when `filter(ctx)` returns `true`. Use this to scope a plugin to a specific External API integration type, collection, etc.'
    },
    {
      type: 'pre',
      code: `// Only render for External APIs tagged as "oracle-ebs"
slots: {
  'external-api-detail': {
    filter: ({ api }) => api.integration_type === 'oracle-ebs',
    component: OraclePanel,
  },
}

// Only render toolbar for the "invoices" collection
slots: {
  'collection-toolbar': {
    filter: ({ collection }) => collection === 'invoices',
    component: InvoiceToolbar,
  },
}`
    },
    { type: 'h3', text: 'nav-sidebar slot' },
    {
      type: 'p',
      text: 'The `nav-sidebar` slot is declarative — provide metadata, not a component. Nivaro renders the link using the standard `NavItem` component:'
    },
    {
      type: 'pre',
      code: `slots: {
  'nav-sidebar': {
    section: 'extensions',   // 'main' | 'automation' | 'system' | 'monitoring' | 'extensions'
    label: 'Oracle EBS',
    icon: SomeIcon,          // React component (lucide or custom SVG)
    href: '/extensions/ui/oracle-ebs',
  },
}`
    }
  ]
}

export const extPluginBuildGuide: DocSection = {
  id: 'ext-plugin-build',
  label: 'Building a UI Plugin',
  content: [
    { type: 'h1', id: 'ext-plugin-build', text: 'Building a UI Plugin — Full TypeScript Guide' },
    {
      type: 'p',
      text: 'Plugin UI bundles are compiled to IIFE-format JavaScript. You write TypeScript + JSX; Vite compiles it. React must not be bundled — it comes from `window.__NIVARO__` at runtime. This guide walks through every step from an empty folder to a running plugin.'
    },

    { type: 'h3', text: 'Step 1 — Project structure' },
    {
      type: 'pre',
      code: `my-plugin/              ← this folder is mounted into /app/extensions/my-plugin
  src/
    ui.tsx            ← React component source (TypeScript + JSX)
    api.ts            ← API-side source (routes, hooks, cron)
    types.ts          ← shared types between UI and API
  manifest.json       ← tells Nivaro about the UI bundle
  package.json
  tsconfig.json       ← for UI (targets bundler module resolution)
  tsconfig.api.json   ← for API (targets Node ESM)
  vite.config.ts      ← builds ui.tsx → ui.js (IIFE)`
    },

    { type: 'h3', text: 'Step 2 — package.json' },
    {
      type: 'pre',
      code: `{
  "name": "@my-org/nivaro-plugin-my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build && tsc -p tsconfig.api.json",
    "build:ui": "vite build",
    "build:api": "tsc -p tsconfig.api.json",
    "dev": "vite build --watch"
  },
  "devDependencies": {
    "@nivaro/sdk": "latest",
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "vite": "^6.0.0"
  }
}`
    },

    { type: 'h3', text: 'Step 3 — tsconfig.json (UI side)' },
    {
      type: 'pre',
      code: `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "lib": ["ES2020", "DOM"],
    "types": ["node"]
  },
  "include": ["src/ui.tsx", "src/types.ts"]
}`
    },

    { type: 'h3', text: 'Step 4 — tsconfig.api.json (API side)' },
    {
      type: 'pre',
      code: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": ".",
    "rootDir": "src",
    "strict": true,
    "lib": ["ES2022"]
  },
  "include": ["src/api.ts", "src/types.ts"]
}`
    },

    { type: 'h3', text: 'Step 5 — vite.config.ts' },
    {
      type: 'p',
      text: 'The key is externalizing `react` and `react/jsx-runtime`, then injecting a banner that maps those globals to `window.__NIVARO__`. This lets your source use normal JSX imports without bundling React.'
    },
    {
      type: 'pre',
      code: `// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/ui.tsx',
      formats: ['iife'],
      name: 'NivaroPlugin_MyPlugin',   // IIFE wrapper name — arbitrary
      fileName: () => 'ui.js',
    },
    outDir: '.',        // output ui.js at the plugin root
    emptyOutDir: false, // don't wipe manifest.json / index.js
    rollupOptions: {
      // Tell Rollup not to bundle react — they'll be globals from the banner
      external: ['react', 'react/jsx-runtime'],
      output: {
        globals: {
          'react': 'React',
          'react/jsx-runtime': '__NVR_JSX__',
        },
        // Inject globals at the top of the IIFE before any plugin code runs
        banner: \`
var React = window.__NIVARO__.React;
var __NVR_JSX__ = {
  jsx: React.createElement,
  jsxs: React.createElement,
  Fragment: React.Fragment,
  createElement: React.createElement,
};
\`,
      },
    },
  },
});`
    },

    { type: 'h3', text: 'Step 6 — src/types.ts' },
    {
      type: 'pre',
      code: `// src/types.ts
// Shared between UI and API sides

export interface MyPluginConfig {
  clientId: string;
  expiresAt: string | null;
  lastRotated: string | null;
}`
    },

    { type: 'h3', text: 'Step 7 — src/ui.tsx (UI component)' },
    {
      type: 'pre',
      code: `// src/ui.tsx
import React, { useState, useEffect } from 'react';
import type { NivaroExtensionPlugin, ExternalApiSlotContext } from '@nivaro/sdk';
import type { MyPluginConfig } from './types';

// ─── Panel component ─────────────────────────────────────────────────────────

function MyPanel({ api }: { api: ExternalApiSlotContext }) {
  const config = api.integration_config as MyPluginConfig | null;
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const isExpiringSoon = config?.expiresAt
    ? new Date(config.expiresAt) < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    : false;

  async function rotateSecret() {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(\`/api/extensions/my-plugin/rotate/\${api.id}\`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await res.text());
      setStatus('Secret rotated successfully.');
    } catch (err) {
      setStatus(\`Error: \${err instanceof Error ? err.message : 'Unknown error'}\`);
    } finally {
      setLoading(false);
    }
  }

  const panelStyle: React.CSSProperties = {
    marginTop: 20,
    padding: '16px 20px',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    background: '#f8fafc',
  };

  const warningStyle: React.CSSProperties = {
    marginTop: 8,
    padding: '8px 12px',
    background: '#fef9c3',
    border: '1px solid #fde68a',
    borderRadius: 6,
    fontSize: 12,
    color: '#92400e',
  };

  return (
    <div style={panelStyle}>
      <p style={{ fontWeight: 600, marginBottom: 12, fontSize: 13 }}>My Plugin</p>

      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
        <tbody>
          <tr>
            <td style={{ color: '#64748b', paddingRight: 16, paddingBottom: 6 }}>Client ID</td>
            <td style={{ fontFamily: 'monospace' }}>{config?.clientId ?? '—'}</td>
          </tr>
          <tr>
            <td style={{ color: '#64748b', paddingRight: 16, paddingBottom: 6 }}>Expires</td>
            <td style={{ color: isExpiringSoon ? '#b45309' : undefined }}>
              {config?.expiresAt
                ? new Date(config.expiresAt).toLocaleDateString()
                : '—'}
              {isExpiringSoon && ' ⚠ expiring soon'}
            </td>
          </tr>
          <tr>
            <td style={{ color: '#64748b', paddingRight: 16 }}>Last rotated</td>
            <td>{config?.lastRotated ? new Date(config.lastRotated).toLocaleDateString() : '—'}</td>
          </tr>
        </tbody>
      </table>

      {isExpiringSoon && (
        <div style={warningStyle}>Secret expires within 30 days. Rotate it before expiry.</div>
      )}

      <button
        type="button"
        onClick={rotateSecret}
        disabled={loading}
        style={{
          marginTop: 12,
          padding: '6px 14px',
          fontSize: 13,
          background: loading ? '#e2e8f0' : '#0ea5e9',
          color: loading ? '#94a3b8' : '#fff',
          border: 'none',
          borderRadius: 6,
          cursor: loading ? 'not-allowed' : 'pointer',
        }}
      >
        {loading ? 'Rotating…' : 'Rotate Secret'}
      </button>

      {status && (
        <p style={{ marginTop: 8, fontSize: 12, color: status.startsWith('Error') ? '#dc2626' : '#16a34a' }}>
          {status}
        </p>
      )}
    </div>
  );
}

// ─── Plugin registration ─────────────────────────────────────────────────────

const plugin: NivaroExtensionPlugin = {
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.0.0',
  slots: {
    'external-api-detail': {
      filter: ({ api }) => api.integration_type === 'my-plugin',
      component: MyPanel as unknown as never,
    },
    'nav-sidebar': {
      section: 'extensions',
      label: 'My Plugin',
      // Icon: plain SVG element (no lucide dependency in plugin)
      icon: () => React.createElement('svg', {
        xmlns: 'http://www.w3.org/2000/svg', width: 15, height: 15,
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, React.createElement('circle', { cx: 12, cy: 12, r: 10 })),
      href: '/extensions/ui/my-plugin',
    },
  },
};

window.__NIVARO__.registerPlugin(plugin);`
    },

    { type: 'h3', text: 'Step 8 — src/api.ts (API side)' },
    {
      type: 'pre',
      code: `// src/api.ts  →  compiled to api.js by tsconfig.api.json
// Rename to index.ts if you want this as the main entry point,
// or keep api.ts and import it from index.ts.
import type { ExtensionContext } from '../../../src/extensions/loader.js';
import type { MyPluginConfig } from './types.js';

export async function register(ctx: ExtensionContext) {

  // ── Migrate: add my_plugin_clients table if missing ──────────────────────
  const exists = await ctx.database.schema.hasTable('my_plugin_clients');
  if (!exists) {
    await ctx.database.schema.createTable('my_plugin_clients', (t) => {
      t.increments('id');
      t.integer('external_api_id').notNullable()
        .references('id').inTable('nivaro_external_apis').onDelete('CASCADE');
      t.string('client_id', 255).notNullable();
      t.datetime('expires_at').nullable();
      t.datetime('last_rotated').nullable();
    });
  }

  // ── Routes ───────────────────────────────────────────────────────────────
  ctx.app.register(async (f) => {
    f.addHook('preHandler', async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: 'Unauthorized' });
    });

    // GET config for an External API
    f.get<{ Params: { apiId: string } }>(
      '/extensions/my-plugin/config/:apiId',
      async (req, reply) => {
        const row = await ctx.database('my_plugin_clients')
          .where({ external_api_id: req.params.apiId })
          .first();
        return reply.send({ data: row ?? null });
      },
    );

    // PATCH config (set client ID, etc.)
    f.patch<{ Params: { apiId: string }; Body: Partial<MyPluginConfig> }>(
      '/extensions/my-plugin/config/:apiId',
      async (req, reply) => {
        const { clientId, expiresAt } = req.body;
        const existing = await ctx.database('my_plugin_clients')
          .where({ external_api_id: req.params.apiId })
          .first();

        if (existing) {
          await ctx.database('my_plugin_clients')
            .where({ id: existing.id })
            .update({ client_id: clientId, expires_at: expiresAt });
        } else {
          await ctx.database('my_plugin_clients').insert({
            external_api_id: req.params.apiId,
            client_id: clientId,
            expires_at: expiresAt,
          });
        }

        // Also write summary into integration_config for the UI panel
        await ctx.database('nivaro_external_apis')
          .where({ id: req.params.apiId })
          .update({
            integration_config: JSON.stringify({ clientId, expiresAt, lastRotated: null }),
          });

        return reply.send({ ok: true });
      },
    );

    // POST rotate — calls the external system, updates stored config
    f.post<{ Params: { apiId: string } }>(
      '/extensions/my-plugin/rotate/:apiId',
      async (req, reply) => {
        const res = await ctx.callExternalApi(Number(req.params.apiId), {
          method: 'POST',
          path: '/rotate-secret',
        });

        if (res.status >= 400) {
          return reply.code(502).send({ error: 'Upstream rotation failed', upstream: res.body });
        }

        const now = new Date().toISOString();
        await ctx.database('my_plugin_clients')
          .where({ external_api_id: req.params.apiId })
          .update({ last_rotated: now });

        // Refresh integration_config so the panel shows the new date
        const row = await ctx.database('my_plugin_clients')
          .where({ external_api_id: req.params.apiId })
          .first();

        await ctx.database('nivaro_external_apis')
          .where({ id: req.params.apiId })
          .update({
            integration_config: JSON.stringify({
              clientId: row?.client_id,
              expiresAt: row?.expires_at,
              lastRotated: now,
            }),
          });

        return reply.send({ ok: true });
      },
    );
  });

  // ── Cron: warn 30 days before expiry ─────────────────────────────────────
  ctx.cron.schedule('expiry-check', '0 9 * * *', async () => {
    const threshold = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const expiring = await ctx.database('my_plugin_clients')
      .where('expires_at', '<', threshold)
      .whereNotNull('expires_at');

    for (const row of expiring) {
      ctx.logger.warn({ apiId: row.external_api_id }, 'my-plugin client secret expiring soon');
    }
  });

  ctx.logger.info('my-plugin registered');
}`
    },

    { type: 'h3', text: 'Step 9 — index.ts (extension entry point)' },
    {
      type: 'pre',
      code: `// src/index.ts  →  compiled to index.js (the extension entry point)
import { register } from './api.js';

export default {
  id: 'my-plugin',
  register,
};`
    },

    { type: 'h3', text: 'Step 10 — manifest.json' },
    {
      type: 'pre',
      code: `{
  "name": "My Plugin",
  "version": "1.0.0",
  "uiBundle": "ui.js",
  "slots": ["external-api-detail", "nav-sidebar"]
}`
    },

    { type: 'h3', text: 'Step 11 — Build' },
    {
      type: 'pre',
      code: `# Install deps
pnpm install   # or npm install

# Build everything: ui.js (Vite IIFE) + index.js (tsc)
pnpm build

# Watch mode during development
pnpm dev`
    },
    {
      type: 'p',
      text: 'After `pnpm build`, your plugin directory contains `ui.js` (admin bundle), `index.js` (API side), and `manifest.json`. These three files are everything Nivaro needs.'
    },

    { type: 'h3', text: 'Step 12 — Docker mount and deploy' },
    {
      type: 'pre',
      code: `# docker-compose.yml
services:
  nivaro:
    image: nivaro:latest
    volumes:
      - ./my-plugin:/app/extensions/my-plugin
    environment:
      - DB_HOST=...`
    },
    {
      type: 'p',
      text: 'After mounting the volume, hot-reload the API side without restarting the container:'
    },
    {
      type: 'pre',
      code: `curl -X POST https://your-nivaro/api/extensions/reload \\
  -H "Authorization: Bearer <static-token>"`
    },
    {
      type: 'p',
      text: 'The UI bundle is served immediately — no reload needed on the API. Open the admin in a fresh browser tab to load the new script.'
    },

    { type: 'h3', text: 'Step 13 — Wire up in the admin' },
    {
      type: 'ul',
      items: [
        'Go to External APIs and open or create an API entry',
        'Set Integration Type to `my-plugin` (or whatever string your filter checks)',
        'Save — the My Plugin panel now appears at the bottom of the edit page',
        'Use the panel to enter the client ID and configure the integration'
      ]
    },

    { type: 'h3', text: 'Development iteration loop' },
    {
      type: 'ul',
      items: [
        'Edit `src/ui.tsx` → `pnpm dev` rebuilds `ui.js` on save',
        'Hard-refresh the admin tab to reload the script (or use `loadedExtensions.delete` from browser devtools)',
        'Edit `src/api.ts` → `pnpm build:api` → `POST /api/extensions/reload` to hot-swap routes',
        'Type-check everything: `pnpm tsc --noEmit` (both tsconfig files)'
      ]
    },

    {
      type: 'note',
      text: "The `component: MyPanel as unknown as never` cast is required because the SDK's `PluginSlots` interface uses `unknown` for components (the SDK is framework-agnostic). The cast is safe — Nivaro passes the correct props at runtime."
    }
  ]
}

export const extPluginIntegrationTypes: DocSection = {
  id: 'ext-plugin-integration-types',
  label: 'External API Integrations',
  content: [
    { type: 'h1', id: 'ext-plugin-integration-types', text: 'External API Integration Types' },
    {
      type: 'p',
      text: 'Every External API record has an optional `integration_type` field — a free-form string tag (e.g. `"sat-ng"`, `"oracle-ebs"`). Plugins use this to identify which External APIs they manage and render targeted UI panels.'
    },
    {
      type: 'p',
      text: 'Set the integration type in the External API edit page under the "Integration Type" card. Leave blank for APIs that no plugin manages.'
    },
    {
      type: 'table',
      head: ['Field', 'Type', 'Description'],
      rows: [
        [
          'integration_type',
          'string | null',
          'Free-form tag identifying the plugin that manages this API (e.g. "sat-ng")'
        ],
        [
          'integration_config',
          'object | null',
          'JSON config blob. Plugins write and read this to store integration-specific metadata (client IDs, expiry dates, etc.). Not exposed in the base form — plugins manage it directly via API calls.'
        ]
      ]
    },
    { type: 'h3', text: 'Typical plugin pattern' },
    {
      type: 'pre',
      code: `// 1. User sets integration_type = "sat-ng" on an External API
//    and enters their SAT-NG client ID in the plugin's panel UI

// 2. Plugin's external-api-detail slot filters to only that API:
slots: {
  'external-api-detail': {
    filter: ({ api }) => api.integration_type === 'sat-ng',
    component: SatNgPanel,
  }
}

// 3. Plugin panel reads integration_config from the API object
function SatNgPanel({ api }) {
  var config = api.integration_config; // { clientId: "...", expiresAt: "..." }
  // ...render client info, rotation warnings, etc.
}

// 4. Plugin's API side (index.js) registers routes to read/write integration_config:
ctx.app.register(async (f) => {
  f.patch('/api/external-apis/:id/sat-ng-config', async (req, reply) => {
    const { clientId } = req.body;
    await ctx.database('nivaro_external_apis')
      .where({ id: req.params.id })
      .update({ integration_config: JSON.stringify({ clientId }) });
    return reply.send({ ok: true });
  });
});`
    },
    {
      type: 'note',
      text: 'The base Nivaro form only exposes `integration_type`. The `integration_config` JSON blob is intentionally managed by the plugin — the plugin panel renders its own fields and calls its own API routes to persist config.'
    }
  ]
}

export const extRegistrations: DocSection = {
  id: 'ext-registrations',
  label: 'Registration APIs',
  content: [
    { type: 'h1', id: 'ext-registrations', text: 'Extension Registration APIs' },
    {
      type: 'p',
      text: 'Beyond hooks, cron, and routes, extensions can register capabilities that plug into specific admin UI surfaces and server pipelines. Working examples for every type live in `examples/my-project/extensions/`.'
    },

    { type: 'h3', text: 'Bulk actions' },
    {
      type: 'p',
      text: 'Appear as buttons in the collection browser selection bar when rows are selected. The `execute` function runs server-side and returns a toast message.'
    },
    {
      type: 'pre',
      code: `ctx.bulkActions.register({
  id: 'mark-fulfilled',
  label: 'Mark fulfilled',
  icon: 'CheckCircle2',
  collections: ['orders'],   // omit for all collections
  async execute({ ids, collection }) {
    const n = await ctx.database(collection).whereIn('id', ids).update({ status: 'fulfilled' });
    return { message: \`\${n} order\${n === 1 ? '' : 's'} marked fulfilled\` };
  },
});`
    },

    { type: 'h3', text: 'Item actions' },
    {
      type: 'p',
      text: 'Appear as buttons in the item editor toolbar alongside Save. Useful for "Push to ERP", "Generate PDF", "Send notification" patterns.'
    },
    {
      type: 'pre',
      code: `ctx.itemActions.register({
  id: 'push-to-erp',
  label: 'Push to ERP',
  variant: 'outline',        // 'default' | 'outline' | 'destructive'
  collections: ['invoices'],
  async execute({ itemId, collection }) {
    await ctx.callExternalApi('my-erp', { method: 'POST', path: '/invoices', body: { id: itemId } });
    return { message: 'Invoice pushed to ERP' };
  },
});`
    },

    { type: 'h3', text: 'Notification channels' },
    {
      type: 'p',
      text: 'Every in-app notification is also delivered to all registered channels. Useful for Slack, Teams, SMS, email via a custom provider.'
    },
    {
      type: 'pre',
      code: `ctx.notificationChannels.register({
  id: 'slack',
  label: 'Slack',
  async deliver({ subject, message, recipient }) {
    await fetch(process.env.SLACK_WEBHOOK_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: \`*\${subject}*\\n\${message}\` }),
    });
  },
});`
    },

    { type: 'h3', text: 'Storage adapters' },
    {
      type: 'p',
      text: 'Replace local disk storage with any cloud provider. The adapter interface matches the local adapter exactly — put, get, delete, url.'
    },
    {
      type: 'pre',
      code: `ctx.storage.register('s3', {
  async put(key, stream, meta) { /* upload to S3 */ },
  async get(key) { /* return readable stream from S3 */ },
  async delete(key) { /* delete from S3 */ },
  async url(key) { return getSignedUrl(client, key); },
});
ctx.storage.setActive('s3');`
    },

    { type: 'h3', text: 'Dashboard widgets' },
    {
      type: 'p',
      text: 'Register custom widget types. The widget type appears in the dashboard builder widget picker alongside built-in types.'
    },
    {
      type: 'pre',
      code: `ctx.dashboardWidgets.register({
  type: 'my-ext:revenue-chart',
  label: 'Revenue Chart',
  icon: 'BarChart3',
  description: 'Monthly revenue from the billing API',
  fieldMappings: [{ key: 'period', label: 'Period', required: true }],
});`
    },

    { type: 'h3', text: 'Collection views' },
    {
      type: 'p',
      text: 'Add view modes to the collection browser (Kanban, calendar, Gantt, map). The view renders via a UI bundle URL that receives collection data via postMessage.'
    },
    {
      type: 'pre',
      code: `ctx.collectionViews.register({
  id: 'kanban',
  label: 'Kanban',
  icon: 'Columns3',
  bundleUrl: '/api/extensions/my-ext/ui.js',
  fieldMappings: [
    { key: 'statusField', label: 'Status field', required: true },
    { key: 'titleField',  label: 'Title field',  required: true },
  ],
});`
    },

    { type: 'h3', text: 'Import parsers' },
    {
      type: 'p',
      text: 'Add file format support to the Data Import wizard. The parser is selected automatically by MIME type or file extension. Returns column-named row objects identical to CSV rows.'
    },
    {
      type: 'pre',
      code: `ctx.importParsers.register({
  mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  extensions: ['xlsx'],
  label: 'Excel (.xlsx)',
  async parse(content) {
    const XLSX = await import('xlsx');
    const ws = XLSX.read(content, { type: 'buffer' }).Sheets['Sheet1'];
    return XLSX.utils.sheet_to_json(ws, { defval: '' })
      .map(row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, String(v)])));
  },
});`
    },

    { type: 'h3', text: 'Custom validators' },
    {
      type: 'p',
      text: 'Add validator operators to the field validation rule system. Once registered, the operator appears in Data Model → Field → Validation Rules.'
    },
    {
      type: 'pre',
      code: `ctx.validators.register({
  operator: 'phone_e164',
  label: 'Phone (E.164)',
  validate(value) {
    if (!value) return null;
    return /^\\+[1-9]\\d{7,14}$/.test(String(value))
      ? null
      : 'Must be a valid E.164 phone number';
  },
});`
    },

    { type: 'h3', text: 'Discovery endpoint' },
    {
      type: 'p',
      text: 'All registered capabilities are accessible via a single endpoint, scoped to a collection when relevant:'
    },
    {
      type: 'pre',
      code: `GET /api/extension-registry?collection=orders
// Returns all 9 registries: bulkActions, itemActions, notificationChannels,
// dashboardWidgets, fieldTypes, collectionViews, importParsers, validators,
// storageAdapters + activeStorageAdapter`
    }
  ]
}

export const mssqlRules: DocSection = {
  id: 'mssql-rules',
  label: 'MSSQL FK Rules',
  content: [
    { type: 'h1', id: 'mssql-rules', text: 'MSSQL FK Rules' },
    {
      type: 'p',
      text: 'MSSQL error 1785 fires when a foreign key introduces "cycles or multiple cascade paths." Three rules apply when adding new migrations:'
    },
    {
      type: 'ul',
      items: [
        'Self-referential FKs must use NO ACTION — not SET NULL or CASCADE. Affects `nivaro_file_folders.parent` and `nivaro_revisions.parent`.',
        'Multiple FKs on the same table must use NO ACTION — `nivaro_revisions` has both `activity` and `parent` FKs; MSSQL rejects multiple cascade paths on the same table.',
        'ON DELETE SET NULL requires a nullable column — MSSQL error 1761 if the column is NOT NULL.'
      ]
    },
    {
      type: 'warn',
      text: "When adding new FKs, default to `onDelete('NO ACTION')` and handle cascades in application code."
    },
    {
      type: 'pre',
      code: `// Safe FK pattern for new migrations:
t.uuid('some_id')
  .nullable()
  .references('id')
  .inTable('some_table')
  .onDelete('NO ACTION');   // never CASCADE or SET NULL unless you've verified no cycles`
    }
  ]
}
