import type { Knex } from 'knex'

// Help-video settings that are not per video: how renders are encoded (#1561)
// and, later, the house style (#1551). One JSON text column so new keys need
// no migration; NULL = every default. services/help-video-settings.ts owns the
// shape and keeps keys it does not know intact when it saves.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'help_video_settings'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('help_video_settings').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'help_video_settings')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('help_video_settings')
    })
  }
}
