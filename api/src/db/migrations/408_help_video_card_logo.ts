import type { Knex } from 'knex'

// Help-video cards get a logo of their own, so a video can carry a brand mark
// without changing the instance logo (sign-in page, admin sidebar). NULL =
// the cards fall back to the instance logo (brand_logo).
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'help_video_card_logo'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.uuid('help_video_card_logo').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'help_video_card_logo')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('help_video_card_logo')
    })
  }
}
