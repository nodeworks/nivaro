import type { DocSection } from '../types.js'

export const dbTuning: DocSection = {
  id: 'db-tuning',
  label: 'Database Tuning',
  content: [
    { type: 'h1', id: 'db-tuning', text: 'Database Tuning' },
    {
      type: 'p',
      text: 'The Database tuning page at /db-tuning (Operations → Health) is a propose-only tuning loop over the platform’s own workload. Each night it reads what the database and the API already record, turns what it finds into candidate changes, proves every candidate before listing it, and ranks the proposals by the time each would save per day. Nothing changes until an administrator clicks Apply. An applied change is watched (7 days by default) and rolled back on its own when it regresses. Admins only; index and procedure changes need SQL Server.'
    },
    {
      type: 'p',
      text: 'The page lists proposals in tabs: Proposed, Watching, Applied, Rolled back (failed ones too), Rejected by proof, Dismissed and Stale. Each proposal shows its evidence, its proof and the method that produced it, the exact change and its undo. DB & Runtime Health shows a strip linking here while proposals are waiting.'
    },
    { type: 'h2', id: 'db-tuning-kinds', text: 'What it proposes' },
    {
      type: 'table',
      head: ['Kind', 'Found from', 'The change'],
      rows: [
        [
          'Index (create)',
          'SQL Server’s missing-index DMVs, the index advisor (foreign keys, queue filters, row filters, state mirrors) and the missing-index groups in slow-run plans captured for saved queries. One or two key columns; a candidate whose keys equal or lead an existing index’s keys is declined.',
          'CREATE NONCLUSTERED INDEX; the undo drops it.'
        ],
        [
          'Index (drop)',
          'Index usage since the server started: a plain nonclustered index with no reads and more than 100 writes, or whose keys are a strict prefix of a live index’s. Nothing before 30 days of uptime.',
          'DROP INDEX; the undo recreates the exact definition recorded at proposal time.'
        ],
        [
          'Procedure rewrite',
          'Procedures averaging 2 s or more and run at least 20 times a week, with a body the twin proof can run and recorded parameter sets. Rewritten by mechanical transformers first (a filter-only junction join becomes EXISTS; a correlated "last success" MAX becomes a grouped temp table), else by one AI call.',
          'CREATE OR ALTER PROCEDURE with the new body; the undo restores the old body.'
        ],
        [
          'Store a rollup',
          'Virtual rollup fields read at least 200 times a day (list reads in the request log over 7 days), against the writes to their source collections.',
          'Turns on `computed_store` the way the Table Editor’s Store toggle does (column, flag, backfill); the undo turns it off and keeps the column.'
        ],
        [
          'Cache a query',
          'Saved queries that run uncached, take 1 s or more and run at least 10 times a day.',
          'Sets `cache_ttl`, and `warm_daily` when its slowest run is more than twice its average; the undo restores both.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'A query cache TTL comes from measured write gaps: the activity log’s create, update and delete rows on each source table over the last 7 days. A source is nightly-fed when gaps of 6 h or more cover 80% of the week and 80% of the last day, and one gap lasts 20 h or more; it gets 6 h. Otherwise the TTL is half the median gap, between 1 minute and 24 hours.',
        'A source with no activity rows (a table nothing writes through the API) cannot be measured: the proposal says `gap_assumed` and its TTL is capped at 5 minutes. A query whose sources cannot be resolved is never proposed.',
        'Recursive (tree) rollups and rollups on `nivaro_*` collections are never proposed for storing: a stored total recalculates on a direct child’s write only, so descendant writes would leave a tree total stale.',
        'A drop is never proposed for a unique, primary-key or foreign-key-backing index, anything that is not nonclustered, an index named anywhere in a module definition (an index hint fails with error 308 once the index is gone), or an index this ledger created in the last 60 days.',
        'The temp-table guard transformer is never applied to a stored-procedure body: a guard inside a callee would drop the caller’s same-named #temp table.'
      ]
    },
    { type: 'h2', id: 'db-tuning-proofs', text: 'How each proposal is proven' },
    {
      type: 'p',
      text: 'Every candidate is proven by the method its kind allows before it is listed. A passed proof lists it as Proposed; a failed one lists it under Rejected by proof with the proof kept, so the reason is visible. Proofs never change a real object; the twin and hypothetical index are temporary.'
    },
    {
      type: 'table',
      head: ['Kind', 'Proof', 'Rolls back when'],
      rows: [
        [
          'Index (create)',
          'Hypothetical index: the top statements that touch the leading column are planned without and with it (estimated plans only; the index is built STATISTICS_ONLY inside a transaction that is rolled back). Passes when one statement is at least 20% cheaper and none is more than 1% dearer. When that path is unavailable, `dmv-estimate`: SQL Server’s improvement measure is at least 10, or, for a candidate SQL Server never asked for, the column has observed read traffic (live reads that filter or sort by it, or a captured slow plan that wanted it). A candidate from configuration alone fails with "no observed traffic".',
          '20 of the trailing 24 hourly samples (average elapsed time of the statements that touch the column) are over the regression threshold'
        ],
        [
          'Index (drop)',
          'Usage stats, read live when the proof runs: zero reads over at least 30 days of uptime, or a strict prefix of an index that still exists.',
          'The same statements regress, by the same rule'
        ],
        [
          'Procedure rewrite',
          'Twin: the rewrite is deployed as `<proc>__tune_<8 hex>`, a name of its own per proof, and both bodies run with every recorded parameter set in A B B A order (old, new, new, old). Rows must be identical (canonicalised, compared as a multiset), the new median at most 75% of the old, and no set slower (every new run of a set slower than every old run of it). When the old body’s two runs disagree, the procedure is nondeterministic and the proof refuses. `proc_timeout_minutes` bounds the whole proof.',
          '20 of the trailing 24 samples of the procedure’s average elapsed time are over the threshold, or the nightly re-diff finds different rows'
        ],
        [
          'Store a rollup',
          'Cost model: reading costs at least 3× the upkeep (reads a day × a list page’s recompute, against child writes a day × one recalc, timed on a 20-row sample).',
          'Any of 20 sampled rows drifts from the live formula, at once'
        ],
        [
          'Cache a query',
          'Freshness: its source tables resolve and it saves at least 5 s a day.',
          '20 of the trailing 24 samples of its average execution time are over the threshold'
        ]
      ]
    },
    {
      type: 'p',
      text: 'The regression threshold is the baseline × (1 + regression_pct / 100). The baseline is read just before the change runs; fewer than 20 measured samples never count as a regression, so one bad hour never rolls a change back.'
    },
    { type: 'h3', id: 'db-tuning-twin', text: 'What the twin proof refuses' },
    {
      type: 'ul',
      items: [
        'A body, the current one or the rewrite, that writes a real table (INSERT, UPDATE, DELETE, MERGE, TRUNCATE, BULK INSERT or SELECT INTO anything but a #temp table or table variable), runs DDL on anything but a #temp table, or runs GRANT, DENY, REVOKE, DBCC, BACKUP, RESTORE, KILL, SHUTDOWN or RECONFIGURE.',
        'Dynamic SQL (`sp_executesql`, `EXEC(@sql)`, `EXEC @proc`), a call to itself, a linked server (four-part names, OPENQUERY, OPENROWSET, OPENDATASOURCE), an EXEC into another database, or a call to an `sp_` / `xp_` system procedure.',
        'Each procedure either body EXECs is read from sys.sql_modules and judged by the same rules, one level deep: a callee that calls further is refused, not followed. A real procedure already holding the twin’s name is refused too.',
        'Every EXEC in a proof runs inside `BEGIN TRAN … ROLLBACK`, a backstop for a write the rules missed. The twin is dropped when the proof ends. A process killed mid-proof leaves it behind for the boot sweep, which drops twins (`…__tune` and `…__tune_<hex>`) older than max(30, proof timeout + 5) minutes; a younger one may belong to a proof running on another process. The readiness check fails on a twin older than a day.',
        'A proof that could not run (a catalog read threw, or it ran out of its time budget) judged nothing: a standing proposal stays Proposed. A refusal on policy rejects it.'
      ]
    },
    {
      type: 'note',
      text: 'The hypothetical-index path uses `DBCC AUTOPILOT`, which is undocumented and may need sysadmin. Where the database login cannot run it, `dmv-estimate` is the expected path, and the proposal says which method it used.'
    },
    { type: 'h2', id: 'db-tuning-apply', text: 'Apply, watch and roll back' },
    {
      type: 'ul',
      items: [
        'Apply is two clicks and sends only the proposal id; the change itself comes from the proposal row. Only a Proposed row applies. A Stale or Rejected-by-proof row needs Re-prove first, and a procedure rewrite needs a passed twin proof whatever its status says. Re-prove reads the live object first: one that changed since the proposal keeps the row Stale (409 `TUNING_STALE`) and is not proved; the nightly run proposes against what is live.',
        'Before anything runs, Apply re-reads the live object: an index that now exists or whose definition changed, a procedure body edited since the proof, a query whose cache settings changed. Any of these moves the row to Stale. An index drop is refused (409 `TUNING_NOT_APPLICABLE`) when the live index is unique or backs a primary key, a unique constraint or a foreign key.',
        'Every index statement is parsed into a fixed shape, its names re-checked against sys.*, and run as the canonical rendering, never as stored. A created index may not be UNIQUE, filtered or on a named filegroup, and may set only ONLINE, SORT_IN_TEMPDB, DATA_COMPRESSION, FILLFACTOR and MAXDOP. An index drop’s undo may restore the full recorded definition.',
        'The watch baseline is read before the change runs: CREATE INDEX recompiles the table’s plans and CREATE OR ALTER resets the procedure’s stats, so a figure read afterwards is mostly empty. If the change fails part-way, whatever landed is undone at once and the row ends Failed with the reason.',
        'The hourly watch samples every watched change against its baseline. A regression rolls the change back and tells whoever applied it in their Notifications inbox. A change past its watch window becomes Applied.',
        'A rewritten procedure is re-diffed every night at 07:55 UTC: the old body is deployed as the twin and run against the live rewrite on one recorded parameter set, a different one each night. Different rows roll the rewrite back. When the live procedure’s own two runs disagree (the data moved between them), the re-check is nondeterministic: it is listed in the watch run, never rolled back.',
        'Roll back by hand from Watching or Applied. The undo is refused, and the row left Failed for a person, when the live object changed since the apply (a procedure edited since, an index dropped or rebuilt).',
        'The watch also ends an apply or rollback that died with its process: a row stuck in applying for more than 30 minutes whose job run is no longer running is marked Failed, without running the undo, so a person reads the row and its undo first.',
        'Dismiss needs a note and works on Proposed, Stale, Rejected-by-proof and Failed rows. A dismissed or rolled-back change is not proposed again for 90 days. A change rejected by proof is not proved again for 7 days. An AI rewrite counts as one attempt per procedure body, whatever the model answers. A Proposed row whose evidence has not been seen for 14 days closes as dismissed.',
        'Apply, rollback, dismiss, re-prove and settings changes each write an activity row, which the incident timeline shows. Apply and rollback also appear in Background Jobs as runs of kind tuning.'
      ]
    },
    { type: 'h2', id: 'db-tuning-replication', text: 'Replicated tables and procedures' },
    {
      type: 'p',
      text: 'A change to a replication article (a table or procedure published by SQL Server replication) forwards to every subscriber. Proposals carry `replicated`, and Apply checks replication again, live, at apply time, because a publication may postdate the proof. A replicated target, or a rollup whose collection is one (storing it adds a column), is refused unless the request says the DBA agreed (`dba_ok`). The page then shows the statements that would forward and asks for "The DBA agreed — apply".'
    },
    { type: 'h2', id: 'db-tuning-settings', text: 'Settings' },
    {
      type: 'p',
      text: 'The Settings card is on the Database tuning page itself, not under Settings. Values are stored in `nivaro_settings.db_tuning`; a save that holds a bad value names every bad key. A save sends only the fields changed on the card and merges them onto the stored value, so an instance override (Settings → Instance) is never copied into the shared row. Database tuning is off by default.'
    },
    {
      type: 'table',
      head: ['Setting', 'Default', 'Range', 'What it does'],
      rows: [
        [
          'enabled',
          'off',
          '',
          'The master switch. While it is off the nightly observe and the hourly watch return at once and the readiness check passes.'
        ],
        [
          'ai_rewrites',
          'on',
          '',
          'Ask the AI for a procedure rewrite when no mechanical transformer applies (at most 5 a night). The answer must keep the procedure name and the exact parameter list. The calls are logged in AI calls under the feature `db-tune`.'
        ],
        [
          'min_estimate_ms_per_day',
          '5000',
          '0–86,400,000',
          'Candidates estimated to save less are not proved. Procedure rewrites are exempt: their estimate is a lower bound until the proof measures it.'
        ],
        ['watch_days', '7', '1–30', 'How long an applied change is watched.'],
        [
          'regression_pct',
          '25',
          '5–100',
          'How much worse than the baseline a sample must be to count against the change.'
        ],
        [
          'proc_timeout_minutes',
          '10',
          '1–30',
          'The time budget of one twin proof, every set and run together. A proof that runs out drops its twin and judges nothing: a standing proposal stays as it was.'
        ],
        [
          'ai_daily_budget_usd',
          '2',
          '0–1000',
          'AI rewrites are skipped while the last 24 hours of AI spend is over this.'
        ]
      ]
    },
    { type: 'h2', id: 'db-tuning-schedule', text: 'When it runs' },
    {
      type: 'ul',
      items: [
        '`db-tuning-observe`, nightly at 03:35 (a heavy job): every observer reads its evidence (at most 10 minutes each, 60 minutes for the run), candidates are deduplicated, ones dismissed or rolled back lately, rejected by proof in the last 7 days, or on a target with a change in flight are skipped, and the 20 biggest estimates are proved. The rest carry over to the next night.',
        '`db-tuning-watch`, hourly at :55.',
        'Both are always registered and return at once while database tuning is off. Scheduled ticks also need a process that ticks (`CRON_TICKS`); Run now in Background Jobs always works, and both have a dry run.',
        'Run the observer from the page: a real run starts in the background and the page follows it until it finishes. One observe run at a time per database: a run is refused (409 `TUNING_RUNNING` from the page) while another, on any process, has been running for less than 70 minutes. Dry run lists what it would prove and changes nothing.',
        'The readiness check `db-tuning` (Operations) fails on a leftover twin older than a day, and warns on an observe run older than 48 hours, a change still watching a day past its window, an apply or rollback that died, or a failed apply or rollback.'
      ]
    },
    { type: 'h2', id: 'db-tuning-param-sets', text: 'Recorded parameter sets' },
    {
      type: 'p',
      text: 'A procedure proof replays real calls. Every saved-query execute (`POST /custom-queries/:slug/execute`) and every procedure execute (`POST /procedures/:name/execute`) records the parameters the call actually bound in `nivaro_tuning_param_sets`, the newest 10 per target, with values under credential-looking names masked. A procedure also gets the sets of the saved queries that EXEC it, when every name in a set is one of the procedure’s own parameters (a saved query records its own names). A procedure with no recorded sets is not proposed.'
    },
    { type: 'h2', id: 'db-tuning-extensions', text: 'Observers from extensions' },
    {
      type: 'p',
      text: 'An extension adds candidates with `ctx.tuning.registerObserver({ id, kind, observe })` (`TuningObserverDef` in @nivaro/extension-kit). The id is `<extension>:<name>`, and `observe()` returns candidates of that one kind. They go through the same proof and ledger as the built-in observers: the kind and its risk are the registration’s, and nothing an extension returns can mark a candidate proven or apply it. A candidate whose apply or undo type does not match its kind (index kinds take `sql`, proc_rewrite `proc_body`, rollup_store `field_patch`, query_cache `query_patch`) is dropped, and its SQL is parsed and re-validated at Apply, never run as given. An observer that throws or runs out of time is logged and skipped.'
    },
    {
      type: 'pre',
      code: `import { defineExtension } from '@nivaro/extension-kit'

export default defineExtension({
  id: 'my-ext',
  async register(ctx) {
    ctx.tuning.registerObserver({
      id: 'my-ext:archive-lookups',
      kind: 'index_create',
      async observe() {
        return [
          {
            kind: 'index_create',
            target: 'archive_rows.batch_id',
            change_key: 'batch_id',
            title: 'Index archive_rows.batch_id — nightly lookups scan the table',
            evidence: { dmv_improvement: 42 },
            estimate_ms_per_day: 90_000,
            risk: 'reversible',
            apply: {
              type: 'sql',
              statements: ['CREATE NONCLUSTERED INDEX [ix_archive_rows_batch_id] ON [archive_rows] ([batch_id])']
            },
            undo: {
              type: 'sql',
              statements: ['DROP INDEX [ix_archive_rows_batch_id] ON [archive_rows]']
            }
          }
        ]
      }
    })
  }
})`
    },
    { type: 'h2', id: 'db-tuning-api', text: 'API' },
    {
      type: 'pre',
      code: `GET   /api/db-tuning                         // counts by status and kind, open estimate, last run, is_running, settings, extension observers
GET   /api/db-tuning/proposals?status=proposed,stale&kind=index_create
GET   /api/db-tuning/proposals/:id
POST  /api/db-tuning/proposals/:id/apply      { dba_ok?: true }
POST  /api/db-tuning/proposals/:id/rollback   { reason?: string }
POST  /api/db-tuning/proposals/:id/dismiss    { note: string }   // note required
POST  /api/db-tuning/proposals/:id/reprove
POST  /api/db-tuning/observe                  { dry_run?: true } // a real run answers 202 and runs in the background
GET   /api/db-tuning/settings
PATCH /api/db-tuning/settings                 { enabled?, ai_rewrites?, min_estimate_ms_per_day?, … }`
    },
    {
      type: 'p',
      text: 'Admins only. A refusal answers 409 (400 for a malformed change) with a code: `TUNING_STALE`, `TUNING_REPLICATED` (with the target and the statements), `TUNING_NOT_APPLICABLE`, `TUNING_INVALID`, `TUNING_DISABLED` or `TUNING_RUNNING`.'
    }
  ]
}
