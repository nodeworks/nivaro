import type { Knex } from 'knex'

/**
 * Hub shared features: directory lookups and the nightly directory sync per app on a Hub shared
 * deployment. There the deployment's own Microsoft app registration (GRAPH_* / OIDC_* env) is
 * never used; each app saves its own:
 *
 *   nivaro_settings.directory_graph_tenant_id      the Microsoft (Entra) tenant id
 *   nivaro_settings.directory_graph_client_id      the app registration's client id
 *   nivaro_settings.directory_graph_client_secret  its client secret, sealed (enc:v1, the app's
 *                                                  own key) and masked on every read
 *
 * Self-hosted and Nivaro Cloud keep reading the env and ignore these. Nullable, each added only
 * when missing; down drops what is there.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'directory_graph_tenant_id'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.string('directory_graph_tenant_id', 64).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'directory_graph_client_id'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.string('directory_graph_client_id', 64).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_settings', 'directory_graph_client_secret'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('directory_graph_client_secret').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of [
    'directory_graph_client_secret',
    'directory_graph_client_id',
    'directory_graph_tenant_id'
  ]) {
    if (await knex.schema.hasColumn('nivaro_settings', col)) {
      await knex.schema.alterTable('nivaro_settings', (t) => t.dropColumn(col))
    }
  }
}
