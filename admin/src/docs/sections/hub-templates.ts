import type { DocSection } from '../types.js'

/** Hub enhancement 24: app templates installed by Create app. */
export const hubTemplatesDocs: DocSection = {
  id: 'hub-templates',
  label: 'App templates',
  content: [
    { type: 'h1', id: 'hub-templates', text: 'App templates' },
    {
      type: 'p',
      text: 'A template is an App Blueprint kept on the Hub. Pick one on Create app and the Hub installs it into every new environment once its first administrator exists. The new app starts with the template’s collections, fields, relations, workflows, layouts, queues and rules (payload templates as unpublished drafts) and never with data.'
    },
    { type: 'h2', id: 'hub-templates-library', text: 'The template library' },
    {
      type: 'p',
      text: 'Apps → Templates (Hub administrators only). Export a blueprint in any app (Promotion → Blueprints → Export or Publish), then press Upload template here, pick the .json file and give it a name, a version (like `1.2.0`) and a description. Name and version are read from a published package when you leave them empty. A template is at most 8 MB.'
    },
    {
      type: 'ul',
      items: [
        'The uploaded blueprint never changes: a new version is a new upload, and the same name and version twice is refused (`TEMPLATE_EXISTS`).',
        'Name and description can be edited. Archive hides a template from Create app and keeps its history; Restore brings it back.',
        'Delete works only while no environment that still exists has used the template (`TEMPLATE_IN_USE`); archive it otherwise.',
        'Download gives the stored package back, to install it by hand from Promotion → Blueprints in any app.'
      ]
    },
    { type: 'h2', id: 'hub-templates-rules', text: 'What a template may carry' },
    {
      type: 'p',
      text: 'A template goes into a new app without anyone there reviewing it, so upload keeps only what is safe to install that way, and the app checks again before it installs. The template’s detail shows what was removed.'
    },
    {
      type: 'ul',
      items: [
        'Only known columns of each part are kept. A collection’s virtual SQL (`is_virtual`, `virtual_sql`) is removed, so it installs as an ordinary table. Audit switches are removed too (`accountability`, `read_logging`, the activity and trash retention days), as are a field’s `remote_options_config` and `cross_record_defaults`. Ids that only mean something on the source instance are dropped.',
        'Every part must stay inside the template’s own collections. A relation, workflow binding, layout, queue or rule that names another collection is left out, and so is anything naming a `nivaro_` or `directus_` table (any spelling). A relation may point at `nivaro_files`.',
        'Size limits: at most 100 collections, 3,000 fields, 500 relations, 50 workflows, 300 layouts, 100 queues, 300 rules and 100 payload templates (`TOO_MANY_PARTS`). A file that is not shaped like a blueprint is refused (`BAD_SHAPE`).',
        'Transition actions and rules come along. Create app says how many there are, because they run on the app once it is installed.'
      ]
    },
    { type: 'h2', id: 'hub-templates-create', text: 'Picking a template on Create app' },
    {
      type: 'p',
      text: 'Create app has an App template field under "Where and which version" (default: No template). The preview lists what the template brings and what upload removed. It refuses an archived or deleted template (`TEMPLATE_UNKNOWN`), an app version before 0.3.215 (`TEMPLATE_APP_TOO_OLD`), and an app placed on a shared deployment (`TEMPLATE_NOT_FOR_SHARED`). A template exported from a newer Nivaro than the app’s version is a warning: settings the older version does not know are skipped.'
    },
    {
      type: 'p',
      text: 'The creation’s last step, `template`, runs after `admin` in every environment; with no template it is done at once. It starts the install on the app, which runs in the background, and reads its progress every 10 seconds for up to an hour. Each workflow, layout and queue goes in whole or not at all. When some parts fail, the step ends `TEMPLATE_PARTIAL` with the app’s report, and Retry installs only what is still missing. If the app restarts during the install, the step starts it again.'
    },
    { type: 'h2', id: 'hub-templates-app', text: 'On the app' },
    {
      type: 'ul',
      items: [
        '`POST /api/hub-link/template` starts the install and answers `202 {install_id}`. Only the Hub can call it (bearer = the app’s `HUB_TOKEN`; never in cloud mode or on a shared deployment).',
        'Like the first administrator, it is frozen while maintenance is on and refused once the app has moved away (`APP_MOVED`).',
        'One install runs at a time on the app, across its replicas (a Redis lock). Starting the same template again while it runs joins that run; another template answers `409 TEMPLATE_INSTALLING`.',
        '`GET /api/hub-link/template/:id` reads the run: `running`, `done`, `partial`, `failed` or `interrupted`, with the report. The report names parts and short codes; the database’s own error text stays in the app’s log.',
        'The app must be fresh, checked under the lock. Any business collection the template does not bring, or a table of the template that exists without being registered (an adopted database), refuses with `409 APP_NOT_EMPTY` and names them.',
        'The install runs as the app’s oldest active administrator and is logged as `hub-template-install`.'
      ]
    },
    { type: 'h2', id: 'hub-templates-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'What it does'],
      rows: [
        [
          '`GET /api/hub/templates[?archived=1]`',
          'The library (manifest, counts and what upload removed, never the bundle). Administrators.'
        ],
        ['`GET /api/hub/templates/:id`', 'One template.'],
        ['`GET /api/hub/templates/:id/bundle`', 'The stored package as a download.'],
        [
          '`POST /api/hub/templates`',
          '`{bundle, name?, description?, version?}` → 201. Logged `hub-template-upload`.'
        ],
        [
          '`PATCH /api/hub/templates/:id`',
          '`{name?, description?, archived?}`. Logged `hub-template-update`.'
        ],
        [
          '`DELETE /api/hub/templates/:id`',
          '204, or 409 `TEMPLATE_IN_USE`. Logged `hub-template-delete`.'
        ],
        [
          '`POST /api/hub/apps/create` `template_id`',
          'The template a creation installs (optional).'
        ],
        [
          '`POST /api/hub-link/template` (app)',
          '`{bundle, digest, template}` → 202 `{install_id}` · 400 `BAD_BUNDLE`/`BAD_DIGEST`/`BAD_SHAPE`/`TOO_MANY_PARTS` · 409 `APP_NOT_EMPTY`/`TEMPLATE_INSTALLING`.'
        ],
        [
          '`GET /api/hub-link/template/:id` (app)',
          'The run: status, report, parts. 404 `UNKNOWN_INSTALL`.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Tables `nivaro_hub_app_templates` and `nivaro_hub_template_installs` (migration 571) belong to the Hub. An environment refresh keeps the target’s copy, and a config promotion never copies them. The app keeps its install state in its own Redis (`nvr:hub-template:*`, bound to the app’s hub token).'
    }
  ]
}

/** Hub enhancement 25: the Hub's MCP tools. */
export const hubMcpDocs: DocSection = {
  id: 'hub-mcp',
  label: 'Hub tools for assistants (MCP)',
  content: [
    { type: 'h1', id: 'hub-mcp', text: 'Hub tools for assistants (MCP)' },
    {
      type: 'p',
      text: 'On a Nivaro Hub (`HUB=on`), the hosted `/api/mcp` and the `nivaro-mcp` stdio server can offer Hub tools: an assistant reads the apps and plans a change, and a person always starts the change. A connection gets the tools only when it was given the Hub:'
    },
    {
      type: 'ul',
      items: [
        'an OAuth connection (ChatGPT, Claude, Codex …) with the `hub:read` scope, which the consent page offers on a Hub ("Also let it read the Hub and make plans");',
        'an API key with a `$hub` scope entry (`{collection: "$hub", actions: ["read"]}`). A key for every collection (`*`) does not get it;',
        'never a connection or key narrowed to named collections. The Hub routes refuse those too.'
      ]
    },
    {
      type: 'table',
      head: ['Tool', 'What it answers', 'Who'],
      rows: [
        ['`hub_list_apps`', 'The apps you may see: id, key, name.', 'Owners and administrators'],
        [
          '`hub_read_app`',
          'One app’s environments in promotion order and its owners.',
          'Owners and administrators'
        ],
        [
          '`hub_app_status`',
          'Each environment’s state, version, preflight and readiness (`fresh` asks now).',
          'Owners and administrators'
        ],
        [
          '`hub_fleet_status`',
          'Every app you may see with each environment’s last state; not-ok ones listed first.',
          'Owners and administrators'
        ],
        [
          '`hub_deploy_history`',
          'An environment’s Hub promotions and rollbacks (or its GitLab deploys).',
          'Owners and administrators'
        ],
        [
          '`hub_plan_promote`',
          'The versions on offer, or the plan of a promotion or rollback, with the link to start it.',
          'Owners and administrators'
        ],
        ['`hub_list_shared`', 'The shared deployments.', 'Administrators'],
        [
          '`hub_plan_move`',
          'The plan of a move between a dedicated stack and a shared deployment, with the link.',
          'Administrators'
        ],
        [
          '`hub_plan_upgrade`',
          'The plan of a shared deployment upgrade or rollback, with the link.',
          'Administrators'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Every tool calls the Hub’s own REST routes as you: an administrator sees every app, an app owner only their own (another app answers not found).',
        'The three administrator tools are listed only for an administrator whose connection is not narrowed by a scope.',
        'The plan tools call only the `…/plan` routes. Those start nothing and take no lock (reading an upgrade plan may mark a run whose server died as interrupted, as the page does). A plan reaches the assistant without its plan hash, confirmation text or image digests. Each answer carries the link to the page where a person checks the plan and starts it. Promote, move, upgrade and cancel stay a person’s action in the Hub.',
        'Like every tool, they can be limited further by a connection’s tool allowlist or a kit (MCP connections). The scope editor lists them only on a Hub.'
      ]
    }
  ]
}
