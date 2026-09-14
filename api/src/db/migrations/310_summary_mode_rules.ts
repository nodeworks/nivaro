import type { Knex } from 'knex'

/**
 * Summary Mode rules (2026-09-14):
 *  - nivaro_collections.summary_mode_rules — JSON
 *      { default: 'edit'|'summary', rules: [{ roles?, states?, states_op?, mode }] }
 *    deciding which mode the record form opens in, by viewer role and/or the
 *    record's pipeline state (first match wins; new records always Edit).
 *  - migration 307's read_mode_default_roles (a bare role list) is folded into
 *    one rule per collection and the column is dropped.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_collections', 'summary_mode_rules'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.text('summary_mode_rules').nullable()
    })
  }
  if (await knex.schema.hasColumn('nivaro_collections', 'read_mode_default_roles')) {
    const rows = (await knex('nivaro_collections')
      .whereNotNull('read_mode_default_roles')
      .select('collection', 'read_mode_default_roles', 'summary_mode_rules')) as Array<{
      collection: string
      read_mode_default_roles: string | null
      summary_mode_rules: string | null
    }>
    for (const row of rows) {
      if (row.summary_mode_rules) continue
      let roles: string[] = []
      try {
        const parsed = JSON.parse(row.read_mode_default_roles ?? '[]')
        if (Array.isArray(parsed)) roles = parsed.map(String)
      } catch {
        roles = []
      }
      if (roles.length === 0) continue
      await knex('nivaro_collections')
        .where('collection', row.collection)
        .update({
          summary_mode_rules: JSON.stringify({
            default: 'edit',
            rules: [{ roles, states: null, states_op: 'in', mode: 'summary' }]
          })
        })
    }
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('read_mode_default_roles')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_collections', 'read_mode_default_roles'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.text('read_mode_default_roles').nullable()
    })
  }
  if (await knex.schema.hasColumn('nivaro_collections', 'summary_mode_rules')) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('summary_mode_rules')
    })
  }
}
