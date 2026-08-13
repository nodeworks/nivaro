import type { Knex } from 'knex'

/**
 * Addendum cards need the full change story: the amount BEFORE and AFTER the
 * change (cost_impact alone only carries the net), and file attachments.
 * attachments = JSON array of nivaro_files ids (nvarchar text, parseJson on
 * read — same convention as every other JSON column).
 */
export async function up(knex: Knex): Promise<void> {
  const hasPrev = await knex.schema.hasColumn('nivaro_addendums', 'previous_amount')
  if (!hasPrev) {
    await knex.schema.alterTable('nivaro_addendums', (t) => {
      t.decimal('previous_amount', 18, 2).nullable()
      t.decimal('new_amount', 18, 2).nullable()
      t.text('attachments').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasPrev = await knex.schema.hasColumn('nivaro_addendums', 'previous_amount')
  if (hasPrev) {
    await knex.schema.alterTable('nivaro_addendums', (t) => {
      t.dropColumn('previous_amount')
      t.dropColumn('new_amount')
      t.dropColumn('attachments')
    })
  }
}
