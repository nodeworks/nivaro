import type { DocSection } from '../types.js'

export const sqlChecksDocs: DocSection = {
  id: 'sql-checks',
  label: 'SQL Checks',
  content: [
    { type: 'h1', id: 'sql-checks', text: 'SQL Checks' },
    {
      type: 'p',
      text: 'SQL checks, the SQL checks tab of the Database page (/database/sql-checks, Operations → Database), checks the SQL that runs against the database for mistakes that corrupt or slow data. It reads every procedure, function, view and trigger definition from the database itself (sys.sql_modules), plus the SQL bodies Nivaro keeps in its own tables: import definitions’ stored procedure bodies and custom queries. Findings are tracked across runs, so a finding has a history: when it first appeared, how many runs saw it, and when it went away. Checks only read; nothing is changed by a run. Two kinds of procedure fix can be applied from a finding by a person (see Applying a fix). Admins only; SQL Server only.'
    },
    { type: 'h2', id: 'sql-checks-checks', text: 'What it checks' },
    {
      type: 'table',
      head: ['Check', 'Severity', 'What it finds'],
      rows: [
        [
          'MERGE on a nullable key',
          'Critical when the key holds NULLs now, else warning',
          'A MERGE whose ON clause compares a nullable target column with = and no NULL-safe form (ISNULL / COALESCE, an IS NULL pair, IS NOT DISTINCT FROM, INTERSECT). NULL never equals NULL, so those rows are inserted again on every run. With live counts on, the finding shows how many rows hold NULL keys and how many extra rows already sit in NULL-key groups.'
        ],
        [
          'MERGE source may repeat a key',
          'Warning',
          'A MERGE source with no ROW_NUMBER / GROUP BY / DISTINCT and no unique index on the joined columns. A repeated key stops the whole MERGE.'
        ],
        [
          'Write without WHERE',
          'Critical',
          'An UPDATE or DELETE with no top-level WHERE and no JOIN predicate. Temp tables, table variables and MERGE actions are ignored.'
        ],
        [
          'Transaction without XACT_ABORT',
          'Warning',
          'BEGIN TRAN in a module with no SET XACT_ABORT ON and no CATCH that rolls back on @@TRANCOUNT: a failed statement can leave the transaction open on a pooled connection.'
        ],
        [
          'Local-time clock',
          'Info',
          'GETDATE() / SYSDATETIME() calls (one finding per object, with the count and lines).'
        ],
        [
          'NOT IN over a nullable column',
          'Warning',
          'NOT IN (SELECT col …) where col is nullable and the subquery does not filter NULLs.'
        ],
        [
          'SELECT * on a wide table',
          'Info',
          'SELECT * from a table with max-length text or binary columns.'
        ],
        [
          'Import body differs from deployed',
          'Warning (info when not deployed)',
          'An import definition whose stored procedure body differs from the deployed procedure of the same name (comments, whitespace and the CREATE / ALTER verb are ignored), or names a procedure the database does not have.'
        ],
        [
          'SQLFluff rule',
          'Info',
          'Correctness rules from SQLFluff (ambiguous references RF01/RF02, AM01–AM07, unused CTEs ST03, subqueries in joins ST05) when a SQLFluff sidecar is configured. Layout and style rules are dropped.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'The checks are pattern checks over T-SQL with comments and string literals blanked out, not a full parser: each prefers missing a case to raising a wrong one. A finding that is intended (a procedure that clears a work table on purpose) is marked as expected with a note; it stays out of the open count until someone reopens it.'
    },
    { type: 'h2', id: 'sql-checks-page', text: 'The page' },
    {
      type: 'ul',
      items: [
        'Header: open critical / warning / info counts, the last run (when, how long, whether SQLFluff ran), Run now (two clicks) and Settings.',
        'Findings: filter by status, severity and check, or search. The detail shows the statement with line numbers, why it matters, the live figures, the suggested fix with a Copy button, the history (opened, resolved, reopened, marked as expected) and a link to the editor: /procedures for a procedure, the custom query editor, or the import definition in the Imports console (/imports?definition=<key>).',
        'Trends: open findings per run by severity, new and resolved per run, open findings by check and the objects with the most.',
        'Fixes: cleanups and guard indexes logged by fix scripts, and “Procedure changed” rows Nivaro logs itself when a run finds that findings went away because their procedure or query was edited.',
        'Runs: every run with its duration, counts, SQLFluff status and errors.',
        'The Database page’s Overview tab shows a strip linking here while critical findings are open.'
      ]
    },
    { type: 'h2', id: 'sql-checks-settings', text: 'Settings and schedule' },
    {
      type: 'p',
      text: 'Settings live on the tab (nivaro_settings.sql_checks): run nightly (off by default), count NULL keys and copies (reads the tables a MERGE writes; tables over the row cap, 5,000,000 by default, are skipped), the per-table count timeout (120 s), and whether to check import definitions and custom queries. The nightly run is the `sql-checks` job at 03:30 (Jobs can move it); it only ticks on deployed instances. SQL_CHECKS=on or off in the server environment forces the nightly run on or off whatever the setting says, for databases rebuilt nightly from another one (the setting would be wiped); the page then shows the switch as set by the server’s configuration. Run now always works.'
    },
    { type: 'h2', id: 'sql-checks-sqlfluff', text: 'SQLFluff sidecar' },
    {
      type: 'p',
      text: 'SQL_LINT_URL points at a small service running SQLFluff with the T-SQL dialect; SQL_LINT_TOKEN is its bearer token (a secret: SQL_LINT_TOKEN_FILE works, and the environment viewer masks it). Each module’s text is sent on its own, never any data: POST {SQL_LINT_URL}/lint with {sql, dialect: "tsql"} answers {violations: [{code, line, description}], parse_errors}. A busy sidecar (503) is retried with a short backoff; a refused token (401), a sidecar that stays busy or does not answer marks the run’s SQLFluff as unavailable and keeps the other checks; a per-module timeout (504) skips that module only. SQLFluff findings resolve only in runs where SQLFluff answered.'
    },
    { type: 'h2', id: 'sql-checks-apply', text: 'Applying a fix' },
    {
      type: 'p',
      text: 'Two mechanical findings can be fixed from their detail panel with Propose fix: a transaction without SET XACT_ABORT ON (the statement is added first in the procedure body, after AS / AS BEGIN and after a leading SET NOCOUNT ON), and a MERGE on a nullable key whose ON clause is a plain AND of column-to-column equalities (each pair on a nullable target column becomes (s.k = t.k OR (s.k IS NULL AND t.k IS NULL))). Anything else (functions, OR, literals, ranges in the ON clause, other checks, views and functions) says “This one needs a person” and keeps the written steps.'
    },
    {
      type: 'ul',
      items: [
        'The preview changes nothing: it shows the diff with old and new line numbers. The compile check is a separate POST (it holds a schema lock on the procedure for up to 5 seconds) that compiles the new definition inside a transaction that is rolled back.',
        'Adding XACT_ABORT is marked risky when the procedure commits in a CATCH block or reads XACT_STATE() or @@ERROR to carry on after an error: with XACT_ABORT ON those paths behave differently (error 3930). A NULL-safe ON carries a note that the OR form can turn an index seek into a scan on a large table.',
        'A NULL-safe ON is marked risky when copies already sit in NULL-key groups (one incoming row then updates all of them) or when the MERGE source may repeat a key (SQL Server would stop the whole MERGE). A risky fix needs an extra confirmation.',
        'Apply (two clicks) sends the preview’s hash; if the definition changed since the preview it is refused (409) and the preview is rebuilt.',
        'A procedure is changed with CREATE OR ALTER through the same path as the Procedures page, on one connection that holds an exclusive application lock on that procedure (so two servers cannot change it at once) and re-reads it first: if it changed since the preview, nothing is deployed. The deployed text always names the procedure itself (a renamed procedure, or a header without a schema, is rewritten to [schema].[name]). It is then checked again at once; if the re-check reports anything new, or the finding is still there, the previous definition is put back automatically (only while the procedure is still exactly what the fix deployed) and the panel says why.',
        'An import definition whose stored body was identical to the procedure gets the new body too (with a version snapshot). A finding on a stored body that differs from the deployed procedure only changes the stored body; deploy it from the import definition.',
        'Every apply, automatic put-back and revert is a “Procedure changed” row on the Fixes tab with the diff; Revert (two clicks) restores the previous definition, and is refused when the procedure changed again after the fix. When an automatic put-back itself failed, the row offers Restore previous version. Import definition bodies that were synced are put back only if nobody edited them since, with their deployed hash and time.'
      ]
    },
    {
      type: 'warn',
      text: 'If your deployment keeps a procedure’s source elsewhere (a repository or deploy script), update it there too — otherwise the next deploy puts the old version back.'
    },
    { type: 'h2', id: 'sql-checks-fixes', text: 'Logging a fix from a script' },
    {
      type: 'p',
      text: 'A script that repairs data (removes copies, adds a guard index) logs what it did so the page can show it next to the findings: insert into nivaro_sql_check_fixes directly, or POST /api/sql-checks/fixes as an administrator (an admin’s API key works).'
    },
    {
      type: 'pre',
      code: '{\n  "action": "cleanup",\n  "check_key": "merge-null-key",\n  "target_table": "workflows_files",\n  "rows_affected": 273657,\n  "backup_table": "zz_backup_workflows_files_20261019",\n  "detail": { "kept": "newest row per key" },\n  "run_by": "fix-null-key-copies"\n}'
    },
    { type: 'p', text: 'action is cleanup, proc_fix, guard_index or other.' },
    { type: 'h2', id: 'sql-checks-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'What it does'],
      rows: [
        [
          'GET /api/sql-checks/summary',
          'Open counts by severity and check, the last run, the trend over the last 30 runs, top objects, settings and whether a run is going.'
        ],
        [
          'POST /api/sql-checks/run',
          'Starts a run in the background (202 with run_id); 409 while one is running.'
        ],
        ['GET /api/sql-checks/runs · /runs/:id', 'Run history (paged) and one run with its stats.'],
        [
          'GET /api/sql-checks/findings',
          'Findings; filters status (open, accepted, resolved, all), severity, check, object, q; page and limit.'
        ],
        [
          'GET /api/sql-checks/findings/:id',
          'One finding with its statement, figures, suggested fix and event history.'
        ],
        [
          'PATCH /api/sql-checks/findings/:id',
          '{status: "accepted", note} marks it as expected (a note is required); {status: "open"} reopens one marked as expected.'
        ],
        [
          'GET /api/sql-checks/findings/:id/proposal',
          'The proposed fix: {proposable, class, risky, reasons, notes, diff, unified, new_definition_hash}. Changes nothing and compiles nothing.'
        ],
        [
          'POST /api/sql-checks/findings/:id/proposal/compile',
          '{new_definition_hash} compiles the previewed text in a rolled-back transaction: {ok, error?}.'
        ],
        [
          'POST /api/sql-checks/findings/:id/apply',
          '{new_definition_hash, confirm_risky?} applies the previewed fix; 409 when the definition changed since the preview, 422 when it does not compile. Answers {fix_id, applied, rolled_back, reason?, deployed}.'
        ],
        [
          'POST /api/sql-checks/fixes/:id/revert',
          'Restores the definition a fix from the page replaced (also after a failed automatic put-back); 409 when the procedure changed after the fix. Answers {reverted, skipped_import_bodies}.'
        ],
        ['GET · POST /api/sql-checks/fixes', 'The fix log (paged); log a fix from a script.'],
        [
          'GET · PATCH /api/sql-checks/settings',
          'Read and change the settings (strict: unknown keys and bad values are refused with every problem named).'
        ]
      ]
    }
  ]
}
