import type { Knex } from 'knex'

// Headline snapshots gain the Fusion figures of the PUB budget model: the
// imported Fusion committed / remaining sums and the weighted Total Remaining
// % (0–100). NULL on every row written before this release, and on any night
// no project in the selection carried a Fusion figure.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_dashboard_snapshots', 'fusion_remaining'))) {
    await knex.schema.alterTable('nivaro_dashboard_snapshots', (t) => {
      t.decimal('fusion_committed', 18, 2).nullable()
      t.decimal('fusion_remaining', 18, 2).nullable()
      t.decimal('remaining_pct', 9, 4).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_dashboard_snapshots', 'fusion_remaining')) {
    await knex.schema.alterTable('nivaro_dashboard_snapshots', (t) => {
      t.dropColumn('fusion_committed')
      t.dropColumn('fusion_remaining')
      t.dropColumn('remaining_pct')
    })
  }
}
