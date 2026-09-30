import type { Knex } from 'knex'

/**
 * Inbound mapping bench (#624, #824, #825) — four text columns on
 * nivaro_inbound_mappings, all nullable, all JSON or template text:
 *   - children (JSON array) — nested one-to-many rules: each entry names an
 *     alias on the target collection, the payload path holding the rows and
 *     that child's own column rules (the import-template line_map format).
 *   - fixtures (JSON array, <= 20 entries) — named partner payloads the
 *     editor re-runs on every rule edit. A column, not a child table: they are
 *     configuration of the mapping and travel with its row wherever the row
 *     is copied, snapshotted or diffed.
 *   - response_template (Liquid) — the body the endpoint answers with; NULL
 *     keeps the default body.
 *   - response_status (JSON) — {success, partial, rejected} → HTTP status.
 * Every step is hasTable/hasColumn guarded and additive.
 */
const COLS: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
  ['children', (t) => t.text('children').nullable()],
  ['fixtures', (t) => t.text('fixtures').nullable()],
  ['response_template', (t) => t.text('response_template').nullable()],
  ['response_status', (t) => t.text('response_status').nullable()]
]

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_inbound_mappings'))) return
  for (const [name, add] of COLS) {
    if (!(await knex.schema.hasColumn('nivaro_inbound_mappings', name)))
      await knex.schema.alterTable('nivaro_inbound_mappings', (t) => add(t))
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_inbound_mappings'))) return
  for (const [name] of COLS) {
    if (await knex.schema.hasColumn('nivaro_inbound_mappings', name))
      await knex.schema.alterTable('nivaro_inbound_mappings', (t) => t.dropColumn(name))
  }
}
