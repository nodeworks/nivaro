import type { Knex } from 'knex'

/**
 * Dead-file-link detection: a nivaro_files row whose physical bytes are gone
 * (host moved, storage lost, container swap) renders as a working link until
 * someone clicks it. `missing_at` marks a row whose file could not be found
 * on disk; `last_verified_at` records when the check last ran either way.
 * Written by the nightly file-integrity sweep and the on-demand batch verify
 * route; cleared the moment a check finds the bytes again.
 */
export async function up(knex: Knex): Promise<void> {
  const addCol = async (name: string, add: (t: Knex.AlterTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn('nivaro_files', name))) {
      await knex.schema.alterTable('nivaro_files', add)
    }
  }
  await addCol('missing_at', (t) => {
    t.dateTime('missing_at').nullable()
  })
  await addCol('last_verified_at', (t) => {
    t.dateTime('last_verified_at').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['missing_at', 'last_verified_at']) {
    if (await knex.schema.hasColumn('nivaro_files', col)) {
      await knex.schema.alterTable('nivaro_files', (t) => {
        t.dropColumn(col)
      })
    }
  }
}
