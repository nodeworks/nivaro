import type { Knex } from 'knex'

/**
 * Nivaro Hub third-party providers in the existing Hub flows (Task 11a). Every column is nullable
 * and added only when missing; no foreign keys (the Hub checks the rows itself). Created on every
 * install, used only in hub mode (HUB=on). Spec: docs/superpowers/specs/2026-11-26-hub-providers-design.md
 * ("How existing flows use it", decision 4: existing Hub rows link, never get replaced).
 *
 *  - nivaro_hub_db_servers.resource_id   the managed `aws.rds_instance` (nivaro_hub_resources.id)
 *                                        this database server is; the Hub reads its endpoint and
 *                                        refuses deleting the instance while another app's
 *                                        databases live on it.
 *  - nivaro_hub_targets.connection_id    a target of kind `github`: the GitHub provider connection
 *                                        (nivaro_hub_connections.id) new apps' repositories are
 *                                        created through.
 *  - nivaro_hub_components.resource_id   a component of kind `github_actions` / `vercel` /
 *                                        `eas_update`: the managed resource it deploys through (a
 *                                        `github.workflow`, a `vercel.project`, an `expo.channel`).
 */
const COLUMNS: Array<[table: string, column: string]> = [
  ['nivaro_hub_db_servers', 'resource_id'],
  ['nivaro_hub_targets', 'connection_id'],
  ['nivaro_hub_components', 'resource_id']
]

export async function up(knex: Knex): Promise<void> {
  for (const [table, column] of COLUMNS) {
    if (!(await knex.schema.hasTable(table))) continue
    if (await knex.schema.hasColumn(table, column)) continue
    await knex.schema.alterTable(table, (t) => {
      t.integer(column).nullable()
    })
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: the columns may hold live Hub links.
}
