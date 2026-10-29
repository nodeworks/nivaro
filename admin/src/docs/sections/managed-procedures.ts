import type { DocSection } from '../types.js'

export const managedProceduresDocs: DocSection = {
  id: 'managed-procedures',
  label: 'App-managed procedures',
  content: [
    { type: 'h1', id: 'managed-procedures', text: 'App-managed procedures' },
    {
      type: 'p',
      text: 'The stored procedures Nivaro deploys have exactly one writer each, and that writer is the app. A procedure that belongs to an import definition is written by that definition (its stored procedure body). Every other procedure is written through config: its full text and every earlier version live in two configuration tables, and the Procedures page (Developer → Procedures, admins only, SQL Server only) saves there before it changes the database. Because the text is configuration, it travels with the rest of config when environments are promoted, instead of living in a folder of files that has to be deployed separately.'
    },
    { type: 'h2', id: 'managed-procedures-kinds', text: 'Two kinds, one writer' },
    {
      type: 'table',
      head: ['Kind', 'Where the text lives', 'Written by'],
      rows: [
        [
          'Import-owned',
          'The import definition’s stored procedure body (`nivaro_import_definitions.procedure_body`).',
          'The import definition (its editor and Deploy). The Procedures page shows it read-only with a link to the definition.'
        ],
        [
          'Managed',
          '`nivaro_managed_procedures` (current body, version number, owner, description, dropped mark) and `nivaro_managed_procedure_versions` (every saved body with its note, author and time).',
          'The Procedures page, SQL checks fixes and database tuning, all through one save-and-deploy path. A save stores the version first, deploys it second, and puts config back when the database refuses it.'
        ],
        [
          'Not managed',
          'Only in the database.',
          'Nobody yet. A procedure becomes managed the first time you adopt, edit or drop it on the Procedures page. Procedures you never touch stay as they are.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'If an import definition and a managed row both name the same procedure, the import wins and the managed row is flagged as a conflict. Two import definitions naming one procedure are also a conflict: nothing is deployed for that name until one of them lets go.'
    },
    { type: 'h2', id: 'managed-procedures-page', text: 'What you can do on the Procedures page' },
    {
      type: 'table',
      head: ['Action', 'What it does'],
      rows: [
        [
          'New procedure',
          'Saves the text as version 1 in config, then deploys it. A name that already exists (live or in config, dropped ones included) is refused and offers to open the existing one.'
        ],
        [
          'Edit and Deploy',
          'Saves the text as the next version with an optional note, then deploys it. An unchanged body saves nothing; changing only the owner or description updates them in place without a new version. Editing an unmanaged procedure adopts it first, and the page says so before it does.'
        ],
        [
          'Adopt',
          'Stores the procedure as it is in the database as a version, without deploying anything. From then on the procedure is managed.'
        ],
        [
          'Keep the database’s version',
          'For a managed procedure whose database text has drifted from config: stores the live text as the next version and marks it deployed. Use it when someone fixed the procedure directly in the database and that change is the right one.'
        ],
        [
          'Deploy version',
          'Deploys config as it stands. This is the fix for “drifted”, “not deployed” and “drop pending”.'
        ],
        [
          'History and Restore',
          'Lists every version with its note, author and time, shows a diff against the current one, and Restore saves an older body as the next version and deploys it. A dropped procedure comes back the same way.'
        ],
        [
          'Drop',
          'Marks the procedure dropped in config (the row and its versions are kept) and drops it in the database. The drop travels to other environments like any other change.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Two guards stop you overwriting someone else’s work. A save carries the version you started from, so when someone saved a newer one the page says so and keeps your edit for you to compare (409 `PROC_STALE`). It also carries a fingerprint of the live definition, so when the database was changed behind config’s back you choose between keeping the database’s version and overwriting it with yours (409 `PROC_DRIFTED`).'
    },
    {
      type: 'h2',
      id: 'managed-procedures-deploy',
      text: 'How the database is brought in line'
    },
    {
      type: 'p',
      text: 'A deploy never trusts its own bookkeeping. It compares config’s body with the live definition (header folded, whitespace collapsed, letter case kept) and only runs CREATE OR ALTER when they differ. The deployed hash, time and author on the row are written after a deploy as a record of what this database got, and are corrected when the live text already matches. A dropped row drops the live procedure if it exists and leaves it alone if it does not.'
    },
    {
      type: 'ul',
      items: [
        'Changes made on the Procedures page deploy at once on that instance.',
        'Other environments get the text with the rest of config: promote copies both tables, and the target keeps its own deployed hash, time and author, because those describe that database. A nightly promote to staging therefore brings procedure changes and drops along with it.',
        'The deploy step on the target (the app-managed deploy script, `pnpm --filter @nivaro/api run proc:deploy-app-managed`) deploys every managed row and every import body by comparing with the live definition, drops included. It is a dry run until `--execute`, `--only a,b` limits it, and it reports deployed, already current, skipped and failed procedures.',
        'The readiness check `managed-proc-drift` warns when a managed or import-owned procedure differs from its config, is not deployed, or is in conflict. It skips on a database with no managed rows.',
        'Rolling out to staging needs the release that carries migration 507 first, then the nightly promote.'
      ]
    },
    { type: 'h2', id: 'managed-procedures-writers', text: 'Other writers respect the owner' },
    {
      type: 'ul',
      items: [
        'SQL checks: a fix on a managed procedure is built from the config body and saved as a version, then deployed (see Applying a fix under SQL checks). Reverting it saves the previous body as the next version. A dropped or conflicting procedure is refused.',
        'Database tuning: a procedure rewrite on a managed procedure saves a version and deploys through config. An import-owned procedure is refused (change it in the import definition), and so is a managed one whose config no longer matches the database. Observers no longer propose rewrites they cannot apply.',
        'Import definitions: saving, restoring or deploying a definition whose body defines a procedure that is app-managed is refused (409 `MANAGED_PROCEDURE`). Give the import its own procedure, or drop the managed one first.',
        'Collection Designer: when it would generate an import procedure whose name is already owned, it skips the procedure step and says so.',
        'Scripts: the deploy, adoption, export and sync scripts of a deployment’s extension ask the same owner answer and skip, or reroute to config, any name they do not own. `proc:adopt --from files` reads a folder of procedure files once and stores each one that matches the live database as version 1 (dry run by default; dev only). `proc:dump` now exports FROM config for review and diffs; it never deploys, and writes files only with `--execute`.'
      ]
    },
    { type: 'h2', id: 'managed-procedures-chips', text: 'Status chips' },
    {
      type: 'table',
      head: ['Chip', 'Meaning', 'What to do'],
      rows: [
        ['(none)', 'Managed, and the database matches config.', 'Nothing.'],
        [
          'drifted',
          'The database differs from the saved version.',
          'Deploy version, or Keep the database’s version.'
        ],
        ['not deployed', 'Config has the procedure and the database does not.', 'Deploy version.'],
        [
          'drop pending',
          'Config marks it dropped, but it still exists in the database.',
          'Drop it here now (deploy), or Restore a version.'
        ],
        [
          'dropped',
          'Dropped in config and gone from the database.',
          'Nothing, or Restore a version to bring it back.'
        ],
        [
          'conflict',
          'An import definition (or two) also owns this name.',
          'Give the import its own procedure, or drop the managed row.'
        ],
        ['import', 'Owned by an import definition.', 'Edit it in the import definition.'],
        ['not managed', 'Only in the database; nobody owns it yet.', 'Adopt it, or leave it alone.']
      ]
    },
    {
      type: 'note',
      text: 'Where a nightly promotion replaces procedure config (staging), set `PROCEDURE_EDIT_WARNING` (for example "Procedures here are replaced every night from development. Make lasting changes on development.") to show a banner at the top of the Procedures page. Unset = no banner.'
    },
    { type: 'h2', id: 'managed-procedures-api', text: 'API' },
    {
      type: 'p',
      text: 'All routes are under `/api/procedures`, admin only. Errors come back as `{ error, code }`.'
    },
    {
      type: 'table',
      head: ['Method and path', 'Body / query', 'Answer and errors'],
      rows: [
        [
          'GET /',
          '—',
          'Live procedures plus config-only managed rows (`live: false`), each with `managed`: `{ kind: "import", key }`, `{ kind: "managed", status, version, owner }` or null. Also `warning`: the `PROCEDURE_EDIT_WARNING` text or null.'
        ],
        [
          'GET /:name',
          '—',
          'The live definition, `live_hash`, parameters, `managed` and `config` (body, body_hash, version, deployed_*, dropped_at, owner, description). 404 only when neither the database nor config has it.'
        ],
        [
          'PUT /:name',
          '`definition`, `note?`, `create?`, `owner?`, `description?`, `base_hash?`, `base_version?`, `base_live_hash?`',
          '`{ ok, created, version, unchanged, deployed }`. 400 `DEPLOY_FAILED` (config put back); 409 `APP_MANAGED`, `PROC_EXISTS`, `PROC_STALE`, `PROC_DRIFTED`, `PROC_UNREADABLE`; 500 `DEPLOY_STAMP_FAILED` (deployed, config kept).'
        ],
        [
          'POST /:name/adopt',
          '`note?`, `keep_live?` (or `?keep_live=1`)',
          '`{ data: { version, unchanged } }`. 409 `APP_MANAGED`, `PROC_ALREADY_MANAGED` (without keep_live), `PROC_UNREADABLE`; 404 `PROC_NOT_FOUND`.'
        ],
        [
          'DELETE /:name',
          '`base_version?` (body or query)',
          '204. Adopts an unmanaged procedure first, marks it dropped, drops it. 400 `DROP_FAILED` (with `config_dropped`); 409 `APP_MANAGED`, `PROC_STALE`.'
        ],
        [
          'GET /:name/versions',
          '—',
          '`{ data: [{ version, body_hash, note, created_at, created_by }] }`, newest first.'
        ],
        [
          'GET /:name/versions/:version',
          '—',
          'One version with its `body`. 404 `PROC_VERSION_NOT_FOUND`.'
        ],
        [
          'POST /:name/versions/:version/restore',
          '`note?`, `base_hash?`, `base_version?`, `base_live_hash?`',
          '`{ data: { version, unchanged, deployed } }`. Saves that body as the next version, then deploys it; revives a dropped procedure.'
        ],
        [
          'POST /:name/deploy',
          '—',
          '`{ data: DeployResult }`. Deploys config as it stands. 404 `PROC_NOT_FOUND` with no config row.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'The AI review, AI fix, AI generate and execute routes under the same prefix are unchanged.'
    },
    {
      type: 'warn',
      text: 'Do not change a managed procedure directly in the database or from a deploy script. The next deploy puts config’s version back, and until then the page shows it as drifted. Make the change on the Procedures page, or choose Keep the database’s version to accept it.'
    },
    {
      type: 'note',
      text: 'Migration 507 adds the two tables (empty) to every database. Both are configuration: they are included in config snapshots and promote, while the per-database deployed hash, time and author are not restored from one.'
    }
  ]
}
