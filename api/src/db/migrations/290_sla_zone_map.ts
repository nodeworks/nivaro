import type { Knex } from 'knex'

/**
 * Per-region SLA clocks. sla_zone_map on settings holds
 * {source_collection, zones: {recordId: IANA zone}} — a record whose FK
 * (or first M2M link) points at a mapped source record counts business
 * hours in THAT zone instead of the instance-wide sla_timezone.
 * nivaro_queue_items.sla_timezone caches the resolved zone per row so the
 * materialized queues' sync per-row SLA math stays one narrow scan.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'sla_zone_map'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('sla_zone_map').nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_queue_items', 'sla_timezone'))) {
    await knex.schema.alterTable('nivaro_queue_items', (t) => {
      t.string('sla_timezone', 100).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'sla_zone_map')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('sla_zone_map')
    })
  }
  if (await knex.schema.hasColumn('nivaro_queue_items', 'sla_timezone')) {
    await knex.schema.alterTable('nivaro_queue_items', (t) => {
      t.dropColumn('sla_timezone')
    })
  }
}
