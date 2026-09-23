/**
 * Dead columns — the registry (#505).
 *
 * A column a model change left behind is re-read by accident: someone greps
 * the table, sees `view_mode`, and builds on it. Every column the codebase
 * has stopped writing is listed here with the date it died, what replaced
 * it, and whether it can be dropped yet. The readiness check reports
 * entries still present on the database; `pnpm dead-columns:check` greps the
 * source trees for any entry and fails when code still names one that is
 * marked droppable — so a column is never dropped while something reads it,
 * and never lingers once nothing does.
 *
 * Business-table debris (legacy forecasts key/revision/current on production,
 * cifa_items.bom_category, workflows.workflow_task) is EFP's and lives with
 * the DBA cutover notes, not here.
 */
export interface DeadColumn {
  table: string
  column: string
  /** When the last writer stopped. */
  since: string
  replaced_by: string
  /**
   * drop — no code path names it; a migration may drop it (or already did).
   * retire — code still reads or writes it; remove those first.
   */
  status: 'drop' | 'retire'
  /** Migration that drops it, once one exists. */
  dropped_by?: string
  /** What still touches it while status is 'retire'. */
  blocked_by?: string
}

export const DEAD_COLUMNS: DeadColumn[] = [
  {
    table: 'nivaro_queues',
    column: 'view_mode',
    since: '2026-07-06',
    replaced_by: 'display_config.views / default_view',
    status: 'drop',
    dropped_by: '336_drop_dead_columns'
  },
  {
    table: 'nivaro_queue_column_prefs',
    column: 'visible_columns',
    since: '2026-07-10',
    replaced_by:
      'display_config.default_columns + saved-view column snapshots (nivaro_queue_views.state.columns)',
    status: 'retire',
    blocked_by:
      'routes/queues.ts column-prefs GET/PUT still read and write it; the row itself survives for default_view_id'
  },
  {
    table: 'workflows',
    column: 'workflow_state',
    since: '2026-09-22',
    replaced_by: 'v_*_state views / $state (pipeline-instance state)',
    status: 'retire',
    blocked_by: 'the mirror writes it until retire-legacy-state-columns runs at cutover'
  },
  {
    table: 'inventory_request',
    column: 'request_state',
    since: '2026-09-22',
    replaced_by: 'v_*_state views / $state (pipeline-instance state)',
    status: 'retire',
    blocked_by: 'the mirror writes it until retire-legacy-state-columns runs at cutover'
  },
  {
    table: 'workflows',
    column: 'last_state_change',
    since: '2026-09-22',
    replaced_by: 'v_*_state views / $state (pipeline-instance state)',
    status: 'retire',
    blocked_by: 'the mirror writes it until retire-legacy-state-columns runs at cutover'
  },
  {
    table: 'inventory_request',
    column: 'last_state_change',
    since: '2026-09-22',
    replaced_by: 'v_*_state views / $state (pipeline-instance state)',
    status: 'retire',
    blocked_by: 'the mirror writes it until retire-legacy-state-columns runs at cutover'
  }
]
