import type { DocSection } from '../types'

/** Nivaro Hub config promotion (idea 30): move configuration between an app's environments. */
export const hubConfigDocs: DocSection = {
  id: 'hub-config',
  label: 'Config promotion',
  content: [
    { type: 'h1', id: 'hub-config', text: 'Config promotion' },
    {
      type: 'p',
      text: 'Apps → Config (`/hub/config`) moves an app’s configuration from one of its environments to another — typically development → staging → production — without anyone exporting and uploading files. It is the same engine as Environments → Config and its restore points, driven by the Hub over each app’s hub link (a dedicated app) or its shared deployment’s link. For Hub administrators; every plan, apply, undo and refusal is logged on `nivaro_hub_config_promotions`.'
    },
    { type: 'h2', id: 'hub-config-what', text: 'What can move' },
    {
      type: 'table',
      head: ['Group', 'Tables', 'Notes'],
      rows: [
        [
          'Forms and layouts',
          'collection layouts, field placement, layout templates, linked sections, field groups, field rules',
          ''
        ],
        [
          'Flows',
          'flows, flow steps',
          'Step addresses, headers, auth and secret options never travel; each environment keeps its own. A flow new on the target arrives switched off. Flow version history is not copied: the target keeps its own.'
        ],
        [
          'Payload templates',
          'templates, published versions, drafts',
          'Body secrets live in the external API, which never travels; a template names a secret only by its placeholder.'
        ],
        [
          'Managed procedures',
          'managed procedure definitions + versions',
          'Each changed procedure is then deployed into the target’s database through its one writer.'
        ],
        [
          'Pipelines',
          'workflow templates, steps, moves, bindings, owner dimensions, owner groups, members, teams',
          'Owner-group members come over only for people active on the target.'
        ],
        [
          'Roles and policies',
          'roles, policies',
          'People and their role assignments never travel.'
        ],
        [
          'Settings (no secrets)',
          'nivaro_settings',
          'Only the product settings that are the same everywhere; mail, SMS, push, Teams, AI keys, storage, sign-in, maintenance and job switches stay as the target has them.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Never carried: any credential (dropped by name and by list at export, again on arrival), every column the TARGET’s environment-refresh keep registry keeps (core and extension entries: endpoints, switches, sign-in, secrets), tables it keeps whole, people, User Scopes and the schema registry (collections, fields, relations describe database columns a config copy cannot create — they move with a release or a blueprint). A row new on the target in a table whose columns the target keeps arrives switched off when those columns are switches; otherwise it is held back and named on the plan.'
    },
    { type: 'h2', id: 'hub-config-flow', text: 'Plan, apply, undo' },
    {
      type: 'ul',
      items: [
        'Plan: pick From, To and the groups (optionally “Also remove rows the source no longer has”). The Hub reads a snapshot from the source app and the TARGET app works out the plan against its own rows: a field diff per row (now → after, values capped and secrets masked), what it keeps, held rows, and the changes made on it that were not promoted (Environments → Changed here) that the write would overwrite. A newer plan for the same target replaces the older one.',
        'Apply: bound to the plan hash and refused after 24 hours. On production (the Hub’s one production rule) type the environment key. Refused while a move of the target is open (`MOVE_OPEN`), in a freeze window (`FROZEN`), while anything else holds the environment (`CONFIG_PROMOTION_RUNNING` and the other lock holders), and — when the target refuses promotions over its own changes — until they are marked as intended there or you tick Overwrite. The Hub reads the source again; if either side changed since the plan, nothing is written (`STALE`) and you plan again.',
        'The target writes everything in one locked transaction and first stores a restore point of exactly the rows it locks. The promoted tables then join its “Changed here” baseline; other tables keep theirs.',
        'Undo: “See what undo would change” previews restoring that restore point (its own hash), then Undo puts the target back as it was just before the promotion. A freeze never stops an undo (it is a true rollback); a move still does. Production needs the typed key.',
        'Owners and admins of the app are told when a promotion lands, fails or needs a new plan.'
      ]
    },
    {
      type: 'warn',
      text: 'Rows are matched by id, as in Environments → Config: environments that were not set up from one another may give the same id to different things. The plan warns when a change would rename a row — check those rows before applying. Both environments need Nivaro 0.3.215 or later and a SQL Server database; on a shared deployment the app’s own database is used.'
    },
    { type: 'h2', id: 'hub-config-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'What'],
      rows: [
        ['`GET /api/hub/config/groups`', 'The groups and their tables'],
        ['`GET /api/hub/apps/:id/config-promotions`', 'The app’s newest 50 promotions'],
        [
          '`POST /api/hub/apps/:id/config-promotions/plan`',
          '`{source_env_id, target_env_id, groups[], deletes?, allow_cascade?}` → the promotion with its plan'
        ],
        ['`GET /api/hub/config-promotions/:id`', 'One promotion'],
        [
          '`POST /api/hub/config-promotions/:id/apply`',
          '`{plan_hash, confirm?, overwrite_prod_changes?}`'
        ],
        ['`POST /api/hub/config-promotions/:id/undo/plan`', 'The undo preview and its hash'],
        [
          '`POST /api/hub/config-promotions/:id/undo`',
          '`{plan_hash, confirm?, overwrite_prod_changes?}`'
        ]
      ]
    },
    {
      type: 'p',
      text: 'App side (bearer only, checked on every request): `POST /api/hub-link/config/{snapshot,plan,apply,undo}` on a dedicated app (HUB_TOKEN), `POST /api/hub-deployment/config/apps/:id/{snapshot,plan,apply,undo}` on a Hub shared deployment. An undo restores only a restore point a Hub promotion stored there.'
    }
  ]
}
