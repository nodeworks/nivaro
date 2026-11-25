import type { DocSection } from '../types'

/** Nivaro Hub config promotion (idea 30): move configuration between an app's environments. */
export const hubConfigDocs: DocSection = {
  id: 'hub-config',
  label: 'Config promotion',
  content: [
    { type: 'h1', id: 'hub-config', text: 'Config promotion' },
    {
      type: 'p',
      text: 'Apps → Config (`/hub/config`) moves an app’s configuration from one of its environments to another — typically development → staging → production — over each app’s hub link (a dedicated app) or its shared deployment’s link. The TARGET app works out the plan from its own rows and writes it with the config restore engine (field diff, plan-hash binding, one locked transaction). For Hub administrators; every plan, apply, check, undo and refusal is logged on `nivaro_hub_config_promotions`. The Environments → Config download, diff, stored restore points, restore and Changed here work exactly as before: the promotion has its own export filter.'
    },
    { type: 'h2', id: 'hub-config-what', text: 'What can move' },
    {
      type: 'table',
      head: ['Group', 'Matched by', 'Notes'],
      rows: [
        [
          'Flows',
          'flow name; steps by flow + step key',
          'Step addresses, headers, auth and every nested secret never travel; a matched step keeps this environment’s own. A webhook trigger’s inbound auth (auth type, secret, timestamp rule) is always the target’s. A flow new on the target arrives switched off (a new webhook flow with bearer auth and a fresh secret); a flow that gains a step needing this environment’s address lands switched off too, named on the plan and in the notice. Flow version history stays per environment.'
        ],
        [
          'Payload templates',
          'key',
          'The external API is matched by name. Body secrets are placeholders; their values live in the external API, which never travels. History stays per environment.'
        ],
        [
          'Managed procedures',
          'name',
          'Saved and deployed through the managed-procedure writer on the target (a new version there, its own deploy record). Import-owned names are refused.'
        ],
        [
          'Roles and policies',
          'role name; policies by role + collection + action',
          'People and their role assignments never travel.'
        ],
        [
          'Settings (no secrets)',
          'the one settings row',
          'Only product settings that are the same everywhere and name nothing by id. Mail, keys, storage, sign-in, switches and role choices stay as the target has them.'
        ]
      ]
    },
    {
      type: 'warn',
      text: 'Rows are matched by name or key, NEVER by id: environments the Hub created have their own databases, so the same id is routinely a different thing. A row the target has under the same name is updated in place; a row it does not have is inserted with a new id. Every reference (a flow step’s external API, flow or person, a template’s external API, a policy’s role) is rewritten to the target’s id of the same thing. The plan refuses — nothing is written — with `ROW_UNMATCHED` (no name, or two rows sharing one) or `REF_UNMAPPED` (a reference the target has nothing of that name for, or a literal id in step options), naming each row.'
    },
    {
      type: 'note',
      text: 'Not offered yet: forms / layouts and pipelines (their rows reference roles, steps, people, widgets and templates by id inside JSON, and mapping all of those by name is not built), version-history tables, the schema registry, people and User Scopes. Both environments need Nivaro 0.3.215 or later and a SQL Server database.'
    },
    {
      type: 'warn',
      text: 'Config promotion ships OFF. It has not yet been tried on a real pair of SQL Server environments, so — like data refreshes and drills — it stays off until an administrator turns it on at the top of the Config tab (`PUT /api/hub/config/switch {config_promotion}`; stored in `nivaro_extension_settings` `nivaro-core` / `hub_config_promotion`). While it is off a new plan and an apply answer 409 `CONFIG_PROMOTION_OFF`; “Check the target” and the undo of a promotion that already ran still work. Turn it on only after a try on a staging pair.'
    },
    { type: 'h2', id: 'hub-config-flow', text: 'Plan, apply, check, undo' },
    {
      type: 'ul',
      items: [
        'Plan: pick From, To and the groups (optionally “Also remove rows the source no longer has”). The plan shows each row’s field diff (now → after; never a step’s outbound part, inbound auth or a secret), what the target keeps, held rows, flows that will arrive switched off, and the changes made on the target that were not promoted (Environments → Changed here). A newer plan for the same target replaces the older one.',
        'Apply: bound to the plan hash and refused after 24 hours. Typed environment key on production. Under the environment lock (holder `config`, renewed every minute) the Hub checks again: an open move (`MOVE_OPEN`), freezes and deploy windows (action `config_promote`; an administrator’s “Start outside the window” skips the windows only), the production pre-deploy checklist (one per promotion). The source is read again; if either side changed, nothing is written (`STALE`).',
        'The target records the run (`nivaro_hub_config_applied`, status `applying`, with a heartbeat) in its own short write BEFORE any work, then writes the rows in one transaction together with a commit marker (`nivaro_hub_config_writes`: the rows it wrote, their values before and hashes after), then deploys managed procedures one by one (`deploying`, each recorded) and ends `applied` or `failed`. The apply is idempotent by the promotion’s run key: a resend replays a finished run, resumes the procedures a stalled one left, or re-runs one that wrote nothing.',
        'A lost answer: the promotion shows `interrupted` — never “nothing written” — and the Hub keeps the environment lock, asking the target every few seconds (up to 15 minutes) until it says `applied` or `failed`. `not_applied` (no record at all) only counts as an answer two minutes after the apply was sent. “Check the target” asks the same and finishes a stalled run’s procedures; while the target still works it says so (`STILL_RUNNING`). After the target was refreshed (no record of an applied promotion) the promotion says “unknown on the target”, never failed, and can no longer be undone.',
        'Flows: a step a promoted flow has on the target but not on the source is removed with the flow, whatever the removal setting — the plan lists these steps, and an undo puts them back. A new flow with exactly the steps of a target flow the source did not send is flagged as a likely rename before any removal. Step option paths the source took off (addresses, headers, secrets) are listed under “What stays as it is”. People in step options (recipients, exclude, assignee, run as …) are matched by email, refusing `REF_UNMAPPED` when the target has no such person, two of them, or one who is suspended, redacted or a machine account; any other uuid or bare id in options or permission rules refuses the plan unless a remap rule handled it.',
        'Undo: only the newest promotion that wrote to an environment. It puts back exactly the rows that promotion wrote, from their values before; rows created since are never touched, and any written row that changed since refuses the undo (`STALE`). Freezes and deploy windows never stop it (reverting bad config during an incident is wanted); an open move does. An administrator on their own session, always with the typed environment key.',
        'Changed here: right after the commit, the rows a promotion (or its undo) wrote — and only those — replace their entries in the target’s promotion baseline, stored as a record of its own kind, never listed with or restorable as a restore point. Rows changed on the target that the promotion did not write stay “changed here”. If the baseline cannot be moved the promotion still stands and its outcome says “baseline not moved” with the reason.',
        'App owners and administrators are told when a promotion lands (with procedures that failed and flows switched off), is refused, or loses its answer.'
      ]
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
          '`{plan_hash, confirm?, overwrite_prod_changes?, checklist_run_id?, outside_window_reason?}`'
        ],
        [
          '`POST /api/hub/config-promotions/:id/check`',
          'Ask the target what it recorded (a lost answer)'
        ],
        ['`POST /api/hub/config-promotions/:id/undo/plan`', 'The undo preview and its hash'],
        [
          '`POST /api/hub/config-promotions/:id/undo`',
          '`{plan_hash, confirm, overwrite_prod_changes?}` — administrator, own session'
        ]
      ]
    },
    {
      type: 'p',
      text: 'App side (bearer only, checked on every request): `POST /api/hub-link/config/{snapshot,plan,apply,status,undo}` on a dedicated app (HUB_TOKEN), `POST /api/hub-deployment/config/apps/:id/{snapshot,plan,apply,status,undo}` on a Hub shared deployment (active apps only).'
    }
  ]
}
