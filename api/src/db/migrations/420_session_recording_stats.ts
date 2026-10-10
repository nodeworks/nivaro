import type { Knex } from 'knex'

// Session replay stats kept per recording as its chunks arrive (#1358, #1397):
//   active_ms           — time someone was actually doing something: the sum of
//                         gaps between input / mutation events, each capped at 5 s
//                         (the list sorts by it; the player skips the rest).
//   active_last_ts      — epoch ms of the last such event, so the next chunk
//                         continues the sum across the chunk boundary.
//   chapter_count       — chapters the recorder's route stamps open (#1397):
//                         one per change of page path.
//   chapter_last_route  — the path the last chapter opened on, so a chunk that
//                         starts on the same page does not count it again.
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
  if (!(await knex.schema.hasColumn(TABLE, 'chapter_count'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.integer('chapter_count').nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'chapter_last_route'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('chapter_last_route', 500).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  for (const col of ['active_ms', 'active_last_ts', 'chapter_count', 'chapter_last_route']) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.dropColumn(col)
      })
    }
  }
}
