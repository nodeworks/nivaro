import type { Knex } from 'knex'

// Traffic Map settings that belong to the instance, not to a person: how long map data is kept
// (snapshots, scheduled snapshots, investigation notebooks), the snapshot schedule, the point
// where the map starts sampling its ticker events, and the descriptions admins write for nodes.
// One JSON text column so new keys need no migration; NULL = every default.
// services/traffic-map-settings.ts owns the shape and keeps keys it does not know intact.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'traffic_map_settings'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('traffic_map_settings').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'traffic_map_settings')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('traffic_map_settings')
    })
  }
}
