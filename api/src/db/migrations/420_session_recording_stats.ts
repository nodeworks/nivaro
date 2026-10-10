import type { Knex } from 'knex'

// Session replay stats kept per recording as its chunks arrive (#1358):
//   active_ms           — time someone was actually doing something: the sum of
//                         gaps between input / mutation events, each capped at 5 s
//                         (the list sorts by it; the player skips the rest).
//   active_last_ts      — epoch ms of the last such event, so the next chunk
//                         continues the sum across the chunk boundary.
// NULL on recordings made before this migration — the list shows nothing then.
const TABLE = 'nivaro_session_recordings'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'active_ms'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.integer('active_ms').nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'active_last_ts'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.bigInteger('active_last_ts').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  for (const col of ['active_ms', 'active_last_ts']) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.dropColumn(col)
      })
    }
  }
}
