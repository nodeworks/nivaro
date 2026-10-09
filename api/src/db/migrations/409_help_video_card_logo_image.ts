import type { Knex } from 'knex'

// The help-video cards' own logo is stored as the image itself (a data URI),
// not a file id: settings travel between environments, files do not, so an
// id copied to another database pointed at nothing there. Replaces 408's
// help_video_card_logo (uuid), which only ever held hand-set test values.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'help_video_card_logo_image'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('help_video_card_logo_image').nullable()
    })
  }
  if (await knex.schema.hasColumn('nivaro_settings', 'help_video_card_logo')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('help_video_card_logo')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'help_video_card_logo'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.uuid('help_video_card_logo').nullable()
    })
  }
  if (await knex.schema.hasColumn('nivaro_settings', 'help_video_card_logo_image')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('help_video_card_logo_image')
    })
  }
}
