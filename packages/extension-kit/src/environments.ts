/**
 * Environment refresh — copy one environment's database over another while the target keeps what
 * belongs to it (its endpoints, credentials, switches, test accounts). The core owns the registry
 * of what an environment keeps; an extension adds its own entries and declares the environments
 * and directions it refreshes (`ctx.environments`).
 */

/** Something the TARGET of a refresh keeps (put back after the source's copy lands). */
export interface EnvKeepEntryInput {
  /** Unique id (`<extension>:<name>`; the core's own are `core:<name>`). */
  id: string
  /** Short plain name shown on the plan ("External API endpoints and credentials"). */
  label: string
  /** Why the target keeps it — one sentence, shown on the plan. */
  reason: string
  /** The nivaro_* (or business) table. */
  table: string
  /**
   * - `table`: the target's whole table is put back (the source's rows are dropped).
   * - `columns`: rows come from the source; `columns` are put back on rows matched by `key`.
   * - `rows`: the target's rows matching `where` are put back (updated by `key`, inserted when the
   *   source has no such row).
   * - `delegate`: kept by a separate step (`handled_by`); listed on the plan only.
   */
  kind: 'table' | 'columns' | 'rows' | 'delegate'
  /** Natural key for `columns` / `rows` (e.g. `['name']`). */
  key?: string[]
  /** `columns`: the columns the target keeps. */
  columns?: string[]
  /** `rows`: SQL predicate over the target's rows — fixed text, never request input. */
  where?: string
  /** Columns whose values the plan masks (credentials). */
  secret_columns?: string[]
  /** Kept only when the target is the database that holds the runbook queue (its own ops state). */
  only_when?: 'runbook-queue-db'
  /** `delegate`: the step that keeps it (shown on the plan). */
  handled_by?: string
  /** `delegate`: further tables the same step keeps. */
  tables?: string[]
  /** `delegate`: argv the host runner runs from the api directory to save (before the copy) and
   *  put back (after it); `{target}` = the target database. First element npx, tsx, node or bash;
   *  a failure only warns. */
  commands?: { save?: string[]; restore?: string[] }
}

/** One environment a refresh can copy from or to. */
export interface EnvRefreshEnvironment {
  /** Slug: `production`, `staging`, `development`. */
  key: string
  label: string
  /** Its database (same SQL Server as the others). */
  database: string
  /** Production is never a target — refused by the core and by the runner. */
  production?: boolean
  /** NIVARO_INSTANCE of the app on this database — external API overrides and mocks are keyed by it. */
  instance_key?: string
  /** This database holds the runbook queue (and quality results): a refresh keeps them. */
  runbook_queue?: boolean
  /** Host folder holding this environment's uploads (read-only fallback for its targets). */
  uploads_dir?: string
  /** Base URL of this environment's app (readiness after a refresh). */
  app_url?: string
}

/** What an extension refreshes and with which host runbooks. */
export interface EnvRefreshDecl {
  /** Key of this extension's host runbook that runs a refresh (target = the direction key). */
  runbook: string
  /** Key of this extension's host runbook that puts the pre-refresh backup back. */
  rollback_runbook?: string
  environments: EnvRefreshEnvironment[]
  /** Allowed directions by environment key (`{ from: 'production', to: 'staging' }`). */
  directions: Array<{ from: string; to: string }>
  /** Folder ON THE DATABASE SERVER for the COPY_ONLY backups (`F:\SQLBackups`). */
  backup_dir?: string
  /** Hours the target's pre-refresh backup is kept for "Roll back" (default 24). */
  rollback_hours?: number
}
