import type { DocSection } from '../types'

/** Nivaro Hub data care: backups, restore drills, environment refreshes and move rehearsals. */
export const hubDataDocs: DocSection = {
  id: 'hub-data',
  label: 'Backups, refreshes and rehearsals',
  content: [
    { type: 'h1', id: 'hub-data', text: 'Backups, refreshes and rehearsals' },
    {
      type: 'p',
      text: 'Apps → Backups & data (`/hub/data`) looks after each environment’s data: database backups on a schedule with retention, files backups to a folder or an S3 bucket, restore drills that prove a backup restores, refreshes of a lower environment from a higher one, and rehearsals of a move onto a shared deployment. Everything here is for Hub administrators and every start is logged (`hub-data-<kind>` on `nivaro_hub_data_runs`).'
    },
    {
      type: 'warn',
      text: 'Refreshes, restore drills and move rehearsals restore databases on live servers. They are OFF until an administrator turns each on under Backups & data → Switches (two presses) — enable them only after a real restore drill on a staging server. Backups need no switch. Backups the Hub writes are not encrypted: the backup folder must be one only database administrators can read.'
    },
    {
      type: 'note',
      text: 'The Hub never holds an app’s records. A database copy is always made by the database server itself (SQL Server BACKUP and RESTORE, through the server’s stored login), files are copied by the app itself (over its hub link or deployment link), and the Hub records only where things went, sizes, times and row counts. The one exception is a refresh’s keep set (below), held sealed with ENCRYPTION_KEY until its rollback window ends.'
    },
    { type: 'h2', id: 'hub-data-backups', text: 'Database backups' },
    {
      type: 'ul',
      items: [
        'Automatic (SQL Server, a server record with a stored login that may back up): the Hub asks the server for a `COPY_ONLY`, checksummed full backup (compressed when the edition allows) into the policy’s folder, or the server’s default backup folder. A UNC share keeps copies off the database server. `COPY_ONLY` never breaks the DBA’s own full/differential/log chain.',
        'Each backup is verified (`RESTORE VERIFYONLY … WITH CHECKSUM`, switchable) and recorded with its file, size and finish time.',
        'Retention: keep the newest N backups, or N days, or both (default 7 backups). The newest is never deleted. Older Hub backup files are deleted with `xp_delete_file`, which needs sysadmin; when the login may not, the run says so and a DBA removes them. Only the Hub’s own files are ever deleted.',
        'Manual servers and other engines: Postgres, MySQL and MariaDB have no server-side BACKUP statement, and a manual server is the DBA’s. The page shows a checklist for the DBA and the last backup seen: SQL Server’s msdb backup history (the DBA’s jobs included), Postgres WAL archiving (`pg_stat_archiver`), and backups a person records with Record backup.'
      ]
    },
    { type: 'h2', id: 'hub-data-files', text: 'Files backups' },
    {
      type: 'ul',
      items: [
        'The app copies every stored file it has (env-local uploads and its saved-settings S3 / Azure objects) into a backup set named `nivaro-<app>-<env>-<run>`, with a `manifest.json`.',
        'Folder target: a folder on the APP’s host, which the app must allow in its own `HUB_FILES_BACKUP_DIRS` (comma list of absolute folders): the Hub can never make an app write outside a folder its operator allowed (`403 DIR_NOT_ALLOWED`). On a shared deployment the folder is on the deployment’s host.',
        'S3 target: bucket, prefix, region and an optional https endpoint (S3-compatible stores). The app uploads only to a bucket its own operator lists in `HUB_FILES_BACKUP_S3` (comma list: `s3://<bucket>[/<prefix>]` for AWS, `https://<endpoint>/<bucket>[/<prefix>]` for an S3-compatible store; a target matches the same endpoint and bucket with a prefix at or under the entry’s). Unset = every S3 backup refused (`403 S3_NOT_ALLOWED`), checked before anything is sent. Every request goes through the SSRF guard: the host is resolved and checked, the connection pinned to that address, private / loopback / link-local addresses refused unless `SSRF_ALLOW_HOSTS` also lists them, and redirects refused. The key pair is stored sealed on the policy, shown only as `••••••`, and sent to the app in the request body only.',
        'Files are streamed, two at a time (a local file from disk, a saved-settings object through its driver’s stream; an S3 target receives 8 MiB multipart parts), so a backup never holds a whole file in the memory of the app it protects. A source that cannot stream is read whole only up to 64 MB, else counted `too large`.',
        'Retention keeps the newest N sets (default 3): the app deletes an older set from its manifest. A set with failed files never costs an older complete one: retention then waits.',
        'Needs the app on 0.3.215 or later (`/api/hub-link/data/*`, `/api/hub-deployment/apps/:id/data/*`).'
      ]
    },
    { type: 'h2', id: 'hub-data-drill', text: 'Restore drills' },
    {
      type: 'p',
      text: 'A drill restores the newest backup (the Hub’s own newest kept file, else the newest full backup msdb lists on a disk path) into `nivaro_hub_scratch_<hub>_d<run>` on the same server (`<hub>` = 8 hex of a hash of this Hub’s ENCRYPTION_KEY, so two Hubs on one server never take each other’s copy; the name is recorded before the restore, so a crashed drill’s copy is found and dropped), timed: the measured time-to-restore. It then runs the app’s database checks on the copy (it opens, every key table that exists live exists and is not empty where live is not, the migration ledger is there, optionally DBCC CHECKDB) and drops the copy, always. A drill never uses REPLACE and never touches the live database; a database already under the scratch name that this run did not mark is left alone and the drill fails. Backups on a backup agent’s virtual device, tape or URL are not restorable by path and the drill says so. The app’s process checks (preflight, readiness) on a copy are the rehearsal’s job.'
    },
    { type: 'h2', id: 'hub-data-refresh', text: 'Refreshing an environment' },
    {
      type: 'p',
      text: 'Refresh copies a higher environment’s database over a lower one of the same app (production → staging, staging → development), keeping the target’s own settings. Off until the Refreshes switch is on, and only into an environment an administrator opted in as a **refresh target** (on the environment’s Refresh card, typed `<app>/<env>`; never possible for one that counts as production). Plan first: the plan lists what is kept (the target app’s own refresh registry — core entries and its extensions’, the same entries the EFP host runbook keeps — with row counts), what is overwritten, and every check. Start it by typing the target database’s name.'
    },
    {
      type: 'table',
      head: ['Refused', 'Why'],
      rows: [
        [
          '`production_target`',
          'The target counts as production: its key names prod / production / prd / live / main / master as a word (`prod-eu`, `prd1`, `eu_live` …), or it is the app’s last environment. Always refused, flag or not.'
        ],
        [
          '`app_says_production`, `target_unverified`',
          'The target app reports NIVARO_ENVIRONMENT=production, or did not answer what it is (refresh-keeps on its link).'
        ],
        ['`not_opted_in`', 'The target is not opted in as a refresh target.'],
        ['`feature_off`', 'Refreshes are switched off on this Hub.'],
        ['`not_lower`', 'The target is not lower than the source in promotion order.'],
        ['`other_app`, `same_database`', 'Another app’s environment, or both use one database.'],
        [
          '`version_mismatch`, `version_unknown`',
          'Both apps must say they run the same Nivaro version (the copy must already match the target’s migrations). Promote the target first.'
        ],
        [
          '`transfer_path`',
          'The databases are on different servers and no shared folder both can read was named.'
        ],
        [
          '`move_open`, `data_busy`',
          'A move, or another backup / drill / refresh / rehearsal, is open on either environment.'
        ],
        [
          '`ENV_BUSY`',
          'A promotion, stack action or move holds the target’s or the source’s environment lock (a refresh holds both as `data`, so neither is promoted while it runs; the source’s version is checked again before its copy).'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'The plan pins the target database: its Hub record, server, name, and the server’s own `database_id` + `create_date`. Start, Resume and Roll back refuse (`TARGET_CHANGED`) when any differs (a record detached and another attached meanwhile).',
        'Steps: strict maintenance on the target (must hold — every replica, administrators included; its prior state is recorded) → rollback point (a `COPY_ONLY` backup of the target) → save what the target keeps (sealed into the run) → `COPY_ONLY` backup of the source → stage `restoring` recorded → `ALTER DATABASE … SET OFFLINE WITH ROLLBACK IMMEDIATE` and RESTORE … WITH REPLACE (never SINGLE_USER: nobody, the app’s pool included, can take a slot) → the restored identity pinned → the target’s login owns the copy again (the source’s login has no user in it) → put back what the target keeps → safety pass (test modes on, external APIs new from the source switched off) → delete the source copy → maintenance back to its prior state → check the target answers. Restart the target app afterwards: it keeps its in-memory caches and sessions.',
        'A failure before the restore writes nothing and puts the maintenance back. From the restore on, the run stays `failed` with the target in maintenance: Resume it (everything a start checks is checked again) or Roll back.',
        'An extension keep entry with its own row filter (`where`) is left out and named on the plan: its SQL would run with the server’s login. A target app that does not answer what it keeps is refused.',
        'Rollback: for 24 hours, the newest refresh of the environment can be rolled back (typed confirm = the pinned database name) — from a finished, failed or interrupted run. It closes the refresh. After the window the rollback point file is deleted and the sealed keep set dropped.',
        'A refresh or rollback whose Hub process stopped reads `interrupted`: Resume continues from its first step not done. An interrupted run (or a failed refresh) can be abandoned with a typed confirm; the rollback point stays until its window ends.'
      ]
    },
    { type: 'h2', id: 'hub-data-rehearsal', text: 'Rehearsing a move' },
    {
      type: 'p',
      text: 'A rehearsal tries a move onto a shared deployment without touching the live app (never put in maintenance, never retired, its name never moved): it plans the real move (its blockers and warnings are reported), copies the database into `nivaro_hub_scratch_<hub>_r<run>` on the same server, lists a temporary app `rh-<run>` on the deployment (in maintenance — every request but /api/version and app-info answers 503 — on a `.rehearsal.invalid` name nothing routes to, on the copy, with the app’s key when the Hub knows it), lets the deployment migrate it as it would migrate the moved app, reads that app’s preflight and readiness score there, copies the files into it with the move’s own file copy (timed), then removes the temporary app’s files, takes it off the list and drops the copy — also when a step failed. Rehearsals onto a dedicated stack are not offered: a temporary dedicated stack is a deploy, not a rehearsal.'
    },
    { type: 'h2', id: 'hub-data-schedule', text: 'Schedules and heal' },
    {
      type: 'ul',
      items: [
        'Schedules are 5-field cron expressions in UTC, at least an hour apart. The Hub job `hub-data-tick` (every 5 minutes, one leader) starts what is due; a start the Hub must refuse (no login, not SQL Server, no files target) is recorded as a refused run, so it waits for the next time.',
        'One data run per environment at a time (Redis lock `nvr:hub:data:<env>`). A run whose heartbeat stopped for 3 minutes is healed by the tick: a refresh or rollback becomes `interrupted`; a backup, drill or rehearsal becomes `failed`; its scratch copy (found by the name its run id gives it), a rehearsal’s backup file and its temporary app’s files are removed and the temporary app taken off the list. A run that lost its lock (its process stalled past the lock’s life) stops before its next step.'
      ]
    },
    { type: 'h2', id: 'hub-data-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'What'],
      rows: [
        [
          '`GET` · `PUT /api/hub/data/switches`',
          '`{refresh_enabled, drill_enabled, rehearsal_enabled}` (all off by default).'
        ],
        [
          '`PUT /api/hub/environments/:id/data/refresh-target`',
          '`{on, confirm: "<app>/<env>"}` opt an environment in or out as a refresh target (refused for production).'
        ],
        [
          '`POST /api/hub/data/runs/:id/abandon`',
          '`{confirm}` abandon an interrupted run or a failed refresh.'
        ],
        [
          '`GET /api/hub/data/environments`',
          'Every environment with its newest backup, drill and policy switches.'
        ],
        [
          '`GET /api/hub/environments/:id/data`',
          'Policy (secrets masked), last backup seen, DBA checklist, what the Hub can do here, newest runs.'
        ],
        ['`PUT /api/hub/environments/:id/data/policy`', 'Save the policy.'],
        [
          '`POST /api/hub/environments/:id/data/backup` · `/files-backup` · `/drill`',
          'Start now (202 `{run_id}`).'
        ],
        [
          '`POST /api/hub/environments/:id/data/backup-seen`',
          '`{at?, note?}` a backup taken outside the Hub.'
        ],
        [
          '`POST /api/hub/environments/:id/data/refresh/plan` · `/refresh`',
          '`{source_env_id, transfer_path?}`; start adds `plan_hash`, `confirm`, `accept_core_keeps?` (409 PLAN_CHANGED / PLAN_BLOCKED / CORE_KEEPS_ONLY, 400 CONFIRM_MISMATCH).'
        ],
        ['`POST /api/hub/environments/:id/data/rehearsal`', '`{shared_id}`.'],
        ['`GET /api/hub/environments/:id/data/runs`, `GET /api/hub/data/runs/:id`', 'History.'],
        [
          '`POST /api/hub/data/runs/:id/resume` · `/rollback`',
          'Resume an interrupted refresh; roll a refresh back (`{confirm}`).'
        ]
      ]
    }
  ]
}
