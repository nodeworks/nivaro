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
      text: 'Apps → Templates (Hub administrators only). Export a blueprint in any app (Promotion → Blueprints → Export or Publish), then press Upload template here, pick the .json file and give it a name, a version (like `1.2.0`) and a description. Name and version are read from a published package when you leave them empty. A template is at most 16 MB.'
    },
    {
      type: 'ul',
      items: [
        'The uploaded blueprint never changes: a new version is a new upload, and the same name and version twice is refused (`TEMPLATE_EXISTS`).',
        'Name and description can be edited. Archive hides a template from Create app and keeps its history; Restore brings it back.',
        'Delete works only while no creation has used the template (`TEMPLATE_IN_USE`); archive it otherwise.',
        'Download gives the stored package back, to install it by hand from Promotion → Blueprints in any app.'
      ]
    },
    { type: 'h2', id: 'hub-templates-create', text: 'Picking a template on Create app' },
    {
      type: 'p',
      text: 'Create app has a Template field under "Where and which version" (default: No template). The preview shows what the template brings. It refuses an archived or deleted template (`TEMPLATE_UNKNOWN`) and an app version before 0.3.215 (`TEMPLATE_APP_TOO_OLD`), the first version whose Hub link takes a template. A template exported from a newer Nivaro than the app’s version is a warning: settings the older version does not know are skipped.'
    },
    {
      type: 'p',
      text: 'The creation’s last step, `template`, runs after `admin` in every environment. With no template it is done at once. It sends the blueprint over the Hub link with its sha256 and keeps the app’s install report on the creation. A call that is cut off is asked again (6 tries, 20 seconds apart); Retry resends the same template and the app skips what it already made.'
    },
    { type: 'h2', id: 'hub-templates-app', text: 'On the app' },
    {
      type: 'p',
      text: '`POST /api/hub-link/template` takes the template. Only the Hub can call it (bearer = the app’s `HUB_TOKEN`; never in cloud mode or on a shared deployment). The install runs as the app’s oldest active administrator and is logged as `hub-template-install`. It is refused with `409 APP_NOT_EMPTY` (naming the collections) when the app has any business collection the template does not bring, so it only ever fills a new app. `400 BAD_DIGEST` means the bundle changed on the way.'
    },
    { type: 'h2', id: 'hub-templates-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'What it does'],
      rows: [
        [
          '`GET /api/hub/templates[?archived=1]`',
          'The library (manifest and counts, never the bundle). Administrators.'
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
          '`{bundle, digest, template}` → 200 `{installed, report}` · 400 `BAD_BUNDLE`/`BAD_DIGEST` · 409 `APP_NOT_EMPTY`.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Tables `nivaro_hub_app_templates` and `nivaro_hub_template_installs` (migration 571) belong to the Hub: an environment refresh keeps the target’s and a config promotion never copies them.'
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
      text: 'On a Nivaro Hub (`HUB=on`) the MCP server (hosted `/api/mcp` and the `nivaro-mcp` stdio server) has Hub tools. An assistant can read the apps and plan a change, and a person always starts the change. The tools are not listed at all on an app or in cloud mode.'
    },
    {
      type: 'table',
      head: ['Tool', 'What it answers', 'Who'],
      rows: [
        ['`hub_list_apps`', 'The apps you may see: id, key, name.', 'Everyone (scoped)'],
        [
          '`hub_read_app`',
          'One app’s environments in promotion order and its owners.',
          'Everyone (scoped)'
        ],
        [
          '`hub_app_status`',
          'Each environment’s state, version, preflight and readiness (`fresh` asks now).',
          'Everyone (scoped)'
        ],
        [
          '`hub_fleet_status`',
          'Every app you may see with each environment’s last state; not-ok ones listed first.',
          'Everyone (scoped)'
        ],
        [
          '`hub_deploy_history`',
          'An environment’s Hub promotions and rollbacks (or its GitLab deploys).',
          'Everyone (scoped)'
        ],
        [
          '`hub_plan_promote`',
          'The versions on offer, or the plan of a promotion or rollback, with the link to start it.',
          'App owners and administrators'
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
        'Every tool calls the Hub’s own REST routes as you, so it sees exactly what the Hub pages show you. An administrator sees every app. An app owner sees only their own apps, and another app answers not found.',
        'The three administrator tools are listed only for an administrator who is not on a collection-limited key.',
        'The plan tools call only the `…/plan` routes, which take no lock and change nothing. Each answer carries the link to the app’s page (or the shared deployment’s) and says it was planned only. Promote, move, upgrade, cancel and every other run stay a person’s action in the Hub.',
        'Like every tool, they can be given to a connection by its tool allowlist or a kit (MCP connections). The scope editor lists them only on a Hub.'
      ]
    }
  ]
}
