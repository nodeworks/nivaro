import type { Knex } from 'knex'

// Script mode (#1491): the steps an author wrote before recording, kept on the
// version as a JSON array of strings so a re-record can offer them again.
// NULL = recorded without a script (and every uploaded file).
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_help_video_versions', 'script'))) {
    await knex.schema.alterTable('nivaro_help_video_versions', (t) => {
      t.text('script').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_help_video_versions', 'script')) {
    await knex.schema.alterTable('nivaro_help_video_versions', (t) => {
      t.dropColumn('script')
    })
  }
}
